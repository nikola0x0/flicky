/**
 * Global chat room — one shared channel across all connected sockets.
 *
 *   client → `chat_send { text }`            (256 char max, rate-limited)
 *   server → `chat_message { from, text, … }` broadcast to everyone
 *   server → `chat_history { messages[] }`   sent on `hello` so a fresh
 *                                            tab sees the recent chat
 *
 * Persistence: SQLite `chat_message` table — survives restart. A
 * background sweep prunes everything but the newest `CHAT_RETAIN_COUNT`
 * rows so the table doesn't grow without bound.
 *
 * Emoji reactions (PRD §Match anatomy "emoji reacts") share the same
 * file because they're a near-clone of chat scoped to a room instead of
 * global. They're not persisted — reactions are ephemeral.
 */
import type { ServerWebSocket } from "bun"
import { insertChatMessage, recentChatMessages, pruneChatMessages } from "../db"
import { env } from "../env"
import { makeLogger, shortId } from "../log"
import { broadcastAll, broadcastRoom, _sendInternal, type SocketState } from "./matchmaking"

const log = makeLogger("chat")

const MAX_TEXT_LEN = 256
const MAX_EMOJI_LEN = 16 // covers multi-codepoint emoji like 👨‍👩‍👧‍👦

type AnyWs = ServerWebSocket<SocketState>

// ─── Chat (global) ──────────────────────────────────────────────────────────

export function handleChatSend(ws: AnyWs, text: unknown): void {
  if (!ws.data.address) {
    _sendInternal(ws, {
      type: "error",
      code: "no_address",
      message: "send `hello` with your address first",
    })
    return
  }
  if (typeof text !== "string" || text.length === 0) {
    _sendInternal(ws, {
      type: "error",
      code: "bad_chat_text",
      message: "text must be a non-empty string",
    })
    return
  }
  const trimmed = text.trim().slice(0, MAX_TEXT_LEN)
  if (trimmed.length === 0) return

  try {
    const row = insertChatMessage(ws.data.address, trimmed)
    broadcastAll({
      type: "chat_message",
      id: row.id,
      from: row.fromAddress,
      text: row.text,
      timestampMs: row.timestampMs,
    })
    log.info(`${shortId(row.fromAddress)}: ${trimmed.slice(0, 60)}`)
  } catch (e) {
    log.warn(`chat_send failed: ${e instanceof Error ? e.message : String(e)}`)
    _sendInternal(ws, {
      type: "error",
      code: "chat_failed",
      message: "could not store message",
    })
  }
}

export function sendChatHistory(ws: AnyWs): void {
  try {
    const rows = recentChatMessages(env.chatHistoryLimit)
    _sendInternal(ws, {
      type: "chat_history",
      messages: rows.map((r) => ({
        id: r.id,
        from: r.fromAddress,
        text: r.text,
        timestampMs: r.timestampMs,
      })),
    })
  } catch (e) {
    log.warn(`history failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** Periodic prune — keeps the table from growing forever. */
export function startChatPruneLoop(): void {
  const tick = () => {
    try {
      const dropped = pruneChatMessages(env.chatRetainCount)
      if (dropped > 0) log.info(`pruned ${dropped} old messages`)
    } catch (e) {
      log.warn(`prune failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  // Stagger first run by 60s so boot doesn't immediately churn the DB.
  setTimeout(() => {
    tick()
    setInterval(tick, env.chatPruneIntervalMs).unref?.()
  }, 60_000).unref?.()
}

// ─── Emoji reactions (room-scoped) ──────────────────────────────────────────

export function handleChatReact(ws: AnyWs, duelId: unknown, emoji: unknown): void {
  if (!ws.data.address) {
    _sendInternal(ws, { type: "error", code: "no_address", message: "say hello first" })
    return
  }
  if (typeof duelId !== "string" || !duelId.startsWith("0x")) {
    _sendInternal(ws, { type: "error", code: "bad_duel_id", message: "duelId must be 0x…" })
    return
  }
  if (typeof emoji !== "string" || emoji.length === 0 || emoji.length > MAX_EMOJI_LEN) {
    _sendInternal(ws, {
      type: "error",
      code: "bad_emoji",
      message: `emoji must be 1..${MAX_EMOJI_LEN} chars`,
    })
    return
  }
  broadcastRoom(duelId, {
    type: "chat_reaction",
    duelId,
    from: ws.data.address,
    emoji,
    timestampMs: Date.now(),
  })
}
