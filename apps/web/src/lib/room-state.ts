import type { SwipeLite } from "@/lib/pnl"

/**
 * Mirror of `room_state` from the server. Kept loose so consumers don't
 * pull the full ServerMsg discriminated-union narrowing inline. Practice
 * mode synthesizes this same shape locally (see use-practice-session.ts)
 * so the charts/ledger render identically in both modes.
 */
export interface RoomState {
  duelId: string
  status: "PENDING" | "ACTIVE" | "COMPLETE"
  cardsRevealed: boolean
  cardCount: number
  cards: Array<{ expiry_market_id: string; strike: string }>
  settledCount: number
  p0Payout: string
  p0Premium: string
  p1Payout: string
  p1Premium: string
  startedAtMs: number
  creator: string
  challenger: string
  stakeCoinType: string
  cardOutcomes: Array<{
    cardIdx: number
    settlementPrice: string
    strike: string
    upWon: boolean
    p0Pnl: string | null
    p1Pnl: string | null
    p0Swipe: WireSwipe | null
    p1Swipe: WireSwipe | null
  }>
  swipes: Array<{
    cardIdx: number
    p0Swipe: WireSwipe | null
    p1Swipe: WireSwipe | null
  }>
}

export type WireSwipe = { isUp: boolean; quantity: string; orderId: string }

/**
 * Narrows a wire swipe (which carries `orderId`) down to the `SwipeLite`
 * shape `pnl.ts`'s helpers need.
 */
export function toSwipeLite(swipe: WireSwipe | null): SwipeLite | null {
  return swipe ? { isUp: swipe.isUp, quantity: swipe.quantity } : null
}
