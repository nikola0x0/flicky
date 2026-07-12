import { useEffect, useState } from "react"
import { fetchSeason, type Season } from "@/lib/season"
import { fmtCountdown } from "@/lib/countdown"
import { useNow } from "@/lib/use-now"

/** localStorage key — per-season so a NEW season re-shows after the old was dismissed. */
function dismissKey(seasonId: string): string {
  return `flicky:season-banner-dismissed:${seasonId}`
}

/**
 * "Season 0 is live" — a dismissible top-pinned banner shown across the game
 * shell while a season is running. Self-contained: fetches `/season`, ticks a
 * live countdown, and hides once dismissed (persisted per season) or once the
 * season has ended. Mirrors the `WsErrorBanner` chrome/positioning so it sits
 * cleanly at the top of the device frame.
 */
export function SeasonBanner() {
  const [season, setSeason] = useState<Season | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const now = useNow(1000)

  useEffect(() => {
    let cancelled = false
    void fetchSeason().then((s) => {
      if (cancelled || !s) return
      setSeason(s)
      try {
        setDismissed(localStorage.getItem(dismissKey(s.id)) === "1")
      } catch {
        /* localStorage unavailable — just show it */
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  if (!season || dismissed) return null
  const remaining = Date.parse(season.endsAt) - now
  if (!Number.isFinite(remaining) || remaining <= 0) return null // season over → hide

  const dismiss = () => {
    setDismissed(true)
    try {
      localStorage.setItem(dismissKey(season.id), "1")
    } catch {
      /* ignore */
    }
  }

  return (
    // Absolute overlay pinned to the top of the device frame — floats OVER the
    // header (dismissible) instead of pushing content down. pointer-events-none
    // on the wrapper + auto on the card so it never blocks clicks around it.
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute inset-x-3 top-20 z-50 flex justify-center"
    >
      <div className="pointer-events-auto flex w-full animate-in items-center gap-3 rounded-md border-2 border-black/55 bg-[#2a2150] px-3 py-2.5 font-pixel shadow-[inset_0_-2px_0_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.08),0_4px_0_rgba(0,0,0,0.45)] duration-200 fade-in slide-in-from-top-2">
        <span aria-hidden className="text-xl leading-none">
          🏆
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm tracking-[0.18em] text-[#ffd27e] uppercase">
            {season.name} is live
          </div>
          <div className="mt-0.5 truncate text-sm text-white/85 tabular-nums">
            {season.prizePool.total} {season.prizePool.currency} prize pool ·
            ends in {fmtCountdown(remaining)}
          </div>
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label="dismiss"
          className="grid size-6 shrink-0 place-items-center rounded text-white/55 transition-colors hover:bg-white/10 hover:text-white"
        >
          ✕
        </button>
      </div>
    </div>
  )
}
