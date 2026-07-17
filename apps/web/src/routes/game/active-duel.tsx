import { useEffect, useRef, useState } from "react"
import { Link } from "react-router"
import { useCurrentAccount, useCurrentClient } from "@mysten/dapp-kit-react"
import type { ClientMsg, ServerMsg } from "@/lib/protocol"
import { STAKE_TIERS, type Tier } from "@/lib/protocol"
import type { Unsubscribe } from "@/hooks/use-flicky-socket"
import {
  buildCreateDuelDusdcTx,
  buildJoinDuelDusdcTx,
  resolveCreatedDuelId,
} from "@/lib/flicky"
import {
  DEEPBOOK,
  buildStakedSwipeTx,
  fetchAccountState,
  fetchMarketTickSize,
  fmtDusdc,
} from "@/lib/deepbook"
import { useFlickySign } from "@/lib/use-flicky-sign"
import { fmtPnlPct } from "@/lib/pnl"
import { SWIPE_WINDOW_MS, swipeWindowRemainingMs } from "@/lib/swipe-window"
import { SWIPE_QUANTITY } from "@/lib/funding"
import { playSfx } from "@/lib/sound"
import { WsErrorBanner } from "@/components/ws-error-banner"
import {
  SwipeScreen,
  CardLedger,
  fmtCountdown,
} from "@/components/swipe-screen"
import { type RoomState } from "@/lib/room-state"

/**
 * Minimum AccountWrapper dUSDC balance to allow a swipe. Each swipe mints a
 * real position whose premium (`entry_probability × SWIPE_QUANTITY / leverage`
 * + fees) is withdrawn from the account; below this the mint aborts deep in
 * `account::withdraw_balance` with an opaque code. The favored side's win
 * probability is capped at ~0.65 (see deckmaster `ZONE_TARGET_PROB`), so its
 * premium ≲ 0.7 × quantity — gate on that plus a small headroom so we prompt a
 * top-up BEFORE the on-chain abort.
 */
const MIN_ACCOUNT_PER_SWIPE = (SWIPE_QUANTITY * 7n) / 10n

/**
 * How long the challenger waits for `duel_assigned` before giving up.
 *
 * It only arrives once the creator has signed `create_duel` AND the
 * indexer has seen the resulting event, so a creator who dismisses their
 * wallet popup used to leave the challenger on "Setting up the match…"
 * forever. The server tears the pairing down at 90s and sends
 * `match_abandoned`; this is the local backstop for when that message
 * can't reach us (socket dropped in the meantime), so it deliberately
 * sits past the server's own deadline.
 */
const CHALLENGER_ASSIGN_TIMEOUT_MS = 120_000

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
  const client = useCurrentClient()
  const sign = useFlickySign()
  const [phase, setPhase] = useState<Phase>(
    resumeDuelId
      ? { kind: "AWAIT_REVEAL", duelId: resumeDuelId }
      : { kind: "ENTRY", reason: "Setting up the match…" }
  )
  const [roomState, setRoomState] = useState<RoomState | null>(null)
  // serverNowMs - Date.now() from the latest match_tick. Corrects the local
  // clock so the swipe-window countdown tracks the chain-enforced deadline
  // even when the player's system clock is skewed. 0 until the first tick.
  const [serverClockOffsetMs, setServerClockOffsetMs] = useState(0)
  // Live market prices + expiry, keyed by expiry_market_id. The
  // `oracle_tick` WS message carries both — no separate on-chain/server
  // expiry lookup needed. Powers mark-to-market PnL + the settle countdown.
  const [ticks, setTicks] = useState<
    Record<string, { spot: string; expiry: string }>
  >({})
  // Market `tick_size`, keyed by expiry_market_id. Needed to build the
  // swipe PTB's (lower_tick, higher_tick] pair. Resolved once per unique
  // market (from the predict indexer, via `fetchMarketTickSize`) when the
  // deck arrives.
  const [tickSizes, setTickSizes] = useState<Record<string, bigint>>({})
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
        msg.cards.length === msg.cardCount
      ) {
        setPhase({
          kind: "SWIPING",
          duelId: phaseRef.current.duelId,
          cardIdx: nextCardIdx(msg as RoomState, account?.address),
        })
      }
      if (
        phaseRef.current.kind === "SWIPING" &&
        countMySwipes(msg as RoomState, account?.address) === msg.cardCount
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

  // Stream market ticks into local state. Used by mark-to-market PnL and
  // the per-card settle countdown (`expiry`).
  useEffect(() => {
    return onMessage((msg) => {
      if (msg.type !== "oracle_tick") return
      setTicks((prev) => ({
        ...prev,
        [msg.expiryMarketId]: { spot: msg.spot, expiry: msg.expiry },
      }))
    })
  }, [onMessage])

  // Track the server clock so the swipe-window countdown is drift-free.
  useEffect(() => {
    return onMessage((msg) => {
      if (msg.type !== "match_tick") return
      setServerClockOffsetMs(msg.serverNowMs - Date.now())
    })
  }, [onMessage])

  // When the deck arrives, prefetch each unique market's `tick_size`
  // (needed to build the swipe PTB — see `deriveTicks` in lib/deepbook.ts)
  // and subscribe to its live ticks. Expiry is NOT fetched here — it rides
  // in on the `oracle_tick` WS message itself (see `ticks` above), so the
  // client never discovers markets on its own.
  const oraclesReady =
    roomState && roomState.cards.length === roomState.cardCount
      ? roomState.cards
      : null
  useEffect(() => {
    if (!oraclesReady) return
    let cancelled = false
    const unique = Array.from(
      new Set(oraclesReady.map((c) => c.expiry_market_id))
    )
    ;(async () => {
      const next: Record<string, bigint> = {}
      for (const id of unique) {
        try {
          next[id] = await fetchMarketTickSize(id)
        } catch (e) {
          console.warn(`fetchMarketTickSize(${id}) failed`, e)
        }
      }
      if (cancelled) return
      setTickSizes((prev) => ({ ...prev, ...next }))
      send({ type: "oracle_subscribe", marketIds: unique })
    })()
    return () => {
      cancelled = true
      send({ type: "oracle_unsubscribe", marketIds: unique })
    }
  }, [oraclesReady, send])

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
            `deck hash must be 32 bytes, got ${deckHashBytes.length}`
          )
        }
        const tx = await buildCreateDuelDusdcTx(
          client,
          account.address,
          deckHashBytes,
          STAKE_TIERS[tier],
          DEEPBOOK.dusdcType
        )
        const res = await sign.mutateAsync({ transaction: tx })
        // Sponsored-gas path returns only `{ digest }` — objectChanges
        // isn't included. Wait for the tx to be indexed, then re-fetch
        // it to read the created Duel id.
        const duelId = await resolveCreatedDuelId(client, res.digest)
        if (!duelId) {
          throw new Error(
            "create_duel landed but Duel id not yet indexed — try again"
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
          DEEPBOOK.dusdcType
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

  // Challenger backstop: surface a dead pairing instead of sitting on
  // "Setting up the match…" indefinitely. Only fires while still in ENTRY
  // — once `duel_assigned` lands, `sentJoinRef` is set and the phase has
  // moved on.
  useEffect(() => {
    if (role !== "challenger") return
    const id = setTimeout(() => {
      if (sentJoinRef.current) return
      setPhase((p) =>
        p.kind === "ENTRY"
          ? {
              kind: "ERROR",
              message:
                "the other player never confirmed the match — exit and queue again.",
            }
          : p
      )
    }, CHALLENGER_ASSIGN_TIMEOUT_MS)
    return () => clearTimeout(id)
  }, [role])

  // 1 Hz wall-clock driving the match-wide swipe-window countdown.
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  // Match-wide swipe window (10 min, chain-enforced). Meaningful only once the
  // duel is live (startedAtMs is set on join). `windowFrac` drives the smooth
  // depletion bar; `isWindowExpired` locks the deck so the player never fires a
  // swipe that aborts on-chain.
  const windowRemainingMs =
    roomState && roomState.startedAtMs > 0
      ? swipeWindowRemainingMs({
          startedAtMs: roomState.startedAtMs,
          serverClockOffsetMs,
          nowMs,
        })
      : null
  const isWindowExpired = windowRemainingMs !== null && windowRemainingMs <= 0
  const isWindowUrgent =
    windowRemainingMs !== null &&
    windowRemainingMs > 0 &&
    windowRemainingMs <= 60_000
  const windowFrac =
    windowRemainingMs === null
      ? 0
      : Math.max(0, Math.min(1, windowRemainingMs / SWIPE_WINDOW_MS))

  // PvP swipe: pre-flight the account balance, build + sign the staked-swipe
  // PTB, translate opaque on-chain aborts, then advance the deck. Drag/busy/
  // error presentation lives in SwipeScreen; throwing here resets the card.
  const pvpSwipe = async (isUp: boolean) => {
    if (phase.kind !== "SWIPING" || !roomState || !account) return
    const { duelId, cardIdx } = phase
    const card = roomState.cards[cardIdx]
    const tickSize = card ? tickSizes[card.expiry_market_id] : undefined
    if (!card || !tickSize) {
      throw new Error("market tick size not loaded yet — try again in a moment")
    }
    try {
      // Pre-flight the account balance: each swipe's mint premium is
      // withdrawn from the AccountWrapper, and if it can't cover it the tx
      // aborts on-chain with an opaque `account::withdraw_balance` code.
      // Catch it here and prompt a top-up instead of burning a sponsored tx.
      const { balance } = await fetchAccountState(account.address)
      if (balance < MIN_ACCOUNT_PER_SWIPE) {
        throw new Error(
          `Account balance low (${fmtDusdc(balance)}). Each swipe needs about ${fmtDusdc(
            MIN_ACCOUNT_PER_SWIPE
          )} of dUSDC in your account for the mint premium — top up your account, then swipe again.`
        )
      }
      const tx = buildStakedSwipeTx({
        duelId,
        wrapperId: managerId,
        marketId: card.expiry_market_id,
        strike: BigInt(card.strike),
        tickSize,
        cardIdx,
        isUp,
        quantity: SWIPE_QUANTITY,
        stakeCoinType: roomState.stakeCoinType,
      })
      await sign.mutateAsync({ transaction: tx })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const insufficient =
        /withdraw_balance|EInsufficient|abort code: 1\b/.test(msg)
      const longShotUnavailable =
        /assert_mint_admission|ENetPremiumBelowMinimum|abort code: 4\b/.test(
          msg
        )
      throw new Error(
        insufficient
          ? "Your account ran out of dUSDC for this swipe's mint premium — top up your account and swipe again."
          : longShotUnavailable
            ? "That long-shot side is too unlikely to place on this market — swipe the other way (the favored call)."
            : msg
      )
    }
    setPhase((p) =>
      p.kind === "SWIPING"
        ? { kind: "SWIPING", duelId: p.duelId, cardIdx: p.cardIdx + 1 }
        : p
    )
  }

  return (
    <div className="flex h-full flex-col gap-4 px-4 py-4 text-white">
      <WsErrorBanner onMessage={onMessage} />
      <div className="flex items-center justify-between">
        <h2 className="text-3xl tracking-[0.2em] uppercase">Active Match</h2>
        <button
          type="button"
          onClick={onExit}
          className="rounded border border-white/25 bg-black/40 px-3 py-1 text-lg backdrop-blur-md hover:bg-black/55"
        >
          Exit
        </button>
      </div>
      {phase.kind === "SWIPING" && windowRemainingMs !== null ? (
        <SwipeWindowBar
          remainingMs={windowRemainingMs}
          frac={windowFrac}
          urgent={isWindowUrgent}
          expired={isWindowExpired}
        />
      ) : (
        <div className="text-base tracking-wider text-white/55 uppercase">
          {tier
            ? `stake ${Number(STAKE_TIERS[tier]) / 1e6} dUSDC`
            : "staked duel"}
        </div>
      )}

      {phase.kind === "ENTRY" && <PhaseEntry reason={phase.reason} />}
      {phase.kind === "AWAIT_REVEAL" && (
        <PhaseAwaitReveal duelId={phase.duelId} roomState={roomState} />
      )}
      {phase.kind === "SWIPING" && roomState && account && (
        <SwipeScreen
          roomState={roomState}
          cardIdx={phase.cardIdx}
          ticks={ticks}
          myAddress={account.address}
          disabled={isWindowExpired}
          onSwipe={pvpSwipe}
          deckExhausted={<SettlingHandoff duelId={phase.duelId} />}
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

/** Full-width swipe-window countdown. Smooth depletion bar (creeps down every
 *  1 Hz tick) + mono mm:ss, ramping amber → red with a pulse in the final 60s.
 *  Match-wide and time-based — it tracks the chain-enforced 10-min window, not
 *  per-swipe progress. */
function SwipeWindowBar({
  remainingMs,
  frac,
  urgent,
  expired,
}: {
  remainingMs: number
  frac: number
  urgent: boolean
  expired: boolean
}) {
  const danger = expired || urgent
  return (
    <div
      className={`flex items-center gap-2.5 border-2 px-3 py-1.5 shadow-[inset_0_2px_0_rgba(255,255,255,0.06),inset_0_-2px_0_rgba(0,0,0,0.5)] ${
        danger
          ? "border-rose-500/70 bg-[#3a1717]"
          : "border-black/60 bg-[#0a0f1f]"
      } ${urgent ? "countdown-urgent" : ""}`}
    >
      <img
        src="/icons/clock.png"
        alt=""
        aria-hidden
        className="size-4 shrink-0 [image-rendering:pixelated]"
      />
      <span
        className={`shrink-0 font-pixel text-base tracking-[0.2em] uppercase tabular-nums ${
          danger ? "text-rose-300" : "text-amber-300"
        }`}
      >
        {expired ? "time's up" : fmtCountdown(remainingMs)}
      </span>
      <div className="relative h-2.5 flex-1 border border-black/70 bg-black/40">
        <div
          className={`h-full ${danger ? "bg-rose-400" : "bg-amber-400"}`}
          style={{ width: `${frac * 100}%`, transition: "width 1s linear" }}
        />
      </div>
    </div>
  )
}

function PhaseEntry({ reason }: { reason: string }) {
  return (
    <div className="rounded-lg border-2 border-black/45 bg-black/45 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.06),inset_0_-2px_0_rgba(0,0,0,0.35)] backdrop-blur-md">
      <p className="text-base text-white/80">{reason}</p>
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
    <div className="rounded-lg border-2 border-black/45 bg-black/45 p-4 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.06),inset_0_-2px_0_rgba(0,0,0,0.35)] backdrop-blur-md">
      <p className="text-base text-white/80">Shuffling the deck&hellip;</p>
      <p className="mt-2 text-sm text-white/55">{ready} / 5 cards ready</p>
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
      <img
        src="/assets/duel/locked-in.png"
        alt=""
        aria-hidden
        draggable={false}
        className="size-56 drop-shadow-[0_0_22px_rgba(74,255,154,0.4)] select-none [-webkit-user-drag:none] [image-rendering:pixelated]"
      />
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
          onClick={() => playSfx("click")}
          className="pixel-tile no-hover bg-emerald-600 px-4 py-3 font-pixel text-sm uppercase"
        >
          watch result
        </Link>
        <Link
          to="/game/home"
          onClick={() => playSfx("click")}
          className="pixel-tile no-hover bg-[#1b2548] px-4 py-3 font-pixel text-sm uppercase"
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
  const myPremium = BigInt(myIsP0 ? roomState.p0Premium : roomState.p1Premium)
  const oppPremium = BigInt(myIsP0 ? roomState.p1Premium : roomState.p0Premium)
  const myNet =
    BigInt(myIsP0 ? roomState.p0Payout : roomState.p1Payout) - myPremium
  const oppNet =
    BigInt(myIsP0 ? roomState.p1Payout : roomState.p0Payout) - oppPremium
  const tied = myNet === oppNet
  const youWon = myNet > oppNet
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded border-2 border-black/55 bg-[#1b2548] p-4 text-center">
        <h3 className="text-2xl tracking-[0.2em] uppercase">
          {tied ? "Tie" : youWon ? "Victory" : "Defeat"}
        </h3>
        <p className="mt-2 text-base text-white/70">
          you {fmtPnlPct(myNet, myPremium)} &middot; opponent{" "}
          {fmtPnlPct(oppNet, oppPremium)}
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
  return Math.min(n, rs.cardCount)
}

function countMySwipes(rs: RoomState, myAddress: string | undefined): number {
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
