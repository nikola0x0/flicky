/**
 * Quick smoke check for 6-24 price-space deck generation. Fetches up to 5
 * live testnet BTC `ExpiryMarket`s from the predict indexer, reads spot
 * from the propbook indexer, runs `buildDeck`, and prints each card's
 * strike offset (bps of spot) and side.
 *
 * Run: bun apps/server/src/scripts/check-deckmaster.ts
 */
import {
  buildDeck,
  commitDeck,
  deriveSeed,
  findDeckMarkets,
  hashToHex,
  readBtcSpot,
} from "../deckmaster"

console.log("⏳ querying predict indexer for live BTC ExpiryMarkets …")
const markets = await findDeckMarkets(5)
console.log(`→ found ${markets.length} eligible BTC markets > 10 min out\n`)
if (markets.length === 0) {
  console.log("no markets — testnet may be quiet. exit.")
  process.exit(1)
}
for (const m of markets) {
  const remainingMin = Math.floor(
    Math.max(0, m.expiry - Date.now()) / 60_000,
  )
  console.log(
    `  ${m.expiryMarketId.slice(0, 14)}…  expires in ~${remainingMin}m  tick=${m.tickSize}  admissionTick=${m.admissionTickSize}`,
  )
}
if (markets.length < 5) {
  console.log("\nfewer than 5 markets — deckmaster HTTP route may 503 depending on the requested band.")
}

console.log("\n⏳ reading BTC spot from propbook indexer …")
const spot = await readBtcSpot()
console.log(`spot: $${(Number(spot) / 1e9).toFixed(2)}\n`)

const seed = deriveSeed({ asset: "BTC", timestampMs: Date.now() })
console.log(`seed: ${hashToHex(seed)}\n`)

const cards = buildDeck(markets, spot, seed)
const deck = commitDeck(cards)

console.log("Per-card landing:\n")
console.log("  idx  strike        side               |Δbps|")
console.log("  ─── ───────────   ────────────────    ──────")
for (let i = 0; i < cards.length; i++) {
  const c = cards[i]
  const diff = c.strike > spot ? c.strike - spot : spot - c.strike
  const bps = (diff * 10_000n) / spot
  const side = c.isUpFavored ? "UP-fav ↓strike" : "DOWN-fav ↑strike"
  console.log(
    `  ${String(i).padStart(3)}  $${(Number(c.strike) / 1e9).toFixed(2).padStart(9)}   ${side.padEnd(18)} ${bps.toString().padStart(5)}`,
  )
}
console.log()
console.log(`hash: ${deck.hashHex}\n`)
