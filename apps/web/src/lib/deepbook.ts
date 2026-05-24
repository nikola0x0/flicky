/**
 * DeepBook Predict integration — staked-tier swipes.
 *
 * Each staked swipe is an atomic PTB combining:
 *   - `predict::mint(...)` — creates a real Predict binary position on
 *     DeepBook with dUSDC from the player's PredictManager
 *   - `duel::record_swipe(...)` — records the swipe in the Flicky duel for
 *     score-based PvP payout
 *
 * The player must own a `PredictManager` and have dUSDC in its balance before
 * staked swipes will succeed.
 *
 * TESTNET BLOCKERS (as of writing):
 *   - DeepBook may not always have a fresh BTC `OracleSVI` ACTIVE; `predict::mint`
 *     aborts `EMarketNotActive` until rotation resumes.
 *   - dUSDC has no public faucet; players need an existing source.
 */
import { Transaction } from "@mysten/sui/transactions"
import type { SuiJsonRpcClient, SuiObjectResponse } from "@mysten/sui/jsonRpc"
import { normalizeSuiObjectId } from "@mysten/sui/utils"
import { bcs } from "@mysten/sui/bcs"

type SuiClient = SuiJsonRpcClient

import * as predict from "@/sui/gen/deepbook_predict/predict"
import * as predictManager from "@/sui/gen/deepbook_predict/predict_manager"
import * as marketKey from "@/sui/gen/deepbook_predict/market_key"
import * as duel from "@/sui/gen/flicky/duel"
import { CONFIG } from "./config"

/** Hard-coded testnet object IDs for DeepBook Predict. */
export const DEEPBOOK = {
  package: CONFIG.deepbookPredictPackageId,
  /** Singleton `Predict` shared object; the protocol entry-point state. */
  predictObject:
    import.meta.env.VITE_DEEPBOOK_PREDICT_OBJECT_ID ??
    "0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a",
  /** Canonical dUSDC coin type on testnet (1e6 decimals). */
  dusdcType:
    "0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC",
} as const

// === Discovery ===

/**
 * localStorage namespace for cached PredictManager ids.
 * Manager ids are permanent per address (DeepBook never deletes them),
 * so this cache is effectively long-lived. Invalidation only happens
 * if the cached object can't be fetched anymore — see `findPredictManager`.
 */
const MANAGER_CACHE_KEY = "flicky.predictManager.v1"

function readManagerCache(address: string): string | null {
  try {
    const raw = localStorage.getItem(MANAGER_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Record<string, string>
    return parsed[address] ?? null
  } catch {
    return null
  }
}

export function writeManagerCache(address: string, managerId: string): void {
  try {
    const raw = localStorage.getItem(MANAGER_CACHE_KEY)
    const parsed = raw
      ? (JSON.parse(raw) as Record<string, string>)
      : {}
    parsed[address] = managerId
    localStorage.setItem(MANAGER_CACHE_KEY, JSON.stringify(parsed))
  } catch {
    // localStorage unavailable / quota exceeded — degrades to event query.
  }
}

function clearManagerCache(address: string): void {
  try {
    const raw = localStorage.getItem(MANAGER_CACHE_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as Record<string, string>
    delete parsed[address]
    localStorage.setItem(MANAGER_CACHE_KEY, JSON.stringify(parsed))
  } catch {
    // ignore
  }
}

/**
 * Find the PredictManager logically owned by `address`.
 *
 * DeepBook publishes `PredictManager` as a **shared** Sui object with an
 * internal `owner: address` field, not an `AddressOwner`-style object.
 * `getOwnedObjects` therefore never returns it. The reliable discovery
 * path is to walk `predict_manager::PredictManagerCreated` events (which
 * carry `{ manager_id, owner }`) and pick the one whose `owner` matches
 * us — but event scans require multiple RPC roundtrips.
 *
 * Cache layer: manager ids are permanent per address, so we cache them
 * in localStorage and short-circuit subsequent lookups. Cache is
 * validated lazily — we trust the id unless a subsequent `getObject`
 * fails, at which point the swipe path will surface a clear error and
 * the caller can invalidate via `writeManagerCache` again.
 */
export async function findPredictManager(
  client: SuiClient,
  address: string,
): Promise<{ id: string } | null> {
  const cached = readManagerCache(address)
  if (cached) return { id: cached }

  // Newest first — if a user accidentally has two events for some reason
  // (shouldn't happen, but be defensive), prefer the most recent.
  let cursor: { txDigest: string; eventSeq: string } | null | undefined = null
  // Walk up to 5 pages (≈ 250 events) before giving up. Plenty for
  // hackathon testnet; we'd swap to an indexer for production scale.
  for (let page = 0; page < 5; page++) {
    const evts = await client.queryEvents({
      query: {
        MoveEventType: `${DEEPBOOK.package}::predict_manager::PredictManagerCreated`,
      },
      limit: 50,
      order: "descending",
      cursor,
    })
    for (const e of evts.data) {
      const p = e.parsedJson as { manager_id: string; owner: string }
      if (p.owner === address) {
        const id = normalizeSuiObjectId(p.manager_id)
        writeManagerCache(address, id)
        return { id }
      }
    }
    if (!evts.hasNextPage) break
    cursor = evts.nextCursor
  }
  return null
}

/**
 * Drop the cached manager id for `address`. Call this when an operation
 * against the cached id fails in a way that suggests the id is stale
 * (e.g. the manager was deleted, or the user moved to a different
 * wallet that happens to share an address by coincidence).
 */
export function invalidateManagerCache(address: string): void {
  clearManagerCache(address)
}

/** Return the player's spendable dUSDC balance in their wallet. */
export async function getWalletDusdcBalance(
  client: SuiClient,
  address: string,
): Promise<bigint> {
  const coins = await client.getCoins({
    owner: address,
    coinType: DEEPBOOK.dusdcType,
  })
  let total = 0n
  for (const c of coins.data) total += BigInt(c.balance)
  return total
}

/** dUSDC held inside a PredictManager (devInspect of `balance<DUSDC>`). */
export async function getManagerDusdcBalance(
  client: SuiClient,
  managerId: string,
): Promise<bigint> {
  const tx = new Transaction()
  tx.add(
    predictManager.balance({
      package: DEEPBOOK.package,
      arguments: [managerId],
      typeArguments: [DEEPBOOK.dusdcType],
    }),
  )
  const res = await client.devInspectTransactionBlock({
    sender: "0x0000000000000000000000000000000000000000000000000000000000000000",
    transactionBlock: tx,
  })
  const ret = res.results?.[0]?.returnValues?.[0]
  if (!ret) return 0n
  return BigInt(bcs.U64.parse(Uint8Array.from(ret[0])))
}

// === PTB builders ===

/** Create a PredictManager for the caller. One-time setup per player.
 *
 * The minimized DeepBook Predict codegen at `sui/gen/deepbook_predict`
 * doesn't expose `create_manager` — the function lives on the deployed
 * DeepBook package but not on the type-stub used by Flicky's contract.
 * We build the call manually instead of going through the codegen
 * binding. Sponsor allowlist whitelists `predict::create_manager` so
 * the sponsored-gas path still works.
 */
export function buildCreateManagerTx(): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: `${DEEPBOOK.package}::predict::create_manager`,
    arguments: [],
  })
  return tx
}

/**
 * Deposit dUSDC from the player's wallet into their PredictManager. Picks
 * coin objects from the wallet, merges them, splits the deposit amount.
 */
export async function buildDepositDusdcTx(
  client: SuiClient,
  owner: string,
  managerId: string,
  amountMicroDusdc: bigint,
): Promise<Transaction> {
  const coins = await client.getCoins({ owner, coinType: DEEPBOOK.dusdcType })
  if (coins.data.length === 0) {
    throw new Error("no dUSDC coins to deposit")
  }
  const tx = new Transaction()
  const [primary, ...rest] = coins.data.map((c) => tx.object(c.coinObjectId))
  if (rest.length > 0) tx.mergeCoins(primary, rest)
  const [deposit] = tx.splitCoins(primary, [tx.pure.u64(amountMicroDusdc)])
  tx.add(
    predictManager.deposit({
      package: DEEPBOOK.package,
      arguments: [managerId, deposit],
      typeArguments: [DEEPBOOK.dusdcType],
    }),
  )
  return tx
}

/** Withdraw dUSDC from a PredictManager back to the owner's wallet. */
export function buildWithdrawDusdcTx(
  managerId: string,
  amountMicroDusdc: bigint,
  recipient: string,
): Transaction {
  const tx = new Transaction()
  const coin = tx.add(
    predictManager.withdraw({
      package: DEEPBOOK.package,
      arguments: [managerId, amountMicroDusdc],
      typeArguments: [DEEPBOOK.dusdcType],
    }),
  )
  tx.transferObjects([coin], tx.pure.address(recipient))
  return tx
}

/**
 * Atomic staked swipe: mint a binary Predict position on DeepBook AND record
 * the swipe in the Flicky duel.
 *
 * `quantity` is in dUSDC micro-units (1e6 = 1 dUSDC). The dUSDC is debited
 * from the player's PredictManager; the position pays `quantity` if correct.
 *
 * Aborts:
 *   - `EMarketNotActive` if the OracleSVI isn't ACTIVE
 *   - insufficient PredictManager balance
 *   - flicky `EOracleNotLive` / `EOutOfTurn` (standard swipe guards)
 */
export function buildStakedSwipeTx(args: {
  duelId: string
  oracleSviId: string
  managerId: string
  oracleExpiry: bigint
  strike: bigint
  isUp: boolean
  quantity: bigint
  /**
   * Premium paid for the Predict position, in dUSDC micro-units. The
   * contract verifies `premium > 0` and the keeper redeems against this
   * exact value, so the FE should pass what `predict::get_mint_amounts`
   * (or `pricing::quote_*`) returned at quote time.
   */
  premium: bigint
  cardIdx: number
}): Transaction {
  const tx = new Transaction()

  // 1. Build MarketKey for the chosen direction.
  const mk = tx.add(
    args.isUp
      ? marketKey.up({
          package: DEEPBOOK.package,
          arguments: [args.oracleSviId, args.oracleExpiry, args.strike],
        })
      : marketKey.down({
          package: DEEPBOOK.package,
          arguments: [args.oracleSviId, args.oracleExpiry, args.strike],
        }),
  )

  // 2. Mint the real DeepBook position. Clock + ctx auto-injected by codegen.
  tx.add(
    predict.mint({
      package: DEEPBOOK.package,
      arguments: [
        DEEPBOOK.predictObject,
        args.managerId,
        args.oracleSviId,
        mk,
        args.quantity,
      ],
      typeArguments: [DEEPBOOK.dusdcType],
    }),
  )

  // 3. Record the swipe in the Flicky duel — same OracleSVI, atomic.
  // New contract signature: (duel, manager, oracle, card_idx, is_up,
  // quantity, premium, clock, ctx). Clock + ctx are auto-injected by
  // the codegen; we pass the other 7 in order.
  tx.add(
    duel.recordSwipe({
      package: CONFIG.packageId,
      arguments: [
        args.duelId,
        args.managerId,
        args.oracleSviId,
        args.cardIdx,
        args.isUp,
        args.quantity,
        args.premium,
      ],
      typeArguments: [DEEPBOOK.dusdcType],
    }),
  )

  return tx
}

/**
 * Keeper path: after the OracleSVI is settled, anyone can push the Predict
 * position payout back into the player's manager.
 */
export function buildRedeemPermissionlessTx(args: {
  managerId: string
  oracleSviId: string
  oracleExpiry: bigint
  strike: bigint
  isUp: boolean
  quantity: bigint
}): Transaction {
  const tx = new Transaction()
  const mk = tx.add(
    args.isUp
      ? marketKey.up({
          package: DEEPBOOK.package,
          arguments: [args.oracleSviId, args.oracleExpiry, args.strike],
        })
      : marketKey.down({
          package: DEEPBOOK.package,
          arguments: [args.oracleSviId, args.oracleExpiry, args.strike],
        }),
  )
  tx.add(
    predict.redeemPermissionless({
      package: DEEPBOOK.package,
      arguments: [
        DEEPBOOK.predictObject,
        args.managerId,
        args.oracleSviId,
        mk,
        args.quantity,
      ],
      typeArguments: [DEEPBOOK.dusdcType],
    }),
  )
  return tx
}

// === Helpers ===

export function fmtDusdc(microUnits: bigint): string {
  return `${(Number(microUnits) / 1e6).toFixed(4)} dUSDC`
}

/**
 * Parse the `created` change matching the new PredictManager out of a
 * `create_manager` tx's objectChanges.
 */
export function extractManagerIdFromChanges(
  changes:
    | SuiObjectResponse[]
    | { type: string; objectType?: string; objectId?: string }[],
): string | null {
  for (const c of changes) {
    const raw = "type" in c ? c : undefined
    if (!raw) continue
    if (raw.type !== "created") continue
    if (!raw.objectType || !raw.objectType.endsWith("::PredictManager")) continue
    return normalizeSuiObjectId(raw.objectId!)
  }
  return null
}
