/** The duel-wide swipe window, enforced on-chain in
 *  `apps/contracts/sources/duel.move` (SWIPE_WINDOW_MS). `record_swipe` and
 *  `record_swipe_free` abort with ESwipeTimeout past `started_at_ms + this`. */
export const SWIPE_WINDOW_MS = 600_000

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
