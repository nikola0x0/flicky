import type { ReactNode } from "react"

import { PixelButton } from "@/components/pixel-button"

/**
 * "Find Match" / "Practice" style CTA. Wraps <PixelButton> with the
 * label + beveled divider + stake-chip layout. For plain pixel-style
 * buttons (icons, system controls, modal actions) use <PixelButton>
 * directly.
 */
export function MatchButton({
  label,
  stake,
  onClick,
  disabled,
  variant = "default",
  className = "",
}: {
  label: ReactNode
  stake?: ReactNode
  onClick?: () => void
  disabled?: boolean
  variant?: "default" | "bordered"
  className?: string
}) {
  return (
    <PixelButton
      variant={variant}
      onClick={onClick}
      disabled={disabled}
      className={`h-14 w-full ${className}`}
    >
      <span className="flex w-full items-center">
        <span className="flex flex-1 items-center justify-center">{label}</span>
        {stake !== undefined && (
          <>
            <span
              aria-hidden
              className="ml-2 mr-1 h-8 w-0.5 shrink-0 bg-black/45 shadow-[1px_0_0_rgba(255,255,255,0.18)]"
            />
            <span className="inline-flex h-9 shrink-0 items-center justify-center gap-1 px-1.5 leading-none">
              {stake}
            </span>
          </>
        )}
      </span>
    </PixelButton>
  )
}
