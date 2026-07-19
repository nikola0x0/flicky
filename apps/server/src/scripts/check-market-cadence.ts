/**
 * Diagnostic: dump the live DeepBook Predict (6-24) BTC `ExpiryMarket`
 * cadence, sorted by settle time soonest-first, and show which markets
 * clear Flicky's deck-selection filter.
 *
 * Answers three questions at a glance:
 *   1. How many BTC markets/oracles are live right now (expiry > now)?
 *   2. How many clear the deck filter (`10min < ttl ≤ 3h`, tunable via
 *      DECK_CARD_MIN_HEADROOM_MS / DECK_CARD_MAX_HORIZON_MS)?
 *   3. What is a duel's wall-clock floor — i.e. when does the SLOWEST card
 *      settle? `finalize` needs ALL cards settled (duel.move), so the
 *      latest-expiring card in the deck gates the whole match.
 *
 * Reuses the exact production selection logic (`selectMarketRows`) so the
 * ELIGIBLE column mirrors what `findDeckMarkets` would actually pick.
 *
 * Run: bun --filter server run check:cadence
 *   or: bun run src/scripts/check-market-cadence.ts
 */
import { normalizeSuiObjectId } from "@mysten/sui/utils"
import { env } from "../env"
import {
  classifyTier,
  selectMarketRows,
  selectTieredMarkets,
  type MarketRow,
} from "../deckmaster"

const DECK_SIZE = 5

const minM = env.deckCardMinHeadroomMs / 60_000
const maxM = env.deckCardMaxHorizonMs / 60_000

console.log("Flicky × 6-24 — live BTC ExpiryMarket cadence\n")
console.log(`  indexer:  ${env.predictIndexerUrl}`)
console.log(
  `  headroom: ${minM} min   horizon: ${maxM} min` +
    `   (DECK_CARD_MIN_HEADROOM_MS / DECK_CARD_MAX_HORIZON_MS)`
)

const res = await fetch(`${env.predictIndexerUrl}/markets?limit=500`)
if (!res.ok) {
  console.error(`predict indexer /markets ${res.status}`)
  process.exit(1)
}
const rows = (await res.json()) as MarketRow[]
const now = Date.now()
console.log(`  now:      ${new Date(now).toISOString()}\n`)

// All live BTC markets (expiry > now), de-duped by id, soonest-first —
// the full cadence, including the ineligible short/long tails.
const seen = new Set<string>()
const live = rows
  .filter((r) => r.propbook_underlying_id === 1 && r.kind === "market_created")
  .filter((r) => {
    if (seen.has(r.expiry_market_id)) return false
    seen.add(r.expiry_market_id)
    return Number(r.expiry) > now
  })
  .sort((a, b) => Number(a.expiry) - Number(b.expiry))

// Production selection: nearest DECK_SIZE eligible markets, sorted asc.
const eligible = selectMarketRows(rows, {
  now,
  minHeadroomMs: env.deckCardMinHeadroomMs,
  maxHorizonMs: env.deckCardMaxHorizonMs,
  count: DECK_SIZE,
})
const eligibleIds = new Set(eligible.map((m) => m.expiryMarketId))

if (live.length === 0) {
  console.log("no live BTC markets — testnet may be quiet. exit.")
  process.exit(0)
}

const tierOf = (r: MarketRow) =>
  classifyTier(
    r.checkpoint_timestamp_ms === undefined
      ? undefined
      : Number(r.expiry) - r.checkpoint_timestamp_ms
  )

console.log("  ttl(min)  expiry(UTC)  tier    status")
console.log("  ────────  ───────────  ─────   ──────────────────────")
for (const r of live) {
  const expiry = Number(r.expiry)
  const ttl = (expiry - now) / 60_000
  const id = normalizeSuiObjectId(r.expiry_market_id)
  let status: string
  if (eligibleIds.has(id)) {
    status = "◆ ELIGIBLE — deck can pick"
  } else if (ttl <= minM) {
    status = `live · below ${minM}m headroom`
  } else {
    status = `live · beyond ${maxM}m horizon`
  }
  console.log(
    `  ${ttl.toFixed(1).padStart(8)}  ${new Date(expiry)
      .toISOString()
      .slice(11, 16)}        ${tierOf(r).padEnd(5)}   ${status}`
  )
}

console.log()
console.log(`  live markets (expiry > now):        ${live.length}`)
console.log(
  `  Flicky-eligible (${minM}m < ttl ≤ ${maxM}m):    ${eligible.length}` +
    (eligible.length < DECK_SIZE
      ? `  ⚠ fewer than a ${DECK_SIZE}-card deck — cards round-robin onto ${eligible.length}`
      : "")
)

if (eligible.length > 0) {
  // The deck grabs the nearest `DECK_SIZE` eligible markets; the duel can
  // only finalize once the LATEST-expiring of them settles.
  const slowest = eligible[eligible.length - 1]
  const slowestTtl = (slowest.expiry - now) / 60_000
  const picks = eligible
    .map((m) => new Date(m.expiry).toISOString().slice(11, 16))
    .join(", ")
  console.log(`  deck picks (nearest ${DECK_SIZE}):            [${picks}]`)
  console.log(
    `  duel wall-clock floor (slowest card): ~${slowestTtl.toFixed(
      0
    )} min after lockup  ${slowestTtl > 30 ? "← long; enable tiers or lower DECK_CARD_MAX_HORIZON_MS" : ""}`
  )
}

// ─── Tiered selection preview (DECK_TIER_ENABLED path) ───────────────────────
console.log()
console.log(
  `  ── Tiered preview: ${env.deckShortCount} short + ${env.deckMidCount} mid` +
    ` (DECK_TIER_ENABLED=${env.deckTierEnabled}) ──`
)
const tiered = selectTieredMarkets(rows, {
  now,
  shortCount: env.deckShortCount,
  midCount: env.deckMidCount,
  shortTtlFloorMs: env.deckShortTtlFloorMs,
  midTtlFloorMs: env.deckMidTtlFloorMs,
  maxHorizonMs: env.deckCardMaxHorizonMs,
})
if (tiered.length === 0) {
  console.log(
    `  (no safe short/mid markets — matchmaking falls back to the flat picker)`
  )
} else {
  const bufM = env.deckTxBufferMs / 60_000
  console.log(
    `  card  expiry(UTC)  settle(min)  swipe-deadline(min, −${env.deckTxBufferMs / 1000}s buf)`
  )
  tiered.forEach((m, i) => {
    const settleMin = (m.expiry - now) / 60_000
    const deadlineMin = settleMin - bufM
    console.log(
      `  ${String(i).padStart(4)}  ${new Date(m.expiry)
        .toISOString()
        .slice(
          11,
          16
        )}       ${settleMin.toFixed(1).padStart(6)}       ${deadlineMin
        .toFixed(1)
        .padStart(6)}`
    )
  })
  const slowest = (tiered[tiered.length - 1].expiry - now) / 60_000
  console.log(
    `  → duel finishes ~${slowest.toFixed(0)} min after lockup; ` +
      `${tiered.length} distinct market(s), ${DECK_SIZE} cards round-robin across them`
  )
}
console.log()
