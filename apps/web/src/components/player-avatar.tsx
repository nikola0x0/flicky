import { useMemo } from "react"
import { iconSrc } from "@/lib/avatar-icons"
import { addressToGradient } from "@/lib/avatar-gradient"
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
