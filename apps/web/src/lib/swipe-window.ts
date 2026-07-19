/** The duel-wide swipe window, enforced on-chain in
 *  `apps/contracts/sources/duel.move` (SWIPE_WINDOW_MS). `record_swipe` and
 *  `record_swipe_free` abort with ESwipeTimeout past `started_at_ms + this`. */
export const SWIPE_WINDOW_MS = 300_000

/** Buffer subtracted from a card's market expiry to get its swipe deadline.
 *  Covers zkLogin sign + sponsor round-trip + build + execute (longest
 *  measured ~12s) so a swipe fired at the deadline still lands while the
 *  market is live. Keep in sync with `DECK_TX_BUFFER_MS` on the server
 *  (`apps/server/src/env.ts`). */
export const CARD_SWIPE_BUFFER_MS = 20_000

/** Milliseconds left in the swipe window, anchored to chain truth.
 *  `serverClockOffsetMs` (= serverNowMs - Date.now(), captured from
 *  `match_tick`) corrects for a skewed client clock. Negative = expired. */
export function swipeWindowRemainingMs(params: {
  startedAtMs: number
  serverClockOffsetMs: number
  nowMs: number
}): number {
  const deadline = params.startedAtMs + SWIPE_WINDOW_MS
  const serverEstimatedNow = params.nowMs + params.serverClockOffsetMs
  return deadline - serverEstimatedNow
}

/** Milliseconds left to swipe THIS card, anchored to chain truth: its
 *  market's `expiry − CARD_SWIPE_BUFFER_MS`. With the tiered deck, short
 *  (3-min) cards resolve well before the 5-min match window, so the per-card
 *  deadline — not the match window — is the binding constraint; the caller
 *  swipes/forfeits against `min(this, swipeWindowRemainingMs)`. Negative =
 *  past deadline. Returns `null` when the card's expiry isn't known yet. */
export function cardSwipeRemainingMs(params: {
  cardExpiryMs: number | undefined
  serverClockOffsetMs: number
  nowMs: number
}): number | null {
  if (params.cardExpiryMs === undefined) return null
  const deadline = params.cardExpiryMs - CARD_SWIPE_BUFFER_MS
  const serverEstimatedNow = params.nowMs + params.serverClockOffsetMs
  return deadline - serverEstimatedNow
}
