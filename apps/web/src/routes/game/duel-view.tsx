import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Link, useParams } from "react-router"
import { useCurrentAccount } from "@mysten/dapp-kit-react"
import { CONFIG } from "@/lib/config"
import { useFlickySocket } from "@/hooks/use-flicky-socket"
import { fmtPnlPct, tickCardPnl, type SwipeLite } from "@/lib/pnl"
import { duelUnsettleable, missingSides } from "@/lib/duel-state"
import {
  buildRefundDuelTx,
  refundEligibility,
  REFUND_TIMEOUT_MS,
} from "@/lib/flicky"
import { useFlickySign } from "@/lib/use-flicky-sign"
import { playSfx } from "@/lib/sound"
import { PixelButton } from "@/components/pixel-button"
import { StreamingPnlChart } from "@/components/streaming-pnl-chart"
import { BtcSpotChart, type StrikeLine } from "@/components/btc-spot-chart"
import { DuelResultModal } from "@/components/duel-result-modal"
import { fmtUsd } from "@/components/swipe-screen"
import { summarizeDuelResult } from "@/lib/duel-result"
import type { CSSProperties } from "react"
import {
  DEMO_DUEL_ID,
  DEMO_OPP_ADDRESS,
  DEMO_ORDER_ID,
  DEMO_QUANTITY,
  DEMO_STRIKE,
  useDemoChart,
  useDemoOracleTicks,
} from "@/lib/demo-chart"

const BLUE_BRAND_STYLE = {
  "--btn-bg": "#4094fb",
  "--btn-highlight": "#7eb6ff",
} as CSSProperties

interface DuelLite {
  id: string
  status: "PENDING" | "ACTIVE" | "COMPLETE"
  stakeCoinType?: string
  creator: string
  challenger: string
  cardsRevealed: boolean
  cardCount: number
  settledCount: number
  winner?: "p0" | "p1" | "tie" | null
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
    p0Swipe: { isUp: boolean; quantity: string; orderId: string } | null
    p1Swipe: { isUp: boolean; quantity: string; orderId: string } | null
  }>
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
  cards: Array<{ expiry_market_id: string; strike: string; expiryMs?: number }>
}

interface Tick {
  spot: string
  expiryMs?: number
  /** Market has settled on-chain — final outcome is known even before
   *  the indexer records it into the duel's `cardOutcomes`. */
  settled?: boolean
  /** The settled market's final price — what `settle_card` scores
   *  against. Once present, PnL locks to it (live spot is ignored). */
  settlementPrice?: string
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

const POLL_INTERVAL_MS = 5_000

function buildDemoDuelDetail(address: string, startedAtMs: number): DuelLite {
  const swipe = (isUp: boolean) => ({
    isUp,
    quantity: DEMO_QUANTITY,
    orderId: DEMO_ORDER_ID,
  })
  return {
    id: DEMO_DUEL_ID,
    status: "ACTIVE",
    creator: address,
    challenger: DEMO_OPP_ADDRESS,
    cardsRevealed: true,
    cardCount: 5,
    settledCount: 2,
    startedAtMs,
    // Net p0 = +$20, p1 = -$20 (matches settled cardOutcomes below).
    p0Payout: "120000000",
    p0Premium: "100000000",
    p1Payout: "80000000",
    p1Premium: "100000000",
    cardOutcomes: [
      {
        cardIdx: 0,
        settlementPrice: "100500000000", // strike + $0.50
        strike: DEMO_STRIKE,
        upWon: true,
        p0Pnl: "50000000",
        p1Pnl: "-50000000",
        p0Swipe: swipe(true),
        p1Swipe: swipe(false),
      },
      {
        cardIdx: 1,
        settlementPrice: "99700000000", // strike - $0.30
        strike: DEMO_STRIKE,
        upWon: false,
        p0Pnl: "-30000000",
        p1Pnl: "30000000",
        p0Swipe: swipe(true),
        p1Swipe: swipe(false),
      },
    ],
    swipes: [
      { cardIdx: 0, p0Swipe: swipe(true), p1Swipe: swipe(false) },
      { cardIdx: 1, p0Swipe: swipe(true), p1Swipe: swipe(false) },
      { cardIdx: 2, p0Swipe: swipe(true), p1Swipe: swipe(false) },
      { cardIdx: 3, p0Swipe: swipe(false), p1Swipe: swipe(true) },
      { cardIdx: 4, p0Swipe: swipe(true), p1Swipe: swipe(true) },
    ],
    // Staggered expiries — one card every 30 s starting from
    // duel-start, so the demo's card 2 has ~30 s remaining and the
    // pending tail cards settle progressively.
    cards: Array.from({ length: 5 }, (_, i) => ({
      expiry_market_id: `demo-oracle-${i}`,
      strike: DEMO_STRIKE,
      expiryMs: startedAtMs + (i + 1) * 30_000,
    })),
  }
}

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
  const demo = useDemoChart()
  const { wsOpen, send, onMessage } = useFlickySocket(address, {
    enabled: !demo,
  })
  const [fetchedDuel, setFetchedDuel] = useState<DuelLite | null>(null)
  const [ticks, setTicks] = useState<Record<string, Tick>>({})
  const [err, setErr] = useState<string | null>(null)
  // Which chart occupies the chart slot — live PnL or the BTC spot price.
  const [chartView, setChartView] = useState<"pnl" | "btc">("pnl")
  // Stable startedAtMs across re-renders so the demo duel object is
  // referentially stable from useMemo's perspective.
  const [demoStartedAtMs] = useState(() => Date.now() - 60_000)

  // 1 Hz wall-clock tick — drives the per-card settle countdowns
  // on each unsettled card. Kept here so the entire CardList re-renders
  // once per second rather than each card timing itself independently.
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const interval = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [])

  // Real fetched duel (or null) when off; synthesized demo duel when on.
  const duel = useMemo<DuelLite | null>(() => {
    if (demo) {
      return buildDemoDuelDetail(address ?? DEMO_OPP_ADDRESS, demoStartedAtMs)
    }
    return fetchedDuel
  }, [demo, address, fetchedDuel, demoStartedAtMs])

  // ── card-settle sfx ──────────────────────────────────────────────
  // Per-card "pending | win | loss" from the participant's perspective —
  // the same rule CardTile renders (loss only when PnL < 0), so sound
  // and badge always agree. Spectators/signed-out viewers get silence.
  const settleStates = useMemo<Array<"pending" | "win" | "loss">>(() => {
    if (!duel) return []
    const p0 = Boolean(address && duel.creator === address)
    const p1 = Boolean(address && duel.challenger === address)
    if (!p0 && !p1) return []
    return duel.cards.map((card, i) => {
      const outcome = duel.cardOutcomes.find((o) => o.cardIdx === i)
      const tick = ticks[card.expiry_market_id]
      if (!outcome && tick?.settled !== true) return "pending"
      const raw = outcome ? (p0 ? outcome.p0Pnl : outcome.p1Pnl) : null
      let pnl: bigint | null = raw != null ? BigInt(raw) : null
      if (pnl === null) {
        const row = duel.swipes.find((s) => s.cardIdx === i)
        const swipe = (p0 ? row?.p0Swipe : row?.p1Swipe) ?? null
        pnl = swipe
          ? tickCardPnl(toSwipeLite(swipe), card.strike, tick, nowMs)
          : null
      }
      return pnl === null ? "pending" : pnl < 0n ? "loss" : "win"
    })
  }, [duel, ticks, address, nowMs])

  // Sound only on a pending→settled transition observed while watching —
  // never a burst of sounds for already-settled cards on first load.
  const prevSettleStates = useRef<Array<"pending" | "win" | "loss"> | null>(
    null
  )
  useEffect(() => {
    const prev = prevSettleStates.current
    prevSettleStates.current = settleStates
    if (!prev || prev.length !== settleStates.length) return
    settleStates.forEach((state, i) => {
      if (prev[i] === "pending" && state !== "pending") {
        playSfx(state === "win" ? "card-win" : "card-loss")
      }
    })
  }, [settleStates])

  // ── result modal ─────────────────────────────────────────────────
  const myIsP0 = Boolean(address && duel?.creator === address)
  const isParticipant =
    myIsP0 || Boolean(address && duel?.challenger === address)
  const summary = useMemo(
    () => (duel && isParticipant ? summarizeDuelResult(duel, myIsP0) : null),
    [duel, isParticipant, myIsP0]
  )
  const [resultOpen, setResultOpen] = useState(false)
  // Stable identity across the 1 Hz `nowMs` re-render — DuelResultModal's
  // fanfare/escape/scroll-lock effect depends on `onClose`, so an inline
  // arrow here would re-fire that effect (and replay the sfx) every
  // second while the modal is open.
  const closeResult = useCallback(() => setResultOpen(false), [])

  // ── stuck-duel refund (same sponsored sign path as history.tsx) ──
  const { mutateAsync: signRefund, isPending: refunding } = useFlickySign()
  const [refunded, setRefunded] = useState(false)
  // Auto-open exactly once per duel per browser: the seen-key guard
  // means a refresh or revisit never re-pops it (the "share result"
  // button below reopens on demand). Demo mode never completes.
  useEffect(() => {
    if (demo || !duel || duel.status !== "COMPLETE" || !isParticipant) return
    const key = `flicky.result-seen.${duel.id}`
    try {
      if (globalThis.localStorage?.getItem(key)) return
      globalThis.localStorage?.setItem(key, "1")
    } catch {
      /* storage unavailable — may re-pop next visit; harmless */
    }
    // Gated by the localStorage read above — this only fires once per
    // duel per browser, not on every render, so it's a legitimate
    // external-system sync rather than derivable render state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setResultOpen(true)
  }, [demo, duel, isParticipant])

  // Initial fetch + polling (mirror of MyMatchTile's pattern — keeps
  // the view honest if the WS room subscription misses an update).
  // Skipped in demo mode (mock seeded below).
  useEffect(() => {
    if (!duelId || demo) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      try {
        const res = await fetch(
          `${CONFIG.serverHttpUrl}/duels/${encodeURIComponent(duelId)}`
        )
        if (res.status === 404) throw new Error("not_indexed")
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const body = (await res.json()) as DuelLite
        if (!cancelled) {
          setFetchedDuel(body)
          setErr(null)
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) timer = setTimeout(tick, POLL_INTERVAL_MS)
      }
    }
    void tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [duelId, demo])

  // Subscribe to the WS room so deltas (room_state) land here too.
  // Skipped in demo mode. Keyed on `wsOpen` so a (re)connect — initial
  // open or a server-restart reconnect — re-sends the subscription
  // instead of silently dropping it on a not-yet-open socket.
  useEffect(() => {
    if (!duelId || demo || !wsOpen) return
    send({ type: "room_subscribe", duelId })
    return () => {
      send({ type: "room_unsubscribe", duelId })
    }
  }, [duelId, send, demo, wsOpen])

  // Demo synthetic oracle-tick stream.
  useDemoOracleTicks(demo, setTicks)

  // Market ticks for mark-to-market on pending cards.
  const marketIds = useMemo(
    () =>
      duel && duel.status === "ACTIVE"
        ? duel.cards.map((c) => c.expiry_market_id)
        : [],
    [duel]
  )
  const oracleKey = marketIds.join(",")
  useEffect(() => {
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
          settlementPrice: msg.settlementPrice ?? undefined,
        },
      }))
    })
    return () => {
      off()
      send({ type: "oracle_unsubscribe", marketIds })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oracleKey, onMessage, send, demo, wsOpen])

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

  const opponent = myIsP0 ? duel.challenger : duel.creator
  const isLive = duel.status === "ACTIVE"

  // ── dead-duel detection ──────────────────────────────────────────
  // A market that settled without both swipes in kills the deck for good
  // (the keeper's bothDone gate never opens; expired markets can't be
  // swiped) — stop pretending settlement is coming and surface the
  // refund path instead.
  const settledMarkets = new Set(
    duel.cards
      .filter((c) => ticks[c.expiry_market_id]?.settled === true)
      .map((c) => c.expiry_market_id)
  )
  const dead = !demo && duelUnsettleable(duel, settledMarkets)
  const sides = dead
    ? missingSides(duel, settledMarkets)
    : { p0: false, p1: false }
  const oppMissing = myIsP0 ? sides.p1 : sides.p0
  const youMissing = myIsP0 ? sides.p0 : sides.p1
  const deadMsg =
    oppMissing && !youMissing
      ? "your opponent didn't finish their swipes"
      : youMissing && !oppMissing
        ? "you didn't finish your swipes"
        : "not every swipe was made in time"
  const refundKind =
    dead && isParticipant && address && !refunded
      ? refundEligibility(duel, address, nowMs)
      : null
  // refund_duel opens 1h after start (contract gate) — count it down.
  const refundOpensInMs = Math.max(
    0,
    duel.startedAtMs + REFUND_TIMEOUT_MS - nowMs
  )
  const onRefund = async () => {
    if (refunding) return
    playSfx("click")
    try {
      await signRefund({
        transaction: buildRefundDuelTx(
          duel.id,
          duel.stakeCoinType || CONFIG.stakeType
        ),
      })
      setRefunded(true)
    } catch {
      // Leave the button up — next tap retries.
    }
  }
  // On-chain settlement lands before the indexer mirrors it, so the duel's
  // `settledCount` lags. Count oracles the tick stream reports as settled
  // and show whichever is further along — keeps "N/5 settled" honest.
  const onChainSettled = duel.cards.reduce(
    (n, c) => n + (ticks[c.expiry_market_id]?.settled ? 1 : 0),
    0
  )
  const settledCount = Math.max(duel.settledCount, onChainSettled)

  // Strike guide for the current card only — "#N" marker for the
  // lowest-index card still in flight, moving to #N+1 the instant it
  // settles (unlike practice mode's lockup chart, which shows all live
  // cards at once — a real duel's cards are watched one at a time, not
  // all settling together at the end of a shared lockup window). Reuses
  // CardTile's combined settled check (indexer outcome OR on-chain tick)
  // rather than practice's simpler `cardOutcomes`-only check, since a real
  // duel's on-chain settlement can land before the indexer mirrors it.
  const currentCardIdx = duel.cards.findIndex((c, i) => {
    const settled =
      duel.cardOutcomes.some((o) => o.cardIdx === i) ||
      ticks[c.expiry_market_id]?.settled === true
    return !settled
  })
  const strikeLines: StrikeLine[] =
    currentCardIdx === -1
      ? []
      : [
          {
            price: Number(BigInt(duel.cards[currentCardIdx].strike)) / 1e9,
            label: `#${currentCardIdx + 1}`,
            color: "#ffd24a",
          },
        ]

  return (
    <div className="relative isolate flex h-full flex-col gap-3 overflow-y-auto px-4 py-4 font-pixel text-white [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {/* Decorative header banner — sits behind the top ~40% of the
          duel view, fading into the page's navy background. Scrolls
          with the content (absolute inside the overflow container)
          so it acts as a hero that reveals on the way in. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[28%] bg-cover bg-top bg-no-repeat [image-rendering:pixelated]"
        style={{
          backgroundImage:
            "linear-gradient(180deg, rgba(27,37,72,0) 0%, rgba(27,37,72,0.6) 50%, #1b2548 85%), url(/assets/duel/duel-header.webp)",
        }}
      />
      <header className="flex items-center justify-between">
        <h1 className="text-4xl tracking-[0.2em] uppercase">
          {duel.status === "ACTIVE"
            ? "ongoing duel"
            : duel.status === "COMPLETE"
              ? "duel result"
              : "upcoming duel"}
        </h1>
        <StatusBadge status={duel.status} />
      </header>

      <div className="grid grid-cols-2 gap-2 text-base tracking-wider uppercase">
        <div className="flex flex-col gap-1 rounded bg-black/30 px-3 py-2 backdrop-blur-sm">
          <span className="text-sm text-white/55">opponent</span>
          <span className="text-lg">{shortAddr(opponent)}</span>
        </div>
        <div className="flex flex-col gap-1 rounded bg-black/30 px-3 py-2 backdrop-blur-sm">
          <span className="text-sm text-white/55">cards</span>
          <span className="text-lg text-white tabular-nums">
            {settledCount} / {duel.cardCount || 5} settled
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex justify-end">
          <div className="inline-flex overflow-hidden rounded bg-black/35 p-0.5 text-xs tracking-[0.18em] uppercase backdrop-blur-sm">
            <ChartToggleButton
              label="pnl"
              active={chartView === "pnl"}
              onClick={() => setChartView("pnl")}
            />
            <ChartToggleButton
              label="btc"
              active={chartView === "btc"}
              onClick={() => setChartView("btc")}
            />
          </div>
        </div>

        {/* Both charts stay mounted (visibility toggled) so each keeps
            accumulating oracle-tick history while the other is shown. */}
        <div className={chartView === "pnl" ? "" : "hidden"}>
          <StreamingPnlChart
            duel={duel}
            ticks={ticks}
            myIsP0={Boolean(myIsP0)}
            youAddress={address ?? ""}
            oppAddress={opponent}
            showRangeControls
          />
        </div>
        <div className={chartView === "btc" ? "" : "hidden"}>
          <BtcSpotChart
            ticks={ticks}
            cards={duel.cards}
            strikeLines={strikeLines}
          />
        </div>
      </div>

      <CardList
        duel={duel}
        myIsP0={Boolean(myIsP0)}
        ticks={ticks}
        nowMs={nowMs}
        dead={dead}
      />

      {dead && isLive && isParticipant && (
        <div className="flex flex-col gap-2 rounded bg-amber-900/30 px-3 py-2.5 text-sm text-amber-200/85">
          {refunded ? (
            <p className="tracking-[0.12em] text-emerald-300 uppercase">
              refunded ✓ — stakes returned
            </p>
          ) : (
            <>
              <p>
                {deadMsg} — this duel can no longer settle. stakes go back to
                both players.
              </p>
              {refundKind ? (
                <PixelButton
                  onClick={onRefund}
                  disabled={refunding}
                  className="h-10 w-full text-base"
                >
                  {refunding ? "refunding…" : "claim refund"}
                </PixelButton>
              ) : (
                <p className="tracking-[0.12em] text-white/60 uppercase tabular-nums">
                  refund opens in {formatRemaining(refundOpensInMs)}
                </p>
              )}
            </>
          )}
        </div>
      )}

      {!isParticipant && (
        <div className="rounded bg-amber-900/30 px-3 py-2 text-sm text-amber-200/85">
          you're not a participant in this duel — view is read-only.
        </div>
      )}

      <footer className="mt-auto flex flex-col gap-2 pt-2">
        {duel.status === "COMPLETE" && summary && (
          <PixelButton
            onClick={() => setResultOpen(true)}
            className="h-12 w-full text-lg"
          >
            share result
          </PixelButton>
        )}
        <Link to="/game/home" className="block">
          <PixelButton style={BLUE_BRAND_STYLE} className="h-12 w-full text-lg">
            back to home
          </PixelButton>
        </Link>
      </footer>

      {/* small queue-leave footer note */}
      <p className="text-center text-xs tracking-[0.18em] text-white/40 uppercase">
        {isLive
          ? dead
            ? "this duel can't settle — stakes are refundable"
            : "settlement runs automatically — keeper handles the rest"
          : "this match is final"}
      </p>

      {summary && (
        <DuelResultModal
          open={resultOpen}
          onClose={closeResult}
          duelId={duel.id}
          summary={summary}
          myAddress={address}
          oppAddress={opponent}
        />
      )}
    </div>
  )
}

function StatusBadge({ status }: { status: DuelLite["status"] }) {
  if (status === "ACTIVE") {
    return (
      <span className="flex items-center gap-2 rounded bg-black/30 px-3 py-1 text-sm tracking-[0.18em] text-emerald-300 uppercase backdrop-blur-sm">
        <span className="inline-block size-2 animate-pulse bg-emerald-400" />
        live
      </span>
    )
  }
  if (status === "COMPLETE") {
    return (
      <span className="rounded bg-black/30 px-3 py-1 text-sm tracking-[0.18em] text-white/70 uppercase backdrop-blur-sm">
        final
      </span>
    )
  }
  return (
    <span className="rounded bg-black/30 px-3 py-1 text-sm tracking-[0.18em] text-white/55 uppercase backdrop-blur-sm">
      pending
    </span>
  )
}

function ChartToggleButton({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`cursor-pointer rounded px-2.5 py-1 transition-colors ${
        active ? "bg-[#4094fb] text-white" : "text-white/55 hover:text-white/85"
      }`}
    >
      {label}
    </button>
  )
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center font-pixel text-white">
      <p className="text-base tracking-[0.18em] uppercase">{title}</p>
      <p className="text-sm text-white/60">{body}</p>
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

type CardState = "live" | "win" | "loss"

function CardList({
  duel,
  myIsP0,
  ticks,
  nowMs,
  dead,
}: {
  duel: DuelLite
  myIsP0: boolean
  ticks: Record<string, Tick>
  nowMs: number
  dead: boolean
}) {
  const slots = Math.max(duel.cardCount, duel.cards.length)
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs tracking-[0.2em] text-white/55 uppercase">
        cards
      </h3>
      <div className="grid grid-cols-5 gap-1.5">
        {Array.from({ length: slots }).map((_, i) => (
          <CardTile
            key={i}
            index={i}
            duel={duel}
            myIsP0={myIsP0}
            ticks={ticks}
            nowMs={nowMs}
            dead={dead}
          />
        ))}
      </div>
    </div>
  )
}

/**
 * Format a duration as a compact clock countdown — always m:ss, so a
 * sub-minute value reads "0:30" rather than "30s". Keeps every card's
 * countdown in one consistent format instead of switching units at 60s.
 */
function formatRemaining(ms: number): string {
  const totalSec = Math.ceil(ms / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return `${min}:${sec.toString().padStart(2, "0")}`
}

/**
 * One card in the deck grid — same visual language as practice mode's
 * lockup strip (swipe-screen's cousin in routes/game/practice.tsx): a flat
 * bordered tile that fades emerald/rose once its outcome is known, mine +
 * opponent's picks as colored ↑/↓ glyphs (mine bright, theirs dimmed), no
 * arrow/badge art.
 */
function CardTile({
  index,
  duel,
  myIsP0,
  ticks,
  nowMs,
  dead,
}: {
  index: number
  duel: DuelLite
  myIsP0: boolean
  ticks: Record<string, Tick>
  nowMs: number
  dead: boolean
}) {
  const card = duel.cards[index]
  const outcome = duel.cardOutcomes.find((o) => o.cardIdx === index)
  const swipeRow = duel.swipes.find((s) => s.cardIdx === index)
  const mySwipe = swipeRow
    ? myIsP0
      ? swipeRow.p0Swipe
      : swipeRow.p1Swipe
    : null
  const oppSwipe = swipeRow
    ? myIsP0
      ? swipeRow.p1Swipe
      : swipeRow.p0Swipe
    : null
  const tick = card ? ticks[card.expiry_market_id] : undefined
  const myPnl: bigint | null =
    outcome && (myIsP0 ? outcome.p0Pnl : outcome.p1Pnl) !== null
      ? BigInt(myIsP0 ? outcome.p0Pnl! : outcome.p1Pnl!)
      : card && mySwipe
        ? tickCardPnl(toSwipeLite(mySwipe), card.strike, tick, nowMs)
        : null

  // A card is final (for COLOR purposes) once the indexer records its
  // outcome OR the oracle tick reports `settled` (which lands first — the
  // on-chain settlement precedes the indexer mirror). Once the tick
  // carries a `settlementPrice`, `tickCardPnl` locks the outcome to it —
  // the same price `settle_card` scores against — so the direction
  // (win/loss) is right even before the indexer catches up, and the live
  // spot re-crossing the strike after expiry can't flip it back. Its
  // MAGNITUDE, though, is a symmetric ±quantity projection with no
  // premium netted in, so it always reads exactly ±100% — only
  // `outcome.p{0,1}Pnl` (the real, premium-netted figure) is trustworthy
  // as a final number. See the `hasOutcome` branch below.
  const settledNow = Boolean(outcome) || tick?.settled === true
  const hasOutcome = Boolean(outcome)
  const state: CardState =
    settledNow && myPnl !== null ? (myPnl < 0n ? "loss" : "win") : "live"
  // Real duels never carry a per-card `expiryMs` from the server — only
  // the oracle tick stream reports it, once `oracle_subscribe` delivers a
  // tick for this card's market (see the `tick?.expiryMs` read above for
  // `markCardPnl`). `card.expiryMs` only exists in the demo fixture.
  const expiryMs = tick?.expiryMs ?? card?.expiryMs
  const remainingMs =
    !settledNow && expiryMs !== undefined ? Math.max(0, expiryMs - nowMs) : null
  // Pre-settle: live sentiment % (once we have a swipe + a live tick to
  // mark it against) alongside the countdown, not one replacing the
  // other — rendered as two stacked lines, not squeezed onto one.
  const livePnlText = myPnl !== null ? signedPercent(myPnl, mySwipe) : null
  const timeText = remainingMs !== null ? formatRemaining(remainingMs) : null

  return (
    <div
      className={`border-2 border-black/55 px-1 py-1.5 text-center font-pixel transition-colors ${
        state === "win"
          ? "bg-emerald-900/60"
          : state === "loss"
            ? "bg-rose-900/60"
            : "bg-[#0e1530]"
      }`}
    >
      <p className="flex items-center justify-center gap-1 text-[11px] text-white/60 uppercase tabular-nums">
        {state === "live" && (
          <span
            aria-label="live"
            className="inline-block size-1.5 animate-pulse bg-cyan-300 shadow-[0_0_5px_rgba(125,230,255,0.9)]"
          />
        )}
        {card ? fmtUsd(card.strike) : "—"}
      </p>
      {/* your pick (bright) · opponent's pick (dimmed) — green up, red down */}
      <p className="text-xl leading-tight">
        <span
          className={
            mySwipe
              ? mySwipe.isUp
                ? "text-emerald-300"
                : "text-rose-300"
              : "text-white/40"
          }
        >
          {mySwipe ? (mySwipe.isUp ? "↑" : "↓") : "—"}
        </span>
        <span className="px-1 text-sm text-white/30">·</span>
        <span
          className={
            oppSwipe
              ? oppSwipe.isUp
                ? "text-emerald-300/50"
                : "text-rose-300/50"
              : "text-white/40"
          }
        >
          {oppSwipe ? (oppSwipe.isUp ? "↑" : "↓") : "…"}
        </span>
      </p>
      <div
        className={`text-sm leading-tight uppercase tabular-nums ${
          state === "win"
            ? "text-emerald-300"
            : state === "loss"
              ? "text-rose-300"
              : "text-cyan-300"
        }`}
      >
        {hasOutcome ? (
          myPnl === null ? (
            "skipped"
          ) : (
            signedPercent(myPnl, mySwipe)
          )
        ) : settledNow ? (
          // Market settled; outcome locked to its settlement price
          // (`tickCardPnl`). On a dead duel the keeper is never coming —
          // "void", not an eternal "settling…".
          <>
            {livePnlText && <p>{livePnlText}</p>}
            <p>{dead ? "void" : "settling…"}</p>
          </>
        ) : livePnlText || timeText ? (
          <>
            {livePnlText && <p>{livePnlText}</p>}
            {timeText && <p>{timeText}</p>}
          </>
        ) : (
          "—"
        )}
      </div>
    </div>
  )
}

/**
 * Per-card PnL as a signed % of the swipe's quantity (the player's stake
 * on that single card). Falls back to "—" if no swipe was made. 6-24
 * swipes carry `orderId` instead of `premium` (the real premium needs a
 * server-side lookup not yet wired into `room_state`/`swipes`; see
 * protocol.ts), so this is relative to `quantity` rather than a true cost
 * basis — see `fmtPnlPct` / `liveCardPnl` in pnl.ts.
 */
function signedPercent(
  micro: bigint,
  swipe: { isUp: boolean; quantity: string; orderId: string } | null
): string {
  if (!swipe) return "—"
  return fmtPnlPct(micro, BigInt(swipe.quantity))
}
