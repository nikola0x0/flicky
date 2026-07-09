/**
 * HTTP endpoints for DeepBook Predict OracleSVI reads.
 *
 * The frontend can hit Sui RPC directly for the same data, but the
 * server-side endpoints give the indexer / keeper / future bots a
 * uniform read path and let us centralize caching later.
 *
 *   GET  /oracle/list?asset=BTC[&minHeadroomMs=…]
 *     → { asset, oracles: [{ id, expiry, spot, forward, active, settled }] }
 *
 *   GET  /oracle/:id
 *     → { id, expiry, spot, forward, active, settled }
 */
import type { SuiGrpcClient } from "@mysten/sui/grpc"
import { normalizeSuiObjectId } from "@mysten/sui/utils"
import { env } from "./env"
import { json } from "./lib/http"
import { getGraphQLClient, getSuiClient } from "./lib/sui"
import { makeLogger } from "./log"

const log = makeLogger("oracle")

const RECENT_EVENTS_QUERY = `query Recent($type: String!, $last: Int!) {
  events(filter: { type: $type }, last: $last) {
    nodes { contents { json } }
  }
}`
type RecentEventsResult = {
  data?: {
    events?: { nodes?: Array<{ contents: { json: Record<string, unknown> } }> }
  }
}

interface OracleFields {
  active: boolean
  expiry: string
  settlement_price: unknown
  prices: { spot: string; forward: string }
}

interface OracleView {
  id: string
  expiry: string
  spot: string
  forward: string
  active: boolean
  settled: boolean
}

function isSettlementSet(v: unknown): boolean {
  if (v === null || v === undefined) return false
  if (typeof v === "string") return true
  if (typeof v === "object") {
    const vec = (v as { fields?: { vec?: unknown[] } }).fields?.vec
    return Array.isArray(vec) && vec.length > 0
  }
  return false
}

function toView(id: string, f: OracleFields): OracleView {
  return {
    id: normalizeSuiObjectId(id),
    expiry: f.expiry,
    spot: f.prices.spot,
    forward: f.prices.forward,
    active: f.active,
    settled: isSettlementSet(f.settlement_price),
  }
}

async function readOracle(
  client: SuiGrpcClient,
  id: string,
): Promise<OracleView | null> {
  const obj = await client.core.getObject({ objectId: id, include: { json: true } })
  if (!obj.object?.json) return null
  return toView(id, obj.object.json as unknown as OracleFields)
}

async function listEligibleOracles(
  client: SuiGrpcClient,
  asset: string,
  minHeadroomMs: number,
): Promise<OracleView[]> {
  const pkg = env.deepbookPredictPackageId
  const now = Date.now()
  const minExpiry = BigInt(now) + BigInt(minHeadroomMs)

  const evRes = (await getGraphQLClient().query({
    query: RECENT_EVENTS_QUERY,
    variables: { type: `${pkg}::registry::OracleCreated`, last: 30 },
  })) as RecentEventsResult
  const candidates: string[] = []
  for (const node of evRes.data?.events?.nodes ?? []) {
    const p = node.contents.json as { oracle_id: string; underlying_asset: string }
    if (p.underlying_asset !== asset) continue
    candidates.push(normalizeSuiObjectId(p.oracle_id))
    if (candidates.length >= 20) break
  }
  if (candidates.length === 0) return []
  const res = await client.core.getObjects({
    objectIds: candidates,
    include: { json: true },
  })
  const eligible: OracleView[] = []
  for (const obj of res.objects) {
    if (obj instanceof Error || !obj.json) continue
    const id = obj.objectId
    const f = obj.json as unknown as OracleFields
    const view = toView(id, f)
    if (!view.active) continue
    if (view.settled) continue
    if (BigInt(view.expiry) <= minExpiry) continue
    eligible.push(view)
  }
  eligible.sort((a, b) =>
    BigInt(a.expiry) < BigInt(b.expiry) ? -1 : BigInt(a.expiry) > BigInt(b.expiry) ? 1 : 0,
  )
  return eligible
}

export async function handleOracleRequest(
  req: Request,
  url: URL,
): Promise<Response | null> {
  if (url.pathname === "/oracle/list" && req.method === "GET") {
    const asset = url.searchParams.get("asset") ?? "BTC"
    const minHeadroomRaw = url.searchParams.get("minHeadroomMs")
    const minHeadroomMs = minHeadroomRaw
      ? Math.max(0, Number(minHeadroomRaw))
      : env.deckCardMinHeadroomMs
    try {
      const oracles = await listEligibleOracles(getSuiClient(), asset, minHeadroomMs)
      return json({ asset, minHeadroomMs, oracles })
    } catch (e) {
      log.warn(`list ${asset}: ${e instanceof Error ? e.message : String(e)}`)
      return json({ error: "oracle list failed", detail: e instanceof Error ? e.message : String(e) }, 500)
    }
  }

  // /oracle/0x… — match anything after the prefix as the id
  if (url.pathname.startsWith("/oracle/") && req.method === "GET") {
    const id = decodeURIComponent(url.pathname.slice("/oracle/".length))
    if (!id.startsWith("0x")) return json({ error: "bad oracle id" }, 400)
    try {
      const view = await readOracle(getSuiClient(), id)
      if (!view) return json({ error: "oracle not found" }, 404)
      return json(view)
    } catch (e) {
      return json({ error: "oracle read failed", detail: e instanceof Error ? e.message : String(e) }, 500)
    }
  }

  return null
}
