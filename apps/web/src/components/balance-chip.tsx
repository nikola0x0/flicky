import type { CSSProperties } from "react"
import { useNavigate } from "react-router"

import { PixelButton } from "@/components/pixel-button"

const PLUS_BUTTON_STYLE = {
  "--btn-bg": "#4094fb",
  "--btn-highlight": "#7eb6ff",
} as CSSProperties

/**
 * Game-currency chip — dark capsule with the token icon poking out the
 * left side, the amount centered in the dark fill, and a chunky blue
 * pixel-art "+" button on the right that navigates to `to` (typically
 * the deposit/swap page).
 */
export function BalanceChip({
  icon,
  amount,
  to,
  label,
}: {
  icon: string
  amount: string
  to: string
  label?: string
}) {
  const navigate = useNavigate()
  return (
    <div className="flex items-center">
      <div className="relative flex h-8 items-center rounded-lg bg-[#1f1812] pl-8 pr-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.05),inset_0_-1px_0_rgba(0,0,0,0.4)]">
        <img
          src={icon}
          alt=""
          aria-hidden
          className="absolute -left-2 top-1/2 size-8 -translate-y-1/2 [image-rendering:pixelated]"
        />
        <span className="text-base tabular-nums tracking-wider text-white">
          {amount}
        </span>
      </div>
      <PixelButton
        onClick={() => navigate(to)}
        style={PLUS_BUTTON_STYLE}
        aria-label={label ? `add ${label}` : "add"}
        className="-ml-2 size-7 !p-0 text-base"
      >
        +
      </PixelButton>
    </div>
  )
}
