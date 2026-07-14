/**
 * The shared swipe surface — the drag-to-swipe TCG card, chart chips/modals,
 * and the per-card ledger. Extracted from active-duel.tsx so PvP and
 * Practice share one engine (CLAUDE.md: gate the money flow, keep the
 * engine). This component is purely presentational + drag mechanics:
 * committing a swipe is delegated to `onSwipe` (PvP: build/sign the staked
 * swipe PTB; Practice: record locally). It never touches the chain.
 */
import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react"
import { createPortal } from "react-dom"
import { SWIPE_QUANTITY } from "@/lib/funding"
import { fmtDusdc } from "@/lib/deepbook"
import { liveCardPnl, fmtPnlPct, upProbability } from "@/lib/pnl"
import { toSwipeLite, type RoomState } from "@/lib/room-state"
import { playSfx } from "@/lib/sound"
import { StreamingPnlChart } from "@/components/streaming-pnl-chart"
import { BtcSpotChart } from "@/components/btc-spot-chart"

/** Format a 1e9-scaled on-chain BTC price as a rounded USD string,
 *  e.g. "67235752957751" → "$67,236". Accepts the raw string or bigint. */
// eslint-disable-next-line react-refresh/only-export-components
export function fmtUsd(v: string | bigint): string {
  return `$${(Number(v) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
}

/** Time until a card settles, auto-scaled: ≥1h → "2h 47m", <1h → "47:12",
 *  ≤0 → "now". Drives the live "settles in …" countdown on the swipe card so
 *  the player knows the horizon they're predicting. */
// eslint-disable-next-line react-refresh/only-export-components
export function fmtCountdown(ms: number): string {
  if (ms <= 0) return "now"
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}h ${m.toString().padStart(2, "0")}m`
  return `${m}:${s.toString().padStart(2, "0")}`
}

// Drag-to-swipe tuning — mirrors the lobby DuelView feel.
const DRAG_COMMIT_FRACTION = 0.3
const DRAG_MAX_ROTATE_DEG = 18

// Card mascot art (generated PNGs in `public/cards/`). Each card slot draws
// its own idle character so the deck feels varied; swiping resolves to the
// bull (YES / up) or the bear (NO / down) for the up/down story.
const IDLE_ART = [
  "/assets/cards/coin.png",
  "/assets/cards/gremlin.png",
  "/assets/cards/wizard.png",
  "/assets/cards/chad.png",
]
const ART_YES = "/assets/cards/bull.png"
const ART_NO = "/assets/cards/bear.png"

export function SwipeScreen({
  roomState,
  cardIdx,
  ticks,
  myAddress,
  opponentAddress,
  disabled = false,
  busyLabel = "minting position…",
  settleLabel,
  onSwipe,
  deckExhausted = null,
}: {
  roomState: RoomState
  cardIdx: number
  ticks: Record<string, { spot: string; expiry: string }>
  myAddress: string
  opponentAddress?: string
  disabled?: boolean
  busyLabel?: string
  settleLabel?: string
  onSwipe: (isUp: boolean) => Promise<void>
  deckExhausted?: ReactNode
}) {
  const card = roomState.cards[cardIdx]
  const tick = card ? ticks[card.expiry_market_id] : undefined
  const expiry = tick ? BigInt(tick.expiry) : undefined
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [chartModal, setChartModal] = useState<null | "btc" | "pnl">(null)

  // 1 Hz wall-clock so the "settles in …" countdown ticks.
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  // ── drag-to-swipe state ──────────────────────────────────────────
  const cardRef = useRef<HTMLDivElement>(null)
  const dragStartX = useRef(0)
  const cardWidth = useRef(0)
  const [drag, setDrag] = useState<{
    x: number
    active: boolean
    flying: null | "up" | "down"
  }>({ x: 0, active: false, flying: null })
  // Reset whenever we advance to a new card.
  useEffect(() => {
    setDrag({ x: 0, active: false, flying: null })
  }, [cardIdx])

  const myIsP0 = myAddress.toLowerCase() === roomState.creator.toLowerCase()
  const opponent =
    opponentAddress ?? (myIsP0 ? roomState.challenger : roomState.creator)
  const chartDuel = {
    id: roomState.duelId,
    settledCount: roomState.settledCount,
    cards: roomState.cards,
    swipes: roomState.swipes,
    cardOutcomes: roomState.cardOutcomes,
  }

  // All of my cards are swiped (cardIdx past the deck) — hand off to the
  // result/home rather than showing a dead-end settlement screen.
  if (cardIdx >= roomState.cards.length) {
    return <>{deckExhausted}</>
  }

  if (!card || (!settleLabel && !expiry)) {
    return (
      <p className="text-base text-white/55">Loading card {cardIdx + 1}…</p>
    )
  }

  const doSwipe = async (isUp: boolean) => {
    if (disabled) return
    playSfx(isUp ? "swipe-up" : "swipe-down")
    setBusy(true)
    setError(null)
    try {
      await onSwipe(isUp)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setDrag({ x: 0, active: false, flying: null })
    } finally {
      setBusy(false)
    }
  }

  // Swipe RIGHT = YES (BTC settles above the strike) → mint UP.
  // Swipe LEFT  = NO  (it won't)                     → mint DOWN.
  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (busy || drag.flying || disabled) return
    cardWidth.current = cardRef.current?.offsetWidth ?? 320
    dragStartX.current = e.clientX
    setDrag({ x: 0, active: true, flying: null })
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!drag.active) return
    setDrag((d) => ({ ...d, x: e.clientX - dragStartX.current }))
  }
  function onPointerUp() {
    if (!drag.active) return
    const ww = cardWidth.current || 320
    const threshold = ww * DRAG_COMMIT_FRACTION
    if (drag.x > threshold) {
      setDrag({ x: drag.x, active: false, flying: "up" })
      void doSwipe(true)
    } else if (drag.x < -threshold) {
      setDrag({ x: drag.x, active: false, flying: "down" })
      void doSwipe(false)
    } else {
      setDrag({ x: 0, active: false, flying: null })
    }
  }

  const flyOff =
    drag.flying === "up"
      ? `translateX(160%) rotate(${DRAG_MAX_ROTATE_DEG + 6}deg)`
      : drag.flying === "down"
        ? `translateX(-160%) rotate(${-(DRAG_MAX_ROTATE_DEG + 6)}deg)`
        : null
  const cw = cardWidth.current || 320
  const rotate = (drag.x / (cw / 2)) * DRAG_MAX_ROTATE_DEG
  const transform =
    flyOff ??
    (drag.x === 0 ? "" : `translateX(${drag.x}px) rotate(${rotate}deg)`)
  const progress = Math.min(1, Math.abs(drag.x) / (cw * DRAG_COMMIT_FRACTION))
  const yesGlow = drag.x > 0 ? progress : 0
  const noGlow = drag.x < 0 ? progress : 0

  // 6-24 exposes no public on-chain quote (`load_live_pricer` runs inside
  // the swipe PTB itself), so there's no real premium/odds to show
  // pre-swipe. Both directions mint the same fixed `SWIPE_QUANTITY` of
  // contracts — that's a stake size, not a quote, so it's honest to show.
  const stakeLabel = fmtDusdc(SWIPE_QUANTITY)
  const hasNext = cardIdx + 1 < roomState.cards.length

  // Live settle countdown — the horizon the player is predicting over.
  // Colour ramps cyan → amber → rose as settlement nears.
  const remainingMs = expiry !== undefined ? Number(expiry) - nowMs : null
  const countdown = remainingMs !== null ? fmtCountdown(remainingMs) : null
  // Estimated per-side win odds under the same digital-BS model as the live
  // PnL mark (upProbability) — surfaces which side is the favored call vs the
  // long-shot (whose premium may be too low to place on a short market), and
  // drifts toward 0/100% as the card nears settlement.
  const upProb =
    tick && card && expiry !== undefined
      ? upProbability(card.strike, tick.spot, Number(expiry), nowMs)
      : null
  const yesPct = upProb === null ? null : Math.round(upProb * 100)
  const noPct = yesPct === null ? null : 100 - yesPct
  const countdownColor =
    remainingMs === null
      ? "text-white/50"
      : remainingMs <= 120_000
        ? "text-rose-300"
        : remainingMs <= 600_000
          ? "text-amber-300"
          : "text-cyan-300"

  // Mascot art reacts to the swipe direction. These are placeholder pixel
  // icons — drop your generated mascot PNGs in `public/cards/` and point
  // CARD_ART at them (e.g. idle: "/cards/coin.png", yes: "/cards/bull.png").
  const swipeDir = drag.x > 24 ? "yes" : drag.x < -24 ? "no" : "idle"
  const idleArt = IDLE_ART[cardIdx % IDLE_ART.length]
  const artSrc =
    swipeDir === "yes" ? ART_YES : swipeDir === "no" ? ART_NO : idleArt
  const artGlow =
    swipeDir === "yes" ? "#4aff9a" : swipeDir === "no" ? "#ff5d6c" : "#ffd24a"

  return (
    <div className="flex flex-1 flex-col">
      {/* top bar — card count + chart toggles (charts live in modals so the
          card owns the screen) */}
      <div className="flex items-center justify-between pb-2">
        <span className="font-pixel text-base tracking-[0.2em] text-white/55 uppercase">
          card {cardIdx + 1} / {roomState.cards.length}
        </span>
        <div className="flex gap-2">
          <ChartChip
            label="btc"
            icon="/icons/coins.png"
            onClick={() => setChartModal("btc")}
          />
          <ChartChip
            label="pnl"
            icon="/icons/arrow_up_down.png"
            onClick={() => setChartModal("pnl")}
          />
        </div>
      </div>

      {/* big, centered swipe card — fills the screen; next card peeks behind */}
      <div
        className="relative flex-1 select-none"
        style={{ touchAction: "none" }}
      >
        {hasNext && (
          <div
            aria-hidden
            className="pixel-tile no-hover absolute inset-x-4 top-6 bottom-3 bg-[#141d3a] bg-cover bg-center [image-rendering:pixelated]"
            style={{ backgroundImage: "url(/assets/cards/card-back.png)" }}
          />
        )}
        <div
          ref={cardRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          className={`pixel-tile absolute inset-x-1 top-2 bottom-4 flex cursor-grab flex-col gap-2.5 bg-[#2c3c74] p-3 shadow-[inset_0_3px_0_rgba(255,255,255,0.1),inset_0_-4px_0_rgba(0,0,0,0.4)] ${
            drag.active ? "" : "transition-transform duration-300 ease-out"
          } ${drag.flying ? "pointer-events-none" : "active:cursor-grabbing"}`}
          style={{ transform, willChange: "transform" }}
        >
          {/* YES / NO swipe tint + stamps (above the card content) */}
          <div
            className="pointer-events-none absolute inset-0 z-20 bg-emerald-500/25"
            style={{ opacity: yesGlow }}
          />
          <div
            className="pointer-events-none absolute inset-0 z-20 bg-rose-500/25"
            style={{ opacity: noGlow }}
          />
          {drag.x > 24 && (
            <div className="absolute bottom-56 left-4 z-30 -rotate-6 border-2 border-emerald-400 bg-[#0e1530]/80 px-3 py-1 font-pixel text-2xl font-black text-emerald-400 uppercase shadow-[3px_3px_0_rgba(0,0,0,0.6)]">
              yes
            </div>
          )}
          {drag.x < -24 && (
            <div className="absolute right-4 bottom-56 z-30 rotate-6 border-2 border-rose-400 bg-[#0e1530]/80 px-3 py-1 font-pixel text-2xl font-black text-rose-400 uppercase shadow-[3px_3px_0_rgba(0,0,0,0.6)]">
              no
            </div>
          )}

          {/* title banner */}
          <div className="flex items-center justify-between border-2 border-black/55 bg-[#0e1530] px-2.5 py-1.5 shadow-[inset_0_2px_0_rgba(255,255,255,0.06),inset_0_-2px_0_rgba(0,0,0,0.45)]">
            <span className="flex items-center gap-1.5 font-pixel text-base tracking-[0.18em] text-amber-300 uppercase">
              <img
                src="/assets/cards/asset-btc-16.png"
                alt=""
                aria-hidden
                className="size-5 [image-rendering:pixelated]"
              />
              btc / usd
            </span>
            <span className="font-pixel text-base tracking-[0.18em] text-white/45 uppercase tabular-nums">
              {cardIdx + 1}/{roomState.cards.length}
            </span>
          </div>

          {/* art window — pixel mascot reacts to the swipe direction */}
          <div className="crt-screen relative flex flex-1 items-center justify-center overflow-hidden border-2 border-black/55 bg-gradient-to-b from-[#243169] to-[#10183a] shadow-[inset_0_3px_0_rgba(255,255,255,0.05),inset_0_-3px_0_rgba(0,0,0,0.5)]">
            <span className="absolute top-1 left-1 size-1.5 bg-black/50" />
            <span className="absolute top-1 right-1 size-1.5 bg-black/50" />
            <span className="absolute bottom-1 left-1 size-1.5 bg-black/50" />
            <span className="absolute right-1 bottom-1 size-1.5 bg-black/50" />
            <img
              src={artSrc}
              alt=""
              aria-hidden
              draggable={false}
              className="pointer-events-none h-[88%] w-[88%] object-contain select-none [-webkit-user-drag:none] [image-rendering:pixelated]"
              style={{
                transform: `scale(${1 + progress * 0.18}) rotate(${rotate * 0.4}deg)`,
                filter: `drop-shadow(0 0 12px ${artGlow})`,
              }}
            />
          </div>

          {/* TCG quote box */}
          <div className="relative border-2 border-black/55 bg-[#11183a] px-3 py-2.5 shadow-[inset_0_2px_0_rgba(255,255,255,0.06),inset_0_-2px_0_rgba(0,0,0,0.5)]">
            <div className="pointer-events-none absolute inset-1 border border-white/10" />
            <p className="font-pixel text-sm tracking-[0.22em] text-amber-300/80 uppercase">
              will btc settle
            </p>
            <p className="mt-1 text-3xl leading-none font-black text-white">
              above {fmtUsd(card.strike)}?
            </p>
            {(settleLabel || countdown) && (
              <p
                className={`mt-1.5 flex items-center gap-1.5 font-pixel text-sm tracking-[0.2em] uppercase tabular-nums ${
                  settleLabel ? "text-cyan-300" : countdownColor
                }`}
              >
                <img
                  src="/icons/clock.png"
                  alt=""
                  aria-hidden
                  className="size-3.5 [image-rendering:pixelated]"
                />
                {settleLabel ??
                  (remainingMs !== null && remainingMs <= 0
                    ? "settling…"
                    : `settles in ${countdown}`)}
              </p>
            )}
          </div>

          {/* live stat pills */}
          <div className="grid grid-cols-2 gap-2">
            <div className="flex items-center gap-2 border-2 border-black/55 bg-[#0e1530] px-2 py-1.5 shadow-[inset_0_2px_0_rgba(255,255,255,0.05),inset_0_-2px_0_rgba(0,0,0,0.45)]">
              <img
                src="/icons/clock.png"
                alt=""
                aria-hidden
                className="size-4 shrink-0 [image-rendering:pixelated]"
              />
              <div className="min-w-0">
                <p className="font-pixel text-xs tracking-[0.2em] text-white/40 uppercase">
                  now
                </p>
                <p className="font-pixel text-lg text-white tabular-nums">
                  {tick ? fmtUsd(tick.spot) : "—"}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 border-2 border-black/55 bg-[#0e1530] px-2 py-1.5 shadow-[inset_0_2px_0_rgba(255,255,255,0.05),inset_0_-2px_0_rgba(0,0,0,0.45)]">
              <img
                src="/icons/dice.png"
                alt=""
                aria-hidden
                className="size-4 shrink-0 [image-rendering:pixelated]"
              />
              <div className="min-w-0">
                <p className="font-pixel text-xs tracking-[0.2em] text-white/40 uppercase">
                  stake
                </p>
                <p className="font-pixel text-lg text-emerald-300 tabular-nums">
                  {stakeLabel}
                </p>
              </div>
            </div>
          </div>

          {/* yes / no action chips — with estimated per-side win odds */}
          <div className="grid grid-cols-2 gap-2">
            <div className="pixel-tile flex items-center justify-center gap-1.5 bg-[#3a1620] px-2 py-2">
              <img
                src="/icons/arrow_left.png"
                alt=""
                aria-hidden
                className="size-4 [image-rendering:pixelated]"
              />
              <span className="font-pixel text-lg text-rose-300 uppercase">
                no
              </span>
              {noPct !== null && (
                <span className="font-pixel text-sm text-rose-300/70 tabular-nums">
                  {noPct}%
                </span>
              )}
            </div>
            <div className="pixel-tile flex items-center justify-center gap-1.5 bg-[#163a26] px-2 py-2">
              <span className="font-pixel text-lg text-emerald-300 uppercase">
                yes
              </span>
              {yesPct !== null && (
                <span className="font-pixel text-sm text-emerald-300/70 tabular-nums">
                  {yesPct}%
                </span>
              )}
              <img
                src="/icons/arrow_right.png"
                alt=""
                aria-hidden
                className="size-4 [image-rendering:pixelated]"
              />
            </div>
          </div>
        </div>
      </div>

      {error && (
        <p className="pt-2 text-center text-sm text-red-400">{error}</p>
      )}
      <p className="pt-2 text-center font-pixel text-[11px] tracking-[0.25em] text-white/40 uppercase">
        {busy ? busyLabel : "swipe → yes · ← no"}
      </p>

      {/* Charts stay mounted (open toggles visibility) so they accumulate
          oracle-tick history for the whole match — warm on open, no reset. */}
      <ChartModal
        open={chartModal === "btc"}
        title="btc / usd"
        onClose={() => setChartModal(null)}
      >
        <BtcSpotChart ticks={ticks} cards={roomState.cards} />
      </ChartModal>
      <ChartModal
        open={chartModal === "pnl"}
        title="projected pnl"
        onClose={() => setChartModal(null)}
      >
        <StreamingPnlChart
          duel={chartDuel}
          ticks={ticks}
          myIsP0={myIsP0}
          youAddress={myAddress}
          oppAddress={opponent}
        />
        <div className="mt-3">
          <CardLedger roomState={roomState} myIsP0={myIsP0} ticks={ticks} />
        </div>
      </ChartModal>
    </div>
  )
}

/** Pixel chip that opens a chart modal. Brightened + bordered so it reads as
 *  a tappable control against the dark gameplay background. */
function ChartChip({
  label,
  icon,
  onClick,
}: {
  label: string
  icon: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="pixel-tile flex items-center gap-1.5 bg-[#3a4d8a] px-3 py-2 font-pixel text-base tracking-[0.15em] text-white uppercase hover:bg-[#46599e]"
    >
      <img
        src={icon}
        alt=""
        aria-hidden
        className="size-5 [image-rendering:pixelated]"
      />
      {label}
    </button>
  )
}

/**
 * Portal modal for the in-match charts. Stays MOUNTED while closed (toggles
 * visibility via opacity, not mount/unmount) so the charts inside keep
 * sampling oracle ticks the whole match — they're warm with history the
 * instant you open them, and reopening never resets the data.
 */
function ChartModal({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.body.style.overflow = "hidden"
    window.addEventListener("keydown", onKey)
    return () => {
      document.body.style.overflow = ""
      window.removeEventListener("keydown", onKey)
    }
  }, [open, onClose])

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-hidden={!open}
      onClick={onClose}
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-[2px] transition-opacity ${
        open ? "opacity-100" : "pointer-events-none opacity-0"
      }`}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="pixel-frame relative w-full max-w-sm rounded-3xl bg-[#1b2548] p-4 font-pixel text-white"
      >
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm tracking-[0.2em] text-white/70 uppercase">
            {title}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="close"
            className="text-xl text-white/55 hover:text-white"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body
  )
}

/**
 * Per-card running ledger. Settled cards show frozen binary PnL from
 * `cardOutcomes` (populated by the indexer the moment each card's oracle
 * publishes `settlement_price`, independent of when `settle_card` runs on
 * chain). Unsettled-but-swiped show smooth mark-to-market.
 */
export function CardLedger({
  roomState,
  myIsP0,
  ticks,
}: {
  roomState: RoomState
  myIsP0: boolean
  ticks: Record<string, { spot: string }>
}) {
  const settledByIdx = new Map(
    roomState.cardOutcomes.map((o) => [o.cardIdx, o])
  )
  return (
    <div className="rounded border border-white/10 bg-white/5 text-sm">
      {roomState.cards.map((card, i) => {
        const settled = settledByIdx.get(i)
        const swipeSlot = roomState.swipes.find((s) => s.cardIdx === i)
        const mySwipe = swipeSlot
          ? myIsP0
            ? swipeSlot.p0Swipe
            : swipeSlot.p1Swipe
          : null
        // % return relative to the swiped quantity (the wire no longer
        // carries per-swipe `premium`, so there's no true cost basis here —
        // `net` relative to `quantity` reads as "how much of your at-risk
        // stake you're up/down", exact for the binary live projection).
        // `net` is the signed PnL (null when there's nothing to show) —
        // drives the value color.
        const quantity = BigInt(toSwipeLite(mySwipe)?.quantity ?? "0")
        let net: bigint | null = null
        let pnlLabel = "—"
        if (settled) {
          const pnl = myIsP0 ? settled.p0Pnl : settled.p1Pnl
          if (pnl !== null) {
            net = BigInt(pnl)
            pnlLabel = `${fmtPnlPct(net, quantity)} (settled)`
          } else {
            pnlLabel = "skipped"
          }
        } else if (mySwipe) {
          const live = liveCardPnl(
            toSwipeLite(mySwipe),
            card.strike,
            ticks[card.expiry_market_id]?.spot
          )
          if (live !== null) {
            net = live
            // "projected", not "live PnL" — this is ±quantity (full
            // notional), not the real payout-minus-premium P&L, so it can
            // overstate the loss side. See lib/pnl.ts's SwipeLite doc.
            pnlLabel = `${fmtPnlPct(live, quantity)} (projected)`
          } else {
            pnlLabel = "ticking…"
          }
        }
        const valueColor =
          net === null
            ? "text-white/45"
            : net > 0n
              ? "text-emerald-300"
              : net < 0n
                ? "text-rose-300"
                : "text-white/70"
        return (
          <div
            key={i}
            className="flex items-center justify-between border-b border-white/5 px-3 py-1 last:border-b-0"
          >
            <span>
              card {i + 1}
              {mySwipe ? (mySwipe.isUp ? " ↑" : " ↓") : ""}
            </span>
            <span className={`tabular-nums ${valueColor}`}>{pnlLabel}</span>
          </div>
        )
      })}
    </div>
  )
}
