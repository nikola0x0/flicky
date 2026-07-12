/**
 * DeepBook Predict (6-24) integration — staked-tier swipes + account onboarding.
 *
 * Each staked swipe is ONE player-signed, sponsored PTB combining:
 *   - `account::generate_auth` — owner auth for the player's AccountWrapper
 *   - `expiry_market::load_live_pricer` — market-bound live pricer (once per tx)
 *   - `expiry_market::mint_exact_quantity` — mints a real 6-24 binary position
 *     funded from the player's escrowed dUSDC; returns a `u256` order id
 *   - `duel::record_swipe(..., order_id, ...)` — records the swipe in the Flicky
 *     duel for score-based PvP payout, chaining the mint's order id
 *
 * The DeepBook / account side is built with RAW `tx.moveCall` (the minimized
 * codegen doesn't expose `expiry_market` / `account` entry points); the flicky
 * `duel::record_swipe` call stays on codegen. The player wallet only ever holds
 * dUSDC — gas is sponsored end-to-end via `lib/sponsor.ts`.
 *
 * A player owns a deterministic, shared `AccountWrapper` (created once via
 * `account_registry::new` + `account::share`) and funds it via `deposit_funds`.
 */
import { Transaction } from "@mysten/sui/transactions"
import { coinWithBalance } from "@mysten/sui/transactions"
import type { ClientWithCoreApi } from "@mysten/sui/client"
import { normalizeSuiObjectId } from "@mysten/sui/utils"

type SuiClient = ClientWithCoreApi

import * as duel from "@/sui/gen/flicky/duel"
import { CONFIG } from "./config"

/** Hard-coded testnet object IDs / package ids for DeepBook Predict (6-24). */
export const DEEPBOOK = {
  deepbookPredictPackageId: CONFIG.deepbookPredictPackageId,
  accountPackageId: CONFIG.accountPackageId,
  accountRegistryId: CONFIG.accountRegistryId,
  protocolConfigId: CONFIG.protocolConfigId,
  oracleRegistryId: CONFIG.oracleRegistryId,
  pythFeedId: CONFIG.pythFeedId,
  bsSpotFeedId: CONFIG.bsSpotFeedId,
  bsForwardFeedId: CONFIG.bsForwardFeedId,
  bsSviFeedId: CONFIG.bsSviFeedId,
  accumulatorRootId: CONFIG.accumulatorRootId,
  predictIndexerUrl: CONFIG.predictIndexerUrl,
  /** Canonical dUSDC coin type on testnet (1e6 decimals). */
  dusdcType:
    "0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC",
} as const

// === Wrapper discovery ===

/**
 * localStorage namespace for cached AccountWrapper ids.
 *
 * A player's wrapper is deterministic + permanent (DeepBook never deletes it),
 * so this cache is effectively long-lived. The `wrapper:v2` namespace exists so
 * stale 4-16-era PredictManager ids (from the previous integration) can never be
 * returned here — it mirrors the server's `wrapper:v2:` fix.
 */
const WRAPPER_CACHE_KEY = "flicky.wrapper.v2"

function readWrapperCache(owner: string): string | null {
  try {
    const raw = localStorage.getItem(WRAPPER_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Record<string, string>
    return parsed[owner] ?? null
  } catch {
    return null
  }
}

export function writeWrapperCache(owner: string, wrapperId: string): void {
  try {
    const raw = localStorage.getItem(WRAPPER_CACHE_KEY)
    const parsed = raw ? (JSON.parse(raw) as Record<string, string>) : {}
    parsed[owner] = wrapperId
    localStorage.setItem(WRAPPER_CACHE_KEY, JSON.stringify(parsed))
  } catch {
    // localStorage unavailable / quota exceeded — degrades to server lookup.
  }
}

export function invalidateWrapperCache(owner: string): void {
  try {
    const raw = localStorage.getItem(WRAPPER_CACHE_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as Record<string, string>
    delete parsed[owner]
    localStorage.setItem(WRAPPER_CACHE_KEY, JSON.stringify(parsed))
  } catch {
    // ignore
  }
}

/**
 * Resolve the AccountWrapper logically owned by `owner`.
 *
 * Resolution order:
 *   1. localStorage cache — wrapper ids are permanent per address.
 *   2. The Flicky server's `/manager` endpoint — the single source of truth
 *      (Plan 2 renamed its response field `managerId` → `wrapper`). A `null`
 *      answer is authoritative: "no wrapper exists yet".
 *
 * Returns:
 *   - a wrapper id string  → found (server or cache)
 *   - `null`               → no wrapper exists yet
 *   - `undefined`          → server unreachable / errored
 */
export async function resolveWrapper(
  owner: string
): Promise<string | null | undefined> {
  const cached = readWrapperCache(owner)
  if (cached) return cached

  try {
    const res = await fetch(
      `${CONFIG.serverHttpUrl}/manager?owner=${encodeURIComponent(owner)}`
    )
    if (!res.ok) return undefined
    const body = (await res.json()) as {
      ok?: boolean
      wrapper?: string | null
    }
    if (!body.ok) return undefined
    if (!body.wrapper) return null
    const id = normalizeSuiObjectId(body.wrapper)
    writeWrapperCache(owner, id)
    return id
  } catch {
    return undefined
  }
}

// === Balances ===

/** Return the player's spendable dUSDC balance in their wallet. */
export async function getWalletDusdcBalance(
  client: SuiClient,
  address: string
): Promise<bigint> {
  const res = await client.core.getBalance({
    owner: address,
    coinType: DEEPBOOK.dusdcType,
  })
  return BigInt(res.balance.balance)
}

/**
 * Resolve wrapper id + dUSDC AccountWrapper balance in one server
 * round-trip (`GET /manager` returns both). Unlike `resolveWrapper`, this
 * always hits the server — balance isn't cacheable client-side the way a
 * permanent wrapper id is — but it still warms the wrapper-id cache when
 * a wrapper is found.
 */
export async function fetchAccountState(
  owner: string
): Promise<{ wrapperId: string | null; balance: bigint }> {
  const res = await fetch(
    `${CONFIG.serverHttpUrl}/manager?owner=${encodeURIComponent(owner)}`
  )
  if (!res.ok) {
    throw new Error(`fetchAccountState: /manager HTTP ${res.status}`)
  }
  const body = (await res.json()) as {
    ok?: boolean
    wrapper?: string | null
    balance?: string | null
  }
  if (!body.ok) throw new Error("fetchAccountState: /manager returned !ok")
  if (body.wrapper) {
    const id = normalizeSuiObjectId(body.wrapper)
    writeWrapperCache(owner, id)
    return { wrapperId: id, balance: BigInt(body.balance ?? "0") }
  }
  return { wrapperId: null, balance: 0n }
}

/**
 * Wait for a `buildCreateAccountTx` transaction to finalize, then resolve
 * the newly created (deterministic) wrapper id. The `AccountWrapper`
 * address is derived purely from `(AccountRegistry, owner)`, but the
 * server's lookup needs the tx to have actually landed first — poll
 * `resolveWrapper` a few times to absorb propagation lag.
 */
export async function waitForCreatedWrapper(
  client: SuiClient,
  digest: string,
  owner: string
): Promise<string> {
  await client.core.waitForTransaction({ digest, include: { effects: true } })
  for (let attempt = 0; attempt < 6; attempt++) {
    const id = await resolveWrapper(owner)
    if (id) return id
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error("account created but wrapper id not resolved yet — try again")
}

// === Tick derivation + market metadata ===

/** Positive-infinity sentinel tick: `(1 << 30) - 1`. Open upper bound. */
const POS_INF_TICK = (1n << 30n) - 1n

/**
 * Derive the `(lower_tick, higher_tick]` pair for a binary swipe.
 *   - UP / YES  = `(K, +inf]`  → `lower = K/tick_size`, `higher = pos_inf_tick`
 *   - DOWN / NO = `[0, K]`     → `lower = 0`,            `higher = K/tick_size`
 */
export function deriveTicks(strike: bigint, isUp: boolean, tickSize: bigint) {
  const strikeTick = strike / tickSize
  return isUp
    ? { lowerTick: strikeTick, higherTick: POS_INF_TICK }
    : { lowerTick: 0n, higherTick: strikeTick }
}

/** Cached `tick_size` per expiry market, keyed by `expiry_market_id`. */
const tickSizeCache = new Map<string, bigint>()

type MarketRow = { expiry_market_id?: string; tick_size?: string }

/**
 * Fetch (and cache) an expiry market's `tick_size` from the predict indexer.
 * `GET {predictIndexerUrl}/markets` returns rows carrying `expiry_market_id`
 * and `tick_size` (a base-unit string, e.g. `"10000000"`).
 */
export async function fetchMarketTickSize(marketId: string): Promise<bigint> {
  const key = normalizeSuiObjectId(marketId)
  const cached = tickSizeCache.get(key)
  if (cached !== undefined) return cached

  const res = await fetch(`${DEEPBOOK.predictIndexerUrl}/markets`)
  if (!res.ok) {
    throw new Error(`fetchMarketTickSize: /markets HTTP ${res.status}`)
  }
  const rows = (await res.json()) as MarketRow[]
  const row = rows.find(
    (r) =>
      r.expiry_market_id && normalizeSuiObjectId(r.expiry_market_id) === key
  )
  if (!row?.tick_size) {
    throw new Error(`fetchMarketTickSize: market ${marketId} not found`)
  }
  const tickSize = BigInt(row.tick_size)
  tickSizeCache.set(key, tickSize)
  return tickSize
}

// === PTB builders ===

const U64_MAX = 2n ** 64n - 1n
const LEVERAGE_1X = 1_000_000_000n // 1e9-scaled; 1e9 == 1x

/**
 * Atomic staked swipe: mint a real 6-24 binary position on DeepBook AND record
 * the swipe in the Flicky duel, in ONE player-signed (sponsored) PTB.
 *
 * `quantity` is in u64 contracts. The premium is withdrawn from the player's
 * AccountWrapper dUSDC balance; the resulting `order_id` is chained into
 * `duel::record_swipe` so a genuine mint backs every swipe.
 *
 * Aborts (see reference gotchas):
 *   - `load_live_pricer` if any feed is stale or the market is past expiry
 *   - insufficient AccountWrapper dUSDC balance
 *   - flicky `EOutOfTurn` / standard swipe guards
 */
export function buildStakedSwipeTx(args: {
  duelId: string
  wrapperId: string
  marketId: string
  strike: bigint
  tickSize: bigint
  cardIdx: number
  isUp: boolean
  quantity: bigint
  /** The `Duel<T>`'s escrow coin type — must match the duel's own `T` (e.g.
   * dUSDC for staked duels), NOT the account/premium coin type. */
  stakeCoinType: string
}): Transaction {
  const tx = new Transaction()
  const { lowerTick, higherTick } = deriveTicks(
    args.strike,
    args.isUp,
    args.tickSize
  )

  // 1. Owner auth for the AccountWrapper (owner = tx sender).
  const auth = tx.moveCall({
    target: `${DEEPBOOK.accountPackageId}::account::generate_auth`,
  })

  // 2. Market-bound live pricer (once per tx, before any live mint).
  const pricer = tx.moveCall({
    target: `${DEEPBOOK.deepbookPredictPackageId}::expiry_market::load_live_pricer`,
    arguments: [
      tx.object(args.marketId),
      tx.object(DEEPBOOK.protocolConfigId),
      tx.object(DEEPBOOK.oracleRegistryId),
      tx.object(DEEPBOOK.pythFeedId),
      tx.object(DEEPBOOK.bsSpotFeedId),
      tx.object(DEEPBOOK.bsForwardFeedId),
      tx.object(DEEPBOOK.bsSviFeedId),
      tx.object(CONFIG.CLOCK_ID),
    ],
  })

  // 3. Mint the exact-quantity position. Returns a u256 order id.
  const order = tx.moveCall({
    target: `${DEEPBOOK.deepbookPredictPackageId}::expiry_market::mint_exact_quantity`,
    arguments: [
      tx.object(args.marketId),
      tx.object(args.wrapperId),
      auth,
      tx.object(DEEPBOOK.protocolConfigId),
      pricer,
      tx.pure.u64(lowerTick),
      tx.pure.u64(higherTick),
      tx.pure.u64(args.quantity),
      tx.pure.u64(LEVERAGE_1X), // leverage: 1x
      tx.pure.u64(U64_MAX), // max_cost: uncapped
      tx.pure.u64(U64_MAX), // max_probability: uncapped
      tx.object(DEEPBOOK.accumulatorRootId),
      tx.object(CONFIG.CLOCK_ID),
    ],
  })

  // 4. Record the swipe in the Flicky duel, chaining the mint's order id.
  //    Clock is auto-injected by the codegen; we pass the leading 5 args.
  tx.add(
    duel.recordSwipe({
      package: CONFIG.packageId,
      arguments: [
        args.duelId,
        tx.pure.u64(args.cardIdx),
        tx.pure.bool(args.isUp),
        tx.pure.u64(args.quantity),
        order,
      ],
      typeArguments: [args.stakeCoinType],
    })
  )

  return tx
}

/**
 * One-time account onboarding: create the player's deterministic AccountWrapper
 * and share it. Funding is a separate step (`buildDepositDusdcTx`).
 */
export function buildCreateAccountTx(): Transaction {
  const tx = new Transaction()
  const wrapper = tx.moveCall({
    target: `${DEEPBOOK.accountPackageId}::account_registry::new`,
    arguments: [tx.object(DEEPBOOK.accountRegistryId)],
  })
  tx.moveCall({
    target: `${DEEPBOOK.accountPackageId}::account::share`,
    arguments: [wrapper],
  })
  return tx
}

/**
 * Deposit dUSDC from the player's wallet into their AccountWrapper. The dUSDC
 * coin is sourced from the player's owned coins via `coinWithBalance`.
 */
export function buildDepositDusdcTx(
  wrapperId: string,
  amount: bigint
): Transaction {
  const tx = new Transaction()
  const auth = tx.moveCall({
    target: `${DEEPBOOK.accountPackageId}::account::generate_auth`,
  })
  const coin = tx.add(
    coinWithBalance({ balance: amount, type: DEEPBOOK.dusdcType })
  )
  tx.moveCall({
    target: `${DEEPBOOK.accountPackageId}::account::deposit_funds`,
    typeArguments: [DEEPBOOK.dusdcType],
    arguments: [
      tx.object(wrapperId),
      auth,
      coin,
      tx.object(DEEPBOOK.accumulatorRootId),
      tx.object(CONFIG.CLOCK_ID),
    ],
  })
  return tx
}

/**
 * Withdraw dUSDC from the player's AccountWrapper back to their wallet.
 * `withdraw_funds<T>(wrapper, auth, amount, root, clock, ctx)` RETURNS the coin
 * (it is not auto-transferred), so the PTB transfers it to `recipient`.
 */
export function buildWithdrawDusdcTx(
  wrapperId: string,
  amount: bigint,
  recipient: string
): Transaction {
  const tx = new Transaction()
  const auth = tx.moveCall({
    target: `${DEEPBOOK.accountPackageId}::account::generate_auth`,
  })
  const coin = tx.moveCall({
    target: `${DEEPBOOK.accountPackageId}::account::withdraw_funds`,
    typeArguments: [DEEPBOOK.dusdcType],
    arguments: [
      tx.object(wrapperId),
      auth,
      tx.pure.u64(amount),
      tx.object(DEEPBOOK.accumulatorRootId),
      tx.object(CONFIG.CLOCK_ID),
    ],
  })
  tx.transferObjects([coin], tx.pure.address(recipient))
  return tx
}

// === Helpers ===

export function fmtDusdc(microUnits: bigint): string {
  return `${(Number(microUnits) / 1e6).toFixed(4)} dUSDC`
}
