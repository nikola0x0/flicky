import { useEffect, type CSSProperties } from "react"
import { createPortal } from "react-dom"
import { useConnectWallet, useWallets } from "@mysten/dapp-kit"
import { isGoogleWallet } from "@mysten/enoki"

import { PixelButton } from "@/components/pixel-button"

const SLUSH_INSTALL_URL = "https://slush.app/"

/**
 * Brand-color overrides for the pixel-cabinet button. Each instance
 * gets its own --btn-bg / --btn-highlight / --btn-text-shadow via
 * inline style, set as CSS custom properties.
 */
const GOOGLE_BRAND_STYLE = {
  "--btn-bg": "#ffffff",
  "--btn-highlight": "#ffffff",
  "--btn-text-shadow": "none",
} as CSSProperties

const SLUSH_BRAND_STYLE = {
  "--btn-bg": "#4094fb",
  "--btn-highlight": "#7eb6ff",
  "--btn-text-shadow": "0 1px 0 rgba(0, 0, 0, 0.35)",
} as CSSProperties

/**
 * Sign-in popup. Mounted via createPortal so it overlays the mobile
 * frame AND the checker background outside it — anything underneath
 * gets dimmed by the backdrop regardless of stacking context.
 *
 * Closes on Escape, on backdrop click, or via the X button.
 *
 * Two sign-in paths:
 *   - Google (Enoki zkLogin) — registered via registerEnokiWallets in
 *     main.tsx, found here via isGoogleWallet().
 *   - Slush — a browser-extension Sui wallet, detected via the wallet-
 *     standard registry. Falls back to an install link if not present.
 */
export interface LoginModalProps {
  open: boolean
  onClose: () => void
}

export function LoginModal({ open, onClose }: LoginModalProps) {
  const wallets = useWallets()
  const { mutate: connectWallet, isPending: isConnecting } = useConnectWallet()

  const googleWallet = wallets.find(isGoogleWallet)
  const slushWallet = wallets.find(
    (w) =>
      w.name.toLowerCase().includes("slush") ||
      // Older versions of Slush still reported as "Sui Wallet".
      w.name === "Sui Wallet",
  )

  const connectAndClose = (wallet: (typeof wallets)[number]) => {
    connectWallet({ wallet }, { onSuccess: () => onClose() })
  }

  const handleGoogle = () => {
    if (googleWallet) connectAndClose(googleWallet)
  }

  const handleSlush = () => {
    if (!slushWallet) {
      window.open(SLUSH_INSTALL_URL, "_blank", "noopener,noreferrer")
      return
    }
    connectAndClose(slushWallet)
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
      aria-labelledby="login-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className="pixel-frame relative w-full max-w-sm rounded-3xl bg-[#1b2548] font-pixel text-white"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="close"
          className="absolute right-3 top-3 grid size-7 place-items-center text-base text-white/55 hover:text-white"
        >
          ✕
        </button>

        <header className="px-6 pb-4 pt-7 text-center">
          <h2
            id="login-title"
            className="text-base uppercase tracking-[0.18em]"
          >
            sign in to flicky
          </h2>
          <p className="mt-1 text-xs uppercase tracking-[0.18em] text-white/45">
            zklogin via enoki
          </p>
        </header>

        <div className="flex flex-col gap-3 px-6 pb-6">
          <PixelButton
            onClick={handleGoogle}
            disabled={!googleWallet || isConnecting}
            style={GOOGLE_BRAND_STYLE}
            className="h-12 !text-neutral-900"
          >
            <span className="flex w-full items-center justify-center gap-2">
              <img
                src="/login_icons/google_icon.png"
                alt=""
                aria-hidden
                className="size-5"
              />
              continue with google
            </span>
          </PixelButton>

          <div className="my-1 flex items-center gap-3 text-[10px] uppercase tracking-[0.2em] text-white/35">
            <span className="h-px flex-1 bg-white/15" />
            or
            <span className="h-px flex-1 bg-white/15" />
          </div>

          <PixelButton
            onClick={handleSlush}
            disabled={isConnecting}
            style={SLUSH_BRAND_STYLE}
            className="h-12"
          >
            <span className="flex w-full items-center justify-center gap-2">
              <img
                src="/login_icons/slush_icon.png"
                alt=""
                aria-hidden
                className="size-5"
              />
              {slushWallet ? "continue with slush" : "install slush"}
            </span>
          </PixelButton>

          <p className="mt-2 text-center text-[10px] uppercase tracking-[0.18em] text-white/35">
            google uses zklogin — your account stays with google. slush is a sui wallet extension.
          </p>
        </div>
      </div>
    </div>,
    document.body,
  )
}

