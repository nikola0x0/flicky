import { useEffect } from "react"
import { createPortal } from "react-dom"
import { useDisconnectWallet } from "@mysten/dapp-kit"

import { PixelButton } from "@/components/pixel-button"

/**
 * Burger-menu popup. Currently just hosts the logout action — wire
 * additional menu items into the button column below as the game
 * grows (inventory, referrals, how-to-play, language, etc.).
 *
 * Portal-mounted so it dims the mobile frame AND the outer checker
 * background, identical pattern to <LoginModal>.
 */
export interface MenuModalProps {
  open: boolean
  onClose: () => void
}

export function MenuModal({ open, onClose }: MenuModalProps) {
  const { mutate: disconnect } = useDisconnectWallet()

  const handleLogout = () => {
    disconnect()
    onClose()
  }

  useEffect(() => {
    if (!open) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.body.style.overflow = "hidden"
    window.addEventListener("keydown", handleKey)
    return () => {
      document.body.style.overflow = ""
      window.removeEventListener("keydown", handleKey)
    }
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="menu-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className="pixel-frame relative w-full max-w-xs rounded-3xl bg-[#1b2548] font-pixel text-white"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="close"
          className="absolute top-3 right-3 grid size-7 place-items-center text-base text-white/55 hover:text-white"
        >
          ✕
        </button>

        <header className="px-6 pt-7 pb-3 text-center">
          <h2 id="menu-title" className="text-2xl tracking-[0.18em] uppercase">
            menu
          </h2>
        </header>

        <div className="flex flex-col gap-3 px-6 pb-6">
          <PixelButton onClick={handleLogout} className="h-12">
            <span className="flex w-full items-center justify-center gap-2 text-2xl">
              <img
                src="/icons/exit.png"
                alt=""
                aria-hidden
                className="size-5 [image-rendering:pixelated]"
              />
              logout
            </span>
          </PixelButton>
        </div>
      </div>
    </div>,
    document.body
  )
}
