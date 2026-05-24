/**
 * Server-authoritative match clock — PRD §Backend: "match timing is
 * authoritative from the server, not the client."
 *
 * Every `MATCH_TICK_INTERVAL_MS` we walk the currently-subscribed rooms,
 * look up the mirrored duel state, and push a `match_tick` to each room
 * carrying `serverNowMs` + duel status. Clients use `serverNowMs` to
 * sync their countdown against drift, and the status flag to know which
 * phase the UI should render (swipe vs lockup vs done).
 *
 * Per-card oracle expiries are NOT pushed here — they're available from
 * the duel object the client already has, and pushing them every tick
 * would bloat the wire. If we ever want per-card countdowns server-side,
 * add an `earliestExpiryMs` field once the indexer mirror stores cards.
 */
import { getDuel } from "../db"
import { env } from "../env"
import { makeLogger } from "../log"
import { broadcastRoom, subscribedRoomIds } from "./matchmaking"

const log = makeLogger("match-clock")

let _interval: ReturnType<typeof setInterval> | null = null

export function startMatchClock(): void {
  if (_interval) return
  log.info(`tick every ${env.matchTickIntervalMs}ms`)
  _interval = setInterval(tick, env.matchTickIntervalMs)
}

export function stopMatchClock(): void {
  if (_interval) {
    clearInterval(_interval)
    _interval = null
  }
}

function tick(): void {
  const rooms = subscribedRoomIds()
  if (rooms.length === 0) return
  const now = Date.now()
  for (const duelId of rooms) {
    let status: "PENDING" | "ACTIVE" | "COMPLETE" = "PENDING"
    try {
      const d = getDuel(duelId)
      if (d) status = d.status
    } catch {
      // db error already logged inside db.ts; keep ticking
    }
    if (status === "COMPLETE") continue // no need to push clock after settle
    broadcastRoom(duelId, {
      type: "match_tick",
      duelId,
      serverNowMs: now,
      status,
    })
  }
}
