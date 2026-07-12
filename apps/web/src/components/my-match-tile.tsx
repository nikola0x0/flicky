import { useEffect, useMemo, useState } from "react"
import { Link } from "react-router"
import { useCurrentAccount } from "@mysten/dapp-kit-react"
import { CONFIG } from "@/lib/config"
import { useFlickySocket } from "@/hooks/use-flicky-socket"
import { StreamingPnlChart } from "@/components/streaming-pnl-chart"
import {
  DEMO_DUEL_ID,
  DEMO_OPP_ADDRESS,
  DEMO_ORDER_ID,
  DEMO_QUANTITY,
  DEMO_STRIKE,
  useDemoChart,
  useDemoOracleTicks,
} from "@/lib/demo-chart"

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
  lastUpdatedMs: number
  cardOutcomes: Array<{
    cardIdx: number
    p0Pnl: string | null
    p1Pnl: string | null
  }>
  swipes: Array<{
    cardIdx: number
    p0Swipe: { isUp: boolean; quantity: string; orderId: string } | null
    p1Swipe: { isUp: boolean; quantity: string; orderId: string } | null
  }>
  cards: Array<{ expiry_market_id: string; strike: string }>
}

interface Tick {
  spot: string
  expiryMs?: number
  /** Market settled on-chain — lands before the indexer mirrors it. */
  settled?: boolean
}

const POLL_INTERVAL_MS = 5_000
const CARD_SLOTS = 5

function buildDemoDuel(address: string): DuelLite {
  return {
    id: DEMO_DUEL_ID,
    status: "ACTIVE",
    creator: address,
    challenger: DEMO_OPP_ADDRESS,
    cardCount: CARD_SLOTS,
    settledCount: 2,
    startedAtMs: Date.now() - 60_000,
    lastUpdatedMs: Date.now(),
    cardOutcomes: [
      { cardIdx: 0, p0Pnl: "50000000", p1Pnl: "-50000000" },
      { cardIdx: 1, p0Pnl: "-30000000", p1Pnl: "30000000" },
    ],
    swipes: [
      {
        cardIdx: 0,
        p0Swipe: {
          isUp: true,
          quantity: DEMO_QUANTITY,
          orderId: DEMO_ORDER_ID,
        },
        p1Swipe: {
          isUp: false,
          quantity: DEMO_QUANTITY,
          orderId: DEMO_ORDER_ID,
        },
      },
      {
        cardIdx: 1,
        p0Swipe: {
          isUp: false,
          quantity: DEMO_QUANTITY,
          orderId: DEMO_ORDER_ID,
        },
        p1Swipe: {
          isUp: true,
          quantity: DEMO_QUANTITY,
          orderId: DEMO_ORDER_ID,
        },
      },
      {
        cardIdx: 2,
        p0Swipe: {
          isUp: true,
          quantity: DEMO_QUANTITY,
          orderId: DEMO_ORDER_ID,
        },
        p1Swipe: {
          isUp: false,
          quantity: DEMO_QUANTITY,
          orderId: DEMO_ORDER_ID,
        },
      },
    ],
    cards: Array.from({ length: CARD_SLOTS }, (_, i) => ({
      expiry_market_id: `demo-oracle-${i}`,
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
  const { wsOpen, send, onMessage } = useFlickySocket(address, {
    enabled: !demo,
  })
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
          `${CONFIG.serverHttpUrl}/duels/recent?player=${encodeURIComponent(address)}&limit=20`
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

  useDemoOracleTicks(demo, setTicks)

  // Demo override: a synthesized ACTIVE duel replaces the polled list,
  // computed (not set into state) so the demo path doesn't fight the
  // real fetch effect on re-mounts.
  const effectiveDuels = useMemo(
    () => (demo && address ? [buildDemoDuel(address)] : duels),
    [demo, address, duels]
  )
  const pick = useMemo(() => pickMatch(effectiveDuels), [effectiveDuels])
  // "Live" means actively being played — not a duel that's fully settled but
  // still ACTIVE because the keeper hasn't finalized it yet. Those are done
  // in every way that matters to the player, so they shouldn't pulse "live".
  const isLive = pick != null && isLiveDuel(pick)

  // Subscribe to oracle ticks for the duel's cards while LIVE. The
  // `unsubscribe` cleanup keeps the keeper's broadcast traffic tight
  // when we navigate away or the duel settles.
  const marketIds = useMemo(
    () => (isLive && pick ? pick.cards.map((c) => c.expiry_market_id) : []),
    [isLive, pick]
  )
  const oracleKey = marketIds.join(",")
  useEffect(() => {
    // Gate on `wsOpen` so the subscribe runs once the socket is actually
    // open — otherwise a subscribe sent before the WS handshake (it can
    // lose the race against the duel poll resolving) is a silent no-op
    // and never retried, leaving the chart tick-less. Also re-fires on a
    // server-restart reconnect.
    if (marketIds.length === 0 || demo || !wsOpen) return
    send({ type: "oracle_subscribe", marketIds })
    const off = onMessage((msg) => {
      if (msg.type !== "oracle_tick") return
      if (!marketIds.includes(msg.expiryMarketId)) return
      setTicks((prev) => ({
        ...prev,
        [msg.expiryMarketId]: {
          spot: msg.spot,
          expiryMs: Number(msg.expiry),
          settled: msg.settlementPrice != null,
        },
      }))
    })
    return () => {
      off()
      send({ type: "oracle_unsubscribe", marketIds })
    }
    // oracleKey condenses the array dependency so we don't re-subscribe
    // on every parent render that returns a fresh `marketIds`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oracleKey, onMessage, send, demo, wsOpen])

  if (!address) return null

  if (!pick) {
    return (
      <section className="w-full rounded-xl border-2 border-black/55 bg-black/35 p-4 font-pixel text-white shadow-[inset_0_-2px_0_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.06)] backdrop-blur-md">
        <header className="mb-3 flex items-center justify-between">
          <h3 className="text-base tracking-[0.2em] uppercase">your match</h3>
          <div className="flex items-center gap-2">
            <span className="rounded bg-white/10 px-2 py-0.5 text-xs tracking-[0.18em] text-white/55 uppercase">
              idle
            </span>
            <Link
              to="/game/history"
              className="rounded border border-white/25 bg-white/5 px-2 py-1 text-xs tracking-[0.18em] text-white/70 uppercase hover:bg-white/10"
            >
              see all →
            </Link>
          </div>
        </header>
        <div className="flex flex-col items-center gap-2 py-4 text-center">
          <img
            src="/icons/swords.png"
            alt=""
            aria-hidden
            className="size-12 opacity-60 [image-rendering:pixelated]"
          />
          <p className="text-base tracking-wider text-white/75 uppercase">
            no active duel
          </p>
          <p className="max-w-[24ch] text-sm leading-relaxed tracking-wider text-white/50">
            your live pvp match will show up here once you start one
          </p>
          <Link
            to="/game/pvp"
            className="mt-2 rounded border border-white/30 bg-white/5 px-3 py-1 text-sm tracking-wider uppercase hover:bg-white/10"
          >
            find a duel
          </Link>
        </div>
      </section>
    )
  }

  const myIsP0 = pick.creator === address
  const opponentAddr = myIsP0 ? pick.challenger : pick.creator
  // On-chain settlement precedes the indexer's `settledCount`, so count
  // oracles the tick stream reports settled and show whichever is ahead.
  const onChainSettled = pick.cards.reduce(
    (n, c) => n + (ticks[c.expiry_market_id]?.settled ? 1 : 0),
    0
  )
  const settledCount = Math.max(pick.settledCount, onChainSettled)

  return (
    <section className="w-full rounded-xl border-2 border-black/55 bg-black/35 p-3 font-pixel text-white shadow-[inset_0_-2px_0_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.06)] backdrop-blur-md">
      <header className="mb-2 flex items-center justify-between">
        <h3 className="text-base tracking-[0.2em] uppercase">your match</h3>
        <div className="flex items-center gap-2">
          <StatusBadge live={isLive} />
          <Link
            to="/game/history"
            className="rounded border border-white/25 bg-white/5 px-2 py-1 text-xs tracking-[0.18em] text-white/70 uppercase hover:bg-white/10"
          >
            see all →
          </Link>
        </div>
      </header>

      <StreamingPnlChart
        duel={pick}
        ticks={ticks}
        myIsP0={myIsP0}
        youAddress={address}
        oppAddress={opponentAddr}
      />

      <footer className="mt-2 flex items-center justify-between text-sm tracking-wider uppercase">
        <div className="flex flex-col">
          <span className="text-white/55">vs</span>
          <span>{shortAddr(opponentAddr)}</span>
        </div>
        <div className="flex flex-col text-right">
          <span className="text-white/55">cards settled</span>
          <span className="text-white tabular-nums">
            {settledCount} / {pick.cardCount || CARD_SLOTS}
          </span>
        </div>
        <Link
          to={`/game/duel/${pick.id}${demo ? "?demoChart=1" : ""}`}
          className="rounded border border-white/30 bg-white/5 px-3 py-1 text-sm tracking-wider uppercase hover:bg-white/10"
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
      <span className="flex items-center gap-1.5 rounded bg-[#1f3a1f] px-2 py-0.5 text-xs tracking-[0.18em] text-emerald-300 uppercase">
        <span className="inline-block size-1.5 animate-pulse rounded-full bg-emerald-400" />
        live
      </span>
    )
  }
  return (
    <span className="rounded bg-white/10 px-2 py-0.5 text-xs tracking-[0.18em] text-white/70 uppercase">
      final
    </span>
  )
}

/** Genuinely in-play: ACTIVE and not every card settled yet. */
function isLiveDuel(d: DuelLite): boolean {
  return (
    d.status === "ACTIVE" && (d.cardCount === 0 || d.settledCount < d.cardCount)
  )
}

/** Recency key — `lastUpdatedMs` is the reliable one; fall back to start. */
function recencyOf(d: DuelLite): number {
  return d.lastUpdatedMs || d.startedAtMs || 0
}

function pickMatch(duels: DuelLite[] | null): DuelLite | null {
  if (!duels || duels.length === 0) return null
  // A genuinely-live duel always takes the slot (newest first). A duel that's
  // fully settled but still ACTIVE — keeper hasn't finalized — is treated as
  // done, so it can't outrank a more-recent finished match.
  const live = duels
    .filter(isLiveDuel)
    .sort((a, b) => recencyOf(b) - recencyOf(a))
  if (live[0]) return live[0]
  // Otherwise show the most-recently-touched finished duel (COMPLETE or a
  // fully-settled-but-unfinalized ACTIVE one). PENDING rows have no result yet.
  const done = duels
    .filter((d) => d.status !== "PENDING")
    .sort((a, b) => recencyOf(b) - recencyOf(a))
  return done[0] ?? null
}

function shortAddr(a: string): string {
  if (a.length < 12) return a
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}
