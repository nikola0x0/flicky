import { forwardRef } from "react"
import { PlayerAvatar } from "@/components/player-avatar"
import type { DuelSummary } from "@/lib/duel-result"

const OUTCOME_COPY = {
  win: { title: "you won", tone: "text-emerald-300" },
  loss: { title: "you lost", tone: "text-rose-300" },
  tie: { title: "draw", tone: "text-white" },
} as const

/**
 * The actual shareable artifact — a portrait card captured to a PNG (see
 * `@/lib/share-image`) and posted as an image, not just a link. Rendered
 * off-screen at a fixed size so the export is consistent regardless of
 * viewport; visual design is independent of <DuelResultModal>'s compact
 * in-app stat row on purpose (this is what gets posted, that's what gets
 * glanced at mid-session).
 *
 * Layout takes cues from trading-PnL share cards (big colored % return,
 * identity row, stat strip, footer branding) adapted to a head-to-head
 * duel: both players' addresses are shown, since the "win" is relative
 * to an opponent, not a market.
 */
export const DuelShareCard = forwardRef<
  HTMLDivElement,
  {
    summary: DuelSummary
    myAddress?: string
    oppAddress: string
    timestamp: string
  }
>(function DuelShareCard({ summary, myAddress, oppAddress, timestamp }, ref) {
  const copy = OUTCOME_COPY[summary.outcome]
  const pctTone =
    summary.outcome === "win"
      ? "text-emerald-300"
      : summary.outcome === "loss"
        ? "text-rose-300"
        : "text-white"

  return (
    <div
      ref={ref}
      className="relative flex w-[480px] flex-col gap-6 overflow-hidden bg-gradient-to-b from-[#1b2548] to-[#0b1228] px-8 py-9 font-pixel text-white"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -top-24 -right-24 size-72 rounded-full bg-[#4094fb]/15 blur-3xl"
      />

      <header className="relative flex items-center justify-between">
        <img
          src="/logo-mark.png"
          alt=""
          aria-hidden
          className="h-9 w-auto [image-rendering:pixelated]"
        />
        <span className="text-xs tracking-[0.18em] text-white/45 uppercase">
          {timestamp}
        </span>
      </header>

      <div className="relative flex flex-col items-center gap-1">
        <span className={`text-2xl tracking-[0.2em] uppercase ${copy.tone}`}>
          {copy.title}
        </span>
        <span
          className={`text-7xl leading-none font-bold tabular-nums ${pctTone}`}
        >
          {summary.freeDuel ? "—" : (summary.returnPctLabel ?? "—")}
        </span>
        {summary.freeDuel && (
          <span className="mt-1 rounded bg-cyan-500/15 px-3 py-1 text-sm tracking-[0.18em] text-cyan-200/85 uppercase">
            free duel
          </span>
        )}
      </div>

      <div className="relative flex items-center justify-center gap-4 rounded-2xl bg-black/25 px-4 py-4">
        <PlayerIdentity address={myAddress} label="you" />
        <span className="text-lg tracking-[0.2em] text-white/40 uppercase">
          vs
        </span>
        <PlayerIdentity address={oppAddress} label="opponent" />
      </div>

      {!summary.freeDuel && (
        <div className="relative grid grid-cols-3 gap-2 text-center">
          <ShareStat
            value={`${summary.hits}/${summary.totalCards}`}
            label="hits"
          />
          <ShareStat value={summary.oddsLabel ?? "—"} label="odds" />
          <ShareStat value={summary.netLabel ?? "—"} label="dusdc" />
        </div>
      )}
      {summary.freeDuel && (
        <div className="relative grid grid-cols-1 text-center">
          <ShareStat
            value={`${summary.hits}/${summary.totalCards}`}
            label="hits"
          />
        </div>
      )}

      <footer className="relative flex items-center justify-between border-t border-white/10 pt-4">
        <span className="text-sm tracking-[0.24em] text-white/55 uppercase">
          flicky
        </span>
        <span className="text-xs tracking-[0.1em] text-white/35">
          play at flicky.gg
        </span>
      </footer>
    </div>
  )
})

function PlayerIdentity({
  address,
  label,
}: {
  address?: string
  label: string
}) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      <PlayerAvatar address={address} size={48} />
      <span className="text-[11px] tracking-[0.1em] text-white/70 tabular-nums">
        {address ? shortAddr(address) : "—"}
      </span>
      <span className="text-[10px] tracking-[0.18em] text-white/35 uppercase">
        {label}
      </span>
    </div>
  )
}

function ShareStat({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col gap-1 rounded bg-black/25 px-2 py-2.5">
      <span className="text-xl tabular-nums">{value}</span>
      <span className="text-[10px] tracking-[0.18em] text-white/50 uppercase">
        {label}
      </span>
    </div>
  )
}

function shortAddr(a: string): string {
  if (!a || a.length < 12) return a
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}
