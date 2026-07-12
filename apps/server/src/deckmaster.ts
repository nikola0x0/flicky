/**
 * AI Deckmaster — generates the 5-card binary-digital deck for each duel.
 *
 * 6-24 model (predict-testnet-6-24, no public on-chain quote):
 *   - Each duel deck = N cards, each pinned to a DIFFERENT DeepBook Predict
 *     `ExpiryMarket`, discovered from the **predict indexer** (`GET
 *     /markets`) rather than an on-chain event scan. Chosen markets are
 *     the nearest expiries strictly later than `now + headroomMs`, sorted
 *     ascending, capped at the requested horizon.
 *   - Strikes are placed in **price space**: read current BTC spot from
 *     the propbook indexer's Pyth feed, offset it by a difficulty-zone bps
 *     ladder (`allocateZones`), sign-balance the offsets across the deck
 *     (`allocateSignBalance`), and snap the result to the market's
 *     `admission_tick_size` grid. This replaces the old on-chain quote
 *     probe (`predict::get_trade_amounts`), which 6-24 doesn't expose
 *     publicly.
 *   - `env.deckStrikeMode` gates the strike algorithm: `"price_offset"`
 *     (this file, default) or `"svi_quote"` (an off-chain-SVI-informed
 *     picker — not implemented yet; `buildDeck` throws if selected).
 *
 * On-chain commit-reveal (unchanged from 4-16):
 *   - `commitDeck` returns `{ cards, hash }` where hash = sha2-256 of the
 *     BCS-serialized card vector that flicky::duel::reveal_deck expects.
 *     `Card` on chain is `{ expiry_market_id: ID, strike: u64 }` —
 *     `DeckCard.expiryMarketId` internally (TS camelCase, matching this
 *     file's other market-id fields); serialized to the wire / BCS /
 *     Postgres JSON as `expiry_market_id` (Plan 2 Task 6 completed the
 *     rename across server/ws — see indexer.ts, ws/protocol.ts).
 *   - The plaintext is persisted to the Postgres `deck` table (see db.ts)
 *     so a server restart doesn't strand pending duels. The keeper or the
 *     player's tab calls `reveal_deck` after `join_duel` lands; we just
 *     serve the plaintext on demand.
 */
import { bcs } from "@mysten/sui/bcs"
import { normalizeSuiAddress, normalizeSuiObjectId } from "@mysten/sui/utils"
import { createHash } from "node:crypto"
import { countDecks, deleteDeck, getDeck, upsertDeck } from "./db"
import { env } from "./env"
import { makeLogger } from "./log"

const log = makeLogger("deckmaster")

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DeckCard {
  /** `ExpiryMarket` id — see header for the wire/BCS key naming note. */
  expiryMarketId: string
  strike: bigint
}

export interface GeneratedDeck {
  cards: DeckCard[]
  hash: Uint8Array
  hashHex: string
}

// ─── BCS shape that matches flicky::duel::Card on chain ─────────────────────

const CardBcs = bcs.struct("Card", {
  expiry_market_id: bcs.Address,
  strike: bcs.u64(),
})
const DeckBcs = bcs.vector(CardBcs)

// ─── Market discovery (predict indexer) ──────────────────────────────────────

/** Raw row shape from `GET {predictIndexerUrl}/markets` (confirmed live
 *  2026-07-10). The indexer returns every `market_created` event ever
 *  emitted (including expired/historical markets) — callers MUST filter
 *  by `propbook_underlying_id`, `kind`, and `expiry`. */
export interface MarketRow {
  expiry_market_id: string
  propbook_underlying_id: number
  expiry: number
  tick_size: string
  admission_tick_size: string
  kind: string
}

/** Normalized, chain-agnostic view of a live `ExpiryMarket` — the input
 *  to `buildDeck`. */
export interface MarketSnapshot {
  expiryMarketId: string
  /** Expiry, ms since epoch. */
  expiry: number
  /** Base tick unit (raw strike = tick × tickSize), 1e9-fixed USD. */
  tickSize: bigint
  /** Coarser grid mint-admissible strikes must land on (a multiple of `tickSize`). */
  admissionTickSize: bigint
}

/**
 * Pure filter/de-dupe/sort/slice logic for selecting live markets from
 * indexer rows. Keeps rows where `propbook_underlying_id === 1 &&
 * kind === "market_created"`, de-dupes by normalized `expiry_market_id`
 * (keeps first), keeps `expiry > now + minHeadroomMs && expiry ≤ now + maxHorizonMs`,
 * sorts by `expiry` ascending, slices to `count`, and maps to `MarketSnapshot`.
 */
export function selectMarketRows(
  rows: MarketRow[],
  opts: {
    now: number
    minHeadroomMs: number
    maxHorizonMs: number
    count: number
  }
): MarketSnapshot[] {
  const { now, minHeadroomMs, maxHorizonMs, count } = opts
  const seen = new Set<string>()
  const out: MarketSnapshot[] = []
  for (const r of rows) {
    if (r.propbook_underlying_id !== 1 || r.kind !== "market_created") continue
    const id = normalizeSuiObjectId(r.expiry_market_id)
    if (seen.has(id)) continue
    seen.add(id)
    const expiry = Number(r.expiry)
    if (expiry <= now + minHeadroomMs || expiry > now + maxHorizonMs) continue
    out.push({
      expiryMarketId: id,
      expiry,
      tickSize: BigInt(r.tick_size),
      admissionTickSize: BigInt(r.admission_tick_size),
    })
  }
  out.sort((a, b) => a.expiry - b.expiry)
  return out.slice(0, count)
}

/**
 * Fetch the `count` nearest live BTC `ExpiryMarket`s from the predict
 * indexer, i.e. those whose expiry clears `now + minHeadroomMs` but falls
 * within `now + maxHorizonMs`. Sorted soonest-first. De-dupes by
 * `expiry_market_id` (the indexer can return more than one `market_created`
 * row per market on event re-emit — keeps the first).
 */
export async function findDeckMarkets(
  count = 5,
  maxHorizonMs = env.deckCardMaxHorizonMs,
  minHeadroomMs = env.deckCardMinHeadroomMs
): Promise<MarketSnapshot[]> {
  const res = await fetch(`${env.predictIndexerUrl}/markets`)
  if (!res.ok) throw new Error(`predict indexer /markets ${res.status}`)
  const rows = (await res.json()) as MarketRow[]
  return selectMarketRows(rows, {
    now: Date.now(),
    minHeadroomMs,
    maxHorizonMs,
    count,
  })
}

/**
 * Current BTC spot from the propbook indexer's Pyth feed, in the same
 * 1e9-fixed USD unit as `MarketSnapshot.tickSize` (confirmed live
 * 2026-07-10: `/oracles/{pythFeedId}/pyth/latest` → `normalized_spot`,
 * e.g. `"63837582739850"` == $63,837.58273985).
 */
export async function readBtcSpot(): Promise<bigint> {
  const res = await fetch(
    `${env.propbookIndexerUrl}/oracles/${env.pythFeedId}/pyth/latest`
  )
  if (!res.ok) throw new Error(`propbook /pyth/latest ${res.status}`)
  const j = (await res.json()) as { normalized_spot: string }
  return BigInt(j.normalized_spot)
}

/**
 * Snap a raw (1e9-fixed) strike price to the nearest `admissionTickSize`
 * multiple, then express it as a tick index (`snapped / tickSize`) — the
 * unit `predict::expiry_market::mint_exact_quantity`'s `lower_tick` /
 * `higher_tick` args expect. `admissionTickSize` must be an integer
 * multiple of `tickSize` (true for every live 6-24 market), so the
 * division is always exact.
 */
export function snapToAdmissionTick(
  rawStrike: bigint,
  tickSize: bigint,
  admissionTickSize: bigint
): bigint {
  if (tickSize <= 0n) {
    throw new Error("snapToAdmissionTick: tickSize must be > 0")
  }
  const r = rawStrike < 0n ? 0n : rawStrike
  if (admissionTickSize <= 0n) return r / tickSize
  const half = admissionTickSize / 2n
  const snappedRaw = ((r + half) / admissionTickSize) * admissionTickSize
  return snappedRaw / tickSize
}

// ─── Seeded PRG (deck-level shape derivation) ────────────────────────────────

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
 * CSPRNG for unbounded streams, but sufficient for picking a handful of
 * ints from small pools.
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

// ─── Sign balance + difficulty zones ─────────────────────────────────────────

/**
 * Sign bias for a card's strike offset:
 *   * `+1` — steer the strike ABOVE spot (DOWN-favoring — settlement
 *           likely below strike, UP swipe is the risky high-reward play).
 *   * `-1` — steer the strike BELOW spot (UP-favoring — swipe UP is the
 *           safe play, DOWN is the long-shot).
 *
 * Used by `buildDeck` to force a balanced sign distribution across the
 * whole deck so a single duel never ships as all-UP-favoring (boring:
 * same swipe pattern wins everything).
 */
export type SignBias = -1 | 1

/**
 * Allocate sign bias across `deckSize` cards so a deck is never skewed
 * all to one side:
 *   * Even N → exactly N/2 UP-favoring + N/2 DOWN-favoring.
 *   * Odd  N → (N+1)/2 of one sign + (N-1)/2 of the other; PRG picks
 *              which sign gets the extra card.
 * Card order PRG-shuffled so the "side" sequence varies per duel.
 */
export function allocateSignBalance(
  deckSize: number,
  prgStream: Generator<number, never>
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
 * Difficulty zone for one card, expressed as strike distance from spot:
 *   close — smallest offset (coin-flip, hardest call)
 *   mid   — moderate offset (a lean, readable but contestable)
 *   edge  — widest offset (long-shot vs gimme)
 */
export type Zone = "close" | "mid" | "edge"

/**
 * Per-deck zone allocation — the difficulty mix:
 *   5 → 2 close + 2 mid + 1 edge   (the PRD's 2/2/1)
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
  prgStream: Generator<number, never>
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
          (_, i) => ZONE_PATTERN[i % ZONE_PATTERN.length]
        )
  return shuffle(zones, prgStream)
}

// ─── Deck construction (price-space strikes) ─────────────────────────────────

/** Open-upper-bound sentinel tick — `(1 << 30) - 1`, per the 6-24 tick grid. */
export const POS_INF_TICK = (1n << 30n) - 1n

/** Strike-offset ladder, bps of spot, by difficulty zone. Close = smallest
 *  offset (near-spot coin flip), edge = widest (long-shot/gimme).
 *
 *  Kept NEAR-ATM (single-digit / ~10 bps) on purpose. 6-24's
 *  `mint_exact_quantity` admits a mint only when its implied entry
 *  probability clears BOTH the `min_net_premium` floor (low-probability side,
 *  `assert_mint_admission`, code 4) AND the `[min_entry, max_entry]` band
 *  (`assert_mint_probability_and_leverage_policy`, code 1). A card must be
 *  mintable in EITHER direction (the player picks UP/NO at swipe time), so
 *  its probability has to stay inside ~[0.33, 0.67] — which, on these
 *  short-expiry (10 min–few hr) BTC markets, means strikes within ~10 bps of
 *  spot. Wider offsets abort live (verified on-chain). Real difficulty
 *  variety needs an on-chain probability probe — that's the `svi_quote`
 *  mode's job; this fixed ladder is the near-ATM interim. */
const ZONE_OFFSET_BPS: Record<Zone, number> = {
  close: 3,
  mid: 6,
  edge: 10,
}

/** One deck card in price space — the shape `buildDeck` returns. Not the
 *  on-chain-committed shape (see `DeckCard`/`commitDeck`): `lowerTick` /
 *  `higherTick` / `isUpFavored` are swipe-PTB-building hints, not part of
 *  the hashed commitment (the player's own `is_up` choice at swipe time
 *  determines which of these actually gets minted). */
export interface DeckCardOut {
  expiryMarketId: string
  /** Raw strike price (tick × tickSize), 1e9-fixed USD. */
  strike: bigint
  lowerTick: bigint
  higherTick: bigint
  /** Whether this card's strike sits below spot (swiping UP is the safer play). */
  isUpFavored: boolean
}

/** Bps added to a colliding card's zone offset on each dedup retry, and the
 *  cumulative cap on how far a single card's offset may be widened before
 *  we give up trying to find a fresh (market, strikeTick) pair.
 *
 *  Kept tiny (steps of 3 bps, ceiling ~15 bps) so a dedup-bumped strike can
 *  never wander past the near-ATM mint-admissible band (see ZONE_OFFSET_BPS).
 *  If the ceiling is hit without finding a fresh pair, `buildDeck` falls
 *  through and reuses the last strike — a duplicate (market, strikeTick)
 *  card is dull but harmless (the deck vector may contain duplicates; the
 *  commitment hash and reveal are unaffected), whereas an out-of-band strike
 *  would abort the mint at swipe time. */
const DEDUP_BUMP_STEP_BPS = 3
const DEDUP_MAX_BUMP_BPS = 15

// ─── svi_quote strike placement (probability-targeted) ───────────────────────

/** Annualized vol for the off-chain digital-option strike placement below.
 *  MUST match the web's `markCardPnl` `ASSUMED_VOL` (apps/web/src/lib/pnl.ts)
 *  so the strike we place lands at the same win-probability the live PnL chart
 *  prices — that's what makes the mark start off-zero and drift on schedule. */
const SVI_VOL = 0.6
const SVI_MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000

/** Target win-probability for the FAVORED direction, by difficulty zone.
 *  Bounded so BOTH sides' premiums (`p × quantity` and `(1-p) × quantity`)
 *  clear the protocol per-swipe `min_net_premium` floor ($1) at
 *  `SWIPE_QUANTITY = 3` dUSDC — the both-sides-mintable band is
 *  p ∈ [0.334, 0.666], and every zone below sits inside it with margin (e.g.
 *  edge 0.63 → long-shot premium ≳ $1.11). mint-probe `buildProbedDeck` now
 *  requires BOTH directions to mint, falling back to ATM only if either
 *  fails. Higher p = stronger lean = more dramatic time-decay PnL drift
 *  toward ±quantity near settlement. */
const ZONE_TARGET_PROB: Record<Zone, number> = {
  close: 0.56,
  mid: 0.61,
  edge: 0.63,
}

/** Inverse standard-normal CDF (Acklam's rational approximation, ~1e-9). */
function invNormCdf(p: number): number {
  if (p <= 0) return -Infinity
  if (p >= 1) return Infinity
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.38357751867269e2, -3.066479806614716e1, 2.506628277459239,
  ]
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1,
  ]
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783,
  ]
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
    3.754408661907416,
  ]
  const pLow = 0.02425
  const pHigh = 1 - pLow
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p))
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    )
  }
  if (p <= pHigh) {
    const q = p - 0.5
    const r = q * q
    return (
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) *
        q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
    )
  }
  const q = Math.sqrt(-2 * Math.log(1 - p))
  return (
    -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  )
}

/**
 * Raw strike price (1e9-fixed) for an svi_quote card: the digital-option
 * strike at which the FAVORED direction has win-probability `targetP`, given
 * `spot`, the market's time-to-expiry, and `SVI_VOL`. Inverts the same
 * Black-Scholes digital the live PnL mark uses:
 *   `pUp = Φ((ln(f/k) − ½v²)/v)` ⇒ `k = f / exp(Φ⁻¹(pUp)·v + ½v²)`, `v = σ√T`.
 * `sign < 0` = UP-favored (strike below spot); `sign > 0` = DOWN-favored
 * (strike above spot). Falls back to ATM (spot) when time-to-expiry ≤ 0.
 */
function sviRawStrike(
  spot: bigint,
  sign: SignBias,
  targetP: number,
  expiry: number,
  nowMs: number
): bigint {
  const tYears = (expiry - nowMs) / SVI_MS_PER_YEAR
  if (!(tYears > 0)) return spot
  const v = SVI_VOL * Math.sqrt(tYears)
  const pUp = sign < 0 ? targetP : 1 - targetP
  const d2 = invNormCdf(pUp)
  const k = Number(spot) / Math.exp(d2 * v + 0.5 * v * v)
  return BigInt(Math.max(0, Math.round(k)))
}

/**
 * svi_quote deck: strikes placed at a per-zone target win-probability (see
 * `ZONE_TARGET_PROB`) instead of a fixed bps offset, so every card carries a
 * genuine directional lean. Because the lean is expressed in probability, the
 * live PnL mark (pricing the same digital) starts off-zero and drifts
 * continuously toward ±quantity via time-decay as the card nears settlement —
 * the drama a flat ATM deck can't produce. Offsets auto-scale with each
 * market's time-to-expiry. Dedup nudges the strike by whole admission cells
 * (preserving the lean's direction) so (market, strikeTick) pairs stay
 * distinct. Requires `nowMs` for time-to-expiry.
 */
function buildSviDeck(
  markets: MarketSnapshot[],
  spot: bigint,
  seed: Uint8Array,
  deckSize: number,
  nowMs: number | undefined
): DeckCardOut[] {
  if (nowMs === undefined) {
    throw new Error("buildDeck: svi_quote mode requires nowMs")
  }
  const stream = prgStream(seed)
  const signs = allocateSignBalance(deckSize, stream)
  const zones = allocateZones(deckSize, stream)
  const seen = new Set<string>()
  return Array.from({ length: deckSize }, (_, i) => {
    const m = markets[i % markets.length]
    const marketId = normalizeSuiAddress(m.expiryMarketId)
    const sign = signs[i]
    const baseRaw = sviRawStrike(
      spot,
      sign,
      ZONE_TARGET_PROB[zones[i]],
      m.expiry,
      nowMs
    )
    // Dedup: nudge one admission cell further from spot (keeping the lean's
    // direction) until the (market, strikeTick) pair is unique, capped so it
    // can't wander far from the intended probability.
    const cell = m.admissionTickSize
    let bump = 0n
    let strikeTick: bigint
    let key: string
    for (;;) {
      const nudged =
        sign > 0 ? baseRaw + bump : baseRaw > bump ? baseRaw - bump : 0n
      strikeTick = snapToAdmissionTick(nudged, m.tickSize, m.admissionTickSize)
      key = `${marketId}:${strikeTick}`
      if (!seen.has(key) || bump >= cell * 10n) break
      bump += cell
    }
    seen.add(key)
    const isUpFavored = sign < 0
    return {
      expiryMarketId: marketId,
      strike: strikeTick * m.tickSize,
      lowerTick: isUpFavored ? strikeTick : 0n,
      higherTick: isUpFavored ? POS_INF_TICK : strikeTick,
      isUpFavored,
    }
  })
}

// ─── Practice deck (synthetic — no markets, no commit-reveal) ────────────────

/** Per-card settle times for a practice match, ms after lockup start
 *  (lockup = the moment the player swipes their 5th card). Staggered so the
 *  45s watch phase pays off card-by-card instead of all at once. */
export const PRACTICE_EXPIRY_OFFSETS_MS = [
  15_000, 22_500, 30_000, 37_500, 45_000,
] as const

export interface PracticeCard {
  /** Strike price, 1e9-fixed USD — same scale as `readBtcSpot`. */
  strike: bigint
  /** Settle time relative to lockup start; the client anchors the clock. */
  expiryOffsetMs: number
  /** Digital-BS win-probability of UP at gen time. Doubles as the scoring
   *  `p_swiped` (practice has no Predict SVI to snapshot): a swipe UP scores
   *  against `pUp`, DOWN against `1 - pUp`. */
  pUp: number
}

/**
 * Synthetic practice deck. Same placement machinery as `buildSviDeck`
 * (PRG-shuffled sign balance + difficulty zones, `ZONE_TARGET_PROB`
 * probability ladder, digital-BS inversion via `sviRawStrike`) but with
 * time-to-expiry = each card's short `PRACTICE_EXPIRY_OFFSETS_MS` — so
 * strikes land close enough to spot (single-digit bps) that the live Pyth
 * feed genuinely crosses them during the 45s lockup. No market snapping, no
 * dedup, no mint probing: nothing on-chain ever sees these strikes.
 *
 * Strikes are anchored at gen-time spot; the player may swipe for a while
 * before lockup, drifting the true probabilities. Acceptable for practice —
 * outcomes stay live-price-driven either way.
 */
export function buildPracticeDeck(
  spot: bigint,
  seed: Uint8Array,
  deckSize = PRACTICE_EXPIRY_OFFSETS_MS.length
): PracticeCard[] {
  if (spot <= 0n) {
    throw new Error("buildPracticeDeck: spot must be positive")
  }
  const stream = prgStream(seed)
  const signs = allocateSignBalance(deckSize, stream)
  const zones = allocateZones(deckSize, stream)
  return Array.from({ length: deckSize }, (_, i) => {
    const expiryOffsetMs =
      PRACTICE_EXPIRY_OFFSETS_MS[
        Math.min(i, PRACTICE_EXPIRY_OFFSETS_MS.length - 1)
      ]
    const targetP = ZONE_TARGET_PROB[zones[i]]
    // T = the card's offset (as if lockup started now): expiry=offset, now=0.
    const strike = sviRawStrike(spot, signs[i], targetP, expiryOffsetMs, 0)
    return {
      strike,
      expiryOffsetMs,
      pUp: signs[i] < 0 ? targetP : 1 - targetP,
    }
  })
}

/**
 * Build a price-space deck of `deckSize` cards distributed round-robin
 * across `markets` (so a full deck can be built from as few as ONE live
 * market), strike = spot ± a zone-scaled bps offset, sign-balanced across
 * the deck, snapped to each card's market's admission grid.
 *
 * `Card` on chain is `(expiry_market_id, strike)` only — two cards sharing
 * a (market, strikeTick) pair would be identical commitments, so cards
 * landing on the same market are guaranteed distinct strikes: on a
 * collision the card's offset is widened by `DEDUP_BUMP_STEP_BPS` and
 * retried (direction/sign is preserved), up to `DEDUP_MAX_BUMP_BPS` total
 * added bps.
 *
 * When `env.deckStrikeMode === "svi_quote"`, delegates to `buildSviDeck`
 * (probability-targeted strikes; needs `nowMs`). Otherwise uses the fixed
 * bps-offset placement below.
 */
export function buildDeck(
  markets: MarketSnapshot[],
  spot: bigint,
  seed: Uint8Array,
  deckSize: number = markets.length,
  nowMs?: number
): DeckCardOut[] {
  if (markets.length === 0) {
    throw new Error("buildDeck: no markets supplied")
  }
  if (deckSize <= 0) return []
  if (env.deckStrikeMode === "svi_quote") {
    return buildSviDeck(markets, spot, seed, deckSize, nowMs)
  }
  const stream = prgStream(seed)
  const signs = allocateSignBalance(deckSize, stream)
  const zones = allocateZones(deckSize, stream)
  const seen = new Set<string>()
  return Array.from({ length: deckSize }, (_, i) => {
    const m = markets[i % markets.length]
    const marketId = normalizeSuiAddress(m.expiryMarketId)
    const sign = signs[i]
    const baseOffsetBps = ZONE_OFFSET_BPS[zones[i]]
    let bumpBps = 0
    let strikeTick: bigint
    let key: string
    for (;;) {
      const offsetBps = BigInt(baseOffsetBps + bumpBps)
      const offset = (spot * offsetBps) / 10_000n
      const rawStrike = sign > 0 ? spot + offset : spot - offset
      strikeTick = snapToAdmissionTick(
        rawStrike,
        m.tickSize,
        m.admissionTickSize
      )
      key = `${marketId}:${strikeTick}`
      if (!seen.has(key) || bumpBps >= DEDUP_MAX_BUMP_BPS) break
      bumpBps += DEDUP_BUMP_STEP_BPS
    }
    seen.add(key)
    const isUpFavored = sign < 0
    return {
      expiryMarketId: marketId,
      strike: strikeTick * m.tickSize,
      lowerTick: isUpFavored ? strikeTick : 0n,
      higherTick: isUpFavored ? POS_INF_TICK : strikeTick,
      isUpFavored,
    }
  })
}

/**
 * Convert a price-space deck (`buildDeck`'s output) to the on-chain
 * commitment shape and compute its hash: sha2-256 of the BCS-serialized
 * `Card` vector `flicky::duel::reveal_deck` expects.
 */
export function commitDeck(cards: DeckCardOut[]): GeneratedDeck {
  const stored: DeckCard[] = cards.map((c) => ({
    expiryMarketId: c.expiryMarketId,
    strike: c.strike,
  }))
  const bytes = DeckBcs.serialize(
    stored.map((c) => ({
      expiry_market_id: c.expiryMarketId,
      strike: c.strike.toString(),
    }))
  ).toBytes()
  const hash = new Uint8Array(createHash("sha256").update(bytes).digest())
  return { cards: stored, hash, hashHex: hashToHex(hash) }
}

export function hashToHex(hash: Uint8Array): string {
  return (
    "0x" +
    Array.from(hash)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  )
}

// ─── Deck sizing ────────────────────────────────────────────────────────────

/**
 * Resolve a deck-size band from the request body.
 * - Explicit `deckSize` collapses the band to [n, n] — preserves the old
 *   strict behavior (503 unless exactly n markets are live).
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
 * Deck size no longer tracks live market count: `buildDeck` distributes
 * `deckSize` cards round-robin across whatever markets are live,
 * guaranteeing distinct (market, strike) pairs. So the market pool no
 * longer needs to be as large as the deck.
 *
 * Floor is 1 market: with the 6-24 mint probe active
 * (`filterMintableMarkets`), the eligible set is narrowed to only
 * currently-backed markets, which volatile LP backing frequently reduces to
 * a single market. A 1-market deck is no longer degenerate now that strikes
 * are near-ATM and distinct per card (all 5 mint both directions), so
 * rejecting it would needlessly fail otherwise-playable matches. `deckSize`
 * is always the band's `max` (an explicit `deckSize` request collapses
 * `resolveDeckBounds` to `{min: n, max: n}`, so this still returns `n`).
 */
export function decideDeckSize(
  liveCount: number,
  bounds: { min: number; max: number }
): { ok: boolean; deckSize: number } {
  return {
    ok: liveCount >= 1,
    deckSize: bounds.max,
  }
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
    cards.map((c) => ({
      expiry_market_id: c.expiryMarketId,
      strike: c.strike.toString(),
    }))
  )
}

function deserializeCards(json: string): DeckCard[] {
  const arr = JSON.parse(json) as Array<{
    expiry_market_id: string
    strike: string
  }>
  return arr.map((c) => ({
    expiryMarketId: c.expiry_market_id,
    strike: BigInt(c.strike),
  }))
}

export async function rememberDeck(
  hash: Uint8Array,
  cards: DeckCard[],
  seed?: Uint8Array
): Promise<string> {
  const hex = hashToHex(hash)
  await upsertDeck(hex, serializeCards(cards), seed ? hashToHex(seed) : null)
  return hex
}

export async function fetchDeck(
  hashHex: string
): Promise<DeckCard[] | undefined> {
  const row = await getDeck(hashHex)
  return row ? deserializeCards(row.cardsJson) : undefined
}

export async function fetchDeckEntry(
  hashHex: string
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
import { clientIp, consume } from "./ratelimit"

export async function handleDeckmasterRequest(
  req: Request,
  url: URL
): Promise<Response | null> {
  if (url.pathname === "/deckmaster/generate" && req.method === "POST") {
    const gate = consume("deckmaster:generate", clientIp(req, null))
    if (!gate.ok) {
      return json({ error: "rate limited", retryMs: gate.retryMs }, 429)
    }
    const body = (await req.json().catch(() => null)) as {
      sender?: string
      tier?: string
      deckSize?: number
      minDeckSize?: number
      maxDeckSize?: number
    } | null
    const sender = body?.sender
    const tier = body?.tier
    // Deck size adapts to live market supply within a band (default [3, 5],
    // clamped to the contract's [1, 20]). An explicit `deckSize` collapses
    // the band for back-compat.
    const bounds = resolveDeckBounds(body ?? {})
    try {
      // findDeckMarkets fetches up to bounds.max markets for spread — but
      // buildDeck no longer needs one distinct market per card, so a
      // single live market is enough to build the full deckSize (cards
      // round-robin across whatever's live; see buildDeck's dedup logic).
      const markets = await findDeckMarkets(bounds.max)
      const decision = decideDeckSize(markets.length, bounds)
      if (!decision.ok) {
        return json(
          {
            error: "not enough live markets",
            detail: `found ${markets.length} live BTC ExpiryMarkets settling within ${env.deckCardMaxHorizonMs / 60_000}min, need ≥2; retry shortly`,
          },
          503
        )
      }
      const spot = await readBtcSpot()
      // Derive a deterministic seed for this generation. The seed is
      // saved alongside the plaintext so anyone with (seed, market list)
      // can recompute the exact strike sequence and verify the deck
      // wasn't biased by the picker.
      const nonceHex = hashToHex(crypto.getRandomValues(new Uint8Array(16)))
      const seed = deriveSeed({
        sender,
        asset: "BTC",
        tier,
        timestampMs: Date.now(),
        nonceHex,
      })
      const outCards = buildDeck(
        markets,
        spot,
        seed,
        decision.deckSize,
        Date.now()
      )
      const deck = commitDeck(outCards)
      await rememberDeck(deck.hash, deck.cards, seed)
      return json({
        cards: outCards.map((c, i) => ({
          expiry_market_id: c.expiryMarketId,
          strike: c.strike.toString(),
          expiry: markets[i % markets.length].expiry.toString(),
        })),
        hash: deck.hashHex,
        seed: hashToHex(seed),
        deckSize: decision.deckSize,
        liveOracleCount: markets.length,
      })
    } catch (e) {
      log.error(
        `generate failed: ${e instanceof Error ? e.message : String(e)}`
      )
      return json(
        {
          error: "deckmaster failed",
          detail: e instanceof Error ? e.message : String(e),
        },
        500
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
        expiry_market_id: c.expiryMarketId,
        strike: c.strike.toString(),
      })),
      hash: hash.toLowerCase(),
      seed: entry.seedHex ?? null,
    })
  }

  return null
}
