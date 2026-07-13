/**
 * Tour step definitions — a single unified "welcome" tour that walks
 * the player through every screen. Each step can optionally specify a
 * `route` to auto-navigate to before highlighting the target element.
 */

export interface TourStep {
  /** DOM id of the element to spotlight. */
  targetId: string
  /** Short description shown in the tooltip. */
  description: string
  /** Optional: preferred tooltip position relative to target. */
  placement?: "top" | "bottom" | "left" | "right"
  /** Optional: the route this step lives on. The tour will navigate here
   *  before highlighting. If omitted, stays on the current page. */
  route?: string
}

export type TourId = "welcome"

export const TOURS: Record<TourId, TourStep[]> = {
  /**
   * Unified welcome tour — guides a new player through:
   *   1. Home screen controls (header, balances, nav)
   *   2. PvP page controls (stake, queue, mode)
   *
   * The `swipe` steps are triggered separately during actual gameplay
   * since they need a live game session to be meaningful.
   */
  welcome: [
    // ── Home screen: header ──────────────────────────────────────
    {
      targetId: "header-avatar",
      description: "Tap your avatar to view profile & stats",
      placement: "bottom",
      route: "/game/home",
    },
    {
      targetId: "balance-wallet",
      description: "Your wallet dUSDC balance — tap + to top up",
      placement: "bottom",
      route: "/game/home",
    },
    {
      targetId: "balance-manager",
      description: "Manager balance funds your duels",
      placement: "bottom",
      route: "/game/home",
    },

    // ── Home screen: bottom nav ──────────────────────────────────
    {
      targetId: "nav-home",
      description: "Home: your dashboard & active matches",
      placement: "top",
      route: "/game/home",
    },
    {
      targetId: "nav-pvp",
      description: "PvP: queue for a real-time duel!",
      placement: "top",
      route: "/game/home",
    },
    {
      targetId: "nav-shop",
      description: "Shop: buy dUSDC to fund your duels",
      placement: "top",
      route: "/game/home",
    },

    // ── PvP screen ───────────────────────────────────────────────
    {
      targetId: "stake-selector",
      description: "Pick your stake — higher stakes, bigger wins",
      placement: "bottom",
      route: "/game/pvp",
    },
    {
      targetId: "queue-match-btn",
      description: "Queue for a live PvP match",
      placement: "top",
      route: "/game/pvp",
    },
    {
      targetId: "game-mode-btn",
      description: "Switch between game modes",
      placement: "top",
      route: "/game/pvp",
    },
  ],
}
