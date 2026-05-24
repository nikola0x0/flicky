/**
 * Practice Mode handler — solo vs. bot, no chain commit, no queue.
 *
 * PRD §Game modes: "Practice is a single-player on-ramp — it shares the
 * swipe UI but does not enter matchmaking or touch the chain."
 *
 * Server returns:
 *   - 5 cards picked via the same `findDeckOracles` logic as a real
 *     duel, so difficulty feels realistic
 *   - 5 pre-decided bot swipes (random 50/50), so the client can replay
 *     the "match" frame-by-frame however it wants
 *
 * Once the deck is sent, the client owns the rest: render the cards,
 * compare player swipes against bot swipes, score against the eventual
 * oracle settlement (which it reads directly from chain — no server
 * call needed because there's no on-chain duel object to mirror).
 */
import type { ServerWebSocket } from "bun"
import { buildDeckFromOracles, deriveSeed, findDeckOracles, hashToHex } from "../deckmaster"
import { getSuiClient } from "../lib/sui"
import { makeLogger, shortId } from "../log"
import type { SocketState } from "./matchmaking"
import { _sendInternal } from "./matchmaking"

const log = makeLogger("practice")

export async function handlePracticeStart(
  ws: ServerWebSocket<SocketState>,
): Promise<void> {
  if (!ws.data.address) {
    _sendInternal(ws, {
      type: "error",
      code: "no_address",
      message: "send `hello` with your address first",
    })
    return
  }
  const client = getSuiClient()
  try {
    const oracles = await findDeckOracles(client, "BTC", 5)
    if (oracles.length < 5) {
      _sendInternal(ws, {
        type: "error",
        code: "no_oracles",
        message: `only ${oracles.length} eligible oracle(s) >10 min out — retry in a few minutes`,
      })
      return
    }
    const nonceHex = hashToHex(crypto.getRandomValues(new Uint8Array(16)))
    const seed = deriveSeed({
      sender: ws.data.address,
      asset: "BTC",
      timestampMs: Date.now(),
      nonceHex,
    })
    const deck = buildDeckFromOracles(oracles, seed)
    const botSwipes = Array.from({ length: 5 }, () => Math.random() > 0.5)
    log.info(`practice for ${shortId(ws.data.address)} — deck ${shortId(deck.hashHex)}`)
    _sendInternal(ws, {
      type: "practice_session",
      cards: deck.cards.map((c, i) => ({
        oracle_id: c.oracle_id,
        strike: c.strike.toString(),
        expiry: oracles[i].expiry.toString(),
      })),
      botSwipes,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log.warn(`practice failed for ${shortId(ws.data.address)}: ${msg}`)
    _sendInternal(ws, {
      type: "error",
      code: "practice_failed",
      message: msg,
    })
  }
}
