/**
 * Season 0 promo banner — a static image styled exactly like the PvP banner
 * (`pvp.tsx`). Rendered inline at the top of the home + leaderboard screens
 * (NOT an absolute overlay). The live countdown, prize breakdown, and per-row
 * prize/eligibility live on the rank screen itself.
 */
export function SeasonBanner({ className = "" }: { className?: string }) {
  return (
    <img
      src="/banners/session-banner.webp"
      alt="season 1"
      className={`block aspect-[3/1] w-full object-cover [image-rendering:pixelated] ${className}`}
    />
  )
}
