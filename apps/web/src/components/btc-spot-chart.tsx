/**
 * BTC spot price chart — TradingView aesthetic in the game's CRT phosphor
 * palette. Reuses the SAME data the duel settles against: the oracle `spot`
 * streamed over the WS (DeepBook Predict's oracle is Pyth-fed), so the chart
 * never disagrees with the strike/settlement the player is betting on.
 *
 * No external chart lib — visx (already a dep) + a RAF easer that slides the
 * head between sparse ~2 s server ticks, mirroring `streaming-pnl-chart`.
 *
 * Trading-desk furniture: gradient area fill, glowing price line, right-hand
 * price scale, the signature last-price tag, a dashed price line, a time
 * axis, and a hover crosshair with price/time readout.
 */
import { useEffect, useMemo, useRef, useState } from "react"
import { Group } from "@visx/group"
import { scaleLinear } from "@visx/scale"
import { AreaClosed, LinePath } from "@visx/shape"
import { curveMonotoneX } from "@visx/curve"

interface Tick {
  spot: string
}
interface PriceSample {
  t: number
  price: number
}

const SAMPLE_INTERVAL_MS = 100
const MAX_SAMPLES = 600 // ~60 s rolling window at 10 Hz
const WINDOW_MS = 60_000
const EASE_MS = 600 // matches server ORACLE_TICK_INTERVAL_MS feel

const PHOSPHOR = "#4aff9a"

/** Current BTC spot (USD) from the live ticks. All BTC oracles share the
 *  same underlying index, so the first card's oracle tick is canonical;
 *  fall back to any available tick. `spot` is 1e9-scaled on chain. */
function pickSpot(
  ticks: Record<string, Tick>,
  cards: Array<{ expiry_market_id: string }>
): number | null {
  for (const c of cards) {
    const t = ticks[c.expiry_market_id]
    if (t?.spot) {
      const v = Number(t.spot) / 1e9
      if (v > 0) return v
    }
  }
  for (const id in ticks) {
    const v = Number(ticks[id].spot) / 1e9
    if (v > 0) return v
  }
  return null
}

/** Rolling, RAF-eased spot series sampled at 10 Hz. */
function useSpotHistory(spot: number | null): PriceSample[] {
  const targetRef = useRef<number | null>(spot)
  const smoothedRef = useRef<number | null>(spot)
  useEffect(() => {
    targetRef.current = spot
  }, [spot])

  useEffect(() => {
    let raf = 0
    let last = performance.now()
    const step = (now: number) => {
      const dt = Math.min(now - last, 100)
      last = now
      const alpha = 1 - Math.exp(-dt / EASE_MS)
      const tg = targetRef.current
      if (tg != null) {
        const cur = smoothedRef.current
        smoothedRef.current = cur == null ? tg : cur + (tg - cur) * alpha
      }
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [])

  const [samples, setSamples] = useState<PriceSample[]>([])
  useEffect(() => {
    const iv = setInterval(() => {
      const p = smoothedRef.current
      if (p == null) return
      setSamples((prev) => {
        const next = [...prev, { t: Date.now(), price: p }]
        return next.length > MAX_SAMPLES ? next.slice(-MAX_SAMPLES) : next
      })
    }, SAMPLE_INTERVAL_MS)
    return () => clearInterval(iv)
  }, [])

  return samples
}

function fmtPrice(p: number, digits = 1): string {
  return `$${p.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`
}

export function BtcSpotChart({
  ticks,
  cards,
}: {
  ticks: Record<string, Tick>
  cards: Array<{ expiry_market_id: string }>
}) {
  const spot = pickSpot(ticks, cards)
  const samples = useSpotHistory(spot)

  const W = 340
  const H = 168
  const ml = 6
  const mr = 62 // right price axis + last-price tag
  const mt = 8
  const mb = 18
  const iw = W - ml - mr
  const ih = H - mt - mb

  const { xDomain, yDomain } = useMemo(() => {
    let tMax = Number.NEGATIVE_INFINITY
    let lo = Number.POSITIVE_INFINITY
    let hi = Number.NEGATIVE_INFINITY
    const cutoff = samples.length
      ? samples[samples.length - 1].t - WINDOW_MS
      : 0
    for (const s of samples) {
      if (s.t < cutoff) continue
      if (s.t > tMax) tMax = s.t
      if (s.price < lo) lo = s.price
      if (s.price > hi) hi = s.price
    }
    const xd: [number, number] = !isFinite(tMax)
      ? [0, 1]
      : [tMax - WINDOW_MS, tMax]
    // Zoom y to the visible range (TradingView-style), with a floor so a
    // dead-flat price still gets a sensible band instead of a zero-height
    // scale. Floor = 0.04% of price (~$27 at $67k).
    if (!isFinite(lo) || !isFinite(hi))
      return { xDomain: xd, yDomain: [0, 1] as [number, number] }
    const mid = (lo + hi) / 2
    const floor = Math.max(mid * 0.0004, 1)
    let half = Math.max((hi - lo) / 2, floor)
    half *= 1.25 // headroom
    return {
      xDomain: xd,
      yDomain: [mid - half, mid + half] as [number, number],
    }
  }, [samples])

  const xScale = useMemo(
    () => scaleLinear<number>({ domain: xDomain, range: [0, iw] }),
    [xDomain, iw]
  )
  const yScale = useMemo(
    () => scaleLinear<number>({ domain: yDomain, range: [ih, 0] }),
    [yDomain, ih]
  )

  const last = samples[samples.length - 1]
  const first = samples.find((s) => s.t >= xDomain[0])
  const up = last && first ? last.price >= first.price : true
  const lineColor = up ? PHOSPHOR : "#ff5d6c"

  const yTicks = useMemo(() => {
    const [lo, hi] = yDomain
    return [hi, (lo + hi) / 2, lo]
  }, [yDomain])

  const hasData = samples.length > 1
  const xHead = last ? xScale(last.t) : 0
  const yHead = last ? yScale(last.price) : 0

  // ── hover crosshair ──────────────────────────────────────────────
  const svgRef = useRef<SVGSVGElement>(null)
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null)
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current
    if (!svg) return
    const r = svg.getBoundingClientRect()
    const px = ((e.clientX - r.left) / r.width) * W - ml
    const py = ((e.clientY - r.top) / r.height) * H - mt
    if (px < 0 || px > iw || py < 0 || py > ih) {
      setHover(null)
      return
    }
    setHover({ x: px, y: py })
  }
  const hoverSample = useMemo(() => {
    if (!hover || !samples.length) return null
    const t = xScale.invert(hover.x)
    let best = samples[0]
    let bestD = Infinity
    for (const s of samples) {
      const d = Math.abs(s.t - t)
      if (d < bestD) {
        bestD = d
        best = s
      }
    }
    return best
  }, [hover, samples, xScale])

  return (
    <div className="crt-screen relative bg-black/30 px-1 pt-1 pb-0.5">
      {/* header strip */}
      <div className="flex items-center justify-between px-1.5 pb-1 text-[10px] tracking-[0.18em] uppercase">
        <span className="flex items-center gap-1.5 text-white/70">
          <span
            className="inline-block size-1.5 animate-pulse rounded-full"
            style={{ background: lineColor, boxShadow: `0 0 6px ${lineColor}` }}
          />
          btc / usd
        </span>
        <span
          className="text-[11px] tabular-nums"
          style={{ color: lineColor, textShadow: `0 0 8px ${lineColor}99` }}
        >
          {last ? fmtPrice(last.price, 2) : "—"}
        </span>
      </div>

      {!hasData && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="text-[10px] tracking-[0.18em] text-white/55 uppercase">
            waiting for oracle tick
          </p>
        </div>
      )}

      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="block h-auto w-full touch-none font-pixel"
        role="img"
        aria-label="BTC spot price"
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id="btc-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={lineColor} stopOpacity={0.34} />
            <stop offset="100%" stopColor={lineColor} stopOpacity={0} />
          </linearGradient>
          <filter id="btc-glow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="2.2" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <Group left={ml} top={mt}>
          {/* horizontal grid + right-axis price labels */}
          {yTicks.map((p, i) => {
            const y = yScale(p)
            return (
              <g key={i} opacity={0.5}>
                <line
                  x1={0}
                  x2={iw}
                  y1={y}
                  y2={y}
                  stroke="#ffffff14"
                  strokeWidth={1}
                  strokeDasharray={i === 1 ? "2 3" : undefined}
                />
                <text
                  x={iw + 6}
                  y={y}
                  fill="#ffffff66"
                  fontSize="11"
                  textAnchor="start"
                  dominantBaseline="middle"
                >
                  {Math.round(p).toLocaleString()}
                </text>
              </g>
            )
          })}

          {hasData && (
            <>
              <AreaClosed
                data={samples}
                x={(d) => xScale(d.t)}
                y={(d) => yScale(d.price)}
                y0={ih}
                yScale={yScale}
                fill="url(#btc-area)"
                curve={curveMonotoneX}
              />
              <LinePath
                data={samples}
                x={(d) => xScale(d.t)}
                y={(d) => yScale(d.price)}
                stroke={lineColor}
                strokeWidth={1.75}
                strokeLinejoin="round"
                strokeLinecap="round"
                curve={curveMonotoneX}
                filter="url(#btc-glow)"
              />

              {/* signature last-price line + head dot */}
              <line
                x1={0}
                x2={iw}
                y1={yHead}
                y2={yHead}
                stroke={lineColor}
                strokeOpacity={0.5}
                strokeDasharray="3 3"
                strokeWidth={1}
              />
              <circle
                cx={xHead}
                cy={yHead}
                r={2.6}
                fill={lineColor}
                filter="url(#btc-glow)"
              />

              {/* crosshair */}
              {hover && hoverSample && (
                <g pointerEvents="none">
                  <line
                    x1={xScale(hoverSample.t)}
                    x2={xScale(hoverSample.t)}
                    y1={0}
                    y2={ih}
                    stroke="#ffffff55"
                    strokeDasharray="2 2"
                  />
                  <line
                    x1={0}
                    x2={iw}
                    y1={hover.y}
                    y2={hover.y}
                    stroke="#ffffff55"
                    strokeDasharray="2 2"
                  />
                  <circle
                    cx={xScale(hoverSample.t)}
                    cy={yScale(hoverSample.price)}
                    r={2.6}
                    fill="#fff"
                  />
                </g>
              )}
            </>
          )}
        </Group>

        {/* last-price tag pinned on the right axis (TradingView signature) */}
        {hasData && (
          <g
            transform={`translate(${ml + iw}, ${mt + (hover ? hover.y : yHead)})`}
          >
            <rect
              x={2}
              y={-7}
              width={mr - 4}
              height={14}
              rx={2}
              fill={hover && hoverSample ? "#ffffff" : lineColor}
            />
            <text
              x={2 + (mr - 4) / 2}
              y={0}
              fill="#0a0f1f"
              fontSize="11"
              fontWeight="700"
              textAnchor="middle"
              dominantBaseline="central"
            >
              {hover && hoverSample
                ? Math.round(yScale.invert(hover.y)).toLocaleString()
                : last
                  ? Math.round(last.price).toLocaleString()
                  : "—"}
            </text>
          </g>
        )}

        {/* time axis */}
        {hasData &&
          [
            { ago: 60_000, anchor: "start" as const },
            { ago: 30_000, anchor: "middle" as const },
            { ago: 0, anchor: "end" as const },
          ].map(({ ago, anchor }) => {
            const x = ml + xScale(xDomain[1] - ago)
            return (
              <text
                key={ago}
                x={x}
                y={H - 5}
                fill="#ffffff66"
                fontSize="11"
                textAnchor={anchor}
              >
                {ago === 0 ? "now" : `-${ago / 1000}s`}
              </text>
            )
          })}
      </svg>
    </div>
  )
}
