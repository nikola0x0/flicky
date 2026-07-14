/**
 * Bun.serve WebSocket lifecycle handlers. The actual matchmaking and
 * room broadcast state lives in `./matchmaking.ts` so this file stays
 * focused on parsing messages and dispatching.
 */
import type { WebSocketHandler } from "bun"
import { getSuiClient } from "../lib/sui"
import { makeLogger, shortId } from "../log"
import { checkQueueBalanceGate, requiredQueueBalance } from "../predict"
import { findDeckMarkets } from "../deckmaster"
import { consume } from "../ratelimit"
import { handleChatReact, handleChatSend, sendChatHistory } from "./chat"
import {
  onSocketCloseOracleStream,
  subscribeOracles,
  subscribeSpot,
  unsubscribeOracles,
  unsubscribeSpot,
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
    const raw =
      typeof message === "string" ? message : message.toString("utf-8")
    const msg = parseClientMsg(raw)
    if (!msg) {
      send(ws, {
        type: "error",
        code: "bad_message",
        message: "invalid JSON or missing `type`",
      })
      return
    }
    switch (msg.type) {
      case "hello": {
        if (typeof msg.address !== "string" || !msg.address.startsWith("0x")) {
          send(ws, {
            type: "error",
            code: "bad_address",
            message: "address must be a 0x… string",
          })
          return
        }
        registerAddress(ws, msg.address)
        await sendChatHistory(ws)
        log.info(`hello ${shortId(msg.address)}`)
        return
      }
      case "queue_join": {
        if (!isValidTier(msg.tier)) {
          send(ws, {
            type: "error",
            code: "bad_tier",
            message: `unknown tier: ${msg.tier}`,
          })
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
        // PRD §Matchmaking: funding-account (6-24 AccountWrapper) balance
        // must cover the tier stake plus the worst-case 5-card premium
        // budget before queueing — see `requiredQueueBalance`. Check via
        // devInspect (no signing, no gas).
        const required = requiredQueueBalance(msg.tier)
        const gate = await checkQueueBalanceGate(
          getSuiClient(),
          ws.data.address,
          required
        )
        if (!gate.ok) {
          if (gate.reason === "no_manager") {
            send(ws, {
              type: "error",
              code: "no_wrapper",
              message:
                "no funding account found for this address — sign in completes the bootstrap on first run",
            })
          } else if (gate.reason === "insufficient_balance") {
            send(ws, {
              type: "error",
              code: "insufficient_balance",
              message: `account balance < ${required} (need stake + ~15 dUSDC premium budget) — deposit before queueing`,
              detail: {
                need: required.toString(),
                have: gate.balance.toString(),
              },
            })
          } else {
            send(ws, {
              type: "error",
              code: "balance_check_failed",
              message: "could not verify account balance; retry shortly",
            })
          }
          return
        }
        // Pre-flight the BTC market pool so players get a clear "try
        // again in a few" instead of silently entering a queue that's
        // going to fail at deck-gen. Deck-gen distributes multiple cards
        // per market (round-robin + strike dedup — see buildDeck in
        // deckmaster.ts) and, at match time, the mint probe
        // (filterMintableMarkets) further narrows to currently-backed
        // markets. A near-ATM deck from a single market is fine, so this
        // gate only needs ONE headroom-eligible market; the real backing
        // check happens at deck-gen. Fetch up to 5 for a fuller spread.
        try {
          // Absorb a momentary market dip the way match-time deck-gen does:
          // retry a few times before rejecting, so a 1-2s flicker in the thin
          // 30min-3h band doesn't bounce the player out of the queue. (This is
          // the loose headroom-only check; deck-gen at match time still runs
          // its own stricter, mint-probed retry — see matchmaking.ts.)
          const MIN_DECK_MARKETS = 1
          const PREFLIGHT_ATTEMPTS = 3
          const PREFLIGHT_RETRY_MS = 1_500
          let available = 0
          for (let attempt = 1; attempt <= PREFLIGHT_ATTEMPTS; attempt++) {
            available = (await findDeckMarkets(5)).length
            if (available >= MIN_DECK_MARKETS) break
            if (attempt < PREFLIGHT_ATTEMPTS) {
              await new Promise((r) => setTimeout(r, PREFLIGHT_RETRY_MS))
            }
          }
          if (available < MIN_DECK_MARKETS) {
            send(ws, {
              type: "error",
              code: "oracles_unavailable",
              message: `No BTC markets live right now — try again in a couple of minutes.`,
              detail: { available, required: MIN_DECK_MARKETS },
            })
            return
          }
        } catch (e) {
          log.warn(
            `oracle preflight failed: ${e instanceof Error ? e.message : String(e)}`
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
          send(ws, {
            type: "error",
            code: "bad_duel_id",
            message: "duelId must be a 0x… string",
          })
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
        await handleChatSend(ws, msg.text)
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
        await handleChatReact(ws, msg.duelId, msg.emoji)
        return
      }
      case "oracle_subscribe": {
        subscribeOracles(ws, msg.marketIds)
        return
      }
      case "oracle_unsubscribe": {
        unsubscribeOracles(ws, msg.marketIds)
        return
      }
      case "spot_subscribe": {
        const rl = consume("ws:spot_subscribe", ws.data.address ?? "anon")
        if (!rl.ok) {
          send(ws, {
            type: "error",
            code: "rate_limited",
            message: `slow down; retry in ${rl.retryMs}ms`,
            detail: { retryMs: rl.retryMs },
          })
          return
        }
        subscribeSpot(ws)
        return
      }
      case "spot_unsubscribe": {
        unsubscribeSpot(ws)
        return
      }
      case "ping": {
        send(ws, { type: "pong" })
        return
      }
      default: {
        send(ws, {
          type: "error",
          code: "unknown_type",
          message: `unknown message type`,
        })
      }
    }
  },

  close(ws) {
    onSocketCloseOracleStream(ws)
    onSocketClose(ws)
  },
}
