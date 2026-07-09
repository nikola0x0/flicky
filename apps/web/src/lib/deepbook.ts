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
import type { ClientWithCoreApi } from "@mysten/sui/client"
import { normalizeSuiObjectId } from "@mysten/sui/utils"
import { bcs } from "@mysten/sui/bcs"

type SuiClient = ClientWithCoreApi

import * as predict from "@/sui/gen/deepbook_predict/predict"
import * as predictManager from "@/sui/gen/deepbook_predict/predict_manager"
import * as marketKey from "@/sui/gen/deepbook_predict/market_key"
import * as duel from "@/sui/gen/flicky/duel"
import { CONFIG } from "./config"
import { getGraphQLClient } from "./graphql"

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
 * `getOwnedObjects` therefore never returns it.
 *
 * Resolution order:
 *   1. localStorage cache — manager ids are permanent per address.
 *   2. The Flicky server's `/manager` endpoint — the single source of
 *      truth. Its lookup is DB-cached AND scans the full event stream, so
 *      a `null` answer is authoritative ("no manager exists yet"), not a
 *      truncated miss. This is what lets us decide whether to bootstrap
 *      without minting a DUPLICATE manager.
 *   3. Direct event scan — a degraded fallback used only when the server
 *      is unreachable. Unbounded like the server, so its `null` is also
 *      authoritative; the page cap is only a runaway-RPC backstop.
 */
const MANAGER_SCAN_PAGE_CAP = 100 // 5000 events ≈ full testnet history

// GraphQL descending scan: `last: 50` + `before: startCursor` walks the
// event stream newest-first, page by page (gRPC has no filtered event API).
const MANAGER_SCAN_QUERY = `query Scan($type: String!, $before: String) {
  events(filter: { type: $type }, last: 50, before: $before) {
    pageInfo { hasPreviousPage startCursor }
    nodes { contents { json } }
  }
}`
type ManagerScanResult = {
  data?: {
    events?: {
      pageInfo?: { hasPreviousPage: boolean; startCursor: string | null }
      nodes?: Array<{ contents: { json: { manager_id: string; owner: string } } }>
    }
  }
}

export async function findPredictManager(
  _client: SuiClient,
  address: string,
): Promise<{ id: string } | null> {
  const cached = readManagerCache(address)
  if (cached) return { id: cached }

  // Primary path: ask the server, which owns the canonical (DB-cached,
  // unbounded) resolution. A reachable server's answer is final.
  const resolved = await resolveManagerViaServer(address)
  if (resolved !== undefined) {
    if (resolved) {
      writeManagerCache(address, resolved)
      return { id: resolved }
    }
    return null // server scanned everything and found none
  }

  // Fallback: server unreachable — scan events directly via GraphQL. Newest
  // first, and UNBOUNDED (same as the server) so a returned `null` always
  // means "scanned the whole stream, found none" — never "gave up early". A
  // truncated null here would let the bootstrap mint a duplicate manager,
  // which is exactly the failure this whole path exists to prevent. The
  // page cap below only guards a misbehaving RPC that never ends.
  const type = `${DEEPBOOK.package}::predict_manager::PredictManagerCreated`
  let before: string | null = null
  for (let page = 0; page < MANAGER_SCAN_PAGE_CAP; page++) {
    const res = (await getGraphQLClient().query({
      query: MANAGER_SCAN_QUERY,
      variables: { type, before },
    })) as ManagerScanResult
    const ev = res.data?.events
    for (const node of ev?.nodes ?? []) {
      const p = node.contents.json
      if (p.owner === address) {
        const id = normalizeSuiObjectId(p.manager_id)
        writeManagerCache(address, id)
        return { id }
      }
    }
    if (!ev?.pageInfo?.hasPreviousPage) break
    before = ev.pageInfo.startCursor
  }
  return null
}

/**
 * Resolve a manager id via the Flicky server's `/manager` endpoint.
 *
 * Returns:
 *   - a manager id string  → server found one
 *   - `null`               → server scanned and found none (authoritative)
 *   - `undefined`          → server unreachable / errored (caller falls back)
 */
async function resolveManagerViaServer(
  address: string,
): Promise<string | null | undefined> {
  try {
    const res = await fetch(
      `${CONFIG.serverHttpUrl}/manager?owner=${encodeURIComponent(address)}`,
    )
    if (!res.ok) return undefined
    const body = (await res.json()) as { ok?: boolean; managerId?: string | null }
    if (!body.ok) return undefined
    return body.managerId ? normalizeSuiObjectId(body.managerId) : null
  } catch {
    return undefined
  }
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
  const res = await client.core.getBalance({
    owner: address,
    coinType: DEEPBOOK.dusdcType,
  })
  return BigInt(res.balance.balance)
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
  tx.setSender("0x0000000000000000000000000000000000000000000000000000000000000000")
  const res = await client.core.simulateTransaction({
    transaction: tx,
    include: { commandResults: true },
  })
  const ret = res.commandResults?.[0]?.returnValues?.[0]
  if (!ret) return 0n
  return BigInt(bcs.u64().parse(ret.bcs))
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
  const coins = await client.core.listCoins({
    owner,
    coinType: DEEPBOOK.dusdcType,
  })
  if (coins.objects.length === 0) {
    throw new Error("no dUSDC coins to deposit")
  }
  const tx = new Transaction()
  const [primary, ...rest] = coins.objects.map((c) => tx.object(c.objectId))
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
  // Contract signature: (duel, manager, predict, oracle, card_idx, is_up,
  // quantity, clock, ctx). The contract snapshots premium + p_swiped
  // on-chain via get_trade_amounts — no client-supplied premium. Clock +
  // ctx are auto-injected by the codegen; we pass the other 7 in order.
  tx.add(
    duel.recordSwipe({
      package: CONFIG.packageId,
      arguments: [
        args.duelId,
        args.managerId,
        DEEPBOOK.predictObject,
        args.oracleSviId,
        args.cardIdx,
        args.isUp,
        args.quantity,
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

// === UI-only swipe-cost quoter ===

export interface SwipeQuote {
  /**
   * dUSDC micro-units. **Display only — do NOT pass to
   * buildStakedSwipeTx.** The contract snapshots its own `premium` via
   * `get_trade_amounts` on-chain at swipe time; this is an estimate
   * that may drift by a few atoms by the time the tx lands.
   */
  premium: bigint
  /**
   * Implied probability in 1e9 fixed point (e.g. 700_000_000 = 0.70)
   * for the side this quote was requested for. Derived as
   * `premium * 1e9 / quantity` — the market's implied probability
   * that the side wins.
   */
  pImplied: bigint
}

/**
 * devInspect `predict::get_trade_amounts` to preview a swipe's cost
 * BEFORE the user clicks UP/DOWN. The Move function returns
 * `(mint_cost, max_payout)` as two u64s; we decode via BCS and
 * compute the implied probability from the mint cost.
 *
 * Network round-trip — call once per (oracleId, strike, isUp) when a
 * card enters the swipe UI, NOT on every `oracle_tick`.
 */
export async function quoteSwipePremium(
  client: SuiClient,
  args: {
    oracleSviId: string
    oracleExpiry: bigint
    strike: bigint
    isUp: boolean
    quantity: bigint
  },
): Promise<SwipeQuote> {
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
    predict.getTradeAmounts({
      package: DEEPBOOK.package,
      arguments: [
        DEEPBOOK.predictObject,
        args.oracleSviId,
        mk,
        args.quantity,
      ],
    }),
  )
  tx.setSender(
    "0x0000000000000000000000000000000000000000000000000000000000000000",
  )
  const res = await client.core.simulateTransaction({
    transaction: tx,
    include: { commandResults: true },
  })
  // The last result is `get_trade_amounts` returning (mint_cost, max_payout).
  // BCS-encoded u64 each. We only need mint_cost.
  const cmds = res.commandResults ?? []
  const last = cmds[cmds.length - 1]
  const rets = last?.returnValues ?? []
  if (rets.length < 1) {
    throw new Error("quoteSwipePremium: unexpected simulate return shape")
  }
  const premium = BigInt(bcs.u64().parse(rets[0].bcs))
  const q = args.quantity
  const pImplied = q > 0n ? (premium * 1_000_000_000n) / q : 0n
  return { premium, pImplied }
}

/**
 * Wait for a `create_manager` tx to be indexed, then resolve the new
 * PredictManager id from the tx's created objects.
 *
 * gRPC replaces v1 `objectChanges` with `effects.changedObjects`
 * (`idOperation === "Created"`) keyed to their Move type via the
 * `objectTypes` map. Returns null if the tx created no PredictManager,
 * so the caller can fall back to event-scan discovery.
 */
export async function waitForCreatedManagerId(
  client: SuiClient,
  digest: string,
): Promise<string | null> {
  const res = await client.core.waitForTransaction({
    digest,
    include: { effects: true, objectTypes: true },
  })
  const tx = res.Transaction
  const types = tx?.objectTypes ?? {}
  for (const c of tx?.effects?.changedObjects ?? []) {
    if (c.idOperation !== "Created") continue
    const t = types[c.objectId]
    if (t && t.endsWith("::PredictManager")) {
      return normalizeSuiObjectId(c.objectId)
    }
  }
  return null
}

/**
 * Resolve the PredictManager id that a `create_manager` tx just produced.
 *
 * Implementation note: we deliberately do NOT parse `objectChanges` on the
 * sign result. The sponsored-gas path returns only `{ digest }`, so that
 * field is missing. Instead — matching what apps/playground does — we
 * wait for the tx to be indexed, then re-run the event-based
 * `findPredictManager` discovery. The `PredictManagerCreated` event is
 * emitted regardless of who paid gas, so this works for both sponsored
 * and wallet-paid paths.
 */
export async function resolveCreatedManagerId(
  client: SuiClient,
  digest: string,
  ownerAddress: string,
): Promise<string | null> {
  await client.core.waitForTransaction({ digest })
  // Bust the per-address cache so we don't return a stale null hit.
  invalidateManagerCache(ownerAddress)
  const mgr = await findPredictManager(client, ownerAddress)
  return mgr?.id ?? null
}
