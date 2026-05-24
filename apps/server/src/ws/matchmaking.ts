/**
 * In-memory matchmaking + duel-room state.
 *
 * Two concerns share this module because they fan-out from the same set
 * of WS connections:
 *
 *   - The queue. One FIFO bucket per tier. When two players sit in the
 *     same bucket they're popped as a (creator, challenger) pair and
 *     each receives a `match_found` so the frontend knows which side of
 *     `duel::create_duel` / `duel::join_duel` to run. Sync-only PvP:
 *     if no opponent shows up the player stays queued until they
 *     `queue_leave` or disconnect. Solo-vs-bot is handled by Practice
 *     Mode (see `./practice.ts`), not by queue fallback.
 *
 *   - The room subscriptions. Once a duel exists on-chain, clients
 *     `room_subscribe { duelId }` to receive state deltas fanned in by
 *     `indexer.ts`. We just remember `address ↔ socket ↔ duelId` so the
 *     indexer can lookup who to send each broadcast to.
 *
 * Everything is in-memory — a server restart wipes queue + room
 * subscriptions, but on-chain state is the source of truth so clients
 * just re-subscribe and pick the duel back up.
 */
import type { ServerWebSocket } from "bun"
import { getPlayerRating } from "../db"
import { env } from "../env"
import { makeLogger, shortId } from "../log"
import { findClosestOpponent } from "../mmr"
import type { ServerMsg, Tier } from "./protocol"
import { STAKE_TIERS } from "./protocol"

const log = makeLogger("match")

// ─── Socket state ───────────────────────────────────────────────────────────

export interface SocketState {
  address: string | null
  /** Tier the socket is currently queued under, if any. */
  queuedTier: Tier | null
  /** Wallclock ms when the socket joined the current queue. */
  queuedAt: number
  /** Duel IDs the socket is subscribed to (for room broadcasts). */
  subscribedDuels: Set<string>
  /** Oracle IDs the socket is subscribed to (for live tick streaming). */
  subscribedOracles: Set<string>
}

export function newSocketState(): SocketState {
  return {
    address: null,
    queuedTier: null,
    queuedAt: 0,
    subscribedDuels: new Set(),
    subscribedOracles: new Set(),
  }
}

// ─── Connection registry ────────────────────────────────────────────────────

type AnyWs = ServerWebSocket<SocketState>

/** Address → set of live sockets. A user can have multiple tabs open. */
const socketsByAddress = new Map<string, Set<AnyWs>>()
/** Tier → FIFO queue of (ws, queuedAt) pairs. */
const queues = new Map<Tier, AnyWs[]>()
/** Duel ID → set of sockets subscribed to that room. */
const roomSubscribers = new Map<string, Set<AnyWs>>()
/** `${duelId}|${address}` → forfeit-grace timer. */
const forfeitTimers = new Map<string, ReturnType<typeof setTimeout>>()
/**
 * Matched-but-not-yet-on-chain pairs. Set by `matchPair` immediately
 * after `match_found` fires; consumed by `indexer.ts::drainTracker` when
 * it sees the creator's `DuelCreated` event so it can push the new
 * duel id to the matched challenger's sockets without any client polling.
 */
const pendingPairs = new Map<string, string>() // creator_addr → challenger_addr

function send(ws: AnyWs, msg: ServerMsg): void {
  try {
    ws.send(JSON.stringify(msg))
  } catch (e) {
    log.warn(`send to ${shortId(ws.data.address ?? "?")} failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

// ─── Hello / auth ───────────────────────────────────────────────────────────

export function registerAddress(ws: AnyWs, address: string): void {
  // Bind connection to address. Replaces any previous binding on the
  // same socket (e.g. user logs out + back in in the same tab).
  unregisterAddress(ws)
  ws.data.address = address
  let bucket = socketsByAddress.get(address)
  if (!bucket) {
    bucket = new Set()
    socketsByAddress.set(address, bucket)
  }
  bucket.add(ws)
  send(ws, { type: "hello", address })
}

function unregisterAddress(ws: AnyWs): void {
  const addr = ws.data.address
  if (!addr) return
  const bucket = socketsByAddress.get(addr)
  if (bucket) {
    bucket.delete(ws)
    if (bucket.size === 0) socketsByAddress.delete(addr)
  }
  ws.data.address = null
}

// ─── Queue ──────────────────────────────────────────────────────────────────

export function joinQueue(ws: AnyWs, tier: Tier): void {
  if (!ws.data.address) {
    send(ws, { type: "error", code: "no_address", message: "send `hello` with your address first" })
    return
  }
  if (tier === "practice") {
    send(ws, {
      type: "error",
      code: "practice_no_queue",
      message: "use `practice_start` for solo-vs-bot practice; the queue is human-vs-human",
    })
    return
  }
  leaveQueue(ws) // idempotent
  ws.data.queuedTier = tier
  ws.data.queuedAt = Date.now()
  let q = queues.get(tier)
  if (!q) {
    q = []
    queues.set(tier, q)
  }

  // MMR-aware pair selection — find the closest-rated waiting opponent
  // within both parties' expanding windows. Falls back to "no match" if
  // no one in the bucket is close enough yet (the candidate keeps
  // waiting — their window will widen and a future joiner will pair).
  const myRating = ws.data.address
    ? getPlayerRating(ws.data.address).rating
    : env.mmrInitialRating
  const candidates = q
    .filter((w) => w.data.address && w.data.address !== ws.data.address)
    .map((w) => ({ ws: w, address: w.data.address!, queuedAtMs: w.data.queuedAt }))
  const pick = findClosestOpponent(
    myRating,
    ws.data.queuedAt,
    candidates.map((c) => ({ address: c.address, queuedAtMs: c.queuedAtMs })),
  )
  if (pick) {
    const opponent = candidates.find((c) => c.address === pick.address)?.ws
    if (opponent) {
      q.splice(q.indexOf(opponent), 1)
      matchPair(opponent, ws, tier)
      return
    }
  }

  q.push(ws)
  send(ws, { type: "queue_status", tier, size: q.length, waitMs: 0 })
}

export function leaveQueue(ws: AnyWs): void {
  const tier = ws.data.queuedTier
  if (!tier) return
  const q = queues.get(tier)
  if (q) {
    const idx = q.indexOf(ws)
    if (idx >= 0) q.splice(idx, 1)
  }
  ws.data.queuedTier = null
  ws.data.queuedAt = 0
  send(ws, { type: "queue_left" })
}

function matchPair(creator: AnyWs, challenger: AnyWs, tier: Tier): void {
  creator.data.queuedTier = null
  challenger.data.queuedTier = null
  const creatorAddr = creator.data.address
  const challengerAddr = challenger.data.address
  log.info(
    `match ${tier}: creator=${shortId(creatorAddr ?? "?")} vs challenger=${shortId(challengerAddr ?? "?")}`,
  )
  // Remember the pairing so the indexer can push `duel_assigned` to the
  // challenger the moment the creator's `DuelCreated` event surfaces.
  if (creatorAddr && challengerAddr) {
    pendingPairs.set(creatorAddr, challengerAddr)
  }
  send(creator, {
    type: "match_found",
    tier,
    role: "creator",
    opponent: challengerAddr ?? "",
  })
  send(challenger, {
    type: "match_found",
    tier,
    role: "challenger",
    opponent: creatorAddr ?? "",
  })
}

/**
 * Pop the challenger matched with `creatorAddr` (if any). Called by the
 * indexer when it sees a `DuelCreated` event for that creator — we then
 * push `duel_assigned` to the challenger's sockets. Returns null when no
 * pair is pending (server restart, queue cleared, etc.).
 */
export function takeMatchedPair(creatorAddr: string): string | null {
  const challenger = pendingPairs.get(creatorAddr)
  if (challenger) pendingPairs.delete(creatorAddr)
  return challenger ?? null
}

// ─── Rooms ──────────────────────────────────────────────────────────────────

export function subscribeRoom(ws: AnyWs, duelId: string): void {
  let bucket = roomSubscribers.get(duelId)
  if (!bucket) {
    bucket = new Set()
    roomSubscribers.set(duelId, bucket)
  }
  const wasEmpty = bucket.size === 0
  bucket.add(ws)
  ws.data.subscribedDuels.add(duelId)
  // If this address had left this room recently, cancel its forfeit
  // timer and signal to peers that they're back.
  const addr = ws.data.address
  if (addr) {
    const key = forfeitKey(duelId, addr)
    const t = forfeitTimers.get(key)
    if (t) {
      clearTimeout(t)
      forfeitTimers.delete(key)
      if (!wasEmpty) {
        broadcastRoom(duelId, { type: "peer_rejoined", duelId, address: addr })
      }
    }
  }
}

export function unsubscribeRoom(ws: AnyWs, duelId: string): void {
  const bucket = roomSubscribers.get(duelId)
  if (bucket) {
    bucket.delete(ws)
    if (bucket.size === 0) roomSubscribers.delete(duelId)
  }
  ws.data.subscribedDuels.delete(duelId)
}

/** Broadcast a server message to every socket subscribed to `duelId`. */
export function broadcastRoom(duelId: string, msg: ServerMsg): void {
  const bucket = roomSubscribers.get(duelId)
  if (!bucket) return
  const wire = JSON.stringify(msg)
  for (const ws of bucket) {
    try {
      ws.send(wire)
    } catch {
      // Sockets that have closed will be cleaned up by the close handler.
    }
  }
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

export function onSocketClose(ws: AnyWs): void {
  leaveQueue(ws)
  const addr = ws.data.address
  for (const duelId of ws.data.subscribedDuels) {
    const bucket = roomSubscribers.get(duelId)
    if (bucket) {
      bucket.delete(ws)
      if (bucket.size === 0) roomSubscribers.delete(duelId)
    }
    // If the address has no other live socket subscribed to this room,
    // start the forfeit grace timer + tell peers they left.
    if (addr && !addressStillInRoom(duelId, addr, ws)) {
      armForfeitTimer(duelId, addr)
    }
  }
  ws.data.subscribedDuels.clear()
  unregisterAddress(ws)
}

function addressStillInRoom(
  duelId: string,
  address: string,
  exclude: AnyWs,
): boolean {
  const bucket = roomSubscribers.get(duelId)
  if (!bucket) return false
  for (const w of bucket) {
    if (w !== exclude && w.data.address === address) return true
  }
  return false
}

function forfeitKey(duelId: string, address: string): string {
  return `${duelId}|${address}`
}

function armForfeitTimer(duelId: string, address: string): void {
  const key = forfeitKey(duelId, address)
  const existing = forfeitTimers.get(key)
  if (existing) clearTimeout(existing)
  broadcastRoom(duelId, {
    type: "peer_left",
    duelId,
    address,
    gracePeriodMs: env.peerForfeitGraceMs,
  })
  const timer = setTimeout(() => {
    forfeitTimers.delete(key)
    // Re-check: did the address come back via subscribeRoom (which would
    // have cancelled this timer)? If we're still here, no.
    broadcastRoom(duelId, { type: "peer_forfeit", duelId, address })
    log.info(`peer_forfeit ${shortId(duelId)} ${shortId(address)}`)
  }, env.peerForfeitGraceMs)
  forfeitTimers.set(key, timer)
}

// ─── Introspection (used by /health) ────────────────────────────────────────

export function queueStats(): Record<Tier, number> {
  const out = {} as Record<Tier, number>
  for (const tier of Object.keys(STAKE_TIERS) as Tier[]) {
    out[tier] = queues.get(tier)?.length ?? 0
  }
  return out
}

export function connectedAddressCount(): number {
  return socketsByAddress.size
}

export function roomCount(): number {
  return roomSubscribers.size
}

// Test-only — clears all module-level state between cases so tests run
// independently. Prefixed `__` to make it obvious this isn't for prod.
export function __resetForTests(): void {
  for (const t of forfeitTimers.values()) clearTimeout(t)
  forfeitTimers.clear()
  socketsByAddress.clear()
  queues.clear()
  roomSubscribers.clear()
  pendingPairs.clear()
}

/** Internal — exposed for the `practice_start` handler to send back the deck. */
export function _sendInternal(ws: AnyWs, msg: ServerMsg): void {
  send(ws, msg)
}

/** Broadcast a message to every connected socket (global chat). */
export function broadcastAll(msg: ServerMsg): void {
  const wire = JSON.stringify(msg)
  for (const bucket of socketsByAddress.values()) {
    for (const ws of bucket) {
      try {
        ws.send(wire)
      } catch {
        // close handler will reap dead sockets
      }
    }
  }
}

/** Snapshot of currently subscribed rooms — used by the match clock loop. */
export function subscribedRoomIds(): string[] {
  return Array.from(roomSubscribers.keys())
}

/** Live sockets bound to `address` (empty set if the user isn't connected). */
export function socketsForAddress(address: string): Set<AnyWs> {
  return socketsByAddress.get(address) ?? new Set()
}

/**
 * Send a message to every live socket of `addresses`. Used by per-duel
 * emoji reactions (filter to creator + challenger only per PRD §Social).
 */
export function sendToAddresses(addresses: string[], msg: ServerMsg): number {
  const wire = JSON.stringify(msg)
  let n = 0
  for (const addr of addresses) {
    const bucket = socketsByAddress.get(addr)
    if (!bucket) continue
    for (const ws of bucket) {
      try {
        ws.send(wire)
        n++
      } catch {
        // close handler reaps dead sockets
      }
    }
  }
  return n
}
