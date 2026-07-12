/**
 * Practice-session driver — the client-side "server" for practice mode.
 *
 * The real server only hands us a synthetic deck + pre-decided bot swipes
 * (`practice_session`) and a market-less live spot stream (`spot_tick`).
 * This hook owns everything a duel room would: the phase machine
 * (INTRO → STARTING → SWIPING → LOCKUP → RESULT), local swipe recording,
 * the bot's staggered reveal, per-card settlement against live spot at
 * each card's expiry offset, and the final score.
 *
 * It synthesizes a `RoomState`-shaped object (market ids `practice-0…4`,
 * challenger = BOT_ADDRESS) so SwipeScreen, the charts, and CardLedger
 * render exactly as they do in PvP. Nothing here touches the chain.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ClientMsg, ServerMsg } from "@/lib/protocol"
import type { Unsubscribe } from "@/hooks/use-flicky-socket"
import type { RoomState } from "@/lib/room-state"
import { SWIPE_QUANTITY } from "@/lib/funding"

/** Sentinel opponent address — drives PlayerAvatar's deterministic gradient
 *  and fills the p1 slot of the synthetic RoomState. */
export const BOT_ADDRESS =
  "0x0000000000000000000000000000000000000000000000000000000000000b07"
export const BOT_NAME = "flicky-bot"

const BOT_REVEAL_MIN_MS = 1_000
const BOT_REVEAL_MAX_MS = 3_000
/** Speed bonus fully decays after this long deliberating on one card. */
const SPEED_BONUS_WINDOW_MS = 10_000
/** The bot "decided" in 1–3s — fixed middling speed bonus for its points. */
const BOT_SPEED_MULT = 1.25
/** If no fresh tick lands this long after a card's expiry, settle with the
 *  latest spot rather than stalling the reveal. */
const SETTLE_GRACE_MS = 6_000
/** Pause after the last card flips before the result screen. */
const RESULT_DELAY_MS = 1_400
const START_TIMEOUT_MS = 10_000

export interface PracticeCard {
  strike: string
  expiryOffsetMs: number
  pUp: number
}

export type PracticePhase =
  | { kind: "INTRO" }
  | { kind: "STARTING" }
  | { kind: "SWIPING"; cardIdx: number }
  | { kind: "LOCKUP"; lockupStartMs: number; lockupEndMs: number }
  | { kind: "RESULT" }
  | { kind: "ERROR"; message: string }

export interface PracticeResult {
  yourPnl: bigint
  botPnl: bigint
  yourPoints: number
  botPoints: number
  youWon: boolean
  tied: boolean
}

interface PlayerSwipe {
  isUp: boolean
  pSwiped: number
  timeOnCardMs: number
}

interface CardOutcome {
  cardIdx: number
  settlementPrice: string
  upWon: boolean
}

interface Session {
  id: string
  cards: PracticeCard[]
  botSwipes: boolean[]
}

export function usePracticeSession({
  address,
  send,
  onMessage,
}: {
  address: string | undefined
  send: (msg: ClientMsg) => void
  onMessage: (h: (msg: ServerMsg) => void) => Unsubscribe
}) {
  const [phase, setPhase] = useState<PracticePhase>({ kind: "INTRO" })
  const [session, setSession] = useState<Session | null>(null)
  const [playerSwipes, setPlayerSwipes] = useState<(PlayerSwipe | null)[]>([])
  const [botRevealed, setBotRevealed] = useState<boolean[]>([])
  const [outcomes, setOutcomes] = useState<CardOutcome[]>([])
  const [lastTick, setLastTick] = useState<{
    spot: string
    receivedAtMs: number
  } | null>(null)
  const [startedAtMs, setStartedAtMs] = useState(0)

  // Deviation from brief: assigning `.current` directly during render (as
  // literally written in the brief) trips this repo's react-hooks/refs rule
  // ("Cannot update ref during render") — the plugin here is the v7
  // React-Compiler-oriented ruleset, stricter than the exhaustive-deps-only
  // complaint the brief anticipated. Syncing via a dedicated effect (the
  // pattern already used for streaming-pnl-chart.tsx's duelRef/targetTicksRef)
  // is lint-clean and behaviorally identical here: every reader of these
  // refs (the WS message handler, the swipe() click callback, the
  // settlement setInterval) fires from a macrotask that lands strictly
  // after React has committed and flushed effects for the render that
  // produced the new value, so the ref is never read stale.
  const phaseRef = useRef(phase)
  useEffect(() => {
    phaseRef.current = phase
  }, [phase])
  const lastTickRef = useRef(lastTick)
  useEffect(() => {
    lastTickRef.current = lastTick
  }, [lastTick])
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([])
  const cardShownAtRef = useRef(0)
  // Duplicate-delivery latch for the WS intake. Because `phaseRef` is
  // synced in a passive effect, React does NOT guarantee a flush between
  // two back-to-back WebSocket `message` macrotasks — a second
  // `practice_session` arriving right behind the first could still read
  // the stale "STARTING" phase, pass the guard, and restart the deck
  // (wiping card 0's just-recorded state). This ref flips SYNCHRONOUSLY
  // inside the handler — within the same macrotask that accepts the
  // session — so the duplicate bails no matter when React commits.
  const sessionAcceptedRef = useRef(false)

  const clearTimers = useCallback(() => {
    for (const t of timersRef.current) clearTimeout(t)
    timersRef.current = []
  }, [])

  const start = useCallback(() => {
    if (!address) return
    clearTimers()
    sessionAcceptedRef.current = false
    setSession(null)
    setPlayerSwipes([])
    setBotRevealed([])
    setOutcomes([])
    setLastTick(null)
    setPhase({ kind: "STARTING" })
    send({ type: "spot_subscribe" })
    send({ type: "practice_start" })
  }, [address, send, clearTimers])

  const reset = useCallback(() => {
    clearTimers()
    sessionAcceptedRef.current = false
    send({ type: "spot_unsubscribe" })
    setSession(null)
    setPlayerSwipes([])
    setBotRevealed([])
    setOutcomes([])
    setLastTick(null)
    setPhase({ kind: "INTRO" })
  }, [send, clearTimers])

  // Unmount: stop the spot stream and any pending bot reveals.
  useEffect(() => {
    return () => {
      clearTimers()
      send({ type: "spot_unsubscribe" })
    }
  }, [send, clearTimers])

  // Give up if the session never arrives (server down / rate-limited).
  useEffect(() => {
    if (phase.kind !== "STARTING") return
    const t = setTimeout(
      () =>
        setPhase({
          kind: "ERROR",
          message: "the server didn't answer — check your connection and retry",
        }),
      START_TIMEOUT_MS
    )
    return () => clearTimeout(t)
  }, [phase])

  // WS intake: the deck, the spot stream, and practice errors.
  useEffect(() => {
    return onMessage((msg: ServerMsg) => {
      if (msg.type === "practice_session") {
        if (phaseRef.current.kind !== "STARTING") return
        if (sessionAcceptedRef.current) return
        // Latch BEFORE any setState: a duplicate delivered in the very
        // next macrotask (before React flushes phaseRef's sync effect)
        // must bail here rather than restart the deck.
        sessionAcceptedRef.current = true
        setSession({
          id: `practice-${Date.now()}`,
          cards: msg.cards,
          botSwipes: msg.botSwipes,
        })
        setPlayerSwipes(Array(msg.cards.length).fill(null))
        setBotRevealed(Array(msg.cards.length).fill(false))
        setStartedAtMs(Date.now())
        cardShownAtRef.current = Date.now()
        setPhase({ kind: "SWIPING", cardIdx: 0 })
      } else if (msg.type === "spot_tick") {
        // Clock-skew-proof: compare card due-times against our own receipt
        // time, not the server's timestampMs.
        setLastTick({ spot: msg.spot, receivedAtMs: Date.now() })
      } else if (
        msg.type === "error" &&
        msg.code === "practice_failed" &&
        phaseRef.current.kind === "STARTING" &&
        // A late error right behind a successful practice_session (same
        // stale-phaseRef window) must not flip an in-progress match to
        // ERROR — the latch is the synchronous source of truth.
        !sessionAcceptedRef.current
      ) {
        setPhase({ kind: "ERROR", message: msg.message })
      }
    })
  }, [onMessage])

  const swipe = useCallback(
    (isUp: boolean) => {
      const p = phaseRef.current
      if (p.kind !== "SWIPING" || !session) return
      const i = p.cardIdx
      const now = Date.now()
      const card = session.cards[i]
      setPlayerSwipes((prev) => {
        const next = [...prev]
        next[i] = {
          isUp,
          pSwiped: isUp ? card.pUp : 1 - card.pUp,
          timeOnCardMs: now - cardShownAtRef.current,
        }
        return next
      })
      // The bot "thinks" for 1–3s, then its pre-decided pick flips face-up.
      const t = setTimeout(
        () =>
          setBotRevealed((prev) => {
            const next = [...prev]
            next[i] = true
            return next
          }),
        BOT_REVEAL_MIN_MS +
          Math.random() * (BOT_REVEAL_MAX_MS - BOT_REVEAL_MIN_MS)
      )
      timersRef.current.push(t)
      cardShownAtRef.current = now
      if (i + 1 < session.cards.length) {
        setPhase({ kind: "SWIPING", cardIdx: i + 1 })
      } else {
        // 5th swipe = lockup starts; card expiries anchor here.
        const lockupStartMs = now
        const lockupEndMs =
          now + Math.max(...session.cards.map((c) => c.expiryOffsetMs))
        setPhase({ kind: "LOCKUP", lockupStartMs, lockupEndMs })
      }
    },
    [session]
  )

  // Settlement loop: each card settles on the first tick received at/after
  // its due time (falling back to the latest spot after a grace period so a
  // stalled stream can't wedge the match).
  useEffect(() => {
    if (phase.kind !== "LOCKUP" || !session) return
    const { lockupStartMs } = phase
    const iv = setInterval(() => {
      const tick = lastTickRef.current
      if (!tick) return
      const now = Date.now()
      setOutcomes((prev) => {
        const settled = new Set(prev.map((o) => o.cardIdx))
        const next = [...prev]
        session.cards.forEach((card, i) => {
          if (settled.has(i)) return
          const dueMs = lockupStartMs + card.expiryOffsetMs
          if (now < dueMs) return
          if (tick.receivedAtMs < dueMs && now - dueMs < SETTLE_GRACE_MS) return
          next.push({
            cardIdx: i,
            settlementPrice: tick.spot,
            // Contract convention: `actual_up = settlement > strike`
            // (mirrors pnl.ts — exact tie goes to DOWN).
            upWon: BigInt(tick.spot) > BigInt(card.strike),
          })
        })
        return next.length === prev.length ? prev : next
      })
    }, 250)
    return () => clearInterval(iv)
  }, [phase, session])

  // All cards settled → brief beat for the last flip, then the result.
  useEffect(() => {
    if (phase.kind !== "LOCKUP" || !session) return
    if (outcomes.length !== session.cards.length) return
    const t = setTimeout(() => setPhase({ kind: "RESULT" }), RESULT_DELAY_MS)
    return () => clearTimeout(t)
  }, [phase, outcomes, session])

  // Synthetic RoomState — the shape SwipeScreen/charts/CardLedger consume.
  const roomState: RoomState | null = useMemo(() => {
    if (!session || !address) return null
    const q = SWIPE_QUANTITY.toString()
    return {
      duelId: session.id,
      status: outcomes.length === session.cards.length ? "COMPLETE" : "ACTIVE",
      cardsRevealed: true,
      cardCount: session.cards.length,
      cards: session.cards.map((c, i) => ({
        expiry_market_id: `practice-${i}`,
        strike: c.strike,
      })),
      settledCount: outcomes.length,
      p0Payout: "0",
      p0Premium: "0",
      p1Payout: "0",
      p1Premium: "0",
      startedAtMs,
      creator: address,
      challenger: BOT_ADDRESS,
      stakeCoinType: "practice",
      cardOutcomes: outcomes.map((o) => {
        const card = session.cards[o.cardIdx]
        const my = playerSwipes[o.cardIdx]
        const bot = session.botSwipes[o.cardIdx]
        const myPnl =
          my === null || my === undefined
            ? null
            : o.upWon === my.isUp
              ? SWIPE_QUANTITY
              : -SWIPE_QUANTITY
        const botPnl = o.upWon === bot ? SWIPE_QUANTITY : -SWIPE_QUANTITY
        return {
          cardIdx: o.cardIdx,
          settlementPrice: o.settlementPrice,
          strike: card.strike,
          upWon: o.upWon,
          p0Pnl: myPnl === null ? null : myPnl.toString(),
          p1Pnl: botPnl.toString(),
          p0Swipe: my ? { isUp: my.isUp, quantity: q, orderId: "0" } : null,
          p1Swipe: { isUp: bot, quantity: q, orderId: "0" },
        }
      }),
      swipes: session.cards.map((_, i) => ({
        cardIdx: i,
        p0Swipe: playerSwipes[i]
          ? { isUp: playerSwipes[i]!.isUp, quantity: q, orderId: "0" }
          : null,
        p1Swipe: botRevealed[i]
          ? { isUp: session.botSwipes[i], quantity: q, orderId: "0" }
          : null,
      })),
    }
  }, [session, address, outcomes, playerSwipes, botRevealed, startedAtMs])

  // Ticks keyed by the synthetic market ids. Pre-lock, expiry is an "as if
  // you locked now" estimate (feeds the odds hint — the countdown line is
  // overridden via SwipeScreen's settleLabel); post-lock it's the real
  // settle time, so charts and countdowns converge on truth.
  //
  // Deviation from brief: the brief's literal `Date.now()` call here trips
  // react-hooks/purity ("impure function during render") under this repo's
  // v7 react-hooks ruleset. `lastTick.receivedAtMs` — already a `Date.now()`
  // snapshot taken in the WS message handler, i.e. outside render — is an
  // equally good "now" for this pre-lock estimate (spot ticks land roughly
  // every second, so it's never more than a tick-period stale) and is
  // already a memo dependency, so swapping it in makes the memo pure with
  // no behavioral change.
  const ticks = useMemo(() => {
    if (!session || !lastTick) return {}
    const lockupStartMs = phase.kind === "LOCKUP" ? phase.lockupStartMs : null
    const out: Record<string, { spot: string; expiry: string }> = {}
    session.cards.forEach((c, i) => {
      const expiryMs =
        (lockupStartMs ?? lastTick.receivedAtMs) + c.expiryOffsetMs
      out[`practice-${i}`] = { spot: lastTick.spot, expiry: String(expiryMs) }
    })
    return out
  }, [session, lastTick, phase])

  // Final score: PnL decides the win (mirrors on-chain finalize semantics);
  // points teach the README scoring rule (1/p × speed multiplier).
  const result: PracticeResult | null = useMemo(() => {
    if (phase.kind !== "RESULT" || !session || !roomState) return null
    let yourPnl = 0n
    let botPnl = 0n
    let yourPoints = 0
    let botPoints = 0
    for (const o of roomState.cardOutcomes) {
      if (o.p0Pnl !== null) yourPnl += BigInt(o.p0Pnl)
      if (o.p1Pnl !== null) botPnl += BigInt(o.p1Pnl)
      const my = playerSwipes[o.cardIdx]
      if (my && o.upWon === my.isUp) {
        const speed =
          1 + 0.5 * Math.max(0, 1 - my.timeOnCardMs / SPEED_BONUS_WINDOW_MS)
        yourPoints += (1 / my.pSwiped) * speed
      }
      const bot = session.botSwipes[o.cardIdx]
      if (o.upWon === bot) {
        const card = session.cards[o.cardIdx]
        const pBot = bot ? card.pUp : 1 - card.pUp
        botPoints += (1 / pBot) * BOT_SPEED_MULT
      }
    }
    return {
      yourPnl,
      botPnl,
      yourPoints,
      botPoints,
      youWon: yourPnl > botPnl,
      tied: yourPnl === botPnl,
    }
  }, [phase, session, roomState, playerSwipes])

  return {
    phase,
    cards: session?.cards ?? [],
    roomState,
    ticks,
    botRevealed,
    result,
    start,
    swipe,
    reset,
  }
}
