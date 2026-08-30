/**
 * `bun run check:sources` — can we build a deck right now, and from what?
 *
 * Exists because the previous diagnostics (`check:6-24-live`,
 * `check:cadence`) both assume the predict HTTP indexer is reachable, so when
 * it vanished they failed with connection errors that said nothing about the
 * actual problem. Twelve days passed before anyone worked out that DeepBook
 * Predict had simply stopped creating markets.
 *
 * This answers the question directly, reads only the chain and our own
 * mirror, and exits non-zero when a deck could NOT be built — so it works as
 * a cron/alert probe as well as something you run by hand.
 *
 * Also prints the RESOLVED package ids beside what is actually emitting
 * events, so a pin mismatch (the version has moved twice already) is visible
 * in one command. See docs/predict-pin-migration.md.
 */
import { env } from "../env"
import { networkEnv } from "../network-env"
import { getGraphQLClient, getSuiClient } from "../lib/sui"
import { listPredictMarkets, predictMarketStats } from "../db"
import { readPythSpot } from "../pyth"

const ne = networkEnv(env.network)

function line(label: string, value: string): void {
  console.log(`  ${label.padEnd(26)} ${value}`)
}

function ago(ms: number | null): string {
  if (ms === null) return "never"
  const d = ms / 86_400_000
  if (d >= 1) return `${d.toFixed(1)}d ago`
  const h = ms / 3_600_000
  if (h >= 1) return `${h.toFixed(1)}h ago`
  return `${Math.round(ms / 1000)}s ago`
}

console.log(`\n=== deck sources — ${env.network} ===\n`)

// ── Resolved config ─────────────────────────────────────────────────────────
console.log("config")
line("DECK_SOURCE", env.deckSource)
line("flicky package", ne.flickyPackageId ?? "(unset)")
line("predict package", ne.deepbookPredictPackageId)
line("predict indexer", ne.predictIndexerUrl)
line("propbook indexer", ne.propbookIndexerUrl)

// ── Is the pinned package the one emitting events? ──────────────────────────
console.log("\non-chain events (is the pin still the live deployment?)")
const gql = getGraphQLClient()
let newestCreatedMs: number | null = null
for (const [label, type] of [
  [
    "MarketCreated",
    `${ne.deepbookPredictPackageId}::config_events::MarketCreated`,
  ],
  [
    "MarketSettled",
    `${ne.deepbookPredictPackageId}::config_events::MarketSettled`,
  ],
  ["OrderMinted", `${ne.deepbookPredictPackageId}::order_events::OrderMinted`],
] as const) {
  try {
    // NOTE: Sui GraphQL caps page size at 50. A larger `last:` returns null
    // rather than an error, which silently reads as "no events".
    const res = (await gql.query({
      query: `query Last($t: String!) {
        events(last: 1, filter: { type: $t }) { nodes { timestamp } }
      }`,
      variables: { t: type },
    })) as { data?: { events?: { nodes?: Array<{ timestamp?: string }> } } }
    const ts = res.data?.events?.nodes?.[0]?.timestamp
    if (!ts) {
      line(label, "NO EVENTS EVER — wrong package pin?")
      continue
    }
    const age = Date.now() - Date.parse(ts)
    if (label === "MarketCreated") newestCreatedMs = age
    line(label, `${ts}  (${ago(age)})`)
  } catch (e) {
    line(label, `query failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

// ── What our own mirror knows ───────────────────────────────────────────────
console.log("\nindexed markets (predict_market mirror)")
let live = 0
try {
  const stats = await predictMarketStats()
  live = stats.liveCount
  line("indexed", String(stats.count))
  line("still live", String(stats.liveCount))
  line(
    "newest expiry",
    stats.newestExpiry === null
      ? "none"
      : `${new Date(stats.newestExpiry).toISOString()}  (${ago(Date.now() - stats.newestExpiry)})`
  )
  const rows = await listPredictMarkets(1)
  const upcoming = rows.filter((r) => r.expiry > Date.now())
  if (upcoming.length) {
    line("soonest live expiry", new Date(upcoming[0].expiry).toISOString())
  }
} catch (e) {
  line("mirror", `unreadable: ${e instanceof Error ? e.message : String(e)}`)
}

// ── Price feed ──────────────────────────────────────────────────────────────
console.log("\nprice feed (needed for strike placement)")
try {
  const spot = await readPythSpot(getSuiClient())
  line(
    "BTC spot",
    `$${(Number(spot.price) / 1e9).toFixed(2)}  (${ago(spot.ageMs)})`
  )
} catch (e) {
  line(
    "BTC spot",
    `UNAVAILABLE — ${e instanceof Error ? e.message : String(e)}`
  )
}

// ── Verdict ─────────────────────────────────────────────────────────────────
const canBuild = live > 0
console.log(
  `\nverdict: ${canBuild ? "CAN build a deck" : "CANNOT build a deck"}`
)
if (!canBuild) {
  console.log(
    newestCreatedMs === null
      ? "  no MarketCreated events for the pinned package — check the pin " +
          "(docs/predict-pin-migration.md)"
      : `  no live markets; last one was created ${ago(newestCreatedMs)}. ` +
          "DeepBook Predict is not currently creating markets."
  )
}
console.log()
process.exit(canBuild ? 0 : 1)
