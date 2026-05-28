/**
 * Diagnostic: dump the latest DeepBook Predict OracleCreated events +
 * the resolved OracleSVI state. Used to understand why
 * `findDeckOracles` returns 0 — could be the asset filter, the headroom
 * filter, or the package id.
 */
import { getSuiClient } from "../lib/sui"
import { env } from "../env"

const client = getSuiClient()
const pkg = env.deepbookPredictPackageId

console.log(`predict package: ${pkg}`)
console.log(`headroom:        ${env.deckCardMinHeadroomMs}ms (${env.deckCardMinHeadroomMs / 60_000}min)`)
console.log()

const evts = await client.queryEvents({
  query: { MoveEventType: `${pkg}::registry::OracleCreated` },
  limit: 20,
  order: "descending",
})
console.log(`got ${evts.data.length} OracleCreated events (newest first)\n`)

const now = Date.now()
const minExpiry = now + env.deckCardMinHeadroomMs
let okCount = 0
for (const e of evts.data) {
  const p = e.parsedJson as {
    oracle_id: string
    underlying_asset: string
    min_strike?: string
    tick_size?: string
  }
  const obj = await client.getObject({
    id: p.oracle_id,
    options: { showContent: true },
  })
  if (obj.data?.content?.dataType !== "moveObject") {
    console.log(`  ${p.oracle_id.slice(0, 14)}…  asset=${p.underlying_asset}  (no content)`)
    continue
  }
  const f = obj.data.content.fields as {
    active: boolean
    expiry: string
    settlement_price: unknown
    prices: { fields: { spot: string; forward: string } }
  }
  const expiry = Number(f.expiry)
  const settled =
    typeof f.settlement_price === "string" ||
    (f.settlement_price &&
      typeof f.settlement_price === "object" &&
      Array.isArray((f.settlement_price as { fields?: { vec?: unknown[] } }).fields?.vec) &&
      ((f.settlement_price as { fields?: { vec?: unknown[] } }).fields?.vec?.length ?? 0) > 0)
  const remainingMin = Math.floor((expiry - now) / 60_000)
  const ok = f.active && !settled && expiry > minExpiry
  if (ok) okCount++
  const spot = Number(f.prices.fields.spot) / 1e9
  console.log(
    `  ${p.oracle_id.slice(0, 14)}…  asset=${p.underlying_asset}  active=${f.active}  settled=${!!settled}  expiry=+${remainingMin}min  spot=$${spot.toFixed(2)}  ${ok ? "✓ eligible" : "—"}`,
  )
}
console.log(`\n=> ${okCount} eligible (active && !settled && expiry > +${env.deckCardMinHeadroomMs / 60_000}min)\n`)
