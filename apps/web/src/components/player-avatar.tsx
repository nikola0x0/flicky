import { useMemo } from "react"

/**
 * Pixel-art player avatar — randomized 2-color gradient seeded by the
 * wallet address, clipped to a staircase-notched square so the
 * silhouette reads as pixel art. A thin black drop-shadow outline
 * traces the notched edge.
 *
 * Same address always produces the same gradient (deterministic hash
 * of the first 8 hex chars → two HSL hues), so an opponent's avatar
 * is consistent across views.
 *
 * Pass no `address` and you get a neutral placeholder gradient — useful
 * for skeletons or signed-out states.
 */
export function PlayerAvatar({
  address,
  size = 40,
  className = "",
}: {
  address?: string
  size?: number
  className?: string
}) {
  const gradient = useMemo(() => addressToGradient(address), [address])
  return (
    <div
      aria-hidden
      className={`pixel-avatar shrink-0 ${className}`}
      style={{
        width: size,
        height: size,
        background: gradient,
      }}
    />
  )
}

function addressToGradient(address?: string): string {
  if (!address) {
    return "linear-gradient(135deg, #94a3b8, #475569)"
  }
  const hex = address.toLowerCase().replace(/^0x/, "")
  const h1 = parseInt(hex.slice(0, 4) || "0", 16) % 360
  const h2 = parseInt(hex.slice(4, 8) || "0", 16) % 360
  return `linear-gradient(135deg, hsl(${h1}, 78%, 60%), hsl(${h2}, 82%, 50%))`
}
