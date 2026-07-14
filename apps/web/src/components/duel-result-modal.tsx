import { useEffect, useState } from "react"
import { createPortal } from "react-dom"
import type { CSSProperties } from "react"
import { PixelButton } from "@/components/pixel-button"
import { PlayerAvatar } from "@/components/player-avatar"
import type { DuelSummary } from "@/lib/duel-result"
import { playSfx } from "@/lib/sound"

const BLUE_BRAND_STYLE = {
  "--btn-bg": "#4094fb",
  "--btn-highlight": "#7eb6ff",
} as CSSProperties

const OUTCOME_COPY = {
  win: { title: "you win!", tone: "text-emerald-300" },
  loss: { title: "you lose", tone: "text-rose-300" },
  tie: { title: "draw", tone: "text-white" },
} as const

/**
 * Post-match result card — pops over the duel view when a participant's
 * duel completes (see duel-view.tsx for the trigger + seen-guard).
 * Share = Web Share where available; copy-link always. The duel-view
 * URL is public (read-only), so recipients land without signing in.
 */
export function DuelResultModal({
  open,
  onClose,
  duelId,
  summary,
  myAddress,
  oppAddress,
}: {
  open: boolean
  onClose: () => void
  duelId: string
  summary: DuelSummary
  myAddress?: string
  oppAddress: string
}) {
  const [copied, setCopied] = useState(false)
  const url = `${window.location.origin}/game/duel/${duelId}`
  const canShare = typeof navigator !== "undefined" && "share" in navigator

  // Fanfare + escape-to-close + body-scroll lock while open (same
  // conventions as the game's other portal modals).
  useEffect(() => {
    if (!open) return
    playSfx(
      summary.outcome === "win"
        ? "duel-win"
        : summary.outcome === "loss"
          ? "duel-lose"
          : "modal-open"
    )
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.body.style.overflow = "hidden"
    window.addEventListener("keydown", onKey)
    return () => {
      document.body.style.overflow = ""
      window.removeEventListener("keydown", onKey)
    }
  }, [open, onClose, summary.outcome])

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(t)
  }, [copied])

  if (!open) return null
  const copy = OUTCOME_COPY[summary.outcome]

  const onShare = () => {
    void navigator.share({ text: summary.shareText, url }).catch(() => {})
  }
  const onCopy = () => {
    try {
      void navigator.clipboard
        ?.writeText(url)
        .then(() => setCopied(true))
        .catch(() => {})
    } catch {
      /* clipboard unavailable — enhancement only */
    }
  }

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="duel-result-title"
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-[2px]"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="pixel-frame relative w-full max-w-sm rounded-3xl bg-[#1b2548] px-6 pt-9 pb-6 font-pixel text-white"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="close"
          className="absolute top-3 right-3 grid size-8 place-items-center text-xl text-white/55 hover:text-white"
        >
          ✕
        </button>

        <h2
          id="duel-result-title"
          className={`text-center text-4xl tracking-[0.16em] uppercase ${copy.tone}`}
        >
          {copy.title}
        </h2>

        <div className="mt-5 flex items-center justify-center gap-4">
          <PlayerAvatar address={myAddress} size={64} />
          <span className="text-xl tracking-[0.2em] text-white/55 uppercase">
            vs
          </span>
          <PlayerAvatar address={oppAddress} size={64} />
        </div>

        <div className="mt-5 grid grid-cols-3 gap-2 text-center">
          <Stat value={`${summary.hits}/${summary.totalCards}`} label="hits" />
          {summary.freeDuel ? (
            <div className="col-span-2 grid place-items-center rounded bg-black/30 px-2 py-2">
              <span className="text-sm tracking-[0.15em] text-cyan-200/85 uppercase">
                free duel
              </span>
            </div>
          ) : (
            <>
              <Stat value={summary.oddsLabel ?? "—"} label="odds" />
              <Stat value={summary.netLabel ?? "—"} label="dusdc" />
            </>
          )}
        </div>

        <div className="mt-6 flex flex-col gap-2">
          {canShare && (
            <PixelButton onClick={onShare} className="h-12 w-full text-lg">
              share
            </PixelButton>
          )}
          <PixelButton
            onClick={onCopy}
            style={BLUE_BRAND_STYLE}
            className="h-12 w-full text-lg"
          >
            {copied ? "copied!" : "copy link"}
          </PixelButton>
        </div>
      </div>
    </div>,
    document.body
  )
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col gap-1 rounded bg-black/30 px-2 py-2">
      <span className="text-2xl tabular-nums">{value}</span>
      <span className="text-xs tracking-[0.18em] text-white/55 uppercase">
        {label}
      </span>
    </div>
  )
}
