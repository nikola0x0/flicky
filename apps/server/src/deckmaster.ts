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
 *   - The plaintext is persisted to the Postgres `deck` table (see db.ts)
 *     so a server restart doesn't strand pending duels. The keeper or the
 *     player's tab calls `reveal_deck` after `join_duel` lands; we just
 *     serve the plaintext on demand.
 */
import { bcs } from "@mysten/sui/bcs"
import { Transaction } from "@mysten/sui/transactions"
import { normalizeSuiAddress, normalizeSuiObjectId } from "@mysten/sui/utils"
import type { SuiGrpcClient } from "@mysten/sui/grpc"
import { createHash } from "node:crypto"
import { countDecks, deleteDeck, getDeck, upsertDeck } from "./db"
import { env } from "./env"
import { makeLogger } from "./log"

const log = makeLogger("deckmaster")

// GraphQL event scans (gRPC can't filter events). SCAN_QUERY walks
// newest-first with `before` cursor; RECENT_QUERY grabs the latest N.
const SCAN_QUERY = `query Scan($type: String!, $before: String) {
  events(filter: { type: $type }, last: 50, before: $before) {
    pageInfo { hasPreviousPage startCursor }
    nodes { contents { json } }
  }
}`
const RECENT_QUERY = `query Recent($type: String!, $last: Int!) {
  events(filter: { type: $type }, last: $last) {
    nodes { contents { json } }
  }
}`
type ScanResult = {
  data?: {
    events?: {
      pageInfo?: { hasPreviousPage: boolean; startCursor: string | null }
      nodes?: Array<{ contents: { json: Record<string, unknown> } }>
    }
  }
}
type RecentResult = {
  data?: {
    events?: { nodes?: Array<{ contents: { json: Record<string, unknown> } }> }
  }
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DeckCard {
  oracle_id: string
  strike: bigint
}

export interface GeneratedDeck {
  cards: DeckCard[]
  hash: Uint8Array
  hashHex: string
  /** Per-card UP ask at generation time (1e9 fixed), aligned with `cards`.
   *  Only set by `buildAndProbeDeck`; the legacy `buildDeckFromOracles`
   *  path doesn't probe quotes. */
  quotes?: bigint[]
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
  _client: SuiGrpcClient,
  pkg: string,
  wanted: Set<string>,
  maxPages = 8,
): Promise<void> {
  const missing = new Set([...wanted].filter((id) => !gridCache.has(id)))
  if (missing.size === 0) return
  let before: string | null = null
  for (let page = 0; page < maxPages && missing.size > 0; page++) {
    const r = (await getGraphQLClient().query({
      query: SCAN_QUERY,
      variables: { type: `${pkg}::registry::OracleCreated`, before },
    })) as ScanResult
    const ev = r.data?.events
    for (const node of ev?.nodes ?? []) {
      const p = node.contents.json as {
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
    if (!ev?.pageInfo?.hasPreviousPage) break
    before = ev.pageInfo.startCursor
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
  client: SuiGrpcClient,
  asset = "BTC",
  count = 5,
  maxHorizonMs = env.deckCardMaxHorizonMs,
): Promise<OracleSnapshot[]> {
  const pkg = env.deepbookPredictPackageId
  const now = Date.now()

  // 1. Recent price-tick events → live oracle id set. One tick tx updates
  //    the whole live set, so ~100 events covers many ticks' worth of ids.
  const tickRes = (await getGraphQLClient().query({
    query: RECENT_QUERY,
    variables: { type: `${pkg}::oracle::OraclePricesUpdated`, last: 100 },
  })) as RecentResult
  const candidateIds = new Set<string>()
  for (const node of tickRes.data?.events?.nodes ?? []) {
    const p = node.contents.json as { oracle_id?: string }
    if (p.oracle_id) candidateIds.add(normalizeSuiObjectId(p.oracle_id))
  }
  if (candidateIds.size === 0) return []

  // 2. Resolve each candidate object into a normalized row.
  const objsRes = await client.core.getObjects({
    objectIds: [...candidateIds],
    include: { json: true },
  })
  const rows: OracleRow[] = []
  for (const obj of objsRes.objects) {
    if (obj instanceof Error || !obj.json) continue
    const f = obj.json as {
      active: boolean
      expiry: string
      settlement_price: unknown
      underlying_asset?: string
      prices: { spot: string; forward: string }
    }
    rows.push({
      id: normalizeSuiObjectId(obj.objectId),
      expiry: BigInt(f.expiry),
      spot: BigInt(f.prices.spot),
      forward: BigInt(f.prices.forward),
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
function readU64LE(bytes: Uint8Array | number[]): bigint {
  let v = 0n
  for (let i = 0; i < 8; i++) {
    v |= BigInt(bytes[i] ?? 0) << BigInt(i * 8)
  }
  return v
}

/**
 * dev_inspect a candidate (oracle, strike, direction) tuple. `viable`
 * only if the inspect succeeds AND the resulting ask lies in the
 * protocol's ask bounds for BOTH UP and DOWN — that's everything the
 * actual `predict::mint` checks before it touches the manager. When
 * viable, the decoded asks (≈ implied probabilities, 1e9 fixed) ride
 * along so callers can band/zone-check the quote without re-probing.
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
  client: SuiGrpcClient,
  oracle: OracleSnapshot,
  strike: bigint,
): Promise<ProbeResult> {
  const pkg = env.deepbookPredictPackageId
  const FLOAT_SCALING = 1_000_000_000n
  const asks = { up: 0n, down: 0n }
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
    // dev_inspect is read-only; sender just needs to be a syntactically
    // valid address.
    tx.setSender(
      "0x0000000000000000000000000000000000000000000000000000000000000001",
    )
    let r:
      | Awaited<
          ReturnType<
            typeof client.core.simulateTransaction<{ commandResults: true }>
          >
        >
      | undefined
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        r = await client.core.simulateTransaction({
          transaction: tx,
          include: { commandResults: true },
        })
        break
      } catch {
        if (attempt === 3) return NOT_VIABLE
        await new Promise((res) => setTimeout(res, 200 * (attempt + 1)))
      }
    }
    if (!r) return NOT_VIABLE
    if (r.$kind !== "Transaction" || !r.Transaction.status.success)
      return NOT_VIABLE
    // results[0] is the market_key call (no public return), results[1] is
    // get_trade_amounts returning (ask_qty, bid_qty), results[2] is
    // ask_bounds returning (min, max). returnValues entry shape:
    // [ [bytes[], "u64"], ... ]
    const trade = r.commandResults?.[1]?.returnValues
    const bounds = r.commandResults?.[2]?.returnValues
    if (!trade || !bounds || trade.length < 1 || bounds.length < 2) {
      return NOT_VIABLE
    }
    const ask = readU64LE(trade[0].bcs)
    const minAsk = readU64LE(bounds[0].bcs)
    const maxAsk = readU64LE(bounds[1].bcs)
    if (ask < minAsk || ask > maxAsk) return NOT_VIABLE
    asks[dir] = ask
  }
  return { viable: true, askUp: asks.up, askDown: asks.down }
}

/** What a probe learns about one (oracle, strike) candidate. */
export interface ProbeResult {
  /** dev_inspect succeeded and both asks sit inside the protocol's
   *  ask bounds — everything `predict::mint` checks pre-manager. */
  viable: boolean
  /** UP ask at qty = 1e9 — the implied probability of UP, 1e9 fixed.
   *  0n when !viable. */
  askUp: bigint
  /** DOWN ask, same scale. 0n when !viable. */
  askDown: bigint
}

const NOT_VIABLE: ProbeResult = { viable: false, askUp: 0n, askDown: 0n }

/**
 * Probe function shape — `(oracle, strike) → ProbeResult`. Defaults to the
 * real `probeCard` against a `SuiGrpcClient`; tests inject a synthetic
 * function so the algorithm can be exercised without RPC.
 */
export type ProbeFn = (
  oracle: OracleSnapshot,
  strike: bigint,
) => Promise<ProbeResult>

/**
 * Bounded-concurrency wrapper. A deck fans out up to
 * `deck_size × ADAPTIVE_PROBE_BUDGET` probe calls; public testnet RPC
 * rate-limits a burst that large and the resulting errors make `probeCard`
 * return `false` for *every* candidate — which looks like "oracle has no
 * viable strike" even though each probe passes when run alone. Routing all
 * probes through a shared limiter caps in-flight `dev_inspect` calls so none
 * get throttled.
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

/** Extra oracles to fetch beyond the requested `max` deck size, so deck
 *  generation can skip a few duds (oracles with unset pricing config / no
 *  viable strike) and still fill the deck from live supply. Kept small —
 *  each extra candidate costs an ATM viability probe. */
const DECK_CANDIDATE_BUFFER = 3

/**
 * Sign bias for `pickStrikeAdaptive`:
 *   * `+1` — steer the strike ABOVE forward (DOWN-favoring market —
 *           settlement likely below strike, UP swipe is the risky high-
 *           reward play, DOWN is the safe-but-expensive play).
 *   * `-1` — steer the strike BELOW forward (UP-favoring market —
 *           swipe UP is the safe play, DOWN is the long-shot).
 *
 * Used by `buildAndProbeDeck` to force a balanced sign distribution
 * across the whole deck so a single duel never ships as all-UP-favoring
 * (boring: same swipe pattern wins everything).
 */
export type SignBias = -1 | 1

/**
 * Allocate sign bias across `deckSize` cards so a deck is never
 * skewed all to one side:
 *   * Even N → exactly N/2 UP-favoring + N/2 DOWN-favoring.
 *   * Odd  N → (N+1)/2 of one sign + (N-1)/2 of the other; PRG picks
 *              which sign gets the extra card.
 * Card order PRG-shuffled so the "side" sequence varies per duel.
 *
 * Non-close cards aim off ATM toward their zone target. Per-card amplitude
 * still floors to ATM if `pickStrikeAdaptive`'s sign-constrained probes find
 * nothing else viable; that's a per-oracle fallback, not a deck-level choice.
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

// ─── Probability zones ──────────────────────────────────────────────────────
//
// Each card targets a difficulty zone expressed on its quote (the UP ask
// from `predict::get_trade_amounts`, ≈ implied probability, 1e9 fixed):
//
//   close: 45–55%            — coin-flip, hardest call
//   mid:   30–45% / 55–70%   — a lean, readable but contestable
//   edge:  band-min–30% / 70%–band-max — long-shot vs gimme
//
// The inner thresholds are fixed; only edge's outer limit comes from the
// configured band ([20%, 80%] by default — see DECK_QUOTE_MIN_PROB).
// Strike-offset % was never the right difficulty knob: the same ±5% is
// 60/40 on a long-dated oracle and 95/5 on a short-dated low-vol one.

export type Zone = "close" | "mid" | "edge"

/** Quote band in 1e9 fixed-point — the global cap on card extremeness. */
export interface QuoteBand {
  min: bigint
  max: bigint
}

export function envQuoteBand(): QuoteBand {
  return {
    min: BigInt(Math.round(env.deckQuoteMinProb * 1e9)),
    max: BigInt(Math.round(env.deckQuoteMaxProb * 1e9)),
  }
}

const ZONE_CLOSE_LO = 450_000_000n
const ZONE_CLOSE_HI = 550_000_000n
const ZONE_MID_LO = 300_000_000n
const ZONE_MID_HI = 700_000_000n

interface Interval {
  lo: bigint
  hi: bigint
}

/**
 * The (band-clipped) quote intervals a zone accepts. A zone squeezed
 * empty by a tight band collapses into its inner neighbor
 * (edge → mid → close); a band so tight even close vanishes degrades
 * to the whole band.
 */
export function zoneIntervals(zone: Zone, band: QuoteBand): Interval[] {
  const clip = (lo: bigint, hi: bigint): Interval | null => {
    const l = lo > band.min ? lo : band.min
    const h = hi < band.max ? hi : band.max
    return l <= h ? { lo: l, hi: h } : null
  }
  const raw: Record<Zone, Array<Interval | null>> = {
    close: [clip(ZONE_CLOSE_LO, ZONE_CLOSE_HI)],
    mid: [
      clip(ZONE_MID_LO, ZONE_CLOSE_LO - 1n),
      clip(ZONE_CLOSE_HI + 1n, ZONE_MID_HI),
    ],
    edge: [
      clip(band.min, ZONE_MID_LO - 1n),
      clip(ZONE_MID_HI + 1n, band.max),
    ],
  }
  const ivs = raw[zone].filter((x): x is Interval => x !== null)
  if (ivs.length > 0) return ivs
  if (zone === "edge") return zoneIntervals("mid", band)
  if (zone === "mid") return zoneIntervals("close", band)
  return [{ lo: band.min, hi: band.max }]
}

export function quoteInZone(q: bigint, zone: Zone, band: QuoteBand): boolean {
  return zoneIntervals(zone, band).some((iv) => q >= iv.lo && q <= iv.hi)
}

/** Distance from `q` to the nearest accepting interval of `zone` (0n inside). */
export function zoneDistance(q: bigint, zone: Zone, band: QuoteBand): bigint {
  let best: bigint | null = null
  for (const iv of zoneIntervals(zone, band)) {
    const d = q < iv.lo ? iv.lo - q : q > iv.hi ? q - iv.hi : 0n
    if (best === null || d < best) best = d
  }
  return best ?? 0n
}

/**
 * The quote a card aims for, given its zone and sign — the midpoint of the
 * zone's accepting region on the side the sign favors. `signBias = +1`
 * (DOWN-favoring, strike above forward) aims below 0.5; `-1` aims above.
 * Computed from the raw zone bounds (not the ±1-clipped intervals) so the
 * targets are clean and mirror around 0.5: close 0.50, mid 0.375/0.625,
 * edge 0.25/0.75. Only edge's outer bound tracks the configured band.
 */
export function zoneTarget(
  zone: Zone,
  signBias: SignBias,
  band: QuoteBand,
): bigint {
  const mid = (lo: bigint, hi: bigint) => (lo + hi) / 2n
  if (zone === "close") return mid(ZONE_CLOSE_LO, ZONE_CLOSE_HI)
  if (zone === "mid") {
    return signBias > 0
      ? mid(ZONE_MID_LO, ZONE_CLOSE_LO)
      : mid(ZONE_CLOSE_HI, ZONE_MID_HI)
  }
  return signBias > 0
    ? mid(band.min, ZONE_MID_LO)
    : mid(ZONE_MID_HI, band.max)
}

/**
 * Per-deck zone allocation — the difficulty mix:
 *   5 → 2 close + 2 mid + 1 edge   (the PRD's 2/2/1, in probability terms)
 *   4 → 1 close + 2 mid + 1 edge
 *   3 → 1 close + 1 mid + 1 edge
 *   2 → 1 close + 1 mid; 1 → close; >5 → repeat the 5-card pattern.
 * PRG-shuffled so card position never reveals difficulty.
 */
const ZONE_PATTERN: readonly Zone[] = [
  "close",
  "close",
  "mid",
  "mid",
  "edge",
] as const

export function allocateZones(
  deckSize: number,
  prgStream: Generator<number, never>,
): Zone[] {
  if (deckSize <= 0) return []
  const base: Record<number, readonly Zone[]> = {
    1: ["close"],
    2: ["close", "mid"],
    3: ["close", "mid", "edge"],
    4: ["close", "mid", "mid", "edge"],
    5: ZONE_PATTERN,
  }
  const zones =
    deckSize <= 5
      ? base[deckSize].slice()
      : Array.from(
          { length: deckSize },
          (_, i) => ZONE_PATTERN[i % ZONE_PATTERN.length],
        )
  return shuffle(zones, prgStream)
}

/** A picked card strike, with the quote that justified it. */
export interface ZonePick {
  strike: bigint
  bps: number
  /** UP ask (implied probability) at pick time, 1e9 fixed. */
  askUp: bigint
}

// ─── Adaptive bracket strike selection ──────────────────────────────────────
//
// Replaces the fixed-bps ladder walk. The in-band strikes (quote ∈ band) live
// in a 10–75bps window on testnet, and that window's width tracks each oracle's
// vol × time-to-expiry — far too variable for any fixed ladder. So instead of
// walking rungs, measure the local quote-vs-bps slope and aim: probe ATM + a
// small seed, interpolate straight to the zone's target quote, verify, refine
// once. ~3–4 probes/card vs a whole ladder, and it adapts to any steepness.

/** Initial seed offset (bps). Viable on both near-expiry and fresh oracles
 *  measured live, so the first slope sample normally succeeds. */
const SEED_OFFSET_BPS = 15
/** Clamp floor for the interpolated offset; also the one seed retry halves
 *  toward this. */
const MIN_OFFSET_BPS = 5
/** Clamp ceiling — only gentle oracles reach it; ~10% is the outer bound that
 *  can still land the edge zone there. */
const MAX_OFFSET_BPS = 1000
/** Hard cap on probes per card: ATM + seed + verify + at most one refine. */
const ADAPTIVE_PROBE_BUDGET = 4

/** Solve a 2-point line for the bps that yields `target`, requiring a strictly
 *  decreasing quote-vs-bps slope (the market is monotone: strike up → UP less
 *  likely). Returns null on a flat/non-decreasing/degenerate sample. */
function solveOffsetForQuote(
  x0: number,
  y0: bigint,
  x1: number,
  y1: bigint,
  target: bigint,
): number | null {
  const dx = x1 - x0
  if (dx === 0) return null
  const slope = Number(y1 - y0) / dx
  if (slope >= 0) return null
  const bps = x0 + Number(target - y0) / slope
  return Number.isFinite(bps) ? Math.round(bps) : null
}

/** Clamp a signed bps offset to [MIN, MAX] in magnitude, preserving sign. */
function clampOffset(bps: number): number {
  const sign = bps < 0 ? -1 : 1
  const mag = Math.min(
    MAX_OFFSET_BPS,
    Math.max(MIN_OFFSET_BPS, Math.abs(Math.round(bps))),
  )
  return sign * mag
}

function absDiff(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a
}

/**
 * Adaptive replacement for `pickZoneStrike`. Steers one card to its zone's
 * target quote by measuring the oracle's local quote-vs-strike slope and
 * interpolating, rather than walking a fixed ladder. Deterministic given
 * (oracle, zone, signBias) — no PRG — so commit-reveal verification is simple.
 *
 * `atmQuote`, if supplied (e.g. from `selectViableOracles`' ATM check), skips
 * the ATM probe.
 *
 * Fallback chain (preserves the `selectViableOracles` invariant): best in-band
 * probe closest to target → ATM (even if out of band) → null (nothing viable).
 */
export async function pickStrikeAdaptive(
  oracle: OracleSnapshot,
  zone: Zone,
  signBias: SignBias,
  probe: ProbeFn,
  band: QuoteBand = envQuoteBand(),
  atmQuote?: bigint,
): Promise<ZonePick | null> {
  const target = zoneTarget(zone, signBias, band)
  const seen: ZonePick[] = []
  const probedBps = new Set<number>()
  let atm: ZonePick | null = null
  let budget = ADAPTIVE_PROBE_BUDGET

  const strikeAt = (bps: number): bigint =>
    snapToTick(
      oracle.forward + (oracle.forward * BigInt(bps)) / 10_000n,
      oracle.minStrike,
      oracle.tickSize,
    )

  const probeAt = async (bps: number): Promise<ZonePick | null> => {
    if (budget <= 0 || probedBps.has(bps)) return null
    const raw = oracle.forward + (oracle.forward * BigInt(bps)) / 10_000n
    if (raw <= 0n) return null
    budget--
    probedBps.add(bps)
    const strike = strikeAt(bps)
    const r = await probe(oracle, strike)
    if (!r.viable) return null
    const pick: ZonePick = { strike, bps, askUp: r.askUp }
    if (bps === 0) atm = pick
    seen.push(pick)
    return pick
  }

  const fallback = (): ZonePick | null => {
    let best: ZonePick | null = null
    for (const c of seen) {
      if (c.askUp < band.min || c.askUp > band.max) continue
      if (best === null || absDiff(c.askUp, target) < absDiff(best.askUp, target)) {
        best = c
      }
    }
    return best ?? atm
  }

  // 1. ATM (reuse a supplied quote if given).
  let q0: bigint
  if (atmQuote !== undefined) {
    atm = { strike: strikeAt(0), bps: 0, askUp: atmQuote }
    seen.push(atm)
    probedBps.add(0)
    q0 = atmQuote
  } else {
    const a = await probeAt(0)
    if (a === null) return null
    q0 = a.askUp
  }
  if (zone === "close") return atm

  // 2. Seed probe toward the target; one retry at half on rejection.
  const dir = target < q0 ? 1 : -1
  let seedPick: ZonePick | null = null
  let seedBps = 0
  for (const mag of [
    SEED_OFFSET_BPS,
    Math.max(MIN_OFFSET_BPS, Math.round(SEED_OFFSET_BPS / 2)),
  ]) {
    seedBps = dir * mag
    seedPick = await probeAt(seedBps)
    if (seedPick !== null) break
  }
  if (seedPick === null) return fallback()
  if (quoteInZone(seedPick.askUp, zone, band)) return seedPick

  // 3. Interpolate from (ATM, seed) and verify.
  const interp = solveOffsetForQuote(0, q0, seedBps, seedPick.askUp, target)
  if (interp !== null) {
    const p2 = await probeAt(clampOffset(interp))
    if (p2 !== null) {
      if (quoteInZone(p2.askUp, zone, band)) return p2
      // 4. One secant refine: interpolate between the two probed points whose
      //    quotes most tightly bracket the target (else the two closest).
      const refine = secantRefineOffset(seen, target)
      if (refine !== null) {
        const p3 = await probeAt(clampOffset(refine))
        if (p3 !== null && quoteInZone(p3.askUp, zone, band)) return p3
      }
    }
  }

  // 5. Best in-band, else ATM.
  return fallback()
}

/** Pick the two probed points that best bracket `target` (one above, one
 *  below) — or the two closest to it — and solve the line through them. */
function secantRefineOffset(seen: ZonePick[], target: bigint): number | null {
  let below: ZonePick | null = null
  let above: ZonePick | null = null
  for (const p of seen) {
    if (p.askUp <= target && (below === null || p.askUp > below.askUp)) below = p
    if (p.askUp >= target && (above === null || p.askUp < above.askUp)) above = p
  }
  let a: ZonePick
  let b: ZonePick
  if (below !== null && above !== null && below.bps !== above.bps) {
    a = below
    b = above
  } else {
    const sorted = [...seen].sort((x, y) =>
      absDiff(x.askUp, target) < absDiff(y.askUp, target) ? -1 : 1,
    )
    if (sorted.length < 2 || sorted[0].bps === sorted[1].bps) return null
    a = sorted[0]
    b = sorted[1]
  }
  return solveOffsetForQuote(a.bps, a.askUp, b.bps, b.askUp, target)
}

/**
 * Generate a deck of `oracles.length` cards (one card per oracle). Each
 * card is steered to its allocated probability zone via `pickStrikeAdaptive`,
 * so a deck always mixes coin-flips, leans, and long-shots — and no card
 * quotes outside the configured band (default 20/80) except the rare
 * ATM-last-resort path.
 *
 * Why we don't go through `buildDeckFromOracles` anymore: the old path
 * picked strike offsets as a % of forward, but offset % was never the
 * right difficulty knob — the same ±5% is 60/40 on a long-dated oracle
 * and 95/5 on a short-dated low-vol one. Probing the actual quote and
 * targeting zones in probability space bounds what the player
 * experiences directly.
 *
 * Deck-level shape: signs are pre-allocated balanced (`allocateSignBalance`)
 * and zones 2/2/1 (`allocateZones`), both PRG-shuffled from the seed, so a
 * deck carries a mix of UP-favoring + DOWN-favoring strikes across the
 * difficulty spread.
 */
/** ATM strike for an oracle: its forward snapped to the tick grid. The
 *  least-aggressive, most-likely-to-price strike — `pickStrikeAdaptive`
 *  always probes it (and falls back to it), so if even this fails the probe
 *  the oracle has no viable strike at all (e.g. pricing config unset). */
export function atmStrike(o: OracleSnapshot): bigint {
  return snapToTick(o.forward, o.minStrike, o.tickSize)
}

/**
 * From `candidates` (soonest-first), return the first up-to-`max` oracles
 * whose ATM strike passes `probe`. Oracles with unset pricing config fail
 * every probe — including ATM — so this drops them, letting deck generation
 * survive a few duds as long as enough live oracles remain. Because
 * `pickStrikeAdaptive` always probes ATM (and falls back to it), an
 * ATM-viable oracle is guaranteed to yield a strike in `buildAndProbeDeck`,
 * so the filtered set never triggers its "no viable strike" throw.
 *
 * Probes fan out concurrently, bounded by the shared `PROBE_CONCURRENCY`
 * limiter (a no-op for synthetic test probes).
 */
export async function selectViableOracles(
  client: SuiGrpcClient,
  candidates: OracleSnapshot[],
  max: number,
  /** Override the probe — defaults to the real `probeCard`. Tests inject a
   *  synthetic function to mark specific oracles non-viable. */
  probeOverride?: ProbeFn,
): Promise<OracleSnapshot[]> {
  const limit = createLimiter(PROBE_CONCURRENCY)
  const rawProbe: ProbeFn =
    probeOverride ?? ((o, strike) => probeCard(client, o, strike))
  const probe: ProbeFn = (o, strike) => limit(() => rawProbe(o, strike))
  const checks = await Promise.all(
    candidates.map((o) => probe(o, atmStrike(o))),
  )
  return candidates.filter((_, i) => checks[i].viable).slice(0, max)
}

export async function buildAndProbeDeck(
  client: SuiGrpcClient,
  oracles: OracleSnapshot[],
  seed: Uint8Array,
  /** Override the per-strike probe — defaults to the real `probeCard`
   *  against the supplied `client`. Tests inject a synthetic function to
   *  exercise the zone-walk algorithm without RPC. */
  probeOverride?: ProbeFn,
  band: QuoteBand = envQuoteBand(),
): Promise<GeneratedDeck> {
  if (oracles.length === 0) {
    throw new Error("buildAndProbeDeck: at least one oracle required")
  }
  // Route every probe through a shared limiter so the deck-wide fan-out
  // (~deck_size × probe-budget concurrent dev_inspects) doesn't trip RPC
  // rate limits. Synthetic test probes are instant, so the limiter is a
  // no-op overhead there.
  const limit = createLimiter(PROBE_CONCURRENCY)
  const rawProbe: ProbeFn =
    probeOverride ?? ((o, strike) => probeCard(client, o, strike))
  const probe: ProbeFn = (o, strike) => limit(() => rawProbe(o, strike))
  // Deck-level shape, drawn deterministically from the seed BEFORE the
  // parallel per-card picks: balanced signs + shuffled difficulty zones.
  // The per-card pick itself is deterministic, so nothing below races
  // against the shared PRG.
  const stream = prgStream(seed)
  const signs = allocateSignBalance(oracles.length, stream)
  const zones = allocateZones(oracles.length, stream)
  const picks = await Promise.all(
    oracles.map(async (o, i) => {
      const pick = await pickStrikeAdaptive(o, zones[i], signs[i], probe, band)
      if (pick === null) {
        throw new Error(
          `oracle ${o.id} has no viable strike (pricing config may be unset)`,
        )
      }
      log.info(
        `card ${i}: ${o.id.slice(0, 12)}… zone=${zones[i]} forward=${o.forward} → strike=${pick.strike} (offset ${pick.bps} bps, quote=${(Number(pick.askUp) / 1e9).toFixed(3)}, side=${signs[i] > 0 ? "DOWN-fav" : "UP-fav"})`,
      )
      return pick
    }),
  )
  const fixedCards: DeckCard[] = picks.map((p, i) => ({
    oracle_id: normalizeSuiAddress(oracles[i].id),
    strike: p.strike,
  }))
  const bytes = DeckBcs.serialize(
    fixedCards.map((c) => ({
      oracle_id: c.oracle_id,
      strike: c.strike.toString(),
    })),
  ).toBytes()
  const hash = new Uint8Array(createHash("sha256").update(bytes).digest())
  return {
    cards: fixedCards,
    hash,
    hashHex: hashToHex(hash),
    quotes: picks.map((p) => p.askUp),
  }
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

// ─── Plaintext persistence (Postgres `deck` table) ───────────────────────────
//
// Was apps/server/.data/decks.json — now one row per commitment (keyed by
// the lowercased "0x…" sha2-256 hash) so the store survives restarts with
// no mounted volume and is shared across any future server replicas. Each
// entry holds the revealed cards plus the seed used to derive their
// strikes; `seedHex` is optional for back-compat with decks generated
// before the deterministic-seed change.

export interface StoreEntry {
  cards: DeckCard[]
  seedHex?: string
}

/** Cards serialize to JSON with strikes as decimal strings (u64 > 2^53). */
function serializeCards(cards: DeckCard[]): string {
  return JSON.stringify(
    cards.map((c) => ({ oracle_id: c.oracle_id, strike: c.strike.toString() })),
  )
}

function deserializeCards(json: string): DeckCard[] {
  const arr = JSON.parse(json) as Array<{ oracle_id: string; strike: string }>
  return arr.map((c) => ({ oracle_id: c.oracle_id, strike: BigInt(c.strike) }))
}

export async function rememberDeck(
  hash: Uint8Array,
  cards: DeckCard[],
  seed?: Uint8Array,
): Promise<string> {
  const hex = hashToHex(hash)
  await upsertDeck(hex, serializeCards(cards), seed ? hashToHex(seed) : null)
  return hex
}

export async function fetchDeck(
  hashHex: string,
): Promise<DeckCard[] | undefined> {
  const row = await getDeck(hashHex)
  return row ? deserializeCards(row.cardsJson) : undefined
}

export async function fetchDeckEntry(
  hashHex: string,
): Promise<StoreEntry | undefined> {
  const row = await getDeck(hashHex)
  if (!row) return undefined
  return {
    cards: deserializeCards(row.cardsJson),
    seedHex: row.seedHex ?? undefined,
  }
}

export async function forgetDeck(hashHex: string): Promise<void> {
  await deleteDeck(hashHex)
}

export async function knownHashCount(): Promise<number> {
  return countDecks()
}

// ─── HTTP routes ────────────────────────────────────────────────────────────

import { json } from "./lib/http"
import { getGraphQLClient, getSuiClient } from "./lib/sui"
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
      | {
          asset?: string
          sender?: string
          tier?: string
          deckSize?: number
          minDeckSize?: number
          maxDeckSize?: number
        }
      | null
    const asset = body?.asset ?? "BTC"
    const sender = body?.sender
    const tier = body?.tier
    // Deck size adapts to live oracle supply within a band (default [3, 5],
    // clamped to the contract's [1, 20]). An explicit `deckSize` collapses
    // the band for back-compat. We fetch up to `max`, then size greedily.
    const bounds = resolveDeckBounds(body ?? {})
    const client = getSuiClient()
    try {
      // Over-fetch candidates, then drop oracles with no viable strike
      // (unset pricing config) so a few duds don't sink the whole deck.
      const candidates = await findDeckOracles(
        client,
        asset,
        bounds.max + DECK_CANDIDATE_BUFFER,
      )
      const viable = await selectViableOracles(client, candidates, bounds.max)
      const decision = decideDeckSize(viable.length, bounds)
      if (!decision.ok) {
        return json(
          {
            error: "not enough live oracles",
            detail: `found ${candidates.length} live ${asset} oracles settling within ${env.deckCardMaxHorizonMs / 60_000}min, ${viable.length} with a viable strike, need ≥${bounds.min}; retry shortly`,
          },
          503,
        )
      }
      const chosen = viable.slice(0, decision.deckSize)
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
      const deck = await buildAndProbeDeck(client, chosen, seed)
      await rememberDeck(deck.hash, deck.cards, seed)
      return json({
        cards: deck.cards.map((c, i) => ({
          oracle_id: c.oracle_id,
          strike: c.strike.toString(),
          expiry: chosen[i].expiry.toString(),
          // Implied probability of UP at generation time, e.g. "0.6250".
          quote: deck.quotes
            ? (Number(deck.quotes[i]) / 1e9).toFixed(4)
            : undefined,
        })),
        hash: deck.hashHex,
        seed: hashToHex(seed),
        deckSize: decision.deckSize,
        liveOracleCount: candidates.length,
        viableOracleCount: viable.length,
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
    const entry = await fetchDeckEntry(hash)
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
