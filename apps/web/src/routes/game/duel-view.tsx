import { useEffect, useMemo, useState } from "react"
import { Link, useParams } from "react-router"
import { useCurrentAccount } from "@mysten/dapp-kit"
import { CONFIG } from "@/lib/config"
import { useFlickySocket } from "@/hooks/use-flicky-socket"
import { liveCardPnl } from "@/lib/pnl"
import { PixelButton } from "@/components/pixel-button"
import type { CSSProperties } from "react"

const BLUE_BRAND_STYLE = {
  "--btn-bg": "#4094fb",
  "--btn-highlight": "#7eb6ff",
} as CSSProperties

interface DuelLite {
  id: string
  status: "PENDING" | "ACTIVE" | "COMPLETE"
  creator: string
  challenger: string
  cardsRevealed: boolean
  cardCount: number
  settledCount: number
  startedAtMs: number
  p0Payout: string
  p0Premium: string
  p1Payout: string
  p1Premium: string
  cardOutcomes: Array<{
    cardIdx: number
    settlementPrice: string
    strike: string
    upWon: boolean
    p0Pnl: string | null
    p1Pnl: string | null
    p0Swipe: { isUp: boolean; quantity: string; premium: string } | null
    p1Swipe: { isUp: boolean; quantity: string; premium: string } | null
  }>
  swipes: Array<{
    cardIdx: number
    p0Swipe: { isUp: boolean; quantity: string; premium: string } | null
    p1Swipe: { isUp: boolean; quantity: string; premium: string } | null
  }>
  cards: Array<{ oracle_id: string; strike: string }>
}

interface Tick {
  spot: string
  forward: string
}

const POLL_INTERVAL_MS = 5_000

/**
 * Read-only duel detail view. Opened from the home tile's "open" button
 * when a player has a settling or recently-completed duel. Doesn't let
 * you swipe — by exit time all 5 swipes are usually in. Subscribes to
 * `room_state` over WS so settlement updates land in real time, and to
 * each card's oracle ticks so mark-to-market PnL updates between
 * settlements.
 */
export default function DuelView() {
  const { duelId } = useParams<{ duelId: string }>()
  const account = useCurrentAccount()
  const address = account?.address
  const { send, onMessage } = useFlickySocket(address)
  const [duel, setDuel] = useState<DuelLite | null>(null)
  const [ticks, setTicks] = useState<Record<string, Tick>>({})
  const [err, setErr] = useState<string | null>(null)

  // Initial fetch + polling (mirror of MyMatchTile's pattern — keeps
  // the view honest if the WS room subscription misses an update).
  useEffect(() => {
    if (!duelId) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      try {
        const res = await fetch(`${CONFIG.serverHttpUrl}/duels/${encodeURIComponent(duelId)}`)
        if (res.status === 404) throw new Error("not_indexed")
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const body = (await res.json()) as DuelLite
        if (!cancelled) {
          setDuel(body)
          setErr(null)
        }
      } catch (e) {
        if (!cancelled)
          setErr(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) timer = setTimeout(tick, POLL_INTERVAL_MS)
      }
    }
    void tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [duelId])

  // Subscribe to the WS room so deltas (room_state) land here too.
  useEffect(() => {
    if (!duelId) return
    send({ type: "room_subscribe", duelId })
    return () => {
      send({ type: "room_unsubscribe", duelId })
    }
  }, [duelId, send])

  // Oracle ticks for mark-to-market on pending cards.
  const oracleIds = useMemo(
    () =>
      duel && duel.status === "ACTIVE"
        ? duel.cards.map((c) => c.oracle_id)
        : [],
    [duel],
  )
  const oracleKey = oracleIds.join(",")
  useEffect(() => {
    if (oracleIds.length === 0) return
    send({ type: "oracle_subscribe", oracleIds })
    const off = onMessage((msg) => {
      if (msg.type !== "oracle_tick") return
      if (!oracleIds.includes(msg.oracleId)) return
      setTicks((prev) => ({
        ...prev,
        [msg.oracleId]: { spot: msg.spot, forward: msg.forward },
      }))
    })
    return () => {
      off()
      send({ type: "oracle_unsubscribe", oracleIds })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oracleKey, onMessage, send])

  if (!duelId) {
    return <Notice title="missing duel id" body="this url has no duel id." />
  }
  if (err === "not_indexed") {
    return (
      <Notice
        title="duel not indexed yet"
        body="the indexer hasn't picked up this duel — try again in a few seconds."
      />
    )
  }
  if (!duel) {
    return <Notice title="loading…" body="fetching duel state." />
  }

  const myIsP0 = address && duel.creator === address
  const myIsP1 = address && duel.challenger === address
  const isParticipant = myIsP0 || myIsP1
  const opponent = myIsP0 ? duel.challenger : duel.creator
  const isLive = duel.status === "ACTIVE"

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto px-4 py-4 font-pixel text-white">
      <header className="flex items-center justify-between">
        <h1 className="text-base tracking-[0.2em] uppercase">duel</h1>
        <StatusBadge status={duel.status} />
      </header>

      <div className="grid grid-cols-2 gap-2 text-xs tracking-wider uppercase">
        <div className="flex flex-col rounded bg-white/5 px-3 py-2">
          <span className="text-white/55">opponent</span>
          <span className="text-sm">{shortAddr(opponent)}</span>
        </div>
        <div className="flex flex-col rounded bg-white/5 px-3 py-2">
          <span className="text-white/55">cards</span>
          <span className="text-sm text-white tabular-nums">
            {duel.settledCount} / {duel.cardCount || 5} settled
          </span>
        </div>
      </div>

      <PnlChart
        pick={duel}
        myIsP0={Boolean(myIsP0)}
        ticks={ticks}
        height={180}
      />

      <CardList duel={duel} myIsP0={Boolean(myIsP0)} ticks={ticks} />

      {!isParticipant && (
        <div className="rounded bg-amber-900/30 px-3 py-2 text-xs text-amber-200/85">
          you're not a participant in this duel — view is read-only.
        </div>
      )}

      <footer className="mt-auto pt-2">
        <Link to="/game/home" className="block">
          <PixelButton style={BLUE_BRAND_STYLE} className="h-12 w-full text-lg">
            back to home
          </PixelButton>
        </Link>
      </footer>

      {/* small queue-leave footer note */}
      <p className="text-center text-[10px] tracking-[0.18em] text-white/40 uppercase">
        {isLive ? "settlement runs automatically — keeper handles the rest" : "this match is final"}
      </p>
    </div>
  )
}

function StatusBadge({ status }: { status: DuelLite["status"] }) {
  if (status === "ACTIVE") {
    return (
      <span className="flex items-center gap-1.5 rounded bg-[#1f3a1f] px-2 py-0.5 text-[10px] tracking-[0.18em] text-emerald-300 uppercase">
        <span className="inline-block size-1.5 animate-pulse rounded-full bg-emerald-400" />
        live
      </span>
    )
  }
  if (status === "COMPLETE") {
    return (
      <span className="rounded bg-white/10 px-2 py-0.5 text-[10px] tracking-[0.18em] text-white/70 uppercase">
        final
      </span>
    )
  }
  return (
    <span className="rounded bg-white/10 px-2 py-0.5 text-[10px] tracking-[0.18em] text-white/55 uppercase">
      pending
    </span>
  )
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center font-pixel text-white">
      <p className="text-sm tracking-[0.18em] uppercase">{title}</p>
      <p className="text-xs text-white/60">{body}</p>
      <Link to="/game/home" className="block w-full max-w-[200px]">
        <PixelButton style={BLUE_BRAND_STYLE} className="h-12 w-full text-base">
          back
        </PixelButton>
      </Link>
    </div>
  )
}

function shortAddr(a: string): string {
  if (!a || a.length < 12) return a
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

// ─── Chart (shared shape with MyMatchTile) ──────────────────────────────────

interface SeriesPoint {
  value: bigint
  isLive: boolean
}

function buildSeries(
  d: DuelLite,
  side: "p0" | "p1",
  ticks: Record<string, Tick>,
): Array<SeriesPoint | null> {
  const slots = Math.max(d.cardCount, 5)
  const outcomeByIdx = new Map<number, bigint | null>()
  for (const o of d.cardOutcomes) {
    const raw = side === "p0" ? o.p0Pnl : o.p1Pnl
    outcomeByIdx.set(o.cardIdx, raw === null ? null : BigInt(raw))
  }
  const swipeByIdx = new Map<number, DuelLite["swipes"][number]>()
  for (const s of d.swipes) swipeByIdx.set(s.cardIdx, s)

  const series: Array<SeriesPoint | null> = []
  let running = 0n
  let broken = false
  for (let i = 0; i < slots; i++) {
    if (broken) {
      series.push(null)
      continue
    }
    const settled = outcomeByIdx.get(i)
    if (settled !== undefined && settled !== null) {
      running += settled
      series.push({ value: running, isLive: false })
      continue
    }
    const card = d.cards[i]
    const swipeRow = swipeByIdx.get(i)
    const swipe = swipeRow
      ? side === "p0"
        ? swipeRow.p0Swipe
        : swipeRow.p1Swipe
      : null
    const tick = card ? ticks[card.oracle_id] : undefined
    const live = liveCardPnl(swipe, card?.strike, tick?.forward)
    if (live === null) {
      broken = true
      series.push(null)
      continue
    }
    running += live
    series.push({ value: running, isLive: true })
  }
  return series
}

function PnlChart({
  pick,
  myIsP0,
  ticks,
  height = 132,
}: {
  pick: DuelLite
  myIsP0: boolean
  ticks: Record<string, Tick>
  height?: number
}) {
  const slots = Math.max(pick.cardCount, 5)
  const you = useMemo(
    () => buildSeries(pick, myIsP0 ? "p0" : "p1", ticks),
    [pick, myIsP0, ticks],
  )
  const opp = useMemo(
    () => buildSeries(pick, myIsP0 ? "p1" : "p0", ticks),
    [pick, myIsP0, ticks],
  )

  const allValues = [...you, ...opp]
    .filter((p): p is SeriesPoint => p !== null)
    .map((p) => p.value)
  const hasAnyData = allValues.length > 0
  const absMax = allValues.reduce(
    (m, v) => (v < 0n ? (v < -m ? -v : m) : v > m ? v : m),
    0n,
  )
  const minAmp = 500_000n
  const amp = absMax > minAmp ? absMax : minAmp

  const W = 320
  const H = height
  const padL = 36
  const padR = 12
  const padT = 8
  const padB = 22
  const innerW = W - padL - padR
  const innerH = H - padT - padB
  const xFor = (slot: number) =>
    padL + (slots <= 1 ? innerW / 2 : (innerW * slot) / (slots - 1))
  const yFor = (micro: bigint) => {
    const num = Number(micro)
    const range = Number(amp)
    const t = (num + range) / (2 * range)
    return padT + innerH * (1 - t)
  }
  const yZero = yFor(0n)

  return (
    <div className="relative rounded bg-black/25 px-1 py-1">
      {!hasAnyData && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-4 text-center">
          <p className="text-[11px] tracking-[0.18em] text-white/55 uppercase">
            waiting for first settlement
            <br />
            <span className="text-white/35">no cards reported yet</span>
          </p>
        </div>
      )}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="block h-auto w-full [image-rendering:pixelated]"
        role="img"
        aria-label="match PnL per card slot"
      >
        <line x1={padL} y1={padT} x2={W - padR} y2={padT} stroke="#ffffff20" />
        <line x1={padL} y1={yZero} x2={W - padR} y2={yZero} stroke="#ffffff35" strokeDasharray="2 2" />
        <line x1={padL} y1={H - padB} x2={W - padR} y2={H - padB} stroke="#ffffff20" />
        <text x={padL - 6} y={padT + 4} fill="#ffffffaa" fontSize="9" textAnchor="end" fontFamily="monospace">+{fmtUsd(amp)}</text>
        <text x={padL - 6} y={yZero + 3} fill="#ffffffcc" fontSize="9" textAnchor="end" fontFamily="monospace">$0.00</text>
        <text x={padL - 6} y={H - padB + 3} fill="#ffffffaa" fontSize="9" textAnchor="end" fontFamily="monospace">-{fmtUsd(amp)}</text>

        {Array.from({ length: slots }).map((_, i) => (
          <g key={i}>
            <line x1={xFor(i)} y1={H - padB} x2={xFor(i)} y2={H - padB + 3} stroke="#ffffff55" />
            <text x={xFor(i)} y={H - padB + 14} fill="#ffffff80" fontSize="9" textAnchor="middle" fontFamily="monospace">{i + 1}</text>
          </g>
        ))}

        <SeriesLine
          color="#f08585"
          points={opp.map((p, i) => ({ x: xFor(i), y: p === null ? null : yFor(p.value), live: p?.isLive ?? false }))}
        />
        <SeriesLine
          color="#7eb6ff"
          points={you.map((p, i) => ({ x: xFor(i), y: p === null ? null : yFor(p.value), live: p?.isLive ?? false }))}
        />
      </svg>

      <div className="mt-1 flex items-center justify-between px-1 text-[10px] tracking-[0.18em] uppercase">
        <span className="flex items-center gap-1.5 text-white">
          <span className="inline-block size-2 rounded-full bg-[#7eb6ff]" />
          you {fmtSeriesTail(you)}
        </span>
        <span className="flex items-center gap-1.5 text-white/75">
          opp {fmtSeriesTail(opp)}
          <span className="inline-block size-2 rounded-full bg-[#f08585]" />
        </span>
      </div>
    </div>
  )
}

function SeriesLine({
  color,
  points,
}: {
  color: string
  points: Array<{ x: number; y: number | null; live: boolean }>
}) {
  const segments: Array<Array<{ x: number; y: number; live: boolean }>> = []
  let cur: Array<{ x: number; y: number; live: boolean }> = []
  for (const p of points) {
    if (p.y === null) {
      if (cur.length) segments.push(cur)
      cur = []
    } else {
      cur.push({ x: p.x, y: p.y, live: p.live })
    }
  }
  if (cur.length) segments.push(cur)

  return (
    <>
      {segments.map((seg, si) => {
        const allLive = seg.every((p) => p.live)
        return (
          <polyline
            key={si}
            fill="none"
            stroke={color}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            strokeDasharray={allLive ? "4 3" : undefined}
            opacity={allLive ? 0.7 : 1}
            points={seg.map((p) => `${p.x},${p.y}`).join(" ")}
          />
        )
      })}
      {points.map((p, i) =>
        p.y === null ? null : (
          <circle
            key={i}
            cx={p.x}
            cy={p.y}
            r={p.live ? 2.5 : 3}
            fill={p.live ? "#1b2548" : color}
            stroke={color}
            strokeWidth={1.5}
            opacity={p.live ? 0.85 : 1}
          />
        ),
      )}
    </>
  )
}

// ─── Per-card breakdown ──────────────────────────────────────────────────────

function CardList({
  duel,
  myIsP0,
  ticks,
}: {
  duel: DuelLite
  myIsP0: boolean
  ticks: Record<string, Tick>
}) {
  const slots = Math.max(duel.cardCount, duel.cards.length, 5)
  const outcomeByIdx = new Map(duel.cardOutcomes.map((o) => [o.cardIdx, o]))
  const swipeByIdx = new Map(duel.swipes.map((s) => [s.cardIdx, s]))

  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="text-[10px] tracking-[0.2em] text-white/55 uppercase">cards</h3>
      {Array.from({ length: slots }).map((_, i) => {
        const card = duel.cards[i]
        const outcome = outcomeByIdx.get(i)
        const swipeRow = swipeByIdx.get(i)
        const mySwipe = swipeRow
          ? myIsP0 ? swipeRow.p0Swipe : swipeRow.p1Swipe
          : null
        const myPnl =
          outcome && (myIsP0 ? outcome.p0Pnl : outcome.p1Pnl) !== null
            ? BigInt(myIsP0 ? outcome.p0Pnl! : outcome.p1Pnl!)
            : card && mySwipe
              ? liveCardPnl(mySwipe, card.strike, ticks[card.oracle_id]?.forward)
              : null

        return (
          <div
            key={i}
            className="flex items-center justify-between rounded bg-white/5 px-2 py-1.5 text-xs"
          >
            <span className="text-white/55 tabular-nums">{i + 1}</span>
            <span className="text-white/60">
              {mySwipe ? (mySwipe.isUp ? "▲ up" : "▼ down") : "—"}
            </span>
            <span className="text-white/55">
              {outcome
                ? outcome.upWon
                  ? "settled ▲"
                  : "settled ▼"
                : card
                  ? "pending"
                  : "—"}
            </span>
            <span
              className={`tabular-nums ${
                myPnl === null
                  ? "text-white/40"
                  : myPnl < 0n
                    ? "text-rose-300"
                    : myPnl > 0n
                      ? "text-emerald-300"
                      : "text-white/60"
              }`}
            >
              {myPnl === null ? "—" : signedUsd(myPnl)}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function fmtUsd(micro: bigint): string {
  const abs = micro < 0n ? -micro : micro
  return `$${(Number(abs) / 1_000_000).toFixed(2)}`
}

function signedUsd(micro: bigint): string {
  const sign = micro < 0n ? "-" : micro > 0n ? "+" : ""
  const abs = micro < 0n ? -micro : micro
  return `${sign}$${(Number(abs) / 1_000_000).toFixed(2)}`
}

function fmtSeriesTail(series: Array<SeriesPoint | null>): string {
  let last: bigint | null = null
  for (const p of series) if (p !== null) last = p.value
  if (last === null) return "$0.00"
  return signedUsd(last)
}
