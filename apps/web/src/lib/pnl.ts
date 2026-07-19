/**
 * PnL projection helpers for the active-duel UI.
 *
 * Settled cards use the contract's binary PnL — `payout - premium`,
 * available through `room_state.p{0,1}Payout` / `p{0,1}Premium` once
 * `settle_card` lands (accumulated incrementally per card; `finalize`
 * then distributes the pot) and, per-card, through `cardOutcomes[i].p{0,1}Pnl`
 * (server-computed with the true premium). Unsettled-but-swiped cards use a
 * projection from `oracle_tick`'s live spot price instead.
 *
 * 6-24: the swipe wire dropped per-swipe `premium` (only `orderId` remains
 * — the real premium needs a server-side lookup by `orderId` that isn't
 * wired in yet). Without a cost basis to net out, the live projection below
 * mirrors the contract's binary payout shape (`payout = correct ? quantity
 * : 0`) but reframed as a symmetric win/lose PnL: `+quantity` when the
 * current spot favors the swiped direction, `-quantity` when it doesn't.
 * This is a projection of the win/lose outcome, not a true (payout −
 * premium) P&L — settled cards should prefer the server-computed
 * `cardOutcomes[i].p{0,1}Pnl` and only fall back to this for the brief
 * pre-indexer window right after on-chain settlement.
 *
 * Mirrors `liveCardPnl` / `markCardPnl` usage in apps/playground.
 */

export interface SwipeLite {
  isUp: boolean
  quantity: string
}

/**
 * Live PnL for one swipe, in dUSDC micro-units (1e6). Returns null when we
 * lack the inputs (no swipe / tick / strike).
 *
 * These are BINARY options, not futures — so the mark isn't a linear
 * price-diff. We use the "if it settled at the current spot" outcome: a
 * position currently in-the-money projects to `+quantity` (the full stake
 * at risk, matching a correct on-chain `payout = correct ? quantity : 0`),
 * out-of-the-money projects to `-quantity` (the stake lost). Flips as the
 * spot crosses the strike. Settled cards skip this and use the contract's
 * binary PnL from `cardOutcomes`.
 */
export function liveCardPnl(
  swipe: SwipeLite | null,
  strike: string | undefined,
  spot: string | undefined
): bigint | null {
  if (!swipe || strike === undefined || spot === undefined) return null
  const s = BigInt(strike)
  const p = BigInt(spot)
  const inMoney = swipe.isUp ? p > s : p <= s
  const q = BigInt(swipe.quantity)
  return inMoney ? q : -q
}

/**
 * Annualized vol assumption for the live mark-to-market below. Short-dated
 * BTC binaries are very sensitive to moneyness near expiry; this constant
 * just sets how reactive the mark is to forward moves. Tunable — it doesn't
 * affect settled PnL, only the smooth pre-settlement projection.
 */
const ASSUMED_VOL = 0.6
const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000

/** Standard normal CDF via Abramowitz & Stegun 7.1.26 erf approximation. */
function normCdf(x: number): number {
  const sign = x < 0 ? -1 : 1
  const z = Math.abs(x) / Math.SQRT2
  const t = 1 / (1 + 0.3275911 * z)
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-z * z)
  return 0.5 * (1 + sign * y)
}

/**
 * Continuous mark-to-market for one swipe, in dUSDC micro-units (1e6).
 *
 * Unlike {@link liveCardPnl} (a binary step that only flips when the spot
 * crosses the strike), this prices the card as the *expected value* of the
 * symmetric win/lose projection: `quantity × (2 × P(in-the-money) − 1)`,
 * which ranges over `[-quantity, +quantity]`. The probability is a digital
 * Black-Scholes estimate from the live spot, strike, and remaining time, so
 * the mark slides smoothly between `-quantity` (p→0) and `+quantity` (p→1)
 * as the spot and clock move — and converges to the exact binary outcome
 * (`liveCardPnl`) at expiry. This is what makes the live chart move
 * continuously instead of sitting flat between strike crossings.
 *
 * No premium is netted in (the wire no longer carries a per-swipe premium)
 * — this is a projection of the win/lose outcome, not a true (payout −
 * premium) P&L. Falls back to the binary outcome when `expiryMs` is
 * unknown or already reached. Returns null when core inputs are missing.
 */
/**
 * Digital "BTC settles strictly above `strike`" probability under the same
 * Black-Scholes model {@link markCardPnl} prices — so a card's shown per-side
 * win odds and its live PnL always agree. Collapses to the binary 0/1 outcome
 * at/after expiry (matching the contract's `actual_up = settlement > strike`).
 * Returns null when `strike`/`spot` are missing or non-positive.
 */
export function upProbability(
  strike: string | undefined,
  spot: string | undefined,
  expiryMs: number | undefined,
  nowMs: number
): number | null {
  if (strike === undefined || spot === undefined) return null
  const f = Number(BigInt(spot))
  const k = Number(BigInt(strike))
  if (!(f > 0) || !(k > 0)) return null
  const tYears = expiryMs !== undefined ? (expiryMs - nowMs) / MS_PER_YEAR : 0
  if (!(tYears > 0)) return f > k ? 1 : 0
  const v = ASSUMED_VOL * Math.sqrt(tYears)
  const d2 = (Math.log(f / k) - 0.5 * v * v) / v
  return normCdf(d2)
}

export function markCardPnl(
  swipe: SwipeLite | null,
  strike: string | undefined,
  spot: string | undefined,
  expiryMs: number | undefined,
  nowMs: number
): bigint | null {
  if (!swipe) return null
  const pUp = upProbability(strike, spot, expiryMs, nowMs)
  if (pUp === null) return null
  const q = Number(BigInt(swipe.quantity))
  const pIn = swipe.isUp ? pUp : 1 - pUp
  return BigInt(Math.round(q * (2 * pIn - 1)))
}

/** The tick fields the mark helpers need — both the duel-view and chart
 *  tick shapes structurally satisfy it. */
export interface TickLite {
  spot: string
  expiryMs?: number
  /** Present once the market settled — the price the contract scores
   *  against (`actual_up = settlement > strike`). */
  settlementPrice?: string
}

/**
 * Mark for one swipe given the latest oracle tick. A settled market LOCKS
 * to the binary outcome at its `settlementPrice` — the live spot must not
 * move it again (the spot re-crossing the strike after expiry would
 * otherwise flip a card that already resolved; the settlement price is
 * what `settle_card` will score against). Unsettled markets keep the
 * continuous Black-Scholes mark from the live spot.
 */
export function tickCardPnl(
  swipe: SwipeLite | null,
  strike: string | undefined,
  tick: TickLite | undefined,
  nowMs: number
): bigint | null {
  if (tick?.settlementPrice != null) {
    // `expiryMs: undefined` collapses the probability to the pure binary
    // outcome of settlementPrice-vs-strike (see `upProbability`).
    return markCardPnl(swipe, strike, tick.settlementPrice, undefined, nowMs)
  }
  return markCardPnl(swipe, strike, tick?.spot, tick?.expiryMs, nowMs)
}

/**
 * Format dUSDC micro-units (1e6) as a signed human string, e.g.
 *   +0.4200 dUSDC
 *   -1.0000 dUSDC
 *    0.0000 dUSDC
 */
export function fmtDusdcSigned(microUnits: bigint): string {
  const sign = microUnits < 0n ? "-" : microUnits > 0n ? "+" : " "
  const abs = microUnits < 0n ? -microUnits : microUnits
  return `${sign}${(Number(abs) / 1e6).toFixed(4)} dUSDC`
}

/**
 * Format a PnL as a signed % return relative to `baseMicro`, e.g. "+100%"
 * on a won card or "-100%" on a lost one. Both args are dUSDC micro-units.
 *
 * `baseMicro` is whatever cost basis / notional the caller has: the real
 * per-duel premium aggregate (`p{0,1}Premium`, still available on chain —
 * see `history.tsx`) when computing a true return, or the swiped
 * `quantity` as a projection when no premium is available (per-swipe
 * `premium` was dropped from the wire — see `liveCardPnl`/`markCardPnl`).
 * Falls back to "—" only when there's nothing to divide by.
 */
export function fmtPnlPct(pnlMicro: bigint, baseMicro: bigint): string {
  if (baseMicro <= 0n) return "—"
  const pct = (Number(pnlMicro) / Number(baseMicro)) * 100
  const sign = pct > 0 ? "+" : ""
  return `${sign}${pct.toFixed(0)}%`
}
