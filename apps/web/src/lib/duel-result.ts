/**
 * Single source of truth for classifying a finished duel as win/loss/tie
 * for a given player. Used by the home card, history, and anywhere else
 * that shows a W/L so they never disagree.
 *
 * Prefers the authoritative `winner` the server mirrors from the on-chain
 * DuelFinalized event. For older rows finalized before that column existed
 * (`winner` null), it falls back to the contract's own rule: the
 * head-to-head net comparison `p0_net` vs `p1_net`. This mirrors
 * apps/server/src/mmr.ts:outcomeFromDuel exactly.
 */
export type DuelWinner = "p0" | "p1" | "tie"
export type PlayerResult = "win" | "loss" | "tie"

export interface DuelResultInput {
  creator: string
  p0Payout: string
  p0Premium: string
  p1Payout: string
  p1Premium: string
  winner?: DuelWinner | null
}

export function winnerSideOf(d: DuelResultInput): DuelWinner {
  if (d.winner === "p0" || d.winner === "p1" || d.winner === "tie") {
    return d.winner
  }
  const p0Net = BigInt(d.p0Payout) - BigInt(d.p0Premium)
  const p1Net = BigInt(d.p1Payout) - BigInt(d.p1Premium)
  if (p0Net > p1Net) return "p0"
  if (p1Net > p0Net) return "p1"
  return "tie"
}

export function playerDuelResult(d: DuelResultInput, me: string): PlayerResult {
  const side = winnerSideOf(d)
  if (side === "tie") return "tie"
  const myIsP0 = d.creator.toLowerCase() === me.toLowerCase()
  return side === (myIsP0 ? "p0" : "p1") ? "win" : "loss"
}

/**
 * Everything the post-match result card shows, computed from fields the
 * duel-detail endpoint already returns. Outcome defers to
 * `winnerSideOf` (on-chain `winner` preferred, net comparison fallback)
 * so the card can never disagree with the home tile / history W-L.
 *
 * hits counts settled cards where the player swiped and PnL ≥ 0 — the
 * exact rule duel-view's CardTile uses for its win badge. Free/social
 * duels (premium 0) get no odds/net: there is no stake to multiply.
 */
export interface DuelSummaryInput extends DuelResultInput {
  cardCount: number
  cardOutcomes: Array<{
    p0Pnl: string | null
    p1Pnl: string | null
    p0Swipe: { isUp: boolean } | null
    p1Swipe: { isUp: boolean } | null
  }>
}

export interface DuelSummary {
  outcome: PlayerResult
  hits: number
  totalCards: number
  freeDuel: boolean
  oddsLabel: string | null
  netLabel: string | null
  shareText: string
}

export function summarizeDuelResult(
  d: DuelSummaryInput,
  myIsP0: boolean
): DuelSummary {
  const side = winnerSideOf(d)
  const outcome: PlayerResult =
    side === "tie" ? "tie" : side === (myIsP0 ? "p0" : "p1") ? "win" : "loss"
  const hits = d.cardOutcomes.filter((o) => {
    const swipe = myIsP0 ? o.p0Swipe : o.p1Swipe
    const pnl = myIsP0 ? o.p0Pnl : o.p1Pnl
    return swipe !== null && pnl !== null && BigInt(pnl) >= 0n
  }).length
  const totalCards = Math.max(d.cardCount, d.cardOutcomes.length)
  const payout = BigInt(myIsP0 ? d.p0Payout : d.p1Payout)
  const premium = BigInt(myIsP0 ? d.p0Premium : d.p1Premium)
  const freeDuel = premium === 0n
  const oddsLabel = freeDuel
    ? null
    : `${(Number(payout) / Number(premium)).toFixed(1)}×`
  const netLabel = freeDuel ? null : fmtNetShort(payout - premium)
  const parts = [`${hits}/${totalCards} hits`]
  if (oddsLabel) parts.push(`${oddsLabel} odds`)
  if (netLabel) parts.push(`${netLabel} dUSDC`)
  return {
    outcome,
    hits,
    totalCards,
    freeDuel,
    oddsLabel,
    netLabel,
    shareText: `flicky duel — ${parts.join(" · ")} — watch:`,
  }
}

/** micro-dUSDC → compact signed amount: "+7", "-2", "+6.5". */
function fmtNetShort(micro: bigint): string {
  const sign = micro < 0n ? "-" : micro > 0n ? "+" : ""
  const abs = micro < 0n ? -micro : micro
  const units = Number(abs) / 1e6
  const label = Number.isInteger(units)
    ? units.toString()
    : units.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")
  return `${sign}${label}`
}
