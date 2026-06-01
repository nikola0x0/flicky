/**
 * AI Deckmaster — generates the 5-card binary-digital deck for each duel.
 *
 * PRD model (locked):
 *   - Each duel deck = 5 cards, each pinned to a DIFFERENT DeepBook
 *     Predict OracleSVI. The chosen 5 oracles are the nearest resolutions
 *     strictly later than `now + 10 min`, sorted by expiry ascending.
 *   - For each chosen oracle, we read its forward price and pick a strike
 *     offset (placeholder difficulty model: ±2%, ±5%, ATM — upgrade to an
 *     SVI-informed 2/2/1 split later; the commit-reveal scaffolding does
 *     not care which strikes get committed, only that the hash matches).
 *
 * On-chain commit-reveal:
 *   - `buildDeck` returns `{ cards, hash }` where hash = sha2-256 of the
 *     BCS-serialized card vector that flicky::duel::reveal_deck expects.
 *   - The plaintext is persisted to `.data/decks.json` so a server
 *     restart doesn't strand pending duels. The keeper or the player's
 *     tab calls `reveal_deck` after `join_duel` lands; we just serve the
 *     plaintext on demand.
 */
import { bcs } from "@mysten/sui/bcs"
import { Transaction } from "@mysten/sui/transactions"
import { normalizeSuiAddress, normalizeSuiObjectId } from "@mysten/sui/utils"
import type { SuiClient } from "@mysten/sui/client"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { env } from "./env"
import { makeLogger } from "./log"

const log = makeLogger("deckmaster")

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DeckCard {
  oracle_id: string
  strike: bigint
}

export interface GeneratedDeck {
  cards: DeckCard[]
  hash: Uint8Array
  hashHex: string
}

export interface OracleSnapshot {
  id: string
  expiry: bigint
  spot: bigint
  forward: bigint
  /**
   * Strike grid parameters from `OracleCreated`. The chain validates
   * `strike % tick_size == 0 && strike >= min_strike` inside
   * `oracle_config::assert_valid_strike` (abort code 2) — we must snap
   * raw price-derived strikes to this grid before committing them.
   */
  minStrike: bigint
  tickSize: bigint
}

/**
 * Snap a raw strike to the oracle's grid: `min_strike + n × tick_size`,
 * clamped at `min_strike`. Matches `oracle_config::assert_valid_strike`.
 */
export function snapToTick(
  strike: bigint,
  minStrike: bigint,
  tickSize: bigint,
): bigint {
  if (tickSize <= 0n) return strike
  if (strike < minStrike) return minStrike
  return minStrike + ((strike - minStrike) / tickSize) * tickSize
}

// ─── BCS shape that matches flicky::duel::Card on chain ─────────────────────

const CardBcs = bcs.struct("Card", {
  oracle_id: bcs.Address,
  strike: bcs.u64(),
})
const DeckBcs = bcs.vector(CardBcs)

// ─── Oracle discovery ───────────────────────────────────────────────────────

/**
 * Default strike grid for BTC oracles, used as a fallback when an oracle's
 * `OracleCreated` event is too deep in history to find cheaply. Matches the
 * observed testnet config (min_strike $50k, tick $1, both in 1e9 fixed).
 * A wrong guess only costs amplitude — `probeCard` rejects off-grid strikes
 * and the picker falls to the next candidate, never producing an invalid
 * deck.
 */
const DEFAULT_BTC_GRID = { minStrike: 50_000_000_000_000n, tickSize: 1_000_000_000n }

/**
 * Grid-param cache keyed by oracle id. `OracleCreated` events are immutable
 * and the grid never changes, so once resolved we never re-scan for it.
 */
const gridCache = new Map<string, { minStrike: bigint; tickSize: bigint }>()

/**
 * Resolve `(min_strike, tick_size)` for each id in `wanted` by scanning
 * `registry::OracleCreated` events. Long-dated oracles' creation events sit
 * thousands deep, so we paginate up to `maxPages` and stop as soon as every
 * wanted id is resolved. Cached across calls. Ids still unresolved after the
 * scan fall back to `DEFAULT_BTC_GRID` at the call site.
 */
async function resolveGrids(
  client: SuiClient,
  pkg: string,
  wanted: Set<string>,
  maxPages = 8,
): Promise<void> {
  const missing = new Set([...wanted].filter((id) => !gridCache.has(id)))
  if (missing.size === 0) return
  let cursor: { txDigest: string; eventSeq: string } | null | undefined = null
  for (let page = 0; page < maxPages && missing.size > 0; page++) {
    const r = await client.queryEvents({
      query: { MoveEventType: `${pkg}::registry::OracleCreated` },
      cursor,
      limit: 50,
      order: "descending",
    })
    for (const e of r.data) {
      const p = e.parsedJson as {
        oracle_id: string
        min_strike?: string
        tick_size?: string
      }
      const id = normalizeSuiObjectId(p.oracle_id)
      if (!gridCache.has(id)) {
        gridCache.set(id, {
          minStrike: BigInt(p.min_strike ?? DEFAULT_BTC_GRID.minStrike.toString()),
          tickSize: BigInt(p.tick_size ?? DEFAULT_BTC_GRID.tickSize.toString()),
        })
      }
      missing.delete(id)
    }
    if (!r.hasNextPage) break
    cursor = r.nextCursor
  }
}

/**
 * Fetch the `count` nearest live BTC OracleSVI objects whose expiry is
 * strictly more than `now + DECK_CARD_MIN_HEADROOM_MS` (default 10 min).
 *
 * Discovery is via `oracle::OraclePricesUpdated` events, NOT
 * `registry::OracleCreated`. The price-tick cron touches exactly the set
 * of currently-live oracles every second, so the most recent price-tick
 * events reveal every active oracle — including long-dated ones whose
 * creation event is buried thousands deep in history. (The old
 * creation-event scan with `limit: 30` structurally missed those, which is
 * why a deck of 7/14/21-day oracles read as "0 live".)
 *
 * Strategy:
 *   1. Collect oracle ids from recent `OraclePricesUpdated` events.
 *   2. `getObject` each, filter by (active && !settled && asset && expiry
 *      > now + headroom).
 *   3. Resolve strike grid via a bounded `OracleCreated` scan (cached),
 *      falling back to `DEFAULT_BTC_GRID` when unfindable.
 *   4. Sort by expiry ascending, take `count`.
 *
 * Returns fewer than `count` (possibly empty) if not enough live oracles
 * exist; callers decide whether to retry or surface a 503.
 */
/** Normalized, chain-agnostic view of a candidate oracle — the input to
 *  `selectDeckOracleRows`. Decoupling selection from RPC shapes keeps the
 *  filter/sort logic pure and unit-testable. */
export interface OracleRow {
  id: string
  expiry: bigint
  spot: bigint
  forward: bigint
  active: boolean
  settled: boolean
  /** `undefined` when the object didn't expose `underlying_asset`. */
  asset?: string
}

/**
 * Filter candidate oracles to those eligible for a deck, ordered
 * soonest-settling first, capped at `cap`.
 *
 * Eligible = active && !settled && matching asset && non-zero spot/forward
 * && `now + headroom < expiry ≤ now + maxHorizon`. The upper bound keeps
 * the game settling fast (a duel finalizes only once its latest card's
 * oracle settles); soonest-first ordering means a smaller deck always uses
 * the fastest oracles.
 */
export function selectDeckOracleRows(
  rows: OracleRow[],
  opts: {
    nowMs: number
    headroomMs: number
    maxHorizonMs: number
    asset: string
    cap: number
  },
): OracleRow[] {
  const minExpiry = BigInt(opts.nowMs) + BigInt(opts.headroomMs)
  const maxExpiry = BigInt(opts.nowMs) + BigInt(opts.maxHorizonMs)
  const live = rows.filter(
    (r) =>
      r.active &&
      !r.settled &&
      (r.asset === undefined || r.asset === opts.asset) &&
      r.spot !== 0n &&
      r.forward !== 0n &&
      r.expiry > minExpiry &&
      r.expiry <= maxExpiry,
  )
  live.sort((a, b) => (a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1 : 0))
  return live.slice(0, opts.cap)
}

export async function findDeckOracles(
  client: SuiClient,
  asset = "BTC",
  count = 5,
  maxHorizonMs = env.deckCardMaxHorizonMs,
): Promise<OracleSnapshot[]> {
  const pkg = env.deepbookPredictPackageId
  const now = Date.now()

  // 1. Recent price-tick events → live oracle id set. One tick tx updates
  //    the whole live set, so ~100 events covers many ticks' worth of ids.
  const ticks = await client.queryEvents({
    query: { MoveEventType: `${pkg}::oracle::OraclePricesUpdated` },
    limit: 100,
    order: "descending",
  })
  const candidateIds = new Set<string>()
  for (const e of ticks.data) {
    const p = e.parsedJson as { oracle_id?: string }
    if (p.oracle_id) candidateIds.add(normalizeSuiObjectId(p.oracle_id))
  }
  if (candidateIds.size === 0) return []

  // 2. Resolve each candidate object into a normalized row.
  const objs = await client.multiGetObjects({
    ids: [...candidateIds],
    options: { showContent: true },
  })
  const rows: OracleRow[] = []
  for (const obj of objs) {
    if (obj.data?.content?.dataType !== "moveObject") continue
    const f = obj.data.content.fields as {
      active: boolean
      expiry: string
      settlement_price: unknown
      underlying_asset?: string
      prices: { fields: { spot: string; forward: string } }
    }
    rows.push({
      id: normalizeSuiObjectId(obj.data.objectId),
      expiry: BigInt(f.expiry),
      spot: BigInt(f.prices.fields.spot),
      forward: BigInt(f.prices.fields.forward),
      active: f.active,
      settled: isSettlementSet(f.settlement_price),
      asset: f.underlying_asset,
    })
  }

  // 3. Filter (asset, live, headroom < expiry ≤ horizon), sort soonest-first,
  //    take the nearest `count`, then resolve grids only for those.
  const chosen = selectDeckOracleRows(rows, {
    nowMs: now,
    headroomMs: env.deckCardMinHeadroomMs,
    maxHorizonMs,
    asset,
    cap: count,
  })
  if (chosen.length === 0) return []
  await resolveGrids(client, pkg, new Set(chosen.map((o) => o.id)))

  return chosen.map((o) => {
    const grid = gridCache.get(o.id) ?? DEFAULT_BTC_GRID
    return {
      id: o.id,
      expiry: o.expiry,
      spot: o.spot,
      forward: o.forward,
      minStrike: grid.minStrike,
      tickSize: grid.tickSize,
    }
  })
}

function isSettlementSet(v: unknown): boolean {
  if (v === null || v === undefined) return false
  if (typeof v === "string") return true
  if (typeof v === "object") {
    const vec = (v as { fields?: { vec?: unknown[] } }).fields?.vec
    return Array.isArray(vec) && vec.length > 0
  }
  return false
}

// ─── Deck construction (seeded PRG + 2/2/1 difficulty mix) ──────────────────
//
// PRD §AI Deckmaster: "the generator chooses strike + side per card to
// balance difficulty (mix of close-to-money hard calls and deep-OTM
// gimmes/traps)." We implement this as a fixed 2/2/1 allocation across
// three difficulty buckets — strike-offset relative to the oracle's
// forward is the proxy for difficulty (close ≈ ~50% implied → coin
// flip → hardest, far OTM ≈ ~5-15% implied → near-gimme).
//
// Buckets are PRG-ordered across the 5 oracles, and PRG also picks
// which pct inside each bucket. The seed is deterministic — anyone
// with `seed` can recompute the exact deck.

/**
 * Difficulty buckets — strike pct of forward.
 *
 * These are *target* offsets only. The on-chain pricing engine
 * (`pricing_config::quote_spread_from_fair_price`) requires the binary
 * fair-price to satisfy `0 < p < 1.0` in 1e9 fixed point; for low-vol
 * short-dated oracles even a 3% offset can round p to a bound and
 * abort the mint. Each generated card is dev_inspect-probed (see
 * `probeCard`) and silently degraded to ATM (100%) if the chosen
 * offset would abort. That way we get variety when SVI cooperates
 * and a safe ATM card when it doesn't.
 */
const STRIKE_BUCKETS = {
  /** Hard calls — close-to-money. */
  close: [99n, 100n, 101n] as const,
  /** Mid-difficulty — moderate offset. */
  mid: [97n, 98n, 102n, 103n] as const,
  /** Easy / gimmes / traps — wider OTM. */
  otm: [94n, 95n, 105n, 106n] as const,
} as const

type Difficulty = keyof typeof STRIKE_BUCKETS

/**
 * 2 close + 2 mid + 1 otm per deck. The order across the 5 oracles is
 * PRG-shuffled so card index N isn't always the same difficulty.
 */
const DIFFICULTY_ALLOCATION: readonly Difficulty[] = [
  "close",
  "close",
  "mid",
  "mid",
  "otm",
] as const

/** Stable seed derivation — 32 bytes from sha256(sender || asset || tier || timestamp || nonce). */
export function deriveSeed(input: {
  sender?: string
  asset: string
  tier?: string
  timestampMs: number
  nonceHex?: string
}): Uint8Array {
  const h = createHash("sha256")
  if (input.sender) h.update(input.sender)
  h.update("|")
  h.update(input.asset)
  h.update("|")
  if (input.tier) h.update(input.tier)
  h.update("|")
  h.update(String(input.timestampMs))
  h.update("|")
  if (input.nonceHex) h.update(input.nonceHex)
  return new Uint8Array(h.digest())
}

/**
 * Tiny seeded PRG — sha256 in counter mode. Deterministic given the seed
 * so anyone with `seed` can recompute the exact strike sequence. Not a
 * CSPRNG for unbounded streams, but sufficient for picking 5 ints from
 * small pools.
 */
function* prgStream(seed: Uint8Array): Generator<number, never> {
  let counter = 0
  while (true) {
    const h = createHash("sha256")
    h.update(seed)
    h.update(Buffer.from(String(counter)))
    const out = h.digest()
    for (let i = 0; i < out.length; i++) yield out[i]
    counter++
  }
}

/** Fisher-Yates shuffle of `arr` using bytes from `stream`. Pure, returns new array. */
function shuffle<T>(arr: readonly T[], stream: Generator<number, never>): T[] {
  const out = arr.slice()
  for (let i = out.length - 1; i > 0; i--) {
    // Reject-sample to avoid modulo bias.
    const cap = 256 - (256 % (i + 1))
    let j: number
    for (;;) {
      const b = stream.next().value
      if (b < cap) {
        j = b % (i + 1)
        break
      }
    }
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/** Pick one element from `pool` via PRG (reject-sample). */
function pickFromPool<T>(pool: readonly T[], stream: Generator<number, never>): T {
  const cap = 256 - (256 % pool.length)
  for (;;) {
    const b = stream.next().value
    if (b < cap) return pool[b % pool.length]
  }
}

/** Decode an 8-byte little-endian u64 buffer to bigint. */
function readU64LE(bytes: number[]): bigint {
  let v = 0n
  for (let i = 0; i < 8; i++) {
    v |= BigInt(bytes[i] ?? 0) << BigInt(i * 8)
  }
  return v
}

/**
 * dev_inspect a candidate (oracle, strike, direction) tuple. Returns
 * `true` only if the inspect succeeds AND the resulting ask lies in
 * the protocol's ask bounds for BOTH UP and DOWN — that's everything
 * the actual `predict::mint` checks before it touches the manager.
 *
 * Catches two distinct aborts the player would otherwise hit:
 *   - `pricing_config::quote_spread_from_fair_price` code 1
 *     `EFairPriceAlreadySettled` — fair_price rounds to 0 or 1e9.
 *     Surfaces as a non-success status from dev_inspect because
 *     `get_trade_amounts` calls `trade_prices` which calls quote_spread.
 *   - `predict::assert_mintable_ask` code 7 `EAskPriceOutOfBounds` —
 *     ask < min_ask (1%) or > max_ask (99%). `get_trade_amounts`
 *     happily returns the bad ask without checking bounds, so we
 *     call `ask_bounds` in the same tx and compare manually.
 *
 * Quantity is fixed at FLOAT_SCALING (1e9) so `math::mul(ask, qty)`
 * returns the raw ask price directly.
 */
export async function probeCard(
  client: SuiClient,
  oracle: OracleSnapshot,
  strike: bigint,
): Promise<boolean> {
  const pkg = env.deepbookPredictPackageId
  const FLOAT_SCALING = 1_000_000_000n
  for (const dir of ["up", "down"] as const) {
    const tx = new Transaction()
    const mk = tx.moveCall({
      target: `${pkg}::market_key::${dir}`,
      arguments: [
        tx.pure.id(oracle.id),
        tx.pure.u64(oracle.expiry),
        tx.pure.u64(strike),
      ],
    })
    // Command 1: (ask, bid) at quantity=FLOAT_SCALING → raw prices.
    tx.moveCall({
      target: `${pkg}::predict::get_trade_amounts`,
      arguments: [
        tx.object(env.deepbookPredictObjectId),
        tx.object(oracle.id),
        mk,
        tx.pure.u64(FLOAT_SCALING),
        tx.object("0x6"),
      ],
    })
    // Command 2: (min_ask, max_ask) for this oracle.
    tx.moveCall({
      target: `${pkg}::predict::ask_bounds`,
      arguments: [
        tx.object(env.deepbookPredictObjectId),
        tx.pure.id(oracle.id),
      ],
    })
    // A thrown error here is transient (network blip / RPC rate-limit), NOT
    // a signal that the strike is invalid — so retry with backoff before
    // giving up. Only a *clean* dev_inspect response that reports a
    // non-success status or an out-of-bounds ask means the strike is
    // genuinely unmintable. Conflating the two (the old `catch → false`)
    // made throttled probes look like dead oracles.
    let r:
      | Awaited<ReturnType<typeof client.devInspectTransactionBlock>>
      | undefined
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        r = await client.devInspectTransactionBlock({
          transactionBlock: tx,
          // dev_inspect is read-only; sender just needs to be a
          // syntactically valid address.
          sender:
            "0x0000000000000000000000000000000000000000000000000000000000000001",
        })
        break
      } catch {
        if (attempt === 3) return false
        await new Promise((res) => setTimeout(res, 200 * (attempt + 1)))
      }
    }
    if (!r) return false
    if (r.effects.status.status !== "success") return false
    // results[0] is the market_key call (no public return), results[1] is
    // get_trade_amounts returning (ask_qty, bid_qty), results[2] is
    // ask_bounds returning (min, max). returnValues entry shape:
    // [ [bytes[], "u64"], ... ]
    const trade = r.results?.[1]?.returnValues
    const bounds = r.results?.[2]?.returnValues
    if (!trade || !bounds || trade.length < 1 || bounds.length < 2) {
      return false
    }
    const ask = readU64LE(trade[0][0])
    const minAsk = readU64LE(bounds[0][0])
    const maxAsk = readU64LE(bounds[1][0])
    if (ask < minAsk || ask > maxAsk) return false
  }
  return true
}

/**
 * Candidate strike offsets from the oracle's forward price, in basis points
 * (1/100 of a percent). Listed from MOST aggressive to LEAST, then mirrored
 * to cover both sides of the forward; `pickMaxAmplitudeStrike` walks these
 * in descending |bps| order and picks the first one that passes
 * `probeCard`.
 *
 * The goal is to maximise the game's score variance: a strike far from
 * forward gives an implied probability close to 0 or 1, so a correct UP/
 * DOWN call there pays roughly `quantity` against a tiny `premium` — the
 * payout asymmetry that makes the game fun. ATM (offset 0) is the safe
 * fallback that always works but pays close to 50/50, which is boring.
 *
 * The on-chain pricing engine
 * (`pricing_config::quote_spread_from_fair_price` and
 * `predict::assert_mintable_ask`) rejects strikes whose fair price rounds
 * to 0/1 or whose ask falls outside `[min_ask, max_ask]` (1%/99%). On
 * low-vol short-dated oracles even ±5% fails — that's why the previous
 * fixed `STRIKE_BUCKETS = [±1%, ±2%, ±3%, ±5%, ±6%]` deck regularly fell
 * back to ATM. Probing the whole spectrum lets each card land on the
 * widest still-viable offset for THAT oracle.
 */
const OFFSET_CANDIDATES_BPS: readonly number[] = [
  2000, 1500, 1200, 1000, 800, 600, 500, 400, 300, 200, 100, 50,
] as const

/**
 * Probe function shape — `(oracle, strike) → viable?`. Defaults to the
 * real `probeCard` against a `SuiClient`; tests inject a synthetic
 * function so the algorithm can be exercised without RPC.
 */
export type ProbeFn = (oracle: OracleSnapshot, strike: bigint) => Promise<boolean>

/**
 * Bounded-concurrency wrapper. `buildAndProbeDeck` fans out
 * `deck_size × |OFFSET_CANDIDATES_BPS|` (~125 for a 5-card deck) probe
 * calls; public testnet RPC rate-limits a burst that large and the
 * resulting errors make `probeCard` return `false` for *every* candidate
 * — which looks like "oracle has no viable strike" even though each probe
 * passes when run alone. Routing all probes through a shared limiter caps
 * in-flight `dev_inspect` calls so none get throttled.
 */
function createLimiter(max: number): <T>(thunk: () => Promise<T>) => Promise<T> {
  let active = 0
  const queue: Array<() => void> = []
  const next = () => {
    active--
    const run = queue.shift()
    if (run) run()
  }
  return <T>(thunk: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const run = () => {
        active++
        thunk().then(resolve, reject).finally(next)
      }
      if (active < max) run()
      else queue.push(run)
    })
}

/** Max concurrent `dev_inspect` probes against the RPC. Kept low — public
 *  testnet fullnodes throttle aggressively, and `probeCard` already retries
 *  transient failures, so a small pool is both safer and barely slower
 *  (each pick early-exits on its first viable, most-aggressive candidate). */
const PROBE_CONCURRENCY = 4

/**
 * Sign bias for `pickMaxAmplitudeStrike`:
 *   * `+1` — only probe strikes ABOVE forward (DOWN-favoring market —
 *           settlement likely below strike, UP swipe is the risky high-
 *           reward play, DOWN is the safe-but-expensive play).
 *   * `-1` — only probe strikes BELOW forward (UP-favoring market —
 *           swipe UP is the safe play, DOWN is the long-shot).
 *   * `undefined` — probe both signs (legacy / single-card use).
 *
 * Used by `buildAndProbeDeck` to force a balanced sign distribution
 * across the whole deck so a single duel never ships as all-UP-favoring
 * (boring: same swipe pattern wins everything).
 */
export type SignBias = -1 | 1

/**
 * For one oracle, find the strike that maximises `|strike - forward|`
 * while still passing `probe` (which exercises both UP and DOWN
 * `predict::mint`-like preconditions). Probes all candidates from
 * `OFFSET_CANDIDATES_BPS` in parallel — dev_inspect is read-only, so the
 * fan-out is cheap and we get the answer in one round-trip's worth of
 * latency instead of K. Returns `null` if not even ATM is viable; caller
 * treats that as a hard oracle failure.
 *
 * `signBias` restricts which side of `forward` the strike lands on:
 *   * `+1` → strike > forward; `-1` → strike < forward; `undefined` →
 *     PRG decides at each aggressiveness level.
 *
 * `prgStream` is consumed only when `signBias` is undefined — to
 * randomise UP-side vs DOWN-side at each tier. When `signBias` is fixed
 * the algorithm is deterministic for that oracle (still descends by
 * `|bps|` so the most aggressive viable wins).
 */
export async function pickMaxAmplitudeStrike(
  oracle: OracleSnapshot,
  prgStream: Generator<number, never>,
  probe: ProbeFn,
  signBias?: SignBias,
): Promise<{ strike: bigint; bps: number } | null> {
  // Build candidate list ordered by descending |bps|.
  //   * `signBias` set     → only that sign, monotone descending.
  //   * `signBias` unset   → both signs interleaved at each |bps| tier,
  //                          PRG-shuffled (legacy behavior).
  const ordered: number[] = []
  if (signBias !== undefined) {
    for (const absBps of OFFSET_CANDIDATES_BPS) {
      ordered.push(signBias * absBps)
    }
  } else {
    for (const absBps of OFFSET_CANDIDATES_BPS) {
      const shuffled = shuffle([-absBps, +absBps], prgStream)
      ordered.push(...shuffled)
    }
  }
  ordered.push(0) // ATM as last-resort safety net.

  // Probe everything in parallel. Each candidate gets its snapped strike +
  // probe result; nulls are unsuitable. Walking the ordered list afterwards
  // and returning the first non-null entry preserves the descending-|bps|
  // priority while letting the network round-trips overlap.
  const probes = await Promise.all(
    ordered.map(async (bps) => {
      const raw = oracle.forward + (oracle.forward * BigInt(bps)) / 10_000n
      if (raw <= 0n) return null
      const strike = snapToTick(raw, oracle.minStrike, oracle.tickSize)
      const ok = await probe(oracle, strike)
      return ok ? { strike, bps } : null
    }),
  )
  for (const p of probes) {
    if (p) return p
  }
  return null
}

/**
 * Allocate sign bias across `deckSize` cards so a deck is never
 * skewed all to one side:
 *   * Even N → exactly N/2 UP-favoring + N/2 DOWN-favoring.
 *   * Odd  N → (N+1)/2 of one sign + (N-1)/2 of the other; PRG picks
 *              which sign gets the extra card.
 * Card order PRG-shuffled so the "side" sequence varies per duel.
 *
 * ATM (bps=0) intentionally excluded — every card is forced aggressive.
 * Per-card amplitude still floors to ATM if `pickMaxAmplitudeStrike`'s
 * sign-constrained probe finds nothing else viable; that's a per-oracle
 * fallback, not a deck-level design choice.
 */
export function allocateSignBalance(
  deckSize: number,
  prgStream: Generator<number, never>,
): SignBias[] {
  if (deckSize <= 0) return []
  const half = Math.floor(deckSize / 2)
  const extra = deckSize - 2 * half // 0 (even) or 1 (odd)
  // Coin-flip from PRG: high half of byte = +1 extra, low half = -1 extra.
  const upCount = extra ? half + (prgStream.next().value < 128 ? 1 : 0) : half
  const downCount = deckSize - upCount
  const out: SignBias[] = []
  for (let i = 0; i < upCount; i++) out.push(+1)
  for (let i = 0; i < downCount; i++) out.push(-1)
  return shuffle(out, prgStream)
}

/**
 * Generate a deck of `oracles.length` cards (one card per oracle). For
 * each card, picks the most aggressive viable strike via
 * `pickMaxAmplitudeStrike` — no fixed difficulty buckets, no silent ATM
 * fallback unless the oracle's SVI literally rejects every offset.
 *
 * Why we don't go through `buildDeckFromOracles` anymore: the old path
 * picked from a narrow ±1%–±6% bucket which the on-chain pricing
 * frequently rejected on short-dated low-vol oracles, then quietly
 * collapsed to ATM. Players got a 5-card deck that was effectively all
 * coin-flips with no payout variance. The new path probes ±0.5%–±20%
 * and picks whichever passes, so amplitude scales with each oracle's
 * actual liquidity.
 *
 * Deck-level shape: signs are pre-allocated balanced (`allocateSignBalance`)
 * so a 5-card deck always carries a mix of UP-favoring + DOWN-favoring
 * strikes — players have to read the market both ways, not just swipe
 * one direction.
 */
export async function buildAndProbeDeck(
  client: SuiClient,
  oracles: OracleSnapshot[],
  seed: Uint8Array,
  /** Override the per-strike probe — defaults to the real `probeCard`
   *  against the supplied `client`. Tests inject a synthetic function to
   *  exercise the descend-by-aggressiveness algorithm without RPC. */
  probeOverride?: ProbeFn,
): Promise<GeneratedDeck> {
  if (oracles.length === 0) {
    throw new Error("buildAndProbeDeck: at least one oracle required")
  }
  // Route every probe through a shared limiter so the deck-wide fan-out
  // (~deck_size × candidates concurrent dev_inspects) doesn't trip RPC
  // rate limits. Synthetic test probes are instant, so the limiter is a
  // no-op overhead there.
  const limit = createLimiter(PROBE_CONCURRENCY)
  const rawProbe: ProbeFn =
    probeOverride ?? ((o, strike) => probeCard(client, o, strike))
  const probe: ProbeFn = (o, strike) => limit(() => rawProbe(o, strike))
  // Burn deterministic per-card sub-seeds off the main stream first so the
  // parallel `Promise.all` below doesn't race against a shared PRG.
  const stream = prgStream(seed)
  const signs = allocateSignBalance(oracles.length, stream)
  const subSeeds: Uint8Array[] = []
  for (let i = 0; i < oracles.length; i++) {
    const sub = new Uint8Array(32)
    for (let k = 0; k < 32; k++) sub[k] = stream.next().value
    subSeeds.push(sub)
  }
  const fixedCards: DeckCard[] = await Promise.all(
    oracles.map(async (o, i) => {
      const subStream = prgStream(subSeeds[i])
      const pick = await pickMaxAmplitudeStrike(o, subStream, probe, signs[i])
      if (pick === null) {
        throw new Error(
          `oracle ${o.id} has no viable strike (pricing config may be unset)`,
        )
      }
      log.info(
        `card ${i}: ${o.id.slice(0, 12)}… forward=${o.forward} → strike=${pick.strike} (offset ${pick.bps} bps, side=${signs[i] > 0 ? "DOWN-fav" : "UP-fav"})`,
      )
      return {
        oracle_id: normalizeSuiAddress(o.id),
        strike: pick.strike,
      }
    }),
  )
  const bytes = DeckBcs.serialize(
    fixedCards.map((c) => ({
      oracle_id: c.oracle_id,
      strike: c.strike.toString(),
    })),
  ).toBytes()
  const hash = new Uint8Array(createHash("sha256").update(bytes).digest())
  return { cards: fixedCards, hash, hashHex: hashToHex(hash) }
}

export function buildDeckFromOracles(
  oracles: OracleSnapshot[],
  seed: Uint8Array,
): GeneratedDeck {
  if (oracles.length < 5) {
    throw new Error(
      `need 5 oracles, got ${oracles.length}; widen the window or wait for the next 15-min cron`,
    )
  }
  const stream = prgStream(seed)
  // Step 1: shuffle the 2/2/1 difficulty allocation across the 5 oracles.
  const difficulties = shuffle(DIFFICULTY_ALLOCATION, stream)
  // Step 2: for each oracle, draw a pct from the chosen bucket, then
  // snap the raw strike to the oracle's (min_strike, tick_size) grid.
  // The chain enforces strike % tick_size == 0 inside
  // oracle_config::assert_valid_strike (abort code 2) — unaligned
  // strikes will fail at predict::mint resolution.
  const cards: DeckCard[] = oracles.slice(0, 5).map((o, i) => {
    const bucket = STRIKE_BUCKETS[difficulties[i]]
    const pct = pickFromPool(bucket, stream)
    const raw = (o.forward * pct) / 100n
    return {
      oracle_id: normalizeSuiAddress(o.id),
      strike: snapToTick(raw, o.minStrike, o.tickSize),
    }
  })
  const bytes = DeckBcs.serialize(
    cards.map((c) => ({ oracle_id: c.oracle_id, strike: c.strike.toString() })),
  ).toBytes()
  const hash = new Uint8Array(createHash("sha256").update(bytes).digest())
  return { cards, hash, hashHex: hashToHex(hash) }
}

/**
 * Returns the strike pct (relative to forward) for `strike`. Useful for
 * tests + debug ("which bucket did this strike come from").
 */
export function strikePctOf(forward: bigint, strike: bigint): bigint {
  return (strike * 100n) / forward
}

/** Returns which difficulty bucket a pct falls into, or null if out-of-range. */
export function difficultyOfPct(pct: bigint): Difficulty | null {
  if ((STRIKE_BUCKETS.close as readonly bigint[]).includes(pct)) return "close"
  if ((STRIKE_BUCKETS.mid as readonly bigint[]).includes(pct)) return "mid"
  if ((STRIKE_BUCKETS.otm as readonly bigint[]).includes(pct)) return "otm"
  return null
}

export function hashToHex(hash: Uint8Array): string {
  return (
    "0x" +
    Array.from(hash)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  )
}

// ─── Plaintext persistence ──────────────────────────────────────────────────
//
// Each entry stores the cards plus the seed used to derive their strikes.
// `seed` is optional for backwards-compat with stores from before the
// deterministic-seed change (those decks were generated from the fixed
// STRIKE_PCTS array and have no seed).

interface StoreEntry {
  cards: DeckCard[]
  seedHex?: string
}

const store: Map<string, StoreEntry> = loadStore()

function loadStore(): Map<string, StoreEntry> {
  const path = env.deckmasterStorePath
  if (!existsSync(path)) return new Map()
  try {
    const raw = readFileSync(path, "utf-8")
    const obj = JSON.parse(raw) as Record<
      string,
      | Array<{ oracle_id: string; strike: string }>
      | { cards: Array<{ oracle_id: string; strike: string }>; seedHex?: string }
    >
    const m = new Map<string, StoreEntry>()
    for (const [hex, entry] of Object.entries(obj)) {
      // Legacy: bare cards array. New: { cards, seedHex }.
      const cardsRaw = Array.isArray(entry) ? entry : entry.cards
      const seedHex = Array.isArray(entry) ? undefined : entry.seedHex
      m.set(hex.toLowerCase(), {
        cards: cardsRaw.map((c) => ({
          oracle_id: c.oracle_id,
          strike: BigInt(c.strike),
        })),
        seedHex,
      })
    }
    return m
  } catch (e) {
    log.warn(
      `failed to load ${path}: ${e instanceof Error ? e.message : String(e)}`,
    )
    return new Map()
  }
}

function persistStore(): void {
  const obj: Record<string, { cards: Array<{ oracle_id: string; strike: string }>; seedHex?: string }> = {}
  for (const [hex, entry] of store.entries()) {
    obj[hex] = {
      cards: entry.cards.map((c) => ({
        oracle_id: c.oracle_id,
        strike: c.strike.toString(),
      })),
      seedHex: entry.seedHex,
    }
  }
  try {
    mkdirSync(dirname(env.deckmasterStorePath), { recursive: true })
    writeFileSync(env.deckmasterStorePath, JSON.stringify(obj, null, 2), "utf-8")
  } catch (e) {
    log.warn(
      `failed to persist ${env.deckmasterStorePath}: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
}

export function rememberDeck(
  hash: Uint8Array,
  cards: DeckCard[],
  seed?: Uint8Array,
): string {
  const hex = hashToHex(hash)
  store.set(hex, { cards, seedHex: seed ? hashToHex(seed) : undefined })
  persistStore()
  return hex
}

export function fetchDeck(hashHex: string): DeckCard[] | undefined {
  return store.get(hashHex.toLowerCase())?.cards
}

export function fetchDeckEntry(hashHex: string): StoreEntry | undefined {
  return store.get(hashHex.toLowerCase())
}

export function forgetDeck(hashHex: string): void {
  if (store.delete(hashHex.toLowerCase())) persistStore()
}

export function knownHashCount(): number {
  return store.size
}

// ─── HTTP routes ────────────────────────────────────────────────────────────

import { json } from "./lib/http"
import { getSuiClient } from "./lib/sui"
import { clientIp, consume } from "./ratelimit"

/**
 * Resolve a deck-size band from the request body.
 * - Explicit `deckSize` collapses the band to [n, n] — preserves the old
 *   strict behavior (503 unless exactly n oracles are live).
 * - Otherwise default to [3, 5]. Both bounds are clamped to the contract's
 *   [MIN_DECK_SIZE, MAX_DECK_SIZE] = [1, 20], and `min` is capped at `max`.
 */
export function resolveDeckBounds(body: {
  deckSize?: number
  minDeckSize?: number
  maxDeckSize?: number
}): { min: number; max: number } {
  const clamp = (n: number) => Math.max(1, Math.min(20, Math.floor(n)))
  if (body.deckSize != null) {
    const n = clamp(body.deckSize)
    return { min: n, max: n }
  }
  const max = clamp(body.maxDeckSize ?? 5)
  const min = Math.min(clamp(body.minDeckSize ?? 3), max)
  return { min, max }
}

/**
 * Greedy sizing: build the largest deck supply allows, capped at `max`.
 * `ok` is false when fewer than `min` oracles are live — the only failure
 * case (surfaces as a 503). `deckSize` is meaningful only when `ok`.
 */
export function decideDeckSize(
  liveCount: number,
  bounds: { min: number; max: number },
): { ok: boolean; deckSize: number } {
  return {
    ok: liveCount >= bounds.min,
    deckSize: Math.min(liveCount, bounds.max),
  }
}

export async function handleDeckmasterRequest(
  req: Request,
  url: URL,
): Promise<Response | null> {
  if (url.pathname === "/deckmaster/generate" && req.method === "POST") {
    const gate = consume("deckmaster:generate", clientIp(req, null))
    if (!gate.ok) {
      return json(
        { error: "rate limited", retryMs: gate.retryMs },
        429,
      )
    }
    const body = (await req.json().catch(() => null)) as
      | { asset?: string; sender?: string; tier?: string; deckSize?: number }
      | null
    const asset = body?.asset ?? "BTC"
    const sender = body?.sender
    const tier = body?.tier
    // Deck size is caller-chosen, [1, 20] (matches the contract's
    // MIN/MAX_DECK_SIZE). Each card pins a distinct live oracle, so we need
    // at least `deckSize` eligible oracles. Default 5 for back-compat.
    const deckSize = Math.max(1, Math.min(20, Math.floor(body?.deckSize ?? 5)))
    const client = getSuiClient()
    try {
      const oracles = await findDeckOracles(client, asset, deckSize)
      if (oracles.length < deckSize) {
        return json(
          {
            error: "not enough live oracles",
            detail: `found ${oracles.length} eligible ${asset} oracles >${env.deckCardMinHeadroomMs / 60_000} min out, need ${deckSize}; retry shortly or request a smaller deckSize`,
          },
          503,
        )
      }
      // Derive a deterministic seed for this generation. The seed is
      // saved alongside the plaintext so anyone with (seed, oracle list)
      // can recompute the exact strike sequence and verify the deck
      // wasn't biased by the picker.
      const nonceHex = hashToHex(crypto.getRandomValues(new Uint8Array(16)))
      const seed = deriveSeed({
        sender,
        asset,
        tier,
        timestampMs: Date.now(),
        nonceHex,
      })
      const deck = await buildAndProbeDeck(client, oracles, seed)
      rememberDeck(deck.hash, deck.cards, seed)
      return json({
        cards: deck.cards.map((c, i) => ({
          oracle_id: c.oracle_id,
          strike: c.strike.toString(),
          expiry: oracles[i].expiry.toString(),
        })),
        hash: deck.hashHex,
        seed: hashToHex(seed),
      })
    } catch (e) {
      log.error(`generate failed: ${e instanceof Error ? e.message : String(e)}`)
      return json(
        { error: "deckmaster failed", detail: e instanceof Error ? e.message : String(e) },
        500,
      )
    }
  }

  if (url.pathname === "/deckmaster/reveal" && req.method === "GET") {
    const hash = url.searchParams.get("hash")
    if (!hash) return json({ error: "hash param required" }, 400)
    const entry = fetchDeckEntry(hash)
    if (!entry) return json({ error: "unknown hash" }, 404)
    return json({
      cards: entry.cards.map((c) => ({
        oracle_id: c.oracle_id,
        strike: c.strike.toString(),
      })),
      hash: hash.toLowerCase(),
      seed: entry.seedHex ?? null,
    })
  }

  return null
}
