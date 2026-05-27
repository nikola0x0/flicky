import { useEffect, useRef, useState } from "react"
import { useCurrentAccount, useSuiClient } from "@mysten/dapp-kit"
import type { ClientMsg, ServerMsg } from "@/lib/protocol"
import { STAKE_TIERS, type Tier } from "@/lib/protocol"
import type { Unsubscribe } from "@/hooks/use-flicky-socket"
import {
  buildCreateDuelDusdcTx,
  buildJoinDuelDusdcTx,
} from "@/lib/flicky"
import { DEEPBOOK } from "@/lib/deepbook"
import { useFlickySign } from "@/lib/use-flicky-sign"

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
  managerId: _managerId, // used in Task 9 for the swipe loop
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
      {phase.kind === "SWIPING" && (
        <div className="rounded border border-white/10 bg-white/5 p-4 text-sm">
          Card {phase.cardIdx + 1} / 5 &mdash; swipe UI added in Task 9
        </div>
      )}
      {phase.kind === "AWAIT_SETTLEMENT" && (
        <div className="rounded border border-white/10 bg-white/5 p-4 text-sm">
          All swipes locked &mdash; awaiting settlement &mdash; UI added in Task 9
        </div>
      )}
      {phase.kind === "COMPLETE" && (
        <div className="rounded border border-white/10 bg-white/5 p-4 text-sm">
          Duel complete &mdash; results UI added in Task 9
        </div>
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
