/**
 * Quick smoke check for the max-amplitude deckmaster fix. Fetches 5 live
 * testnet BTC oracles, runs `buildAndProbeDeck`, and prints the strike
 * offset (in bps) each card landed on.
 *
 * Goal: confirm we land on aggressive offsets (>= ±300 bps preferred) on
 * real SVIs instead of always collapsing to ATM (the old behavior).
 *
 * Run: bun apps/server/src/scripts/check-deckmaster.ts
 */
import { getSuiClient } from "../lib/sui"
import {
  buildAndProbeDeck,
  deriveSeed,
  findDeckOracles,
  hashToHex,
  strikePctOf,
} from "../deckmaster"

const client = getSuiClient()

console.log("⏳ querying testnet for BTC oracles …")
const oracles = await findDeckOracles(client, "BTC", 5)
console.log(
  `→ found ${oracles.length} eligible BTC oracles > 10 min out\n`,
)
if (oracles.length === 0) {
  console.log("no oracles — testnet may be quiet. exit.")
  process.exit(1)
}
for (const o of oracles) {
  const remainingMin = Math.floor(
    Math.max(0, Number(o.expiry) - Date.now()) / 60_000,
  )
  console.log(
    `  ${o.id.slice(0, 14)}…  forward=$${(Number(o.forward) / 1e9).toFixed(2)}  expires in ~${remainingMin}m  tick=${o.tickSize}`,
  )
}
if (oracles.length < 5) {
  console.log("\nfewer than 5 oracles — deckmaster will throw.")
}

const seed = deriveSeed({ asset: "BTC", timestampMs: Date.now() })
console.log(`\nseed: ${hashToHex(seed)}\n`)
console.log("⏳ buildAndProbeDeck (parallel probe of ±20% → ±0.5%) …")
const t0 = Date.now()
const deck = await buildAndProbeDeck(client, oracles.slice(0, 5), seed)
const took = Date.now() - t0
console.log(`✓ built deck in ${took}ms\n`)

console.log("Per-card landing:\n")
console.log("  idx  forward      strike        % of fwd   |Δbps|  signed")
console.log("  ─── ───────────  ───────────   ─────────  ──────  ──────")
let aggressiveCount = 0
for (let i = 0; i < deck.cards.length; i++) {
  const o = oracles[i]
  const c = deck.cards[i]
  const pct = Number(strikePctOf(o.forward, c.strike))
  // % comes back as integer percent (1.05 forward → 105). Convert to bps
  // signed offset for the absolute deviation.
  const bps = (pct - 100) * 100
  const absBps = Math.abs(bps)
  if (absBps >= 300) aggressiveCount++
  const arrow = bps > 0 ? "↑" : bps < 0 ? "↓" : "·"
  console.log(
    `  ${String(i).padStart(3)}  $${(Number(o.forward) / 1e9).toFixed(2).padStart(9)}  $${(Number(c.strike) / 1e9).toFixed(2).padStart(9)}   ${String(pct).padStart(4)}%      ${String(absBps).padStart(5)}    ${arrow}${absBps}`,
  )
}
console.log()
console.log(
  `🎯 ${aggressiveCount}/${deck.cards.length} cards landed at >= ±300 bps (the old behavior collapsed all cards to ATM = 0 bps).`,
)
console.log(`\nhash: ${deck.hashHex}\n`)
