import { useEffect, useMemo, useState } from "react"
import { Link } from "react-router"
import { useCurrentAccount } from "@mysten/dapp-kit"
import { CONFIG } from "@/lib/config"
import { fmtPnlPct } from "@/lib/pnl"
import { playerDuelResult } from "@/lib/duel-result"
import { PixelButton } from "@/components/pixel-button"
import type { CSSProperties } from "react"

const BLUE_BRAND_STYLE = {
  "--btn-bg": "#4094fb",
  "--btn-highlight": "#7eb6ff",
} as CSSProperties

/**
 * Wire shape from `GET /duels/recent?player=…`. Trimmed to the fields the
 * history list reads.
 */
interface DuelRow {
  id: string
  status: "PENDING" | "ACTIVE" | "COMPLETE"
  creator: string
  challenger: string
  cardCount: number
  settledCount: number
  p0Payout: string
  p0Premium: string
  p1Payout: string
  p1Premium: string
  winner?: "p0" | "p1" | "tie" | null
  startedAtMs: number
  lastUpdatedMs: number
}

const POLL_INTERVAL_MS = 8_000
const FETCH_LIMIT = 50

/**
 * Full match history for the signed-in player. Lists every recent duel —
 * active, pending, and completed — as a compact, tappable row. The home
 * tile still surfaces just the latest match; this is the "see all" view.
 *
 * Read-only and poll-driven (no WS) — compact rows don't need live oracle
 * ticks, so we keep this light and let the per-duel view own the streaming
 * chart.
 */
export default function GameHistory() {
  const account = useCurrentAccount()
  const address = account?.address
  const [duels, setDuels] = useState<DuelRow[] | null>(null)

  useEffect(() => {
    if (!address) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      try {
        const res = await fetch(
          `${CONFIG.serverHttpUrl}/duels/recent?player=${encodeURIComponent(
            address
          )}&limit=${FETCH_LIMIT}`
        )
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const body = (await res.json()) as { duels: DuelRow[] }
        if (!cancelled) setDuels(body.duels)
      } catch {
        // Silent — next poll retries.
      } finally {
        if (!cancelled) timer = setTimeout(tick, POLL_INTERVAL_MS)
      }
    }
    void tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [address])

  // ACTIVE first (so live matches you can jump back into sit on top), then
  // most-recently-updated. `lastUpdatedMs` is the reliable recency key —
  // PENDING rows carry `startedAtMs: 0`.
  const sorted = useMemo(() => {
    if (!duels) return null
    const rank = (s: DuelRow["status"]) =>
      s === "ACTIVE" ? 0 : s === "PENDING" ? 1 : 2
    return [...duels].sort(
      (a, b) => rank(a.status) - rank(b.status) || b.lastUpdatedMs - a.lastUpdatedMs
    )
  }, [duels])

  return (
    <div className="relative isolate flex h-full flex-col gap-3 overflow-y-auto px-4 py-4 font-pixel text-white [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <header className="flex items-center justify-between">
        <h1 className="text-4xl tracking-[0.2em] uppercase">history</h1>
        {sorted && sorted.length > 0 && (
          <span className="rounded bg-black/30 px-3 py-1 text-sm tracking-[0.18em] text-white/55 uppercase backdrop-blur-sm tabular-nums">
            {sorted.length}
          </span>
        )}
      </header>

      {!address ? (
        <Empty body="connect a wallet to see your matches." />
      ) : sorted === null ? (
        <p className="px-1 py-6 text-center text-sm tracking-[0.18em] text-white/55 uppercase">
          loading…
        </p>
      ) : sorted.length === 0 ? (
        <Empty body="no matches yet — your duels will show up here." cta />
      ) : (
        <ul className="flex flex-col gap-2">
          {sorted.map((d) => (
            <MatchRow key={d.id} duel={d} address={address} />
          ))}
        </ul>
      )}

      <footer className="mt-auto pt-2">
        <Link to="/game/home" className="block">
          <PixelButton style={BLUE_BRAND_STYLE} className="h-12 w-full text-lg">
            back to home
          </PixelButton>
        </Link>
      </footer>
    </div>
  )
}

function MatchRow({ duel, address }: { duel: DuelRow; address: string }) {
  const myIsP0 = duel.creator === address
  const opponent = myIsP0 ? duel.challenger : duel.creator
  const hasOpponent = Boolean(opponent) && opponent !== ZERO_ADDR

  // Net settled PnL for my side — the contract's `payout - premium`,
  // final once the duel is COMPLETE. Used for the return % only; the
  // win/loss chip uses the authoritative head-to-head result below.
  const myPayout = BigInt(myIsP0 ? duel.p0Payout : duel.p1Payout)
  const myPremium = BigInt(myIsP0 ? duel.p0Premium : duel.p1Premium)
  const net = myPayout - myPremium

  const result = duelResult(duel, address)

  return (
    <li>
      <Link
        to={`/game/duel/${duel.id}`}
        className="flex items-center justify-between gap-3 rounded bg-black/30 px-3 py-2.5 backdrop-blur-sm transition-colors hover:bg-black/45"
      >
        <div className="flex min-w-0 items-center gap-3">
          <ResultChip kind={result} />
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-base tracking-wider uppercase">
              {hasOpponent ? `vs ${shortAddr(opponent)}` : "waiting for opponent"}
            </span>
            <span className="text-xs tracking-[0.18em] text-white/45 uppercase tabular-nums">
              {relativeTime(duel.lastUpdatedMs || duel.startedAtMs)}
            </span>
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-end">
          {duel.status === "COMPLETE" ? (
            <span
              className={`text-lg tabular-nums ${pnlColor(net, myPremium)}`}
            >
              {fmtPnlPct(net, myPremium)}
            </span>
          ) : duel.status === "ACTIVE" ? (
            <span className="text-lg text-white tabular-nums">
              {duel.settledCount}/{duel.cardCount || 5}
            </span>
          ) : (
            <span className="text-base text-white/55 uppercase">pending</span>
          )}
          <span className="text-xs tracking-[0.18em] text-white/40 uppercase">
            {duel.status === "ACTIVE"
              ? "settled"
              : duel.status === "COMPLETE"
                ? "return"
                : ""}
          </span>
        </div>
      </Link>
    </li>
  )
}

type ResultKind = "live" | "win" | "loss" | "push" | "pending"

function duelResult(duel: DuelRow, address: string): ResultKind {
  if (duel.status === "ACTIVE") return "live"
  if (duel.status === "PENDING") return "pending"
  const r = playerDuelResult(duel, address)
  return r === "win" ? "win" : r === "loss" ? "loss" : "push"
}

const CHIP_STYLES: Record<ResultKind, string> = {
  live: "bg-[#1f3a1f] text-emerald-300",
  win: "bg-emerald-950/60 text-emerald-300",
  loss: "bg-rose-950/60 text-rose-300",
  push: "bg-white/10 text-white/70",
  pending: "bg-amber-900/40 text-amber-200/85",
}

const CHIP_LABEL: Record<ResultKind, string> = {
  live: "live",
  win: "win",
  loss: "loss",
  push: "push",
  pending: "soon",
}

function ResultChip({ kind }: { kind: ResultKind }) {
  return (
    <span
      className={`flex items-center gap-1.5 rounded px-2 py-1 text-xs tracking-[0.18em] uppercase ${CHIP_STYLES[kind]}`}
    >
      {kind === "live" && (
        <span className="inline-block size-1.5 animate-pulse rounded-full bg-emerald-400" />
      )}
      {CHIP_LABEL[kind]}
    </span>
  )
}

function Empty({ body, cta }: { body: string; cta?: boolean }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded bg-black/30 px-6 py-10 text-center backdrop-blur-sm">
      <img
        src="/icons/swords.png"
        alt=""
        aria-hidden
        className="size-12 opacity-60 [image-rendering:pixelated]"
      />
      <p className="max-w-[28ch] text-sm leading-relaxed tracking-wider text-white/55 uppercase">
        {body}
      </p>
      {cta && (
        <Link
          to="/game/pvp"
          className="mt-1 rounded border border-white/30 bg-white/5 px-3 py-1 text-sm tracking-wider uppercase hover:bg-white/10"
        >
          find a duel
        </Link>
      )}
    </div>
  )
}

const ZERO_ADDR = `0x${"0".repeat(64)}`

function pnlColor(net: bigint, premium: bigint): string {
  if (premium <= 0n) return "text-white/70"
  if (net > 0n) return "text-emerald-400"
  if (net < 0n) return "text-rose-400"
  return "text-white/70"
}

function shortAddr(a: string): string {
  if (!a || a.length < 12) return a
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

/** Compact "time ago" — "just now", "5m", "2h", "3d", or a date past a week. */
function relativeTime(ms: number): string {
  if (!ms) return ""
  const diff = Date.now() - ms
  if (diff < 0) return "just now"
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return "just now"
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d ago`
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  })
}
