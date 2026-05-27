import { useEffect, useMemo, useState } from "react"
import { Link } from "react-router"
import { useCurrentAccount } from "@mysten/dapp-kit"
import { CONFIG } from "@/lib/config"
import { useFlickySocket } from "@/hooks/use-flicky-socket"
import { liveCardPnl } from "@/lib/pnl"

/**
 * Wire shape from `GET /duels/recent?player=…`. Trimmed to fields the
 * tile actually reads; everything else on the row is ignored.
 */
interface DuelLite {
  id: string
  status: "PENDING" | "ACTIVE" | "COMPLETE"
  creator: string
  challenger: string
  cardCount: number
  settledCount: number
  startedAtMs: number
  cardOutcomes: Array<{
    cardIdx: number
    p0Pnl: string | null
    p1Pnl: string | null
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
const CARD_SLOTS = 5

/**
 * Home-screen tile that surfaces a player's currently-settling duel
 * (LIVE) or, if none is active, their most recently completed duel
 * (FINAL). Polls `/duels/recent?player=…` every 5 s, and for ACTIVE
 * duels also subscribes to the per-card oracle ticks over WS so the
 * pending portion of the chart updates in real time (mark-to-market).
 */
export function MyMatchTile() {
  const account = useCurrentAccount()
  const address = account?.address
  const { send, onMessage } = useFlickySocket(address)
  const [duels, setDuels] = useState<DuelLite[] | null>(null)
  const [ticks, setTicks] = useState<Record<string, Tick>>({})

  // Poll the player's duels.
  useEffect(() => {
    if (!address) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      try {
        const res = await fetch(
          `${CONFIG.serverHttpUrl}/duels/recent?player=${encodeURIComponent(address)}&limit=20`,
        )
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const body = (await res.json()) as { duels: DuelLite[] }
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

  const pick = useMemo(() => pickMatch(duels), [duels])
  const isLive = pick?.status === "ACTIVE"

  // Subscribe to oracle ticks for the duel's cards while LIVE. The
  // `unsubscribe` cleanup keeps the keeper's broadcast traffic tight
  // when we navigate away or the duel settles.
  const oracleIds = useMemo(
    () => (isLive && pick ? pick.cards.map((c) => c.oracle_id) : []),
    [isLive, pick],
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
    // oracleKey condenses the array dependency so we don't re-subscribe
    // on every parent render that returns a fresh `oracleIds`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oracleKey, onMessage, send])

  if (!address || !pick) return null

  const myIsP0 = pick.creator === address
  const opponentAddr = myIsP0 ? pick.challenger : pick.creator

  return (
    <section className="w-full rounded-xl border-2 border-black/55 bg-[#1b2548] p-3 font-pixel text-white shadow-[inset_0_-2px_0_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.06)]">
      <header className="mb-2 flex items-center justify-between">
        <h3 className="text-sm tracking-[0.2em] uppercase">your match</h3>
        <StatusBadge live={isLive} />
      </header>

      <PnlChart pick={pick} myIsP0={myIsP0} ticks={ticks} />

      <footer className="mt-2 flex items-center justify-between text-xs tracking-wider uppercase">
        <div className="flex flex-col">
          <span className="text-white/55">vs</span>
          <span>{shortAddr(opponentAddr)}</span>
        </div>
        <div className="flex flex-col text-right">
          <span className="text-white/55">cards settled</span>
          <span className="text-white tabular-nums">
            {pick.settledCount} / {pick.cardCount || CARD_SLOTS}
          </span>
        </div>
        <Link
          to={`/game/duel/${pick.id}`}
          className="rounded border border-white/30 bg-white/5 px-3 py-1 text-xs tracking-wider uppercase hover:bg-white/10"
        >
          {isLive ? "open" : "play again"}
        </Link>
      </footer>
    </section>
  )
}

function StatusBadge({ live }: { live: boolean }) {
  if (live) {
    return (
      <span className="flex items-center gap-1.5 rounded bg-[#1f3a1f] px-2 py-0.5 text-[10px] tracking-[0.18em] text-emerald-300 uppercase">
        <span className="inline-block size-1.5 animate-pulse rounded-full bg-emerald-400" />
        live
      </span>
    )
  }
  return (
    <span className="rounded bg-white/10 px-2 py-0.5 text-[10px] tracking-[0.18em] text-white/70 uppercase">
      final
    </span>
  )
}

function pickMatch(duels: DuelLite[] | null): DuelLite | null {
  if (!duels || duels.length === 0) return null
  const active = duels
    .filter((d) => d.status === "ACTIVE")
    .sort((a, b) => b.startedAtMs - a.startedAtMs)[0]
  if (active) return active
  const complete = duels
    .filter((d) => d.status === "COMPLETE")
    .sort((a, b) => b.startedAtMs - a.startedAtMs)[0]
  return complete ?? null
}

function shortAddr(a: string): string {
  if (a.length < 12) return a
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

interface SeriesPoint {
  value: bigint
  isLive: boolean
}

/**
 * Build cumulative PnL series for one side. Settled cards contribute
 * their binary `pXPnl`. Cards that have a swipe + a live oracle tick
 * contribute `liveCardPnl` (mark-to-market) and are flagged `isLive`.
 * Cards with no swipe yet break the line — series stops there.
 */
function buildSeries(
  pick: DuelLite,
  side: "p0" | "p1",
  ticks: Record<string, Tick>,
): Array<SeriesPoint | null> {
  const slots = Math.max(pick.cardCount, CARD_SLOTS)
  const outcomeByIdx = new Map<number, bigint | null>()
  for (const o of pick.cardOutcomes) {
    const raw = side === "p0" ? o.p0Pnl : o.p1Pnl
    outcomeByIdx.set(o.cardIdx, raw === null ? null : BigInt(raw))
  }
  const swipeByIdx = new Map<number, DuelLite["swipes"][number]>()
  for (const s of pick.swipes) swipeByIdx.set(s.cardIdx, s)

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
    // Not settled — try mark-to-market from oracle tick.
    const card = pick.cards[i]
    const swipeRow = swipeByIdx.get(i)
    const swipe = swipeRow
      ? side === "p0"
        ? swipeRow.p0Swipe
        : swipeRow.p1Swipe
      : null
    const tick = card ? ticks[card.oracle_id] : undefined
    const live = liveCardPnl(swipe, card?.strike, tick?.forward)
    if (live === null) {
      // No swipe yet, or no tick — break the line so we don't fabricate.
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
}: {
  pick: DuelLite
  myIsP0: boolean
  ticks: Record<string, Tick>
}) {
  const slots = Math.max(pick.cardCount, CARD_SLOTS)
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
  const minAmp = 500_000n // 0.5 dUSDC, floor for trivial swings
  const amp = absMax > minAmp ? absMax : minAmp

  const W = 320
  const H = 132
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
  const yTopLabel = `+${fmtUsd(amp)}`
  const yBotLabel = `-${fmtUsd(amp)}`

  return (
    <div className="relative rounded bg-black/25 px-1 py-1">
      {!hasAnyData && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-4 text-center">
          <p className="text-[10px] tracking-[0.18em] text-white/55 uppercase">
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
        <line x1={padL} y1={padT} x2={W - padR} y2={padT} stroke="#ffffff20" strokeWidth={1} />
        <line x1={padL} y1={yZero} x2={W - padR} y2={yZero} stroke="#ffffff35" strokeWidth={1} strokeDasharray="2 2" />
        <line x1={padL} y1={H - padB} x2={W - padR} y2={H - padB} stroke="#ffffff20" strokeWidth={1} />

        <text x={padL - 6} y={padT + 4} fill="#ffffffaa" fontSize="9" textAnchor="end" fontFamily="monospace">{yTopLabel}</text>
        <text x={padL - 6} y={yZero + 3} fill="#ffffffcc" fontSize="9" textAnchor="end" fontFamily="monospace">$0.00</text>
        <text x={padL - 6} y={H - padB + 3} fill="#ffffffaa" fontSize="9" textAnchor="end" fontFamily="monospace">{yBotLabel}</text>

        {Array.from({ length: slots }).map((_, i) => (
          <g key={i}>
            <line
              x1={xFor(i)}
              y1={H - padB}
              x2={xFor(i)}
              y2={H - padB + 3}
              stroke="#ffffff55"
              strokeWidth={1}
            />
            <text
              x={xFor(i)}
              y={H - padB + 14}
              fill="#ffffff80"
              fontSize="9"
              textAnchor="middle"
              fontFamily="monospace"
            >
              {i + 1}
            </text>
          </g>
        ))}

        <SeriesLine
          color="#f08585"
          points={opp.map((p, i) => ({
            x: xFor(i),
            y: p === null ? null : yFor(p.value),
            live: p?.isLive ?? false,
          }))}
        />
        <SeriesLine
          color="#7eb6ff"
          points={you.map((p, i) => ({
            x: xFor(i),
            y: p === null ? null : yFor(p.value),
            live: p?.isLive ?? false,
          }))}
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
  // Build connected segments split where y is null.
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
        // A segment can mix settled + live points. Render two polylines
        // overlapping the segment so each portion uses the right style.
        const pathPts = seg.map((p) => `${p.x},${p.y}`).join(" ")
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
            points={pathPts}
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

function fmtUsd(micro: bigint): string {
  const sign = micro < 0n ? "-" : ""
  const abs = micro < 0n ? -micro : micro
  return `${sign}$${(Number(abs) / 1_000_000).toFixed(2)}`
}

function fmtSeriesTail(series: Array<SeriesPoint | null>): string {
  let last: bigint | null = null
  for (const p of series) if (p !== null) last = p.value
  if (last === null) return "$0.00"
  const sign = last < 0n ? "-" : last > 0n ? "+" : ""
  const abs = last < 0n ? -last : last
  return `${sign}$${(Number(abs) / 1_000_000).toFixed(2)}`
}
