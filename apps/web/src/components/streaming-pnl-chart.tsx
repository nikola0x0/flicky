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
import { markCardPnl, type SwipeLite } from "@/lib/pnl"
import {
  MAX_SAMPLES,
  yAmpFor,
  relativeTimeLabels,
  sliceToRange,
  serializeHistory,
  parseHistory,
  type Sample,
  type Boundary,
} from "@/lib/pnl-history"
import { PlayerAvatar } from "@/components/player-avatar"

export interface ChartDuel {
  id: string
  settledCount: number
  cards: Array<{ expiry_market_id: string; strike: string }>
  swipes: Array<{
    cardIdx: number
    p0Swipe: {
      isUp: boolean
      quantity: string
      orderId: string
      premium?: string
    } | null
    p1Swipe: {
      isUp: boolean
      quantity: string
      orderId: string
      premium?: string
    } | null
  }>
  cardOutcomes: Array<{
    cardIdx: number
    p0Pnl: string | null
    p1Pnl: string | null
  }>
}

export interface ChartTick {
  spot: string
  /** Market expiry (ms). Drives time-decay in the continuous mark. */
  expiryMs?: number
}

const SAMPLE_INTERVAL_MS = 1000 // 1 Hz — one PnL sample per second
// Bounds for the adaptive ease duration (matched to observed tick cadence).
const EASE_MIN_MS = 500
const EASE_MAX_MS = 3000
const STORAGE_BASE = "flicky:pnl-history:"
// v3: earlier formats persisted a long leading flat-"0" run (pre-Pyth-spot in
// v1, pre-first-tick in v2). The bump abandons them — the persist sweep matches
// STORAGE_BASE so any lingering v1/v2 key is purged on the next write.
const STORAGE_PREFIX = STORAGE_BASE + "v3:"

// Manual time-zoom presets (TradingView-style); `null` = full match.
const RANGE_PRESETS: Array<{ label: string; ms: number | null }> = [
  { label: "1m", ms: 60_000 },
  { label: "5m", ms: 300_000 },
  { label: "15m", ms: 900_000 },
  { label: "all", ms: null },
]

export function StreamingPnlChart({
  duel,
  ticks,
  myIsP0,
  youAddress,
  oppAddress,
  showRangeControls = false,
}: {
  duel: ChartDuel
  ticks: Record<string, ChartTick>
  myIsP0: boolean
  youAddress: string
  oppAddress: string
  /** Show the TradingView-style time-range chips (watch view only). */
  showRangeControls?: boolean
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
      showRangeControls={showRangeControls}
    />
  )
}

// Sum of real per-swipe `net_premium` across every card (settled or not)
// for one side — the denominator for the "you"/"opp" percentage badge.
// `premium` is absent for free-tier swipes (never minted) or an order the
// server's mirror hasn't caught up to yet; those just don't contribute.
// ChartCanvas already falls back to a flat "$" y-axis scale when this is 0.
function totalPremium(duel: ChartDuel, side: "p0" | "p1"): bigint {
  let total = 0n
  for (const s of duel.swipes) {
    const swipe = side === "p0" ? s.p0Swipe : s.p1Swipe
    if (swipe?.premium) total += BigInt(swipe.premium)
  }
  return total
}

/**
 * Narrows a wire swipe (which carries `orderId`) down to the `SwipeLite`
 * shape `pnl.ts`'s helpers need. 6-24 dropped per-swipe `premium` from the
 * wire (only `orderId` remains — the real premium needs a server-side
 * lookup that isn't wired in yet), and `SwipeLite` no longer has a
 * `premium` field: `markCardPnl` now projects binary PnL from
 * spot-vs-strike + `quantity` alone.
 */
function toSwipeLite(
  swipe: { isUp: boolean; quantity: string; orderId: string } | null
): SwipeLite | null {
  return swipe ? { isUp: swipe.isUp, quantity: swipe.quantity } : null
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
  nowMs: number
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
    const tick = ticks[card.expiry_market_id]
    if (!tick) continue
    const pnl = markCardPnl(
      toSwipeLite(swipe),
      card.strike,
      tick.spot,
      tick.expiryMs,
      nowMs
    )
    if (pnl !== null) running += pnl
  }
  return running
}

/**
 * Rolling PnL time-series + card-boundary markers. Samples both sides
 * at 1 Hz off the latest duel + smoothed ticks (smoothed via the RAF
 * loop inside) into a growing full-match window, persisted across
 * refresh. Each new card settlement appends a vertical boundary at the
 * moment `settledCount` advances.
 */
function useChartHistory(
  duel: ChartDuel,
  ticks: Record<string, ChartTick>
): { samples: Sample[]; boundaries: Boundary[] } {
  const duelRef = useRef(duel)
  // Latest raw tick values (the target).
  const targetTicksRef = useRef(ticks)
  // Eased copy updated each animation frame — what the sampler reads. Never
  // deletes a market: a sparse/frozen feed keeps its last-known spot so
  // `upProbability` time-decay keeps the mark drifting each second.
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

  // RAF loop: linearly interpolate each market's spot from its last
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
        const targetF = Number(t.spot)
        const e = ease[id]
        if (!e) {
          // First sight of this market — snap, seed the anchor.
          ease[id] = { from: targetF, to: targetF, startMs: now, durMs: 1 }
          smoothed[id] = t
          continue
        }
        if (targetF !== e.to) {
          // New target — re-anchor from the current eased value and ease
          // over the just-observed inter-tick gap.
          const curF = smoothed[id] ? Number(smoothed[id].spot) : e.to
          const gap = Math.min(
            EASE_MAX_MS,
            Math.max(EASE_MIN_MS, now - e.startMs)
          )
          ease[id] = { from: curF, to: targetF, startMs: now, durMs: gap }
        }
        const a = ease[id]
        const p = a.durMs <= 0 ? 1 : Math.min(1, (now - a.startMs) / a.durMs)
        const f = a.from + (a.to - a.from) * p
        smoothed[id] = {
          spot: BigInt(Math.round(f)).toString(),
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

  // Mirror the latest history for the throttled persister + unload flush,
  // which must read current state without re-subscribing every render.
  const historyRef = useRef(history)
  useEffect(() => {
    historyRef.current = history
  }, [history])

  // Hydrate from localStorage when the duel changes (incl. first mount /
  // F5), so a refresh continues the same line instead of resetting.
  useEffect(() => {
    if (typeof window === "undefined") return
    try {
      const restored = parseHistory(
        window.localStorage.getItem(STORAGE_PREFIX + duelId)
      )
      if (restored && restored.duelId === duelId) {
        setHistory({
          duelId,
          samples: restored.samples,
          boundaries: restored.boundaries,
        })
        prevSettledRef.current = duelRef.current.settledCount
      }
    } catch {
      // corrupt / unavailable storage — start fresh, never throw
    }
  }, [duelId])

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
          : { duelId: duel.id, samples: [], boundaries: additions }
      )
    }
  }, [duel])

  useEffect(() => {
    const interval = setInterval(() => {
      const cur = duelRef.current
      // Use raw server ticks (targetTicksRef), NOT smoothed (smoothedTicksRef).
      // Smoothed values depend on each client's RAF timing and diverge across
      // tabs — raw ticks are identical on both clients (same WS payload), so
      // the resulting PnL history is deterministic and the two players' charts
      // match (you-line on A == opp-line on B, and vice versa).
      const ts = targetTicksRef.current
      const now = Date.now()
      // Don't record until there's a real data source — a live tick eased in
      // or a settled card. The pre-first-tick window (and the post-F5
      // re-subscribe gap) would otherwise log a long flat $0 run that
      // persists across refreshes and pins the timeline's start at zero.
      const hasData = Object.keys(ts).length > 0 || cur.settledCount > 0
      if (!hasData) return
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

  // Persist at most every 2 s (piggybacking the 1 Hz sampler's state
  // changes). bigints serialize as strings; only the current duel's entry
  // is kept so storage can't grow across matches.
  const lastPersistRef = useRef(0)
  useEffect(() => {
    if (typeof window === "undefined") return
    if (history.duelId !== duelId || history.samples.length === 0) return
    const now = Date.now()
    if (now - lastPersistRef.current < 2000) return
    lastPersistRef.current = now
    try {
      const key = STORAGE_PREFIX + duelId
      window.localStorage.setItem(
        key,
        serializeHistory(duelId, history.samples, history.boundaries)
      )
      for (let i = window.localStorage.length - 1; i >= 0; i--) {
        const k = window.localStorage.key(i)
        // Match the version-agnostic base so stale v1 keys are purged too.
        if (k && k.startsWith(STORAGE_BASE) && k !== key) {
          window.localStorage.removeItem(k)
        }
      }
    } catch {
      // quota / unavailable — degrade to in-memory only
    }
  }, [history, duelId])

  // Flush the freshest samples when the tab is hidden or navigated away,
  // so a refresh restores right up to the last visible point.
  useEffect(() => {
    if (typeof window === "undefined") return
    const flush = () => {
      const h = historyRef.current
      if (h.duelId !== duelId || h.samples.length === 0) return
      try {
        window.localStorage.setItem(
          STORAGE_PREFIX + duelId,
          serializeHistory(duelId, h.samples, h.boundaries)
        )
      } catch {
        // ignore
      }
    }
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush()
    }
    window.addEventListener("pagehide", flush)
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      window.removeEventListener("pagehide", flush)
      document.removeEventListener("visibilitychange", onVisibility)
    }
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
  showRangeControls,
}: {
  samples: Sample[]
  boundaries: Boundary[]
  myIsP0: boolean
  youAddress: string
  oppAddress: string
  youPremium: bigint
  oppPremium: bigint
  showRangeControls: boolean
}) {
  // Manual time-zoom: `null` = full match; otherwise the last `rangeMs`.
  const [rangeMs, setRangeMs] = useState<number | null>(null)
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

  // Visible slice for the selected zoom (full match when rangeMs === null).
  const visible = useMemo(
    () => sliceToRange(samples, rangeMs),
    [samples, rangeMs]
  )

  const { ampNum, xDomain } = useMemo(() => {
    const firstT = visible.length > 0 ? visible[0].t : 0
    let tMax = Number.NEGATIVE_INFINITY
    for (const s of visible) if (s.t > tMax) tMax = s.t
    // Fixed range pins [tMax - rangeMs, tMax] so the window is stable before
    // it fills; full match grows [firstT, now]. Guard the degenerate
    // single-sample / empty cases so the x-scale has a non-zero span.
    const domain: [number, number] = !isFinite(tMax)
      ? [0, 1]
      : rangeMs !== null
        ? [tMax - rangeMs, tMax]
        : firstT < tMax
          ? [firstT, tMax]
          : [tMax - SAMPLE_INTERVAL_MS, tMax]
    return { ampNum: yAmpFor(visible, myIsP0), xDomain: domain }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, myIsP0, rangeMs])

  const xScale = useMemo(
    () => scaleLinear<number>({ domain: xDomain, range: [0, iw] }),
    [xDomain, iw]
  )
  const yScale = useMemo(
    () => scaleLinear<number>({ domain: [-ampNum, ampNum], range: [ih, 0] }),
    [ampNum, ih]
  )

  const yZero = yScale(0)
  // Y-axis labels in percentage of YOUR premium — the natural reference
  // for "how much of my stake am I up/down". Falls back to a fixed
  // "$" amp if premium is zero (e.g., free-tier duels), so the chart
  // still renders something sensible.
  const ampPercent =
    youPremium > 0n ? Math.round((ampNum / Number(youPremium)) * 100) : 0
  const yTopLabel =
    ampPercent > 0
      ? `+${ampPercent}%`
      : `+${fmtUsd(BigInt(Math.round(ampNum)))}`
  const yBotLabel =
    ampPercent > 0
      ? `-${ampPercent}%`
      : `-${fmtUsd(BigInt(Math.round(ampNum)))}`
  // Break-even midline — read in the same unit as the top/bottom labels.
  const yZeroLabel = ampPercent > 0 ? "0%" : "$0"

  const last = visible[visible.length - 1]
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
        <text
          x={ml - 6}
          y={mt}
          fill="#ffffffaa"
          fontSize="11"
          textAnchor="end"
          dominantBaseline="hanging"
        >
          {yTopLabel}
        </text>
        <text
          x={ml - 6}
          y={mt + yZero}
          fill="#ffffffcc"
          fontSize="11"
          textAnchor="end"
          dominantBaseline="middle"
        >
          {yZeroLabel}
        </text>
        <text
          x={ml - 6}
          y={H - mb}
          fill="#ffffffaa"
          fontSize="11"
          textAnchor="end"
          dominantBaseline="auto"
        >
          {yBotLabel}
        </text>

        <Group left={ml} top={mt}>
          <line
            x1={0}
            x2={iw}
            y1={0}
            y2={0}
            stroke="#ffffff20"
            strokeWidth={1}
          />
          <line
            x1={0}
            x2={iw}
            y1={yZero}
            y2={yZero}
            stroke="#ffffff35"
            strokeDasharray="2 2"
          />
          <line
            x1={0}
            x2={iw}
            y1={ih}
            y2={ih}
            stroke="#ffffff20"
            strokeWidth={1}
          />

          {boundaries.map((b) => {
            if (b.t < xDomain[0] || b.t > xDomain[1]) return null
            const x = xScale(b.t)
            return (
              <g key={`${b.idx}-${b.t}`} opacity={0.65}>
                <line
                  x1={x}
                  x2={x}
                  y1={0}
                  y2={ih}
                  stroke="#ffffff40"
                  strokeDasharray="2 2"
                />
                <text
                  x={x}
                  y={ih + 12}
                  fill="#ffffff80"
                  fontSize="11"
                  textAnchor="middle"
                  dominantBaseline="hanging"
                >
                  c{b.idx + 1}
                </text>
              </g>
            )
          })}

          {hasData &&
            relativeTimeLabels(xDomain[0], xDomain[1], 4).map(
              (mark, i, all) => {
                const x = xScale(mark.t)
                const anchor =
                  i === 0 ? "start" : i === all.length - 1 ? "end" : "middle"
                return (
                  <g key={mark.t} opacity={0.55}>
                    <line
                      x1={x}
                      x2={x}
                      y1={ih}
                      y2={ih + 3}
                      stroke="#ffffff55"
                    />
                    <text
                      x={x}
                      y={ih + 18}
                      fill="#ffffff70"
                      fontSize="11"
                      textAnchor={anchor}
                      dominantBaseline="hanging"
                    >
                      {mark.label}
                    </text>
                  </g>
                )
              }
            )}

          {hasData && (
            <>
              <LinePath
                data={visible}
                x={(d) => xScale(d.t)}
                y={(d) => yScale(Number(oppOf(d)))}
                stroke="#f08585"
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                curve={curveMonotoneX}
              />
              <LinePath
                data={visible}
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

      {showRangeControls && (
        <div className="mt-1 flex items-center justify-end gap-0.5 px-1">
          {RANGE_PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => setRangeMs(p.ms)}
              className={`px-1.5 py-0.5 text-[9px] tracking-[0.12em] uppercase transition-colors ${
                rangeMs === p.ms
                  ? "bg-white/85 text-black"
                  : "bg-white/10 text-white/55 hover:bg-white/20"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}
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
