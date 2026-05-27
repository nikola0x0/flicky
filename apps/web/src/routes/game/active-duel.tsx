import { useEffect, useRef, useState } from "react"
import { useCurrentAccount, useSuiClient } from "@mysten/dapp-kit"
import type { ClientMsg, ServerMsg } from "@/lib/protocol"
import { STAKE_TIERS, type Tier } from "@/lib/protocol"
import type { Unsubscribe } from "@/hooks/use-flicky-socket"
import {
  buildCreateDuelDusdcTx,
  buildJoinDuelDusdcTx,
  fetchOracleSvi,
} from "@/lib/flicky"
import {
  DEEPBOOK,
  buildStakedSwipeTx,
  quoteSwipePremium,
} from "@/lib/deepbook"
import { useFlickySign } from "@/lib/use-flicky-sign"
import { liveCardPnl, runningPnl, fmtDusdcSigned } from "@/lib/pnl"
import { SWIPE_QUANTITY } from "@/components/onboarding-modal"

interface Props {
  role: "creator" | "challenger"
  tier: Tier
  managerId: string
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
  wsOpen,
  send,
  onMessage,
  onExit,
}: Props) {
  const account = useCurrentAccount()
  const client = useSuiClient()
  const sign = useFlickySign()
  const [phase, setPhase] = useState<Phase>({
    kind: "ENTRY",
    reason:
      role === "creator"
        ? "Waiting for deck hash…"
        : "Waiting for opponent to create the duel…",
  })
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

  // Creator: as soon as match_found arrives with the deckHash, sign
  // create_duel and transition to AWAIT_REVEAL. Idempotent — `sentCreateRef`
  // prevents resending if match_found fires twice (server replay, etc.).
  useEffect(() => {
    if (role !== "creator") return
    return onMessage(async (msg) => {
      if (msg.type !== "match_found") return
      if (sentCreateRef.current) return
      sentCreateRef.current = true
      try {
        if (!account) throw new Error("wallet not connected")
        const deckHashBytes = hexToBytes(msg.deckHash)
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
        const duelId = extractDuelIdFromChanges(
          (
            res as {
              objectChanges?: Array<{
                type: string
                objectType?: string
                objectId?: string
              }>
            }
          ).objectChanges ?? [],
        )
        if (!duelId) {
          throw new Error("create_duel succeeded but Duel id not in objectChanges")
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
    })
  }, [role, onMessage, account, client, sign, tier, send])

  // Challenger: wait for duel_assigned, then sign join_duel.
  useEffect(() => {
    if (role !== "challenger") return
    return onMessage(async (msg) => {
      if (msg.type !== "duel_assigned") return
      if (sentJoinRef.current) return
      sentJoinRef.current = true
      try {
        if (!account) throw new Error("wallet not connected")
        const tx = await buildJoinDuelDusdcTx(
          client,
          account.address,
          msg.duelId,
          STAKE_TIERS[tier],
          DEEPBOOK.dusdcType,
        )
        await sign.mutateAsync({ transaction: tx })
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
  }, [role, onMessage, account, client, sign, tier, send])

  return (
    <div className="flex h-full flex-col gap-4 px-4 py-4 text-white">
      <div className="flex items-center justify-between">
        <h2 className="text-xl tracking-[0.2em] uppercase">Active Match</h2>
        <button
          type="button"
          onClick={onExit}
          className="rounded border border-white/30 bg-white/5 px-3 py-1 text-sm hover:bg-white/10"
        >
          Exit
        </button>
      </div>
      <div className="text-xs text-white/55">
        role: {role} &middot; tier: {tier} &middot; ws:{" "}
        {wsOpen ? "open" : "closed"}
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
        <PhaseAwaitSettlement
          roomState={roomState}
          myAddress={account.address}
          ticks={ticks}
        />
      )}
      {phase.kind === "COMPLETE" && roomState && account && (
        <PhaseComplete roomState={roomState} myAddress={account.address} />
      )}
      {phase.kind === "ERROR" && (
        <p className="text-sm text-red-400">{phase.message}</p>
      )}
    </div>
  )
}

function PhaseEntry({ reason }: { reason: string }) {
  return (
    <div className="rounded border border-white/10 bg-white/5 p-4">
      <p className="text-sm text-white/70">{reason}</p>
    </div>
  )
}

function PhaseAwaitReveal({
  duelId,
  roomState,
}: {
  duelId: string
  roomState: RoomState | null
}) {
  return (
    <div className="rounded border border-white/10 bg-white/5 p-4">
      <p className="text-sm text-white/70">
        Duel {duelId.slice(0, 10)}&hellip; preparing&hellip;
      </p>
      <p className="mt-1 text-xs text-white/40">
        status: {roomState?.status ?? "—"} &middot; cards:{" "}
        {roomState?.cards.length ?? 0}/5
      </p>
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

  if (!card || !expiry) {
    return (
      <p className="text-sm text-white/55">Loading card {cardIdx + 1}…</p>
    )
  }

  const tick = ticks[card.oracle_id]
  const myIsP0 = myAddress.toLowerCase() === roomState.creator.toLowerCase()
  const deck = { cards: roomState.cards }
  const myRunning = runningPnl(roomState, myIsP0 ? "p0" : "p1", deck, ticks)
  const oppRunning = runningPnl(roomState, myIsP0 ? "p1" : "p0", deck, ticks)

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
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded border-2 border-black/55 bg-[#1b2548] p-4">
        <p className="text-xs tracking-[0.2em] text-white/55 uppercase">
          card {cardIdx + 1} / 5
        </p>
        <p className="mt-1 text-xl font-bold">strike {card.strike}</p>
        <p className="text-xs text-white/60">
          oracle {card.oracle_id.slice(0, 10)}&hellip;
        </p>
        <p className="mt-2 text-sm text-white/70">
          spot {tick?.spot ?? "—"} &middot; forward {tick?.forward ?? "—"}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          disabled={busy || quoteUp === null}
          onClick={() => void doSwipe(true)}
          className="rounded-md bg-emerald-600 px-4 py-3 font-bold text-white disabled:opacity-40"
        >
          <div className="text-lg">UP</div>
          <div className="text-xs opacity-80">
            cost{" "}
            {quoteUp
              ? fmtDusdcSigned(-quoteUp.premium).trim()
              : "…"}
          </div>
          <div className="text-xs opacity-60">
            p {quoteUp ? `${(Number(quoteUp.pImplied) / 1e7).toFixed(1)}%` : "…"}
          </div>
        </button>
        <button
          type="button"
          disabled={busy || quoteDown === null}
          onClick={() => void doSwipe(false)}
          className="rounded-md bg-rose-600 px-4 py-3 font-bold text-white disabled:opacity-40"
        >
          <div className="text-lg">DOWN</div>
          <div className="text-xs opacity-80">
            cost{" "}
            {quoteDown
              ? fmtDusdcSigned(-quoteDown.premium).trim()
              : "…"}
          </div>
          <div className="text-xs opacity-60">
            p {quoteDown ? `${(Number(quoteDown.pImplied) / 1e7).toFixed(1)}%` : "…"}
          </div>
        </button>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <CardLedger roomState={roomState} myIsP0={myIsP0} ticks={ticks} />

      <div className="rounded border border-white/10 bg-white/5 p-3 text-sm">
        <div>you: {fmtDusdcSigned(myRunning)}</div>
        <div>opponent: {fmtDusdcSigned(oppRunning)}</div>
      </div>
    </div>
  )
}

/**
 * Per-card running ledger. Settled cards show frozen binary PnL from
 * `cardOutcomes` (independent of finalize_multi — populated as each
 * card's oracle settles). Unsettled-but-swiped show smooth mark-to-market.
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
    <div className="rounded border border-white/10 bg-white/5 text-xs">
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

function PhaseAwaitSettlement({
  roomState,
  myAddress,
  ticks,
}: {
  roomState: RoomState
  myAddress: string
  ticks: Record<string, { spot: string; forward: string }>
}) {
  const myIsP0 = myAddress.toLowerCase() === roomState.creator.toLowerCase()
  const deck = { cards: roomState.cards }
  const myRunning = runningPnl(roomState, myIsP0 ? "p0" : "p1", deck, ticks)
  const oppRunning = runningPnl(roomState, myIsP0 ? "p1" : "p0", deck, ticks)
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded border border-white/10 bg-white/5 p-3 text-sm">
        <p className="text-white/70">
          all swipes locked &middot; {roomState.settledCount} / 5 cards settled
        </p>
        {roomState.settledCount === 5 && (
          <p className="mt-1 text-white/50">awaiting finalize tx…</p>
        )}
      </div>
      <CardLedger roomState={roomState} myIsP0={myIsP0} ticks={ticks} />
      <div className="rounded border border-white/10 bg-white/5 p-3 text-sm">
        <div>you: {fmtDusdcSigned(myRunning)}</div>
        <div>opponent: {fmtDusdcSigned(oppRunning)}</div>
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
        <p className="mt-2 text-sm text-white/70">
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

function extractDuelIdFromChanges(
  changes: Array<{ type: string; objectType?: string; objectId?: string }>,
): string | null {
  for (const c of changes) {
    if (c.type !== "created") continue
    if (!c.objectType || !c.objectType.includes("::duel::Duel<")) continue
    return c.objectId ?? null
  }
  return null
}
