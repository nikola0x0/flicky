/**
 * PnL projection helpers for the active-duel UI.
 *
 * Settled cards use the contract's binary PnL — `payout - premium`,
 * available through `room_state.p{0,1}Payout` / `p{0,1}Premium` once
 * `settle_card` lands (accumulated incrementally per card; `finalize`
 * then distributes the pot). Unsettled-but-swiped cards use a smooth
 * mark-to-market projection from `oracle_tick`'s live forward price:
 *
 *   diff = isUp ? (forward - strike) : (strike - forward)
 *   pnl  = diff * quantity / FLOAT_SCALING (1e9)
 *
 * Mirrors `liveCardPnl` / `runningPnl` in apps/playground.
 */

export interface SwipeLite {
  isUp: boolean
  quantity: string
  premium: string
}

/**
 * Live PnL for one swipe, in dUSDC micro-units (1e6). Returns null when we
 * lack the inputs (no swipe / tick / strike).
 *
 * These are BINARY options, not futures — so the mark isn't a linear
 * price-diff. We use the "if it settled at the current forward" outcome:
 * a position currently in-the-money is worth its full `quantity` (so PnL =
 * quantity − premium), and out-of-the-money is worth 0 (PnL = −premium).
 * Bounded to [−premium, quantity − premium], flipping as the forward
 * crosses the strike. Settled cards skip this and use the contract's binary
 * PnL from `cardOutcomes`.
 */
export function liveCardPnl(
  swipe: SwipeLite | null,
  strike: string | undefined,
  forward: string | undefined,
): bigint | null {
  if (!swipe || strike === undefined || forward === undefined) return null
  const s = BigInt(strike)
  const f = BigInt(forward)
  const inMoney = swipe.isUp ? f >= s : f < s
  const q = BigInt(swipe.quantity)
  const premium = BigInt(swipe.premium)
  return inMoney ? q - premium : -premium
}

/**
 * Combined running PnL for `side` = settled real PnL + live mark-to-market.
 *
 * Settled portion: `payout - premium` from the contract's aggregate
 * fields (truth — already netted across all settled cards).
 * Live portion: sum of `liveCardPnl` over cards that have a swipe + a
 * tick but aren't in `cardOutcomes` yet. Swiped cards without a tick
 * are skipped (honest unknown), unswiped cards contribute 0.
 */
export function runningPnl(
  rs: {
    p0Payout: string
    p0Premium: string
    p1Payout: string
    p1Premium: string
    cardOutcomes: Array<{ cardIdx: number }>
    swipes: Array<{
      cardIdx: number
      p0Swipe: SwipeLite | null
      p1Swipe: SwipeLite | null
    }>
  },
  side: "p0" | "p1",
  deck: { cards: Array<{ oracle_id: string; strike: string }> } | null,
  ticks: Record<string, { spot: string; forward: string }>,
): bigint {
  const settled =
    side === "p0"
      ? BigInt(rs.p0Payout) - BigInt(rs.p0Premium)
      : BigInt(rs.p1Payout) - BigInt(rs.p1Premium)
  const settledIdx = new Set(rs.cardOutcomes.map((o) => o.cardIdx))
  let live = 0n
  for (const s of rs.swipes) {
    if (settledIdx.has(s.cardIdx)) continue
    const swipe = side === "p0" ? s.p0Swipe : s.p1Swipe
    if (!swipe) continue
    const card = deck?.cards[s.cardIdx]
    if (!card) continue
    const tick = ticks[card.oracle_id]
    if (!tick) continue
    const pnl = liveCardPnl(swipe, card.strike, tick.forward)
    if (pnl !== null) live += pnl
  }
  return settled + live
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
 * Format a PnL as a signed % return on the premium paid, e.g. "+48x"-grade
 * upside on a long-shot card or "-100%" on a lost one. Both args are dUSDC
 * micro-units. Falls back to "—" when there's no premium to measure against.
 */
export function fmtPnlPct(pnlMicro: bigint, premiumMicro: bigint): string {
  if (premiumMicro <= 0n) return "—"
  const pct = (Number(pnlMicro) / Number(premiumMicro)) * 100
  const sign = pct > 0 ? "+" : ""
  return `${sign}${pct.toFixed(0)}%`
}
