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

export function playerDuelResult(
  d: DuelResultInput,
  me: string,
): PlayerResult {
  const side = winnerSideOf(d)
  if (side === "tie") return "tie"
  const myIsP0 = d.creator.toLowerCase() === me.toLowerCase()
  return side === (myIsP0 ? "p0" : "p1") ? "win" : "loss"
}
