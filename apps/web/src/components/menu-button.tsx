import { useState } from "react"

import { MenuModal } from "@/components/menu-modal"
import { PixelButton } from "@/components/pixel-button"

/**
 * Gear/burger button that owns its own menu-popup state. Drop into any
 * header — clicking opens <MenuModal>, which dims the entire viewport
 * via a portal. Self-contained, no parent wiring required.
 */
export function MenuButton({ className = "" }: { className?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <PixelButton
        variant="bordered"
        aria-label="menu"
        onClick={() => setOpen(true)}
        className={`size-10 !p-0 ${className}`}
      >
        <img
          src="/icons/gear.png"
          alt=""
          aria-hidden
          className="size-6 [image-rendering:pixelated]"
        />
      </PixelButton>
      <MenuModal open={open} onClose={() => setOpen(false)} />
    </>
  )
}
