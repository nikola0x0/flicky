import { useEffect } from "react"
import { createPortal } from "react-dom"

import {
  ACTIVE_NETWORK,
  AVAILABLE_NETWORKS,
  setNetwork,
  type FlickyNetwork,
} from "@/lib/network"
import { useModalSfx, playSfx } from "@/lib/sound"

/**
 * Per-network chip colouring. Mainnet gets the warning-amber treatment so
 * the active chain is never ambiguous at a glance — on mainnet a swipe
 * would spend real money, so this is deliberately the loudest thing in the
 * header after the balances.
 */
const NETWORK_STYLE: Record<FlickyNetwork, { dot: string; text: string }> = {
  testnet: { dot: "bg-[#7ec8e3]", text: "text-[#7ec8e3]" },
  mainnet: { dot: "bg-[#f5a524]", text: "text-[#f5a524]" },
}

const NETWORK_BLURB: Record<FlickyNetwork, string> = {
  testnet: "free test coins. full game.",
  mainnet: "real funds. duels not live yet.",
}

/**
 * Header network chip. Tapping opens the picker; picking a different
 * network persists it and reloads the page (see `lib/network.ts` — CONFIG,
 * the dApp Kit client, and the WS socket are all pinned per page load).
 *
 * Renders nothing when the deploy only offers one network
 * (`VITE_SUI_NETWORKS=testnet`), so a single-network build has no dead
 * control in its header.
 */
export function NetworkSwitcher({
  open,
  onOpen,
  onClose,
}: {
  open: boolean
  onOpen: () => void
  onClose: () => void
}) {
  if (AVAILABLE_NETWORKS.length < 2) return null

  const style = NETWORK_STYLE[ACTIVE_NETWORK]

  return (
    <>
      <button
        type="button"
        id="network-chip"
        onClick={() => {
          playSfx("click")
          onOpen()
        }}
        aria-label={`network: ${ACTIVE_NETWORK}. tap to switch`}
        className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-[#1f1812] px-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.05),inset_0_-1px_0_rgba(0,0,0,0.4)] transition-opacity hover:opacity-85"
      >
        <span
          aria-hidden
          className={`size-2 shrink-0 rounded-full ${style.dot}`}
        />
        <span className={`text-sm tracking-[0.12em] uppercase ${style.text}`}>
          {ACTIVE_NETWORK}
        </span>
      </button>

      <NetworkPicker open={open} onClose={onClose} />
    </>
  )
}

function NetworkPicker({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  useModalSfx(open)

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
      aria-labelledby="network-title"
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-[2px]"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="pixel-frame relative w-full max-w-sm rounded-3xl bg-[#1b2548] font-pixel text-white"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="close"
          className="absolute top-3 right-3 z-10 grid size-7 place-items-center text-2xl text-white/55 hover:text-white"
        >
          ✕
        </button>

        <header className="px-6 pt-7 pb-3 text-center">
          <h2
            id="network-title"
            className="text-2xl tracking-[0.18em] uppercase"
          >
            network
          </h2>
          <p className="mt-1 text-[14px] leading-relaxed text-white/55">
            switching reloads the app
          </p>
        </header>

        <div className="flex flex-col gap-3 px-5 pb-6">
          {AVAILABLE_NETWORKS.map((net) => (
            <NetworkOption
              key={net}
              network={net}
              active={net === ACTIVE_NETWORK}
              onSelect={() => setNetwork(net)}
            />
          ))}
        </div>
      </div>
    </div>,
    document.body
  )
}

function NetworkOption({
  network,
  active,
  onSelect,
}: {
  network: FlickyNetwork
  active: boolean
  onSelect: () => void
}) {
  const style = NETWORK_STYLE[network]
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={active}
      aria-current={active ? "true" : undefined}
      className={`pixel-tile flex w-full items-center gap-3 px-4 py-3 text-left ${
        active ? "opacity-100" : "opacity-70 hover:opacity-100"
      }`}
    >
      <span
        aria-hidden
        className={`size-2.5 shrink-0 rounded-full ${style.dot}`}
      />
      <div className="min-w-0 flex-1">
        <div className={`text-lg tracking-[0.14em] uppercase ${style.text}`}>
          {network}
        </div>
        <div className="truncate text-[14px] text-white/60">
          {NETWORK_BLURB[network]}
        </div>
      </div>
      {active && (
        <span className="shrink-0 text-[13px] tracking-[0.12em] text-white/45 uppercase">
          active
        </span>
      )}
    </button>
  )
}
