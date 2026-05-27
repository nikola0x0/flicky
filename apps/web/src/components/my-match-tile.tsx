import { useEffect, useMemo, useRef, useState } from "react"
import { Link } from "react-router"
import { useCurrentAccount } from "@mysten/dapp-kit"
import { Group } from "@visx/group"
import { scaleLinear } from "@visx/scale"
import { LinePath } from "@visx/shape"
import { curveMonotoneX } from "@visx/curve"
import { CONFIG } from "@/lib/config"
import { useFlickySocket } from "@/hooks/use-flicky-socket"
import { liveCardPnl } from "@/lib/pnl"
import { PlayerAvatar } from "@/components/player-avatar"

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
 * Dev-only visual test path: `?demoChart=1` swaps the tile's data
 * sources for a synthesized ACTIVE duel + a synthetic oracle-tick stream
 * so the chart's avatar + smoothing can be verified without needing
 * the duel pipeline. Gated on `import.meta.env.DEV` so it can't ship.
 */
function useDemoChart(): boolean {
  if (!import.meta.env.DEV) return false
  if (typeof window === "undefined") return false
  return new URLSearchParams(window.location.search).get("demoChart") === "1"
}

const DEMO_OPP_ADDRESS =
  "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
const DEMO_STRIKE = "100000000000" // 100.0 on 1e9 scale
const DEMO_QUANTITY = "1000000000" // 1.0 quantity

function buildDemoDuel(address: string): DuelLite {
  return {
    id: "demo-duel",
    status: "ACTIVE",
    creator: address,
    challenger: DEMO_OPP_ADDRESS,
    cardCount: CARD_SLOTS,
    settledCount: 2,
    startedAtMs: Date.now() - 60_000,
    cardOutcomes: [
      { cardIdx: 0, p0Pnl: "500000", p1Pnl: "-500000" },
      { cardIdx: 1, p0Pnl: "-250000", p1Pnl: "250000" },
    ],
    swipes: [
      {
        cardIdx: 0,
        p0Swipe: { isUp: true, quantity: DEMO_QUANTITY, premium: "100000" },
        p1Swipe: { isUp: false, quantity: DEMO_QUANTITY, premium: "100000" },
      },
      {
        cardIdx: 1,
        p0Swipe: { isUp: false, quantity: DEMO_QUANTITY, premium: "100000" },
        p1Swipe: { isUp: true, quantity: DEMO_QUANTITY, premium: "100000" },
      },
      {
        cardIdx: 2,
        p0Swipe: { isUp: true, quantity: DEMO_QUANTITY, premium: "100000" },
        p1Swipe: { isUp: false, quantity: DEMO_QUANTITY, premium: "100000" },
      },
    ],
    cards: Array.from({ length: CARD_SLOTS }, (_, i) => ({
      oracle_id: `demo-oracle-${i}`,
      strike: DEMO_STRIKE,
    })),
  }
}

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
  const demo = useDemoChart()
  const { send, onMessage } = useFlickySocket(demo ? undefined : address)
  const [duels, setDuels] = useState<DuelLite[] | null>(null)
  const [ticks, setTicks] = useState<Record<string, Tick>>({})

  // Poll the player's duels — skipped in demo mode (mock seeded below).
  useEffect(() => {
    if (!address || demo) return
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
  }, [address, demo])

  // Demo: synthetic oracle-tick stream so the chart visibly moves
  // without a real game in flight. Drives a slow sine wave plus light
  // noise — looks like an actual price chart, not a random twitch.
  useEffect(() => {
    if (!demo) return
    const strike = BigInt(DEMO_STRIKE)
    const start = performance.now()
    const interval = setInterval(() => {
      const t = (performance.now() - start) / 1000
      // Two stacked sines for organic-feeling motion, amp ~0.5 on 1e9 scale.
      const wave =
        Math.sin(t * 0.6) * 350_000_000 + Math.sin(t * 1.7 + 1.2) * 120_000_000
      const noise = (Math.random() - 0.5) * 30_000_000
      const forward = strike + BigInt(Math.round(wave + noise))
      setTicks((prev) => ({
        ...prev,
        "demo-oracle-2": { spot: forward.toString(), forward: forward.toString() },
      }))
    }, 60)
    return () => clearInterval(interval)
  }, [demo])

  // Demo override: a synthesized ACTIVE duel replaces the polled list,
  // computed (not set into state) so the demo path doesn't fight the
  // real fetch effect on re-mounts.
  const effectiveDuels = useMemo(
    () => (demo && address ? [buildDemoDuel(address)] : duels),
    [demo, address, duels],
  )
  const pick = useMemo(() => pickMatch(effectiveDuels), [effectiveDuels])
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
    if (oracleIds.length === 0 || demo) return
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
  }, [oracleKey, onMessage, send, demo])

  const history = useChartHistory(pick, ticks)

  if (!address || !pick) return null

  const myIsP0 = pick.creator === address
  const opponentAddr = myIsP0 ? pick.challenger : pick.creator

  return (
    <section className="w-full rounded-xl border-2 border-black/55 bg-[#1b2548] p-3 font-pixel text-white shadow-[inset_0_-2px_0_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.06)]">
      <header className="mb-2 flex items-center justify-between">
        <h3 className="text-sm tracking-[0.2em] uppercase">your match</h3>
        <StatusBadge live={isLive} />
      </header>

      <StreamingPnlChart
        samples={history.samples}
        boundaries={history.boundaries}
        myIsP0={myIsP0}
        youAddress={address}
        oppAddress={opponentAddr}
      />

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

interface Sample {
  t: number
  p0: bigint
  p1: bigint
}

interface Boundary {
  t: number
  idx: number
}

const SAMPLE_INTERVAL_MS = 100
const MAX_SAMPLES = 600 // ~60 s rolling window at 10 Hz
const MIN_AMP_MICRO = 500_000n // 0.5 dUSDC y-axis floor

/**
 * Aggregate running PnL for one side at this instant. Settled cards
 * contribute their binary `pXPnl`; cards with a swipe + live tick
 * contribute mark-to-market via `liveCardPnl`. Unswiped or
 * tick-less unsettled cards contribute 0 (honest unknown), so the
 * sum stays continuous through every card transition.
 */
function currentRunningPnl(
  pick: DuelLite,
  side: "p0" | "p1",
  ticks: Record<string, Tick>,
): bigint {
  let running = 0n
  for (const o of pick.cardOutcomes) {
    const raw = side === "p0" ? o.p0Pnl : o.p1Pnl
    if (raw !== null) running += BigInt(raw)
  }
  const settledIdx = new Set(pick.cardOutcomes.map((o) => o.cardIdx))
  for (const s of pick.swipes) {
    if (settledIdx.has(s.cardIdx)) continue
    const swipe = side === "p0" ? s.p0Swipe : s.p1Swipe
    if (!swipe) continue
    const card = pick.cards[s.cardIdx]
    if (!card) continue
    const tick = ticks[card.oracle_id]
    if (!tick) continue
    const pnl = liveCardPnl(swipe, card.strike, tick.forward)
    if (pnl !== null) running += pnl
  }
  return running
}

/**
 * Records a rolling PnL time-series + card-boundary markers for the
 * given pick. Samples both sides at 10 Hz off the latest `pick`/`ticks`
 * (read via refs so the sampling interval doesn't tear down on every
 * tick), keeping a ~60 s window. Each new card settlement appends a
 * vertical boundary at the moment we observe `settledCount` advance.
 */
function useChartHistory(
  pick: DuelLite | null,
  ticks: Record<string, Tick>,
): { samples: Sample[]; boundaries: Boundary[] } {
  const pickRef = useRef(pick)
  const ticksRef = useRef(ticks)
  useEffect(() => {
    pickRef.current = pick
  }, [pick])
  useEffect(() => {
    ticksRef.current = ticks
  }, [ticks])

  // History is tagged with the duelId it belongs to. When the active
  // duel changes, render derives empty arrays until the next sampling
  // tick rebuilds them — no synchronous setState-in-effect reset.
  const [history, setHistory] = useState<{
    duelId: string | null
    samples: Sample[]
    boundaries: Boundary[]
  }>({ duelId: null, samples: [], boundaries: [] })

  const duelId = pick?.id ?? null
  const prevSettledRef = useRef(0)

  // Card-boundary detection: when settledCount advances, push a marker
  // for each new index. Setter is conditional, so the lint heuristic
  // doesn't flag a cascading render.
  useEffect(() => {
    if (!pick) {
      prevSettledRef.current = 0
      return
    }
    if (pick.settledCount > prevSettledRef.current) {
      const additions: Boundary[] = []
      const now = Date.now()
      for (let i = prevSettledRef.current; i < pick.settledCount; i++) {
        additions.push({ t: now, idx: i })
      }
      prevSettledRef.current = pick.settledCount
      setHistory((prev) =>
        prev.duelId === pick.id
          ? { ...prev, boundaries: [...prev.boundaries, ...additions] }
          : { duelId: pick.id, samples: [], boundaries: additions },
      )
    }
  }, [pick])

  // 10 Hz sampling loop — runs while we have any duel selected. The
  // setter swaps history wholesale when the duelId mismatches, which
  // handles duel changes without a synchronous reset effect.
  useEffect(() => {
    if (!duelId) return
    const interval = setInterval(() => {
      const cur = pickRef.current
      if (!cur) return
      const ts = ticksRef.current
      const p0 = currentRunningPnl(cur, "p0", ts)
      const p1 = currentRunningPnl(cur, "p1", ts)
      const sample: Sample = { t: Date.now(), p0, p1 }
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

  // Project to current duel — protects against rendering stale data
  // during the brief window where duelId changed but the next sample
  // hasn't replaced history yet.
  if (history.duelId !== duelId) {
    return { samples: [], boundaries: [] }
  }
  return { samples: history.samples, boundaries: history.boundaries }
}

/**
 * Streaming PnL chart: time on the x-axis, cumulative PnL on the y-axis,
 * one line per player ending in their avatar at the live head. Card
 * boundaries surface as dotted vertical markers. Driven by the rolling
 * sample buffer from `useChartHistory` — every 100 ms the head advances
 * rightward, so movement is continuous, not slot-snapped.
 */
function StreamingPnlChart({
  samples,
  boundaries,
  myIsP0,
  youAddress,
  oppAddress,
}: {
  samples: Sample[]
  boundaries: Boundary[]
  myIsP0: boolean
  youAddress: string
  oppAddress: string
}) {
  const W = 320
  const H = 132
  const ml = 36
  const mr = 12
  const mt = 8
  const mb = 22
  const iw = W - ml - mr
  const ih = H - mt - mb

  const youOf = (s: Sample): bigint => (myIsP0 ? s.p0 : s.p1)
  const oppOf = (s: Sample): bigint => (myIsP0 ? s.p1 : s.p0)

  const { ampNum, xDomain } = useMemo(() => {
    let absMax = 0n
    let tMin = Number.POSITIVE_INFINITY
    let tMax = Number.NEGATIVE_INFINITY
    for (const s of samples) {
      const y = youOf(s)
      const o = oppOf(s)
      const ya = y < 0n ? -y : y
      const oa = o < 0n ? -o : o
      if (ya > absMax) absMax = ya
      if (oa > absMax) absMax = oa
      if (s.t < tMin) tMin = s.t
      if (s.t > tMax) tMax = s.t
    }
    // 20% headroom so the live head doesn't kiss the top/bottom rails.
    const padded = ((absMax > MIN_AMP_MICRO ? absMax : MIN_AMP_MICRO) * 12n) / 10n
    // Placeholder domain when there's no data — scales aren't rendered
    // in that branch anyway (we gate on `hasData`).
    const domain: [number, number] = !isFinite(tMin)
      ? [0, 1]
      : tMin === tMax
        ? [tMin - 1000, tMax]
        : [tMin, tMax]
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
  const yTopLabel = `+${fmtUsd(BigInt(Math.round(ampNum)))}`
  const yBotLabel = `-${fmtUsd(BigInt(Math.round(ampNum)))}`

  const last = samples[samples.length - 1]
  const xHead = last ? xScale(last.t) : 0
  const yYouHead = last ? yScale(Number(youOf(last))) : 0
  const yOppHead = last ? yScale(Number(oppOf(last))) : 0
  const avatarSize = 18

  const hasData = samples.length > 0

  return (
    <div className="relative rounded bg-black/25 px-1 py-1">
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
        <text x={ml - 6} y={mt + 4} fill="#ffffffaa" fontSize="9" textAnchor="end" fontFamily="monospace">{yTopLabel}</text>
        <text x={ml - 6} y={mt + yZero + 3} fill="#ffffffcc" fontSize="9" textAnchor="end" fontFamily="monospace">$0.00</text>
        <text x={ml - 6} y={H - mb + 3} fill="#ffffffaa" fontSize="9" textAnchor="end" fontFamily="monospace">{yBotLabel}</text>

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
                <text x={x} y={ih + 10} fill="#ffffff80" fontSize="9" textAnchor="middle" fontFamily="monospace">
                  c{b.idx + 1}
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
        <span className="flex items-center gap-1.5 text-white">
          <span className="inline-block size-2 rounded-full bg-[#7eb6ff]" />
          you {last ? fmtSigned(youOf(last)) : "$0.00"}
        </span>
        <span className="flex items-center gap-1.5 text-white/75">
          opp {last ? fmtSigned(oppOf(last)) : "$0.00"}
          <span className="inline-block size-2 rounded-full bg-[#f08585]" />
        </span>
      </div>
    </div>
  )
}

function fmtUsd(micro: bigint): string {
  const sign = micro < 0n ? "-" : ""
  const abs = micro < 0n ? -micro : micro
  return `${sign}$${(Number(abs) / 1_000_000).toFixed(2)}`
}

function fmtSigned(micro: bigint): string {
  const sign = micro < 0n ? "-" : micro > 0n ? "+" : ""
  const abs = micro < 0n ? -micro : micro
  return `${sign}$${(Number(abs) / 1_000_000).toFixed(2)}`
}
