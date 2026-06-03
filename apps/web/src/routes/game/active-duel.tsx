import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react"
import { Link } from "react-router"
import { useCurrentAccount, useSuiClient } from "@mysten/dapp-kit"
import type { ClientMsg, ServerMsg } from "@/lib/protocol"
import { STAKE_TIERS, type Tier } from "@/lib/protocol"
import type { Unsubscribe } from "@/hooks/use-flicky-socket"
import {
  buildCreateDuelDusdcTx,
  buildJoinDuelDusdcTx,
  fetchOracleSvi,
  resolveCreatedDuelId,
} from "@/lib/flicky"
import {
  DEEPBOOK,
  buildStakedSwipeTx,
  quoteSwipePremium,
} from "@/lib/deepbook"
import { useFlickySign } from "@/lib/use-flicky-sign"
import { liveCardPnl, fmtDusdcSigned } from "@/lib/pnl"
import { SWIPE_QUANTITY } from "@/components/onboarding-modal"
import { WsErrorBanner } from "@/components/ws-error-banner"
import { StreamingPnlChart } from "@/components/streaming-pnl-chart"
import { BtcSpotChart } from "@/components/btc-spot-chart"

/** Format a 1e9-scaled on-chain BTC price as a rounded USD string,
 *  e.g. "67235752957751" → "$67,236". Accepts the raw string or bigint. */
function fmtUsd(v: string | bigint): string {
  return `$${(Number(v) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
}

// Drag-to-swipe tuning — mirrors the lobby DuelView feel.
const DRAG_COMMIT_FRACTION = 0.3
const DRAG_MAX_ROTATE_DEG = 18

interface Props {
  /**
   * Matchmaking entry: the player's role drives the create/join PTB.
   * Omitted in resume mode (`resumeDuelId` set) — the duel already exists,
   * so there's nothing to create/join.
   */
  role?: "creator" | "challenger"
  /** Cosmetic stake-amount tier (matchmaking). Absent on resume. */
  tier?: Tier
  managerId: string
  /**
   * Deck hash from `match_found`. Required for the creator's
   * `create_duel` PTB. Passed as a prop (not subscribed to inside this
   * component) because the message has already fired by the time
   * ActiveDuel mounts — pvp.tsx captures it on receipt. Absent on resume.
   */
  deckHash?: string
  /**
   * Resume mode: mount straight onto an existing duel by id (deep-link /
   * reload-safe). Skips create/join, subscribes to the room, and lets
   * `room_state` drive the phase. Mutually exclusive with `role`/`deckHash`.
   */
  resumeDuelId?: string
  /**
   * Matchmaking handoff: fired with the duel id the moment create/join
   * lands. The matchmaking screen uses it to hand off to the deep-linkable
   * `/game/play/:duelId` route, so the live session lives at a real URL.
   */
  onDuelReady?: (duelId: string) => void
  wsOpen: boolean
  send: (msg: ClientMsg) => void
  onMessage: (handler: (msg: ServerMsg) => void) => Unsubscribe
  onExit: () => void
}

/**
 * Phases of the active-duel state machine. From AWAIT_REVEAL onwards
 * the two roles render the same UI; the ENTRY branch is the only
 * role-conditional code path.
 */
type Phase =
  | { kind: "ENTRY"; reason: string }
  | { kind: "AWAIT_REVEAL"; duelId: string }
  | { kind: "SWIPING"; duelId: string; cardIdx: number }
  | { kind: "AWAIT_SETTLEMENT"; duelId: string }
  | { kind: "COMPLETE"; duelId: string }
  | { kind: "ERROR"; message: string }

/**
 * Mirror of `room_state` from the server. Kept loose so we don't pull
 * the full ServerMsg discriminated-union narrowing inline.
 */
export interface RoomState {
  duelId: string
  status: "PENDING" | "ACTIVE" | "COMPLETE"
  cardsRevealed: boolean
  cardCount: number
  settledCount: number
  cards: Array<{ oracle_id: string; strike: string }>
  p0Payout: string
  p0Premium: string
  p1Payout: string
  p1Premium: string
  startedAtMs: number
  creator: string
  challenger: string
  stakeCoinType: string
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
}

export function ActiveDuel({
  role,
  tier,
  managerId,
  deckHash,
  resumeDuelId,
  onDuelReady,
  // wsOpen is in the Props for future status indicators but the player
  // doesn't need to see the connection state during a match.
  wsOpen: _wsOpen,
  send,
  onMessage,
  onExit,
}: Props) {
  const account = useCurrentAccount()
  const client = useSuiClient()
  const sign = useFlickySign()
  const [phase, setPhase] = useState<Phase>(
    resumeDuelId
      ? { kind: "AWAIT_REVEAL", duelId: resumeDuelId }
      : { kind: "ENTRY", reason: "Setting up the match…" },
  )
  const [roomState, setRoomState] = useState<RoomState | null>(null)
  // Live oracle prices, keyed by oracle id. Powers mark-to-market PnL.
  const [ticks, setTicks] = useState<
    Record<string, { spot: string; forward: string }>
  >({})
  // Oracle expiries, keyed by oracle id. Needed to build MarketKey for
  // swipe quotes and the swipe PTB. Resolved once per unique oracle
  // when the deck arrives.
  const [expiries, setExpiries] = useState<Record<string, bigint>>({})
  // Refs so the WS handler can read latest state without re-subscribing.
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const sentCreateRef = useRef(false)
  const sentJoinRef = useRef(false)

  // Watch room_state once we have a duelId — drives the phase transitions
  // from AWAIT_REVEAL → SWIPING → AWAIT_SETTLEMENT → COMPLETE.
  useEffect(() => {
    return onMessage((msg) => {
      if (msg.type !== "room_state") return
      setRoomState(msg as RoomState)
      if (
        phaseRef.current.kind === "AWAIT_REVEAL" &&
        msg.cardsRevealed &&
        msg.cards.length === 5
      ) {
        setPhase({
          kind: "SWIPING",
          duelId: phaseRef.current.duelId,
          cardIdx: nextCardIdx(msg as RoomState, account?.address),
        })
      }
      if (
        phaseRef.current.kind === "SWIPING" &&
        countMySwipes(msg as RoomState, account?.address) === 5
      ) {
        setPhase({ kind: "AWAIT_SETTLEMENT", duelId: phaseRef.current.duelId })
      }
      if (
        msg.status === "COMPLETE" &&
        phaseRef.current.kind !== "COMPLETE" &&
        phaseRef.current.kind !== "ENTRY"
      ) {
        setPhase({ kind: "COMPLETE", duelId: msg.duelId })
      }
    })
  }, [onMessage, account])

  // Resume mode: the duel already exists, so just subscribe to its room and
  // let `room_state` drive the phase (AWAIT_REVEAL → SWIPING → …). No
  // create/join PTB. Reload- and deep-link-safe.
  useEffect(() => {
    if (!resumeDuelId) return
    send({ type: "room_subscribe", duelId: resumeDuelId })
    return () => send({ type: "room_unsubscribe", duelId: resumeDuelId })
  }, [resumeDuelId, send])

  // Stream oracle ticks into local state. Used by mark-to-market PnL.
  useEffect(() => {
    return onMessage((msg) => {
      if (msg.type !== "oracle_tick") return
      setTicks((prev) => ({
        ...prev,
        [msg.oracleId]: { spot: msg.spot, forward: msg.forward },
      }))
    })
  }, [onMessage])

  // When the deck arrives, fetch each unique oracle's expiry (needed to
  // build MarketKey for quotes + swipes) and subscribe to ticks.
  const oraclesReady =
    roomState?.cards.length === 5 ? roomState.cards : null
  useEffect(() => {
    if (!oraclesReady) return
    let cancelled = false
    const unique = Array.from(new Set(oraclesReady.map((c) => c.oracle_id)))
    ;(async () => {
      const next: Record<string, bigint> = {}
      for (const id of unique) {
        try {
          const info = await fetchOracleSvi(client, id)
          next[id] = info.expiry
        } catch (e) {
          console.warn(`fetchOracleSvi(${id}) failed`, e)
        }
      }
      if (cancelled) return
      setExpiries((prev) => ({ ...prev, ...next }))
      send({ type: "oracle_subscribe", oracleIds: unique })
    })()
    return () => {
      cancelled = true
      send({ type: "oracle_unsubscribe", oracleIds: unique })
    }
  }, [oraclesReady, client, send])

  // Creator: fire create_duel as soon as we mount with the deckHash
  // already captured from match_found at the pvp.tsx level. Subscribing
  // to match_found here would be too late — by the time ActiveDuel
  // mounts, that message has already dispatched. `sentCreateRef` keeps
  // this idempotent across StrictMode double-invocations.
  useEffect(() => {
    if (role !== "creator") return
    if (sentCreateRef.current) return
    sentCreateRef.current = true
    ;(async () => {
      try {
        if (!account) throw new Error("wallet not connected")
        if (!deckHash || !tier) throw new Error("missing deck hash or tier")
        const deckHashBytes = hexToBytes(deckHash)
        if (deckHashBytes.length !== 32) {
          throw new Error(
            `deck hash must be 32 bytes, got ${deckHashBytes.length}`,
          )
        }
        const tx = await buildCreateDuelDusdcTx(
          client,
          account.address,
          deckHashBytes,
          STAKE_TIERS[tier],
          DEEPBOOK.dusdcType,
        )
        const res = await sign.mutateAsync({ transaction: tx })
        // Sponsored-gas path returns only `{ digest }` — objectChanges
        // isn't included. Wait for the tx to be indexed, then re-fetch
        // it to read the created Duel id.
        const duelId = await resolveCreatedDuelId(client, res.digest)
        if (!duelId) {
          throw new Error(
            "create_duel landed but Duel id not yet indexed — try again",
          )
        }
        // Hand off to the deep-linkable play route if the matchmaking
        // screen wants it; otherwise subscribe + advance in place.
        if (onDuelReady) {
          onDuelReady(duelId)
          return
        }
        send({ type: "room_subscribe", duelId })
        setPhase({ kind: "AWAIT_REVEAL", duelId })
      } catch (e) {
        sentCreateRef.current = false
        setPhase({
          kind: "ERROR",
          message: e instanceof Error ? e.message : String(e),
        })
      }
    })()
  }, [role, deckHash, account, client, sign, tier, send, onDuelReady])

  // Challenger: wait for duel_assigned, then sign join_duel.
  useEffect(() => {
    if (role !== "challenger") return
    return onMessage(async (msg) => {
      if (msg.type !== "duel_assigned") return
      if (sentJoinRef.current) return
      sentJoinRef.current = true
      try {
        if (!account) throw new Error("wallet not connected")
        if (!tier) throw new Error("missing tier")
        const tx = await buildJoinDuelDusdcTx(
          client,
          account.address,
          msg.duelId,
          STAKE_TIERS[tier],
          DEEPBOOK.dusdcType,
        )
        await sign.mutateAsync({ transaction: tx })
        if (onDuelReady) {
          onDuelReady(msg.duelId)
          return
        }
        send({ type: "room_subscribe", duelId: msg.duelId })
        setPhase({ kind: "AWAIT_REVEAL", duelId: msg.duelId })
      } catch (e) {
        sentJoinRef.current = false
        setPhase({
          kind: "ERROR",
          message: e instanceof Error ? e.message : String(e),
        })
      }
    })
  }, [role, onMessage, account, client, sign, tier, send, onDuelReady])

  return (
    <div className="flex h-full flex-col gap-4 px-4 py-4 text-white">
      <WsErrorBanner onMessage={onMessage} />
      <div className="flex items-center justify-between">
        <h2 className="text-xl tracking-[0.2em] uppercase">Active Match</h2>
        <button
          type="button"
          onClick={onExit}
          className="rounded border border-white/30 bg-white/5 px-3 py-1 text-base hover:bg-white/10"
        >
          Exit
        </button>
      </div>
      <div className="text-sm tracking-wider text-white/55 uppercase">
        {tier ? `stake ${Number(STAKE_TIERS[tier]) / 1e6} dUSDC` : "staked duel"}
      </div>

      {phase.kind === "ENTRY" && <PhaseEntry reason={phase.reason} />}
      {phase.kind === "AWAIT_REVEAL" && (
        <PhaseAwaitReveal duelId={phase.duelId} roomState={roomState} />
      )}
      {phase.kind === "SWIPING" && roomState && account && (
        <PhaseSwiping
          duelId={phase.duelId}
          cardIdx={phase.cardIdx}
          roomState={roomState}
          managerId={managerId}
          expiries={expiries}
          ticks={ticks}
          myAddress={account.address}
          sign={sign}
          onSwipeDone={() =>
            setPhase((p) =>
              p.kind === "SWIPING"
                ? { kind: "SWIPING", duelId: p.duelId, cardIdx: p.cardIdx + 1 }
                : p,
            )
          }
        />
      )}
      {phase.kind === "AWAIT_SETTLEMENT" && roomState && account && (
        <PhaseAwaitSettlement roomState={roomState} />
      )}
      {phase.kind === "COMPLETE" && roomState && account && (
        <PhaseComplete roomState={roomState} myAddress={account.address} />
      )}
      {phase.kind === "ERROR" && (
        <p className="text-base text-red-400">{phase.message}</p>
      )}
    </div>
  )
}

function PhaseEntry({ reason }: { reason: string }) {
  return (
    <div className="rounded border border-white/10 bg-white/5 p-4">
      <p className="text-base text-white/70">{reason}</p>
    </div>
  )
}

function PhaseAwaitReveal({
  roomState,
}: {
  duelId: string
  roomState: RoomState | null
}) {
  const ready = roomState?.cards.length ?? 0
  return (
    <div className="rounded border border-white/10 bg-white/5 p-4 text-center">
      <p className="text-base text-white/70">Shuffling the deck&hellip;</p>
      <p className="mt-2 text-sm text-white/40">{ready} / 5 cards ready</p>
    </div>
  )
}

function PhaseSwiping({
  duelId,
  cardIdx,
  roomState,
  managerId,
  expiries,
  ticks,
  myAddress,
  sign,
  onSwipeDone,
}: {
  duelId: string
  cardIdx: number
  roomState: RoomState
  managerId: string
  expiries: Record<string, bigint>
  ticks: Record<string, { spot: string; forward: string }>
  myAddress: string
  sign: ReturnType<typeof useFlickySign>
  onSwipeDone: () => void
}) {
  const card = roomState.cards[cardIdx]
  const expiry = card ? expiries[card.oracle_id] : undefined
  const [quoteUp, setQuoteUp] = useState<{
    premium: bigint
    pImplied: bigint
  } | null>(null)
  const [quoteDown, setQuoteDown] = useState<{
    premium: bigint
    pImplied: bigint
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const client = useSuiClient()

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

  // Pre-quote both directions when the card changes. Frozen for the
  // duration of this card — re-quoting on every oracle_tick would hammer
  // devInspect. Contract still snapshots the real premium at swipe time.
  useEffect(() => {
    if (!card || !expiry) return
    let cancelled = false
    setQuoteUp(null)
    setQuoteDown(null)
    setError(null)
    ;(async () => {
      try {
        const [up, down] = await Promise.all([
          quoteSwipePremium(client, {
            oracleSviId: card.oracle_id,
            oracleExpiry: expiry,
            strike: BigInt(card.strike),
            isUp: true,
            quantity: SWIPE_QUANTITY,
          }),
          quoteSwipePremium(client, {
            oracleSviId: card.oracle_id,
            oracleExpiry: expiry,
            strike: BigInt(card.strike),
            isUp: false,
            quantity: SWIPE_QUANTITY,
          }),
        ])
        if (cancelled) return
        setQuoteUp(up)
        setQuoteDown(down)
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [card?.oracle_id, card?.strike, expiry, client])

  const myIsP0 = myAddress.toLowerCase() === roomState.creator.toLowerCase()
  const opponent = myIsP0 ? roomState.challenger : roomState.creator
  const chartDuel = {
    id: duelId,
    settledCount: roomState.settledCount,
    cards: roomState.cards,
    swipes: roomState.swipes,
    cardOutcomes: roomState.cardOutcomes,
  }

  // All of my cards are swiped (cardIdx past the deck) — hand off to the
  // result/home rather than showing a dead-end settlement screen.
  if (cardIdx >= roomState.cards.length) {
    return <SettlingHandoff duelId={duelId} />
  }

  if (!card || !expiry) {
    return (
      <p className="text-base text-white/55">Loading card {cardIdx + 1}…</p>
    )
  }

  const tick = ticks[card.oracle_id]

  const doSwipe = async (isUp: boolean) => {
    setBusy(true)
    setError(null)
    try {
      const tx = buildStakedSwipeTx({
        duelId,
        oracleSviId: card.oracle_id,
        managerId,
        oracleExpiry: expiry,
        strike: BigInt(card.strike),
        isUp,
        quantity: SWIPE_QUANTITY,
        cardIdx,
      })
      await sign.mutateAsync({ transaction: tx })
      onSwipeDone()
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
    if (busy || drag.flying) return
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
    flyOff ?? (drag.x === 0 ? "" : `translateX(${drag.x}px) rotate(${rotate}deg)`)
  const progress = Math.min(1, Math.abs(drag.x) / (cw * DRAG_COMMIT_FRACTION))
  const yesGlow = drag.x > 0 ? progress : 0
  const noGlow = drag.x < 0 ? progress : 0

  const yesCost = quoteUp ? fmtDusdcSigned(-quoteUp.premium).trim() : "…"
  const noCost = quoteDown ? fmtDusdcSigned(-quoteDown.premium).trim() : "…"
  const yesOdds = quoteUp ? `${(Number(quoteUp.pImplied) / 1e7).toFixed(0)}%` : "…"
  const hasNext = cardIdx + 1 < roomState.cards.length

  return (
    <div className="flex flex-col gap-3">
      <BtcSpotChart ticks={ticks} cards={roomState.cards} />

      <p className="font-pixel text-center text-[10px] tracking-[0.25em] text-white/45 uppercase">
        card {cardIdx + 1} / {roomState.cards.length}
      </p>

      {/* swipe arena — top card draggable, next card peeking from the deck */}
      <div
        className="relative select-none"
        style={{ touchAction: "none", height: 244 }}
      >
        {hasNext && (
          <div
            aria-hidden
            className="pixel-tile absolute inset-x-3 bottom-0 top-3 bg-[#141d3a]"
          />
        )}
        <div
          ref={cardRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          className={`pixel-tile absolute inset-0 flex cursor-grab flex-col justify-between bg-[#1b2548] p-5 ${
            drag.active ? "" : "transition-transform duration-300 ease-out"
          } ${drag.flying ? "pointer-events-none" : "active:cursor-grabbing"}`}
          style={{ transform, willChange: "transform" }}
        >
          {/* YES / NO tint + stamps */}
          <div
            className="pointer-events-none absolute inset-0 bg-emerald-500/25"
            style={{ opacity: yesGlow }}
          />
          <div
            className="pointer-events-none absolute inset-0 bg-rose-500/25"
            style={{ opacity: noGlow }}
          />
          {drag.x > 24 && (
            <div className="font-pixel absolute right-3 top-3 rotate-6 border-2 border-emerald-400 px-2 py-0.5 text-base font-black text-emerald-400 uppercase">
              yes
            </div>
          )}
          {drag.x < -24 && (
            <div className="font-pixel absolute left-3 top-3 -rotate-6 border-2 border-rose-400 px-2 py-0.5 text-base font-black text-rose-400 uppercase">
              no
            </div>
          )}

          {/* the claim */}
          <div>
            <p className="font-pixel text-[10px] tracking-[0.2em] text-white/45 uppercase">
              will btc settle
            </p>
            <p className="mt-1 text-2xl leading-tight font-black">
              above {fmtUsd(card.strike)}?
            </p>
            <p className="mt-2 text-sm text-white/55">
              now {tick ? fmtUsd(tick.spot) : "—"} · market {yesOdds}
            </p>
          </div>

          {/* yes / no footer hints */}
          <div className="flex items-end justify-between text-xs">
            <span className="text-rose-300">
              <span className="font-pixel">← no</span>
              <br />
              {noCost}
            </span>
            <span className="text-right text-emerald-300">
              <span className="font-pixel">yes →</span>
              <br />
              {yesCost}
            </span>
          </div>
        </div>
      </div>

      <p className="font-pixel text-center text-[10px] tracking-[0.25em] text-white/40 uppercase">
        {busy ? "minting position…" : "swipe → yes · ← no"}
      </p>

      {error && <p className="text-base text-red-400">{error}</p>}

      <StreamingPnlChart
        duel={chartDuel}
        ticks={ticks}
        myIsP0={myIsP0}
        youAddress={myAddress}
        oppAddress={opponent}
      />

      <CardLedger roomState={roomState} myIsP0={myIsP0} ticks={ticks} />
    </div>
  )
}

/**
 * Per-card running ledger. Settled cards show frozen binary PnL from
 * `cardOutcomes` (populated by the indexer the moment each card's oracle
 * publishes `settlement_price`, independent of when `settle_card` runs on
 * chain). Unsettled-but-swiped show smooth mark-to-market.
 */
function CardLedger({
  roomState,
  myIsP0,
  ticks,
}: {
  roomState: RoomState
  myIsP0: boolean
  ticks: Record<string, { spot: string; forward: string }>
}) {
  const settledByIdx = new Map(
    roomState.cardOutcomes.map((o) => [o.cardIdx, o]),
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
        let pnlLabel = "—"
        if (settled) {
          const pnl = myIsP0 ? settled.p0Pnl : settled.p1Pnl
          pnlLabel =
            pnl !== null
              ? `${fmtDusdcSigned(BigInt(pnl))} (settled)`
              : "skipped"
        } else if (mySwipe) {
          const live = liveCardPnl(
            mySwipe,
            card.strike,
            ticks[card.oracle_id]?.forward,
          )
          pnlLabel =
            live !== null ? `${fmtDusdcSigned(live)} (live)` : "ticking…"
        }
        return (
          <div
            key={i}
            className="flex items-center justify-between border-b border-white/5 px-3 py-1 last:border-b-0"
          >
            <span>
              card {i + 1}
              {mySwipe ? (mySwipe.isUp ? " ↑" : " ↓") : ""}
            </span>
            <span>{pnlLabel}</span>
          </div>
        )
      })}
    </div>
  )
}

function PhaseAwaitSettlement({ roomState }: { roomState: RoomState }) {
  return <SettlingHandoff duelId={roomState.duelId} />
}

/**
 * Both players have locked their swipes — there's nothing more to do in the
 * live screen. The duel settles asynchronously as each card's oracle
 * resolves, so hand off to the result screen (which streams settlement) or
 * back home rather than parking on a static "awaiting settlement" panel.
 */
function SettlingHandoff({ duelId }: { duelId: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-5 px-6 py-10 text-center">
      <p className="font-pixel text-base tracking-[0.2em] text-emerald-300 uppercase">
        picks locked in
      </p>
      <p className="max-w-xs text-sm leading-relaxed text-white/65">
        The duel settles as each card&rsquo;s oracle resolves. Watch it play out
        on the result screen — it&rsquo;ll also be waiting on your home screen.
      </p>
      <div className="flex w-full max-w-xs flex-col gap-2">
        <Link
          to={`/game/duel/${duelId}`}
          className="pixel-tile bg-emerald-600 px-4 py-3 font-pixel text-sm uppercase"
        >
          watch result
        </Link>
        <Link
          to="/game/home"
          className="pixel-tile bg-[#1b2548] px-4 py-3 font-pixel text-sm uppercase"
        >
          back to home
        </Link>
      </div>
    </div>
  )
}

function PhaseComplete({
  roomState,
  myAddress,
}: {
  roomState: RoomState
  myAddress: string
}) {
  const myIsP0 = myAddress.toLowerCase() === roomState.creator.toLowerCase()
  const myNet =
    BigInt(myIsP0 ? roomState.p0Payout : roomState.p1Payout) -
    BigInt(myIsP0 ? roomState.p0Premium : roomState.p1Premium)
  const oppNet =
    BigInt(myIsP0 ? roomState.p1Payout : roomState.p0Payout) -
    BigInt(myIsP0 ? roomState.p1Premium : roomState.p0Premium)
  const tied = myNet === oppNet
  const youWon = myNet > oppNet
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded border-2 border-black/55 bg-[#1b2548] p-4 text-center">
        <h3 className="text-2xl tracking-[0.2em] uppercase">
          {tied ? "Tie" : youWon ? "Victory" : "Defeat"}
        </h3>
        <p className="mt-2 text-base text-white/70">
          you {fmtDusdcSigned(myNet)} &middot; opponent{" "}
          {fmtDusdcSigned(oppNet)}
        </p>
      </div>
      <CardLedger roomState={roomState} myIsP0={myIsP0} ticks={{}} />
    </div>
  )
}

function nextCardIdx(rs: RoomState, myAddress: string | undefined): number {
  if (!myAddress) return 0
  const isP0 = myAddress.toLowerCase() === rs.creator.toLowerCase()
  let n = 0
  for (const s of rs.swipes) {
    const my = isP0 ? s.p0Swipe : s.p1Swipe
    if (my) n = Math.max(n, s.cardIdx + 1)
  }
  return Math.min(n, 5)
}

function countMySwipes(
  rs: RoomState,
  myAddress: string | undefined,
): number {
  if (!myAddress) return 0
  const isP0 = myAddress.toLowerCase() === rs.creator.toLowerCase()
  let n = 0
  for (const s of rs.swipes) {
    const my = isP0 ? s.p0Swipe : s.p1Swipe
    if (my) n++
  }
  return n
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex
  if (clean.length % 2 !== 0) {
    throw new Error(`hex string has odd length: ${hex}`)
  }
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

