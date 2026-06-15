/**
 * One-shot signal for the direction of the next in-frame route-swipe across
 * a top-level route boundary (game ⇆ /profile), where the two routes are
 * separate trees and can't share React Router's per-Outlet transition state.
 *
 * Opening /profile is self-evident (its content always swipes in from the
 * right on mount), but the *return* to the game needs to know it should swipe
 * in from the left rather than hard-cut. The profile back button sets this
 * flag; the game outlet reads it on its first mount.
 *
 * Module-level (not React state) so it survives the route swap. Read with
 * `peekPendingSwipe()` during render (pure) and retire with
 * `clearPendingSwipe()` from an effect, so a later game mount (e.g. the
 * landing→game CRT) doesn't inherit a stale swipe.
 */
type SwipeClass = "route-swipe-from-left" | "route-swipe-from-right"

let pending: SwipeClass | null = null

export function setPendingSwipe(swipe: SwipeClass) {
  pending = swipe
}

export function peekPendingSwipe(): SwipeClass | null {
  return pending
}

export function clearPendingSwipe() {
  pending = null
}
