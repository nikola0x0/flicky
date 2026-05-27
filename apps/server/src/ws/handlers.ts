/**
 * Bun.serve WebSocket lifecycle handlers. The actual matchmaking and
 * room broadcast state lives in `./matchmaking.ts` so this file stays
 * focused on parsing messages and dispatching.
 */
import type { WebSocketHandler } from "bun"
import { getSuiClient } from "../lib/sui"
import { makeLogger, shortId } from "../log"
import { checkQueueBalanceGate, MIN_BALANCE_FOR_QUEUE } from "../predict"
import { findDeckOracles } from "../deckmaster"
import { consume } from "../ratelimit"
import { handleChatReact, handleChatSend, sendChatHistory } from "./chat"
import {
  onSocketCloseOracleStream,
  subscribeOracles,
  unsubscribeOracles,
} from "./oracle-stream"
import { handlePracticeStart } from "./practice"
import { isValidTier, parseClientMsg, type ServerMsg } from "./protocol"
import {
  joinQueue,
  leaveQueue,
  newSocketState,
  onSocketClose,
  registerAddress,
  type SocketState,
  subscribeRoom,
  unsubscribeRoom,
} from "./matchmaking"

const log = makeLogger("ws")

function send(ws: { send: (s: string) => number }, msg: ServerMsg): void {
  ws.send(JSON.stringify(msg))
}

export const websocketHandler: WebSocketHandler<SocketState> = {
  open(ws) {
    // Bun lets us seed per-socket state via `server.upgrade(req, { data: ... })`.
    // If the upgrade didn't seed it, do so here lazily.
    if (!ws.data || typeof ws.data !== "object") {
      ws.data = newSocketState()
    }
  },

  async message(ws, message) {
    const raw = typeof message === "string" ? message : message.toString("utf-8")
    const msg = parseClientMsg(raw)
    if (!msg) {
      send(ws, { type: "error", code: "bad_message", message: "invalid JSON or missing `type`" })
      return
    }
    switch (msg.type) {
      case "hello": {
        if (typeof msg.address !== "string" || !msg.address.startsWith("0x")) {
          send(ws, { type: "error", code: "bad_address", message: "address must be a 0x… string" })
          return
        }
        registerAddress(ws, msg.address)
        sendChatHistory(ws)
        log.info(`hello ${shortId(msg.address)}`)
        return
      }
      case "queue_join": {
        if (!isValidTier(msg.tier)) {
          send(ws, { type: "error", code: "bad_tier", message: `unknown tier: ${msg.tier}` })
          return
        }
        const rlKey = ws.data.address ?? "anon"
        const rl = consume("ws:queue_join", rlKey)
        if (!rl.ok) {
          send(ws, {
            type: "error",
            code: "rate_limited",
            message: `slow down; retry in ${rl.retryMs}ms`,
            detail: { retryMs: rl.retryMs },
          })
          return
        }
        if (msg.tier === "practice") {
          // joinQueue itself rejects practice; let it emit the canonical error.
          await joinQueue(ws, msg.tier)
          return
        }
        if (!ws.data.address) {
          send(ws, {
            type: "error",
            code: "no_address",
            message: "send `hello` with your address first",
          })
          return
        }
        // PRD §Matchmaking: PredictManager balance ≥ 5 dUSDC is required
        // before queueing. Check via devInspect (no signing, no gas).
        const gate = await checkQueueBalanceGate(getSuiClient(), ws.data.address)
        if (!gate.ok) {
          if (gate.reason === "no_manager") {
            send(ws, {
              type: "error",
              code: "no_predict_manager",
              message:
                "no PredictManager found for this address — sign in completes the bootstrap on first run",
            })
          } else if (gate.reason === "insufficient_balance") {
            send(ws, {
              type: "error",
              code: "insufficient_balance",
              message: `PredictManager balance < ${MIN_BALANCE_FOR_QUEUE} (5 dUSDC) — deposit before queueing`,
              detail: { need: MIN_BALANCE_FOR_QUEUE.toString(), have: gate.balance.toString() },
            })
          } else {
            send(ws, {
              type: "error",
              code: "balance_check_failed",
              message: "could not verify PredictManager balance; retry shortly",
            })
          }
          return
        }
        // Pre-flight the BTC oracle pool so players get a clear "try
        // again in a few" instead of silently entering a queue that's
        // going to fail at deck-gen. Upstream Predict creates oracles
        // on a 15-min cron with occasional skipped ticks — when the
        // cron drops we sit at 4/5 eligible oracles until the next
        // beat. Letting the match form anyway leads to a retry loop
        // that the player sees as a permanent "searching".
        try {
          const oracles = await findDeckOracles(getSuiClient(), "BTC", 5)
          if (oracles.length < 5) {
            send(ws, {
              type: "error",
              code: "oracles_unavailable",
              message: `Only ${oracles.length}/5 BTC oracles are live right now. The upstream cron should produce another in a few minutes — try again then.`,
              detail: { available: oracles.length, required: 5 },
            })
            return
          }
        } catch (e) {
          log.warn(
            `oracle preflight failed: ${e instanceof Error ? e.message : String(e)}`,
          )
          send(ws, {
            type: "error",
            code: "oracles_unavailable",
            message: "couldn't check oracle availability; try again shortly",
          })
          return
        }
        await joinQueue(ws, msg.tier)
        return
      }
      case "queue_leave": {
        leaveQueue(ws)
        return
      }
      case "practice_start": {
        const rlKey = ws.data.address ?? "anon"
        const rl = consume("ws:practice_start", rlKey)
        if (!rl.ok) {
          send(ws, {
            type: "error",
            code: "rate_limited",
            message: `slow down; retry in ${rl.retryMs}ms`,
            detail: { retryMs: rl.retryMs },
          })
          return
        }
        await handlePracticeStart(ws)
        return
      }
      case "room_subscribe": {
        if (typeof msg.duelId !== "string" || !msg.duelId.startsWith("0x")) {
          send(ws, { type: "error", code: "bad_duel_id", message: "duelId must be a 0x… string" })
          return
        }
        subscribeRoom(ws, msg.duelId)
        return
      }
      case "room_unsubscribe": {
        if (typeof msg.duelId !== "string") return
        unsubscribeRoom(ws, msg.duelId)
        return
      }
      case "chat_send": {
        const rl = consume("ws:chat_send", ws.data.address ?? "anon")
        if (!rl.ok) {
          send(ws, {
            type: "error",
            code: "rate_limited",
            message: `slow down; retry in ${rl.retryMs}ms`,
            detail: { retryMs: rl.retryMs },
          })
          return
        }
        handleChatSend(ws, msg.text)
        return
      }
      case "chat_react": {
        const rl = consume("ws:chat_react", ws.data.address ?? "anon")
        if (!rl.ok) {
          send(ws, {
            type: "error",
            code: "rate_limited",
            message: `slow down; retry in ${rl.retryMs}ms`,
            detail: { retryMs: rl.retryMs },
          })
          return
        }
        handleChatReact(ws, msg.duelId, msg.emoji)
        return
      }
      case "oracle_subscribe": {
        subscribeOracles(ws, msg.oracleIds)
        return
      }
      case "oracle_unsubscribe": {
        unsubscribeOracles(ws, msg.oracleIds)
        return
      }
      case "ping": {
        send(ws, { type: "pong" })
        return
      }
      default: {
        send(ws, { type: "error", code: "unknown_type", message: `unknown message type` })
      }
    }
  },

  close(ws) {
    onSocketCloseOracleStream(ws)
    onSocketClose(ws)
  },
}
