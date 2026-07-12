/**
 * HTTP endpoints for DeepBook Predict `ExpiryMarket` reads.
 *
 * 6-24 replaces the pre-6-24 `OracleSVI` on-chain struct with no public
 * equivalent — settlement/spot state only surfaces via the predict
 * indexer (`GET /markets`, `GET /markets/{id}/state`) or devInspect
 * getters on `ExpiryMarket`. This file reads the indexer, mirroring
 * `deckmaster.ts`'s market-discovery pattern, so both the frontend and
 * `ws/oracle-stream.ts` have a uniform HTTP read path.
 *
 *   GET  /oracle/list?asset=BTC[&minHeadroomMs=…]
 *     → { asset, minHeadroomMs, markets: [{ id, expiry, spot, forward, active, settled }] }
 *
 *   GET  /oracle/:id
 *     → { id, expiry, spot, forward, active, settled }
 */
import { normalizeSuiObjectId } from "@mysten/sui/utils"
import { env } from "./env"
import { json } from "./lib/http"
import { makeLogger } from "./log"

const log = makeLogger("oracle")

/** Raw row shape from `GET {predictIndexerUrl}/markets` (see deckmaster.ts::MarketRow). */
interface MarketRow {
  expiry_market_id: string
  propbook_underlying_id: number
  expiry: number
  kind: string
}

/** Raw shape from `GET {predictIndexerUrl}/markets/{id}/state`. */
interface MarketStateResponse {
  market?: { expiry_market_id?: string; expiry?: string | number }
  oracle_prices?: { spot?: string; forward?: string }
  settlement?: { settlement_price?: string; settled_at_ms?: string } | null
}

export interface ExpiryMarketView {
  id: string
  expiry: string
  spot: string
  forward: string
  active: boolean
  settled: boolean
}

async function fetchMarketRows(): Promise<MarketRow[]> {
  const res = await fetch(`${env.predictIndexerUrl}/markets`)
  if (!res.ok) throw new Error(`predict indexer /markets ${res.status}`)
  return (await res.json()) as MarketRow[]
}

/** Exported for `ws/oracle-stream.ts` — shared fetch so both call sites agree on the shape. */
export async function fetchMarketState(
  id: string
): Promise<MarketStateResponse | null> {
  const res = await fetch(`${env.predictIndexerUrl}/markets/${id}/state`)
  if (!res.ok) return null
  return (await res.json()) as MarketStateResponse
}

function isSettled(state: MarketStateResponse | null): boolean {
  return !!state?.settlement?.settlement_price
}

async function readExpiryMarket(
  id: string,
  expiryHint?: string
): Promise<ExpiryMarketView | null> {
  const state = await fetchMarketState(id)
  if (!state) return null
  const settled = isSettled(state)
  return {
    id: normalizeSuiObjectId(id),
    expiry: expiryHint ?? String(state.market?.expiry ?? "0"),
    spot: state.oracle_prices?.spot ?? "0",
    forward: state.oracle_prices?.forward ?? "0",
    active: !settled,
    settled,
  }
}

/**
 * List live BTC `ExpiryMarket`s (`propbook_underlying_id === 1`) whose
 * expiry clears `now + minHeadroomMs`, nearest-first. Mirrors
 * `deckmaster.ts::selectMarketRows`'s filter/de-dupe/sort logic; kept
 * separate since this route also fetches per-market spot/forward (via
 * `/markets/{id}/state`), which deckmaster's deck-building path doesn't need.
 */
async function listEligibleMarkets(
  asset: string,
  minHeadroomMs: number
): Promise<ExpiryMarketView[]> {
  if (asset !== "BTC") return [] // only BTC (propbook_underlying_id 1) is wired currently
  const rows = await fetchMarketRows()
  const now = Date.now()
  const minExpiry = BigInt(now) + BigInt(minHeadroomMs)
  const seen = new Set<string>()
  const candidates: MarketRow[] = []
  for (const r of rows) {
    if (r.propbook_underlying_id !== 1 || r.kind !== "market_created") continue
    const id = normalizeSuiObjectId(r.expiry_market_id)
    if (seen.has(id)) continue
    seen.add(id)
    if (BigInt(r.expiry) <= minExpiry) continue
    candidates.push(r)
  }
  candidates.sort((a, b) => a.expiry - b.expiry)
  const top = candidates.slice(0, 20)
  const views = await Promise.all(
    top.map((c) =>
      readExpiryMarket(
        normalizeSuiObjectId(c.expiry_market_id),
        String(c.expiry)
      )
    )
  )
  return views.filter(
    (v): v is ExpiryMarketView => v !== null && v.active && !v.settled
  )
}

export async function handleOracleRequest(
  req: Request,
  url: URL
): Promise<Response | null> {
  if (url.pathname === "/oracle/list" && req.method === "GET") {
    const asset = url.searchParams.get("asset") ?? "BTC"
    const minHeadroomRaw = url.searchParams.get("minHeadroomMs")
    const minHeadroomMs = minHeadroomRaw
      ? Math.max(0, Number(minHeadroomRaw))
      : env.deckCardMinHeadroomMs
    try {
      const markets = await listEligibleMarkets(asset, minHeadroomMs)
      return json({ asset, minHeadroomMs, markets })
    } catch (e) {
      log.warn(`list ${asset}: ${e instanceof Error ? e.message : String(e)}`)
      return json(
        {
          error: "market list failed",
          detail: e instanceof Error ? e.message : String(e),
        },
        500
      )
    }
  }

  // /oracle/0x… — match anything after the prefix as the expiry-market id
  if (url.pathname.startsWith("/oracle/") && req.method === "GET") {
    const id = decodeURIComponent(url.pathname.slice("/oracle/".length))
    if (!id.startsWith("0x")) return json({ error: "bad market id" }, 400)
    try {
      const view = await readExpiryMarket(id)
      if (!view) return json({ error: "market not found" }, 404)
      return json(view)
    } catch (e) {
      return json(
        {
          error: "market read failed",
          detail: e instanceof Error ? e.message : String(e),
        },
        500
      )
    }
  }

  return null
}
