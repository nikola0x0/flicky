/**
 * Diagnostic: dump the latest DeepBook Predict OracleCreated events +
 * the resolved OracleSVI state. Used to understand why
 * `findDeckOracles` returns 0 — could be the asset filter, the headroom
 * filter, or the package id.
 */
import { getGraphQLClient, getSuiClient } from "../lib/sui"
import { env } from "../env"

const client = getSuiClient()
const pkg = env.deepbookPredictPackageId

console.log(`predict package: ${pkg}`)
console.log(`headroom:        ${env.deckCardMinHeadroomMs}ms (${env.deckCardMinHeadroomMs / 60_000}min)`)
console.log()

const evRes = (await getGraphQLClient().query({
  query: `query Recent($type: String!) {
    events(filter: { type: $type }, last: 20) { nodes { contents { json } } }
  }`,
  variables: { type: `${pkg}::registry::OracleCreated` },
})) as {
  data?: { events?: { nodes?: Array<{ contents: { json: Record<string, unknown> } }> } }
}
const nodes = evRes.data?.events?.nodes ?? []
console.log(`got ${nodes.length} OracleCreated events (newest first)\n`)

const now = Date.now()
const minExpiry = now + env.deckCardMinHeadroomMs
let okCount = 0
for (const node of nodes) {
  const p = node.contents.json as {
    oracle_id: string
    underlying_asset: string
    min_strike?: string
    tick_size?: string
  }
  const obj = await client.core.getObject({
    objectId: p.oracle_id,
    include: { json: true },
  })
  if (!obj.object?.json) {
    console.log(`  ${p.oracle_id.slice(0, 14)}…  asset=${p.underlying_asset}  (no content)`)
    continue
  }
  const f = obj.object.json as {
    active: boolean
    expiry: string
    settlement_price: unknown
    prices: { spot: string; forward: string }
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
  const spot = Number(f.prices.spot) / 1e9
  console.log(
    `  ${p.oracle_id.slice(0, 14)}…  asset=${p.underlying_asset}  active=${f.active}  settled=${!!settled}  expiry=+${remainingMin}min  spot=$${spot.toFixed(2)}  ${ok ? "✓ eligible" : "—"}`,
  )
}
console.log(`\n=> ${okCount} eligible (active && !settled && expiry > +${env.deckCardMinHeadroomMs / 60_000}min)\n`)
