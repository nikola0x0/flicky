import { useMemo } from "react"
import { iconSrc } from "@/lib/avatar-icons"
import { useAvatarIcon } from "@/lib/avatar-store"

/**
 * Pixel-art player avatar — an address-seeded 2-color gradient clipped to
 * a staircase-notched square (`.pixel-avatar`), with an optional food
 * icon centered on top.
 *
 * The icon defaults to whatever the player selected for `address`
 * (persisted client-side, so in practice only the local user's own
 * avatar shows one — opponents stay gradient-only). Pass `icon` to
 * override: a valid icon id forces one (e.g. the picker preview), `null`
 * forces gradient-only.
 *
 * Same address always produces the same gradient (deterministic hash of
 * the first 8 hex chars -> two HSL hues), so an opponent's avatar is
 * consistent across views.
 */
export function PlayerAvatar({
  address,
  size = 40,
  className = "",
  icon,
}: {
  address?: string
  size?: number
  className?: string
  icon?: string | null
}) {
  const gradient = useMemo(() => addressToGradient(address), [address])
  const stored = useAvatarIcon(address)
  const iconId = icon === undefined ? stored : icon
  return (
    <div
      aria-hidden
      className={`relative shrink-0 ${className}`}
      style={{ width: size, height: size }}
    >
      <div
        className="pixel-avatar absolute inset-0"
        style={{ background: gradient }}
      />
      {iconId && (
        <img
          src={iconSrc(iconId)}
          alt=""
          aria-hidden
          className="pointer-events-none absolute inset-0 m-auto [image-rendering:pixelated]"
          style={{ width: "64%", height: "64%" }}
        />
      )}
    </div>
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
