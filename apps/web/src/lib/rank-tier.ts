/**
 * Rating → tier mapping and the pixel-styled badge colors for each tier.
 * Shared by the home `PlayerHeroCard` and the `/game/rank` leaderboard so
 * the same rating always renders the same badge. Derived from the in-game
 * palette (no art assets) — a tinted text + inset ring per tier.
 */
export type Tier = "unranked" | "bronze" | "silver" | "gold" | "platinum"

export function ratingToTier(rating: number | null): Tier {
  if (rating === null) return "unranked"
  if (rating < 1100) return "bronze"
  if (rating < 1300) return "silver"
  if (rating < 1500) return "gold"
  return "platinum"
}

export const TIER_STYLES: Record<
  Tier,
  { label: string; text: string; ring: string }
> = {
  unranked: {
    label: "unranked",
    text: "text-white/55",
    ring: "ring-white/15",
  },
  bronze: {
    label: "bronze",
    text: "text-amber-600",
    ring: "ring-amber-700/40",
  },
  silver: {
    label: "silver",
    text: "text-slate-300",
    ring: "ring-slate-400/40",
  },
  gold: {
    label: "gold",
    text: "text-yellow-300",
    ring: "ring-yellow-400/50",
  },
  platinum: {
    label: "platinum",
    text: "text-cyan-300",
    ring: "ring-cyan-400/50",
  },
}
