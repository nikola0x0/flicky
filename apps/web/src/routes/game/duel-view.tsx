import { useEffect, useMemo, useRef, useState } from "react"
import { Link, useParams } from "react-router"
import { useCurrentAccount } from "@mysten/dapp-kit"
import { CONFIG } from "@/lib/config"
import { useFlickySocket } from "@/hooks/use-flicky-socket"
import { markCardPnl } from "@/lib/pnl"
import { PixelButton } from "@/components/pixel-button"
import { StreamingPnlChart } from "@/components/streaming-pnl-chart"
import { BtcSpotChart } from "@/components/btc-spot-chart"
import type { CSSProperties } from "react"
import {
  DEMO_DUEL_ID,
  DEMO_OPP_ADDRESS,
  DEMO_PREMIUM,
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
  cards: Array<{ oracle_id: string; strike: string; expiryMs?: number }>
}

interface Tick {
  spot: string
  forward: string
  expiryMs?: number
  /** Oracle has settled on-chain — final outcome is known even before
   *  the indexer records it into the duel's `cardOutcomes`. */
  settled?: boolean
}

const POLL_INTERVAL_MS = 5_000

function buildDemoDuelDetail(address: string, startedAtMs: number): DuelLite {
  const swipe = (isUp: boolean) => ({
    isUp,
    quantity: DEMO_QUANTITY,
    premium: DEMO_PREMIUM,
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
      oracle_id: `demo-oracle-${i}`,
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

  // 1 Hz wall-clock tick — drives the "settles in Xs" countdowns
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

  // Oracle ticks for mark-to-market on pending cards.
  const oracleIds = useMemo(
    () =>
      duel && duel.status === "ACTIVE"
        ? duel.cards.map((c) => c.oracle_id)
        : [],
    [duel]
  )
  const oracleKey = oracleIds.join(",")
  useEffect(() => {
    if (oracleIds.length === 0 || demo || !wsOpen) return
    send({ type: "oracle_subscribe", oracleIds })
    const off = onMessage((msg) => {
      if (msg.type !== "oracle_tick") return
      if (!oracleIds.includes(msg.oracleId)) return
      setTicks((prev) => ({
        ...prev,
        [msg.oracleId]: {
          spot: msg.spot,
          forward: msg.forward,
          expiryMs: Number(msg.expiry),
          settled: msg.settled,
        },
      }))
    })
    return () => {
      off()
      send({ type: "oracle_unsubscribe", oracleIds })
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

  const myIsP0 = address && duel.creator === address
  const myIsP1 = address && duel.challenger === address
  const isParticipant = myIsP0 || myIsP1
  const opponent = myIsP0 ? duel.challenger : duel.creator
  const isLive = duel.status === "ACTIVE"
  // On-chain settlement lands before the indexer mirrors it, so the duel's
  // `settledCount` lags. Count oracles the tick stream reports as settled
  // and show whichever is further along — keeps "N/5 settled" honest.
  const onChainSettled = duel.cards.reduce(
    (n, c) => n + (ticks[c.oracle_id]?.settled ? 1 : 0),
    0
  )
  const settledCount = Math.max(duel.settledCount, onChainSettled)

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
            "linear-gradient(180deg, rgba(27,37,72,0) 0%, rgba(27,37,72,0.6) 50%, #1b2548 85%), url(/assets/duel/duel-header.png)",
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
          />
        </div>
        <div className={chartView === "btc" ? "" : "hidden"}>
          <BtcSpotChart ticks={ticks} cards={duel.cards} />
        </div>
      </div>

      <CardList duel={duel} myIsP0={Boolean(myIsP0)} ticks={ticks} nowMs={nowMs} />

      {!isParticipant && (
        <div className="rounded bg-amber-900/30 px-3 py-2 text-sm text-amber-200/85">
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
      <p className="text-center text-xs tracking-[0.18em] text-white/40 uppercase">
        {isLive
          ? "settlement runs automatically — keeper handles the rest"
          : "this match is final"}
      </p>
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
        active
          ? "bg-[#4094fb] text-white"
          : "text-white/55 hover:text-white/85"
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

// Chunky pixel-art border per state: a 2px state-tinted inner ring plus a
// beveled inset shadow — a soft color highlight along the top and a black
// shadow along the bottom — so the card reads like a raised game tile. The
// black outer outline comes from `.pixel-tile`; this colors the inside.
const CARD_STATE_STYLES: Record<CardState, string> = {
  live: "bg-cyan-950/40 text-cyan-100 ring-2 ring-cyan-400/70 shadow-[inset_0_3px_0_rgba(125,230,255,0.25),inset_0_-3px_0_rgba(0,0,0,0.5)]",
  win: "bg-emerald-950/40 text-emerald-100 ring-2 ring-emerald-400/70 shadow-[inset_0_3px_0_rgba(110,231,183,0.25),inset_0_-3px_0_rgba(0,0,0,0.5)]",
  loss: "bg-rose-950/40 text-rose-200 ring-2 ring-rose-400/70 shadow-[inset_0_3px_0_rgba(253,164,175,0.25),inset_0_-3px_0_rgba(0,0,0,0.5)]",
}

const CARD_BADGE_SRC: Record<CardState, string> = {
  live: "/assets/cards/badge-live.png",
  win: "/assets/cards/badge-win.png",
  loss: "/assets/cards/badge-loss.png",
}

function CardList({
  duel,
  myIsP0,
  ticks,
  nowMs,
}: {
  duel: DuelLite
  myIsP0: boolean
  ticks: Record<string, Tick>
  nowMs: number
}) {
  const slots = Math.max(duel.cardCount, duel.cards.length, 5)
  const scrollRef = useRef<HTMLDivElement>(null)
  const scrollByDir = (dir: -1 | 1) => {
    const el = scrollRef.current
    if (!el) return
    // ~2 card-widths per click (card 120px + gap 8px).
    el.scrollBy({ left: dir * 256, behavior: "smooth" })
  }
  return (
    <div className="group/cards relative flex flex-col gap-2">
      <h3 className="text-xs tracking-[0.2em] text-white/55 uppercase">
        cards
      </h3>
      {/* Horizontal scroll strip — strikes can be 5-6 digits, so we
          give each card a fixed minimum width and let the container
          scroll sideways on narrow viewports. The `-mx-4` + `px-4`
          combo lets the strip bleed past the page's horizontal padding
          so cards scroll cleanly off the edge. */}
      <div
        ref={scrollRef}
        className="-mx-4 touch-pan-x snap-x scroll-px-4 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        style={{ WebkitOverflowScrolling: "touch" }}
      >
        <div className="flex w-max gap-2">
          {Array.from({ length: slots }).map((_, i) => {
            const card = duel.cards[i]
            const isSettled = i < duel.settledCount
            const remainingMs =
              !isSettled && card?.expiryMs !== undefined
                ? Math.max(0, card.expiryMs - nowMs)
                : null
            return (
              <div
                key={i}
                className="flex w-[120px] flex-none snap-start flex-col gap-1"
              >
                <CardTile
                  index={i}
                  duel={duel}
                  myIsP0={myIsP0}
                  ticks={ticks}
                  nowMs={nowMs}
                />
                <div className="text-center font-pixel">
                  <div className="text-xs tracking-[0.15em] text-white/55 uppercase tabular-nums">
                    {(i + 1).toString().padStart(2, "0")}
                  </div>
                  {remainingMs !== null && remainingMs > 0 && (
                    <div className="text-xs tracking-[0.18em] text-cyan-300/85 tabular-nums">
                      {formatRemaining(remainingMs)}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Desktop scroll buttons. Hidden by default; fade in on hover of
          the card-list area. The `hover:` Tailwind variant only fires
          on devices with a hovering pointer (desktop), so touch
          devices never see them — they have native swipe. */}
      <button
        type="button"
        aria-label="scroll left"
        onClick={() => scrollByDir(-1)}
        className="pixel-tile absolute top-1/2 left-0 hidden -translate-y-1/2 cursor-pointer items-center justify-center bg-black/55 px-2 py-3 text-white opacity-0 transition-opacity hover:bg-black/70 group-hover/cards:opacity-100 [@media(hover:hover)]:flex"
      >
        ◀
      </button>
      <button
        type="button"
        aria-label="scroll right"
        onClick={() => scrollByDir(1)}
        className="pixel-tile absolute top-1/2 right-0 hidden -translate-y-1/2 cursor-pointer items-center justify-center bg-black/55 px-2 py-3 text-white opacity-0 transition-opacity hover:bg-black/70 group-hover/cards:opacity-100 [@media(hover:hover)]:flex"
      >
        ▶
      </button>
    </div>
  )
}

/**
 * Format a duration as a compact "settles in X" string.
 * < 60s  → "30s"
 * ≥ 60s  → "1:30"
 */
function formatRemaining(ms: number): string {
  const totalSec = Math.ceil(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return `${min}:${sec.toString().padStart(2, "0")}`
}

/**
 * One card in the 5-across deck strip. Fixed-width via the parent's
 * `grid-cols-5`, so the layout doesn't jitter as live PnL values
 * wobble. Pixel-tile clip-path matches the rest of the UI.
 *
 * Imagen drop-in spots are marked `TODO(imagen)` — generate the PNGs
 * into `apps/web/public/assets/cards/` and swap the placeholder text
 * for `<img>` to elevate.
 */
function CardTile({
  index,
  duel,
  myIsP0,
  ticks,
  nowMs,
}: {
  index: number
  duel: DuelLite
  myIsP0: boolean
  ticks: Record<string, Tick>
  nowMs: number
}) {
  const card = duel.cards[index]
  const outcome = duel.cardOutcomes.find((o) => o.cardIdx === index)
  const swipeRow = duel.swipes.find((s) => s.cardIdx === index)
  const mySwipe = swipeRow
    ? myIsP0
      ? swipeRow.p0Swipe
      : swipeRow.p1Swipe
    : null
  const tick = card ? ticks[card.oracle_id] : undefined
  const myPnl: bigint | null =
    outcome && (myIsP0 ? outcome.p0Pnl : outcome.p1Pnl) !== null
      ? BigInt(myIsP0 ? outcome.p0Pnl! : outcome.p1Pnl!)
      : card && mySwipe
        ? markCardPnl(
            mySwipe,
            card.strike,
            tick?.forward,
            tick?.expiryMs,
            nowMs,
          )
        : null

  // A card is final once the indexer records its outcome OR the oracle
  // tick reports `settled` (which lands first — the on-chain settlement
  // precedes the indexer mirror). In the settled case `markCardPnl`
  // already returns the binary outcome (expiry has passed), so the
  // win/loss split below is the real result, not a live mark.
  const settledNow = Boolean(outcome) || tick?.settled === true
  const state: CardState =
    settledNow && myPnl !== null ? (myPnl < 0n ? "loss" : "win") : "live"

  const badgeSrc = CARD_BADGE_SRC[state]

  return (
    <div
      className={`pixel-tile relative flex aspect-[3/4] flex-col items-center justify-between p-1.5 text-center font-pixel ring-inset ${CARD_STATE_STYLES[state]}`}
    >
      <div className="flex w-full items-center justify-between tracking-[0.15em] uppercase opacity-90">
        <img
          src="/assets/cards/asset-btc-16.png"
          alt="BTC"
          className="block h-7 w-7 [image-rendering:pixelated]"
        />
        {card && (
          <span className="flex items-center gap-1 text-xs leading-none tabular-nums">
            {state === "live" && (
              <span
                aria-label="live"
                className="inline-block size-1.5 animate-pulse bg-cyan-300 shadow-[0_0_5px_rgba(125,230,255,0.9)]"
              />
            )}
            ${fmtStrike(card.strike)}
          </span>
        )}
      </div>

      {/* Arrow = your prediction. The badge tells you whether it won;
          the strike above gives context for what you were betting on. */}
      <img
        src={
          mySwipe?.isUp
            ? "/assets/cards/up-arrow-pixel.png"
            : "/assets/cards/down-arrow-pixel.png"
        }
        alt={mySwipe?.isUp ? "predicted up" : "predicted down"}
        className="block h-12 w-12 [image-rendering:pixelated]"
      />

      <div className="flex w-full flex-col items-center gap-1">
        {badgeSrc && (
          <img
            src={badgeSrc}
            alt={state}
            className={`block h-10 w-auto [image-rendering:pixelated] ${
              state === "live" ? "animate-pulse" : ""
            }`}
          />
        )}
        <span
          className={`text-base leading-none tabular-nums ${pnlTextColor(myPnl)}`}
        >
          {myPnl === null ? "—" : signedPercent(myPnl, mySwipe)}
        </span>
      </div>
    </div>
  )
}

/**
 * Per-card PnL as a signed % of the swipe's premium (the player's
 * stake on that single card). Falls back to "—" if no swipe was made.
 */
function signedPercent(
  micro: bigint,
  swipe: { premium: string } | null
): string {
  if (!swipe) return "—"
  const premium = BigInt(swipe.premium)
  if (premium === 0n) return "—"
  const pct = Math.round((Number(micro) / Number(premium)) * 100)
  const sign = pct < 0 ? "-" : pct > 0 ? "+" : ""
  return `${sign}${Math.abs(pct)}%`
}

/**
 * Tailwind text color for a per-card PnL: green when up, red when down,
 * muted when flat/unknown. Reflects the PnL sign, not the swipe
 * direction — a correct "down" call is still green.
 */
function pnlTextColor(micro: bigint | null): string {
  if (micro === null || micro === 0n) return "text-white/70"
  return micro > 0n ? "text-emerald-300" : "text-rose-300"
}

/**
 * Format a Move-side strike (on the 1e9 scale) as a whole-dollar label.
 * Full digits — no abbreviation, since the strip scrolls horizontally
 * if 5+ cards × full strike values overflow the container.
 */
function fmtStrike(raw: string): string {
  return Math.round(Number(BigInt(raw)) / 1_000_000_000).toString()
}
