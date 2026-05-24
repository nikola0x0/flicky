import type { ButtonHTMLAttributes, ReactNode } from "react"

type Variant = "default" | "bordered"

/**
 * Single source of truth for the green pixel-cabinet button used across
 * the game. Two variants:
 *
 *   - "default"  → flat green slab with notched corners + bevel
 *   - "bordered" → same, plus a 2 px hard black outline traced around
 *                  the staircase silhouette via filter: drop-shadow
 *
 * Hover and disabled visuals are driven by the CSS class (see
 * `.default-btn-green-container` in globals.css) so the bordered variant
 * keeps its outline through hover/disabled state changes.
 *
 * Use this directly for any pixel-style CTA. For the Find-Match style
 * label + divider + stake chip layout, use <MatchButton> which wraps
 * this component.
 */
export interface PixelButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  children: ReactNode
}

export function PixelButton({
  variant = "default",
  className = "",
  children,
  type = "button",
  ...rest
}: PixelButtonProps) {
  const variantClass =
    variant === "bordered"
      ? "default-btn-green-container with-border"
      : "default-btn-green-container"

  return (
    <button
      type={type}
      className={`
        ${variantClass}
        group inline-flex items-center justify-center
        px-3 py-2 text-white uppercase
        text-sm sm:text-base
        ${className}
      `}
      {...rest}
    >
      {children}
    </button>
  )
}
