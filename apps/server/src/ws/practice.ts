/**
 * Practice Mode handler — solo vs. bot, no chain commit, no queue.
 *
 * PRD §Game modes: "Practice is a single-player on-ramp — it shares the
 * swipe UI but does not enter matchmaking or touch the chain."
 *
 * Server returns:
 *   - 5 cards picked via the same `findDeckMarkets` + `buildDeck` logic as
 *     a real duel, so difficulty feels realistic
 *   - 5 pre-decided bot swipes (random 50/50), so the client can replay
 *     the "match" frame-by-frame however it wants
 *
 * Once the deck is sent, the client owns the rest: render the cards,
 * compare player swipes against bot swipes, score against the eventual
 * market settlement (which it reads directly from chain — no server
 * call needed because there's no on-chain duel object to mirror).
 */
import type { ServerWebSocket } from "bun"
import {
  commitDeck,
  decideDeckSize,
  deriveSeed,
  findDeckMarkets,
  hashToHex,
  readBtcSpot,
  resolveDeckBounds,
} from "../deckmaster"
import { buildProbedDeck, filterMintableMarkets } from "../mint-probe"
import { makeLogger, shortId } from "../log"
import type { SocketState } from "./matchmaking"
import { _sendInternal } from "./matchmaking"

const log = makeLogger("practice")

export async function handlePracticeStart(
  ws: ServerWebSocket<SocketState>
): Promise<void> {
  if (!ws.data.address) {
    _sendInternal(ws, {
      type: "error",
      code: "no_address",
      message: "send `hello` with your address first",
    })
    return
  }
  try {
    const rawMarkets = await findDeckMarkets(5)
    const spot = await readBtcSpot()
    // Drop momentarily-unbacked markets (see mint-probe.ts) so practice cards
    // mint as reliably as real duel cards.
    const markets = await filterMintableMarkets(rawMarkets, spot)
    // Multi-card-per-market: a full deck needs only >= 2 live markets
    // (decideDeckSize's floor); cards distribute across them with distinct
    // strikes. Matches the real matchmaking deck-gen.
    const decision = decideDeckSize(markets.length, resolveDeckBounds({}))
    if (!decision.ok) {
      _sendInternal(ws, {
        type: "error",
        code: "no_oracles",
        message: `only ${markets.length} mintable market(s) right now — retry in a few minutes`,
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
    const cards = await buildProbedDeck(
      markets,
      spot,
      seed,
      decision.deckSize,
      Date.now()
    )
    const botSwipes = Array.from(
      { length: decision.deckSize },
      () => Math.random() > 0.5
    )
    const { hashHex } = commitDeck(cards)
    log.info(
      `practice for ${shortId(ws.data.address)} — deck ${shortId(hashHex)}`
    )
    _sendInternal(ws, {
      type: "practice_session",
      cards: cards.map((c, i) => ({
        expiry_market_id: c.expiryMarketId,
        strike: c.strike.toString(),
        expiry: markets[i].expiry.toString(),
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
