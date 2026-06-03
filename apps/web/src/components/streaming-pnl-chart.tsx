/**
 * Streaming PnL chart — used by both the home-page match tile and the
 * full duel-view route. Time on the x-axis, cumulative PnL on y, one
 * line per player ending in their avatar. Server oracle ticks are
 * eased toward continuously each animation frame, so the head slides
 * between sparse server updates instead of stepping every 2 s.
 *
 * Wrapped in a `.crt-screen` container so both surfaces share the
 * same CRT aesthetic (scanlines, RGB mask, vignette, phosphor glow).
 *
 * Accepts a minimal `ChartDuel` interface — both `DuelLite` shapes in
 * the codebase (home tile + duel-view) structurally satisfy it.
 */
import { useEffect, useMemo, useRef, useState } from "react"
import { Group } from "@visx/group"
import { scaleLinear } from "@visx/scale"
import { LinePath } from "@visx/shape"
import { curveMonotoneX } from "@visx/curve"
import { markCardPnl } from "@/lib/pnl"
import { PlayerAvatar } from "@/components/player-avatar"

export interface ChartDuel {
  id: string
  settledCount: number
  cards: Array<{ oracle_id: string; strike: string }>
  swipes: Array<{
    cardIdx: number
    p0Swipe: { isUp: boolean; quantity: string; premium: string } | null
    p1Swipe: { isUp: boolean; quantity: string; premium: string } | null
  }>
  cardOutcomes: Array<{
    cardIdx: number
    p0Pnl: string | null
    p1Pnl: string | null
  }>
}

export interface ChartTick {
  spot: string
  forward: string
  /** Oracle expiry (ms). Drives time-decay in the continuous mark. */
  expiryMs?: number
}

interface Sample {
  t: number
  p0: bigint
  p1: bigint
}

interface Boundary {
  t: number
  idx: number
}

const SAMPLE_INTERVAL_MS = 60 // ~16 Hz — smoother head than 10 Hz
const MAX_SAMPLES = 1000 // ~60 s rolling window at ~16 Hz
// Bounds for the adaptive ease duration (matched to observed tick cadence).
const EASE_MIN_MS = 500
const EASE_MAX_MS = 3000
const WINDOW_MS = 60_000 // x-axis visible window
const MIN_AMP_MICRO = 500_000n // 0.5 dUSDC y-axis floor

export function StreamingPnlChart({
  duel,
  ticks,
  myIsP0,
  youAddress,
  oppAddress,
}: {
  duel: ChartDuel
  ticks: Record<string, ChartTick>
  myIsP0: boolean
  youAddress: string
  oppAddress: string
}) {
  const history = useChartHistory(duel, ticks)
  // Total premium each side has paid — the denominator for percentage
  // return. Computed from `swipes` (snapshotted at swipe time, so it's
  // present for both settled and live cards).
  const p0Premium = useMemo(() => totalPremium(duel, "p0"), [duel])
  const p1Premium = useMemo(() => totalPremium(duel, "p1"), [duel])
  const youPremium = myIsP0 ? p0Premium : p1Premium
  const oppPremium = myIsP0 ? p1Premium : p0Premium
  return (
    <ChartCanvas
      samples={history.samples}
      boundaries={history.boundaries}
      myIsP0={myIsP0}
      youAddress={youAddress}
      oppAddress={oppAddress}
      youPremium={youPremium}
      oppPremium={oppPremium}
    />
  )
}

function totalPremium(duel: ChartDuel, side: "p0" | "p1"): bigint {
  let total = 0n
  for (const s of duel.swipes) {
    const swipe = side === "p0" ? s.p0Swipe : s.p1Swipe
    if (swipe) total += BigInt(swipe.premium)
  }
  return total
}

/**
 * Aggregate running PnL for one side at this instant. Settled cards
 * contribute their binary `pXPnl`; cards with a swipe + live tick
 * contribute mark-to-market via `liveCardPnl`. Unswiped or
 * tick-less unsettled cards contribute 0 (honest unknown).
 */
function currentRunningPnl(
  duel: ChartDuel,
  side: "p0" | "p1",
  ticks: Record<string, ChartTick>,
  nowMs: number,
): bigint {
  let running = 0n
  for (const o of duel.cardOutcomes) {
    const raw = side === "p0" ? o.p0Pnl : o.p1Pnl
    if (raw !== null) running += BigInt(raw)
  }
  const settledIdx = new Set(duel.cardOutcomes.map((o) => o.cardIdx))
  for (const s of duel.swipes) {
    if (settledIdx.has(s.cardIdx)) continue
    const swipe = side === "p0" ? s.p0Swipe : s.p1Swipe
    if (!swipe) continue
    const card = duel.cards[s.cardIdx]
    if (!card) continue
    const tick = ticks[card.oracle_id]
    if (!tick) continue
    const pnl = markCardPnl(
      swipe,
      card.strike,
      tick.forward,
      tick.expiryMs,
      nowMs,
    )
    if (pnl !== null) running += pnl
  }
  return running
}

/**
 * Rolling PnL time-series + card-boundary markers. Samples both sides
 * at 10 Hz off the latest duel + smoothed ticks (smoothed via the
 * RAF loop inside), keeping a ~60 s window. Each new card settlement
 * appends a vertical boundary at the moment `settledCount` advances.
 */
function useChartHistory(
  duel: ChartDuel,
  ticks: Record<string, ChartTick>,
): { samples: Sample[]; boundaries: Boundary[] } {
  const duelRef = useRef(duel)
  // Latest raw tick values (the target).
  const targetTicksRef = useRef(ticks)
  // Eased copy updated each animation frame — what the sampler reads.
  const smoothedTicksRef = useRef<Record<string, ChartTick>>({})
  // Per-oracle interpolation anchor: linearly ease `from`→`to` across
  // `durMs` starting at `startMs`. `durMs` is set to the *observed* gap
  // between target updates, so motion spans the full inter-tick interval
  // at constant velocity instead of bursting early (the cause of the
  // choppy feel under exponential easing).
  const easeRef = useRef<
    Record<string, { from: number; to: number; startMs: number; durMs: number }>
  >({})
  useEffect(() => {
    duelRef.current = duel
  }, [duel])
  useEffect(() => {
    targetTicksRef.current = ticks
  }, [ticks])

  // RAF loop: linearly interpolate each oracle's forward from its last
  // value to the latest target across the observed tick cadence. When a
  // new target arrives, re-anchor from the *current* eased value (no
  // jump) and stretch the new ease over however long the previous gap
  // was — so 2 s ticks ease over 2 s, 500 ms ticks over 500 ms.
  useEffect(() => {
    let raf = 0
    const step = (now: number) => {
      const target = targetTicksRef.current
      const smoothed = smoothedTicksRef.current
      const ease = easeRef.current
      for (const id in target) {
        const t = target[id]
        const targetF = Number(t.forward)
        const e = ease[id]
        if (!e) {
          // First sight of this oracle — snap, seed the anchor.
          ease[id] = { from: targetF, to: targetF, startMs: now, durMs: 1 }
          smoothed[id] = t
          continue
        }
        if (targetF !== e.to) {
          // New target — re-anchor from the current eased value and ease
          // over the just-observed inter-tick gap.
          const curF = smoothed[id] ? Number(smoothed[id].forward) : e.to
          const gap = Math.min(EASE_MAX_MS, Math.max(EASE_MIN_MS, now - e.startMs))
          ease[id] = { from: curF, to: targetF, startMs: now, durMs: gap }
        }
        const a = ease[id]
        const p = a.durMs <= 0 ? 1 : Math.min(1, (now - a.startMs) / a.durMs)
        const f = a.from + (a.to - a.from) * p
        smoothed[id] = {
          spot: t.spot,
          forward: BigInt(Math.round(f)).toString(),
          expiryMs: t.expiryMs,
        }
      }
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [])

  const [history, setHistory] = useState<{
    duelId: string | null
    samples: Sample[]
    boundaries: Boundary[]
  }>({ duelId: null, samples: [], boundaries: [] })

  const duelId = duel.id
  const prevSettledRef = useRef(0)

  useEffect(() => {
    if (duel.settledCount > prevSettledRef.current) {
      const additions: Boundary[] = []
      const now = Date.now()
      for (let i = prevSettledRef.current; i < duel.settledCount; i++) {
        additions.push({ t: now, idx: i })
      }
      prevSettledRef.current = duel.settledCount
      setHistory((prev) =>
        prev.duelId === duel.id
          ? { ...prev, boundaries: [...prev.boundaries, ...additions] }
          : { duelId: duel.id, samples: [], boundaries: additions },
      )
    }
  }, [duel])

  useEffect(() => {
    const interval = setInterval(() => {
      const cur = duelRef.current
      const ts = smoothedTicksRef.current
      const now = Date.now()
      const p0 = currentRunningPnl(cur, "p0", ts, now)
      const p1 = currentRunningPnl(cur, "p1", ts, now)
      const sample: Sample = { t: now, p0, p1 }
      setHistory((prev) => {
        if (prev.duelId !== cur.id) {
          return { duelId: cur.id, samples: [sample], boundaries: [] }
        }
        const samples =
          prev.samples.length >= MAX_SAMPLES
            ? [...prev.samples.slice(-MAX_SAMPLES + 1), sample]
            : [...prev.samples, sample]
        return { duelId: prev.duelId, samples, boundaries: prev.boundaries }
      })
    }, SAMPLE_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [duelId])

  // Project to current duel — protects against stale-history flashes
  // when duelId changed but the next sample hasn't replaced it yet.
  if (history.duelId !== duelId) {
    return { samples: [], boundaries: [] }
  }
  return { samples: history.samples, boundaries: history.boundaries }
}

function ChartCanvas({
  samples,
  boundaries,
  myIsP0,
  youAddress,
  oppAddress,
  youPremium,
  oppPremium,
}: {
  samples: Sample[]
  boundaries: Boundary[]
  myIsP0: boolean
  youAddress: string
  oppAddress: string
  youPremium: bigint
  oppPremium: bigint
}) {
  const W = 320
  const H = 140
  const ml = 50
  const mr = 12
  const mt = 10
  const mb = 28
  const iw = W - ml - mr
  const ih = H - mt - mb

  const youOf = (s: Sample): bigint => (myIsP0 ? s.p0 : s.p1)
  const oppOf = (s: Sample): bigint => (myIsP0 ? s.p1 : s.p0)

  const { ampNum, xDomain } = useMemo(() => {
    let absMax = 0n
    let tMax = Number.NEGATIVE_INFINITY
    for (const s of samples) {
      const y = youOf(s)
      const o = oppOf(s)
      const ya = y < 0n ? -y : y
      const oa = o < 0n ? -o : o
      if (ya > absMax) absMax = ya
      if (oa > absMax) absMax = oa
      if (s.t > tMax) tMax = s.t
    }
    const padded = ((absMax > MIN_AMP_MICRO ? absMax : MIN_AMP_MICRO) * 12n) / 10n
    const domain: [number, number] = !isFinite(tMax)
      ? [0, 1]
      : [tMax - WINDOW_MS, tMax]
    return { ampNum: Number(padded), xDomain: domain }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [samples, myIsP0])

  const xScale = useMemo(
    () => scaleLinear<number>({ domain: xDomain, range: [0, iw] }),
    [xDomain, iw],
  )
  const yScale = useMemo(
    () => scaleLinear<number>({ domain: [-ampNum, ampNum], range: [ih, 0] }),
    [ampNum, ih],
  )

  const yZero = yScale(0)
  // Y-axis labels in percentage of YOUR premium — the natural reference
  // for "how much of my stake am I up/down". Falls back to a fixed
  // "$" amp if premium is zero (e.g., free-tier duels), so the chart
  // still renders something sensible.
  const ampPercent =
    youPremium > 0n ? Math.round((ampNum / Number(youPremium)) * 100) : 0
  const yTopLabel = ampPercent > 0 ? `+${ampPercent}%` : `+${fmtUsd(BigInt(Math.round(ampNum)))}`
  const yBotLabel = ampPercent > 0 ? `-${ampPercent}%` : `-${fmtUsd(BigInt(Math.round(ampNum)))}`
  // Break-even midline — read in the same unit as the top/bottom labels.
  const yZeroLabel = ampPercent > 0 ? "0%" : "$0"

  const last = samples[samples.length - 1]
  const xHead = last ? xScale(last.t) : 0
  const yYouHead = last ? yScale(Number(youOf(last))) : 0
  const yOppHead = last ? yScale(Number(oppOf(last))) : 0
  const avatarSize = 18

  const hasData = samples.length > 0

  return (
    <div className="crt-screen relative bg-black/25 px-1 py-1">
      {!hasData && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-4 text-center">
          <p className="text-[10px] tracking-[0.18em] text-white/55 uppercase">
            waiting for first tick
          </p>
        </div>
      )}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="block h-auto w-full"
        role="img"
        aria-label="match PnL over time"
      >
        <text x={ml - 6} y={mt} fill="#ffffffaa" fontSize="11" textAnchor="end" dominantBaseline="hanging">{yTopLabel}</text>
        <text x={ml - 6} y={mt + yZero} fill="#ffffffcc" fontSize="11" textAnchor="end" dominantBaseline="middle">{yZeroLabel}</text>
        <text x={ml - 6} y={H - mb} fill="#ffffffaa" fontSize="11" textAnchor="end" dominantBaseline="auto">{yBotLabel}</text>

        <Group left={ml} top={mt}>
          <line x1={0} x2={iw} y1={0} y2={0} stroke="#ffffff20" strokeWidth={1} />
          <line x1={0} x2={iw} y1={yZero} y2={yZero} stroke="#ffffff35" strokeDasharray="2 2" />
          <line x1={0} x2={iw} y1={ih} y2={ih} stroke="#ffffff20" strokeWidth={1} />

          {boundaries.map((b) => {
            if (b.t < xDomain[0] || b.t > xDomain[1]) return null
            const x = xScale(b.t)
            return (
              <g key={`${b.idx}-${b.t}`} opacity={0.65}>
                <line x1={x} x2={x} y1={0} y2={ih} stroke="#ffffff40" strokeDasharray="2 2" />
                <text x={x} y={ih + 12} fill="#ffffff80" fontSize="11" textAnchor="middle" dominantBaseline="hanging">
                  c{b.idx + 1}
                </text>
              </g>
            )
          })}

          {hasData &&
            (
              [
                { ago: 60_000, anchor: "start" as const },
                { ago: 30_000, anchor: "middle" as const },
                { ago: 0, anchor: "end" as const },
              ]
            ).map(({ ago, anchor }) => {
              const tx = xDomain[1] - ago
              const x = xScale(tx)
              return (
                <g key={ago} opacity={0.55}>
                  <line x1={x} x2={x} y1={ih} y2={ih + 3} stroke="#ffffff55" />
                  <text x={x} y={ih + 18} fill="#ffffff70" fontSize="11" textAnchor={anchor} dominantBaseline="hanging">
                    {ago === 0 ? "now" : `-${ago / 1000}s`}
                  </text>
                </g>
              )
            })}

          {hasData && (
            <>
              <LinePath
                data={samples}
                x={(d) => xScale(d.t)}
                y={(d) => yScale(Number(oppOf(d)))}
                stroke="#f08585"
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                curve={curveMonotoneX}
              />
              <LinePath
                data={samples}
                x={(d) => xScale(d.t)}
                y={(d) => yScale(Number(youOf(d)))}
                stroke="#7eb6ff"
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                curve={curveMonotoneX}
              />
              <foreignObject
                x={xHead - avatarSize / 2}
                y={yOppHead - avatarSize / 2}
                width={avatarSize}
                height={avatarSize}
                style={{ overflow: "visible" }}
              >
                <PlayerAvatar address={oppAddress} size={avatarSize} />
              </foreignObject>
              <foreignObject
                x={xHead - avatarSize / 2}
                y={yYouHead - avatarSize / 2}
                width={avatarSize}
                height={avatarSize}
                style={{ overflow: "visible" }}
              >
                <PlayerAvatar address={youAddress} size={avatarSize} />
              </foreignObject>
            </>
          )}
        </Group>
      </svg>

      <div className="mt-1 flex items-center justify-between px-1 text-[10px] tracking-[0.18em] uppercase">
        <span className="flex items-center gap-1.5">
          <PlayerAvatar address={youAddress} size={14} />
          <span className="text-white">you</span>
          <span className={pnlColor(last ? youOf(last) : 0n)}>
            {fmtPnl(last ? youOf(last) : 0n, youPremium)}
          </span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="text-white/75">opp</span>
          <span className={pnlColor(last ? oppOf(last) : 0n)}>
            {fmtPnl(last ? oppOf(last) : 0n, oppPremium)}
          </span>
          <PlayerAvatar address={oppAddress} size={14} />
        </span>
      </div>
    </div>
  )
}

function fmtUsd(micro: bigint): string {
  const sign = micro < 0n ? "-" : ""
  const abs = micro < 0n ? -micro : micro
  return `${sign}$${Math.round(Number(abs) / 1_000_000)}`
}

/**
 * Format a PnL micro value as a signed % of the side's premium, or fall
 * back to a signed dollar amount if premium is zero (free-tier duels).
 */
function fmtPnl(micro: bigint, premium: bigint): string {
  if (premium > 0n) {
    const pct = Math.round((Number(micro) / Number(premium)) * 100)
    const sign = pct < 0 ? "-" : pct > 0 ? "+" : ""
    return `${sign}${Math.abs(pct)}%`
  }
  const sign = micro < 0n ? "-" : micro > 0n ? "+" : ""
  const abs = micro < 0n ? -micro : micro
  return `${sign}$${Math.round(Number(abs) / 1_000_000)}`
}

function pnlColor(micro: bigint): string {
  if (micro > 0n) return "text-emerald-400"
  if (micro < 0n) return "text-rose-400"
  return "text-white/70"
}
