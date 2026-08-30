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
import { json, networkUnavailable, resolveNetworkParam } from "./lib/http"
import { networkEnv } from "./network-env"
import { listPredictMarkets } from "./db"
import { getSuiClient } from "./lib/sui"
import { predictWatchSnapshot } from "./predict-watch"
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

/**
 * Markets from the `predict_market` mirror (see
 * `DuelIndexer::drainMarketCreated`), not from the predict indexer's
 * `/markets`. Same reason as `deckmaster.ts::indexedMarketRows` — that host
 * no longer resolves, and these rows are the same events it replayed.
 */
async function fetchMarketRows(): Promise<MarketRow[]> {
  const rows = await listPredictMarkets(1)
  return rows.map((r) => ({
    expiry_market_id: r.expiryMarketId,
    propbook_underlying_id: r.propbookUnderlyingId,
    expiry: r.expiry,
    tick_size: r.tickSize,
    admission_tick_size: r.admissionTickSize,
    kind: "market_created",
    checkpoint_timestamp_ms: r.createdAtMs ?? undefined,
  }))
}

/**
 * A market's settlement state, read off the `ExpiryMarket` object.
 *
 * Exported for `ws/oracle-stream.ts` so both call sites agree on the shape.
 * Reads the chain rather than `GET /markets/{id}/state`: `settlement_price`
 * is a public field, and it is null (not 0) until the market settles — see
 * `keeper.ts::readMarketSettlement`, which uses the same gate.
 */
export async function fetchMarketState(
  id: string
): Promise<MarketStateResponse | null> {
  try {
    const res = await getSuiClient().core.getObject({
      objectId: id,
      include: { json: true },
    })
    const json = res.object?.json as
      | { settlement_price?: string | number | null }
      | undefined
    if (!json) return null
    const raw = json.settlement_price
    const settled = raw !== undefined && raw !== null && BigInt(raw) > 0n
    return {
      settlement: settled ? { settlement_price: String(raw) } : null,
    } as MarketStateResponse
  } catch {
    return null
  }
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
  if (!url.pathname.startsWith("/oracle")) return null

  // Every read here comes from the Predict indexer, so a network without a
  // Predict deployment has nothing to answer with.
  const resolved = resolveNetworkParam(url)
  if ("error" in resolved) return resolved.error
  if (!networkEnv(resolved.network).predictAvailable) {
    return networkUnavailable(resolved.network)
  }

  if (url.pathname === "/oracle/list" && req.method === "GET") {
    const asset = url.searchParams.get("asset") ?? "BTC"
    const minHeadroomRaw = url.searchParams.get("minHeadroomMs")
    const minHeadroomMs = minHeadroomRaw
      ? Math.max(0, Number(minHeadroomRaw))
      : env.deckCardMinHeadroomMs
    try {
      const markets = await listEligibleMarkets(asset, minHeadroomMs)
      // An empty list is ambiguous on its own — "none right now" reads the
      // same as "upstream has been dark for two weeks", and that ambiguity is
      // part of why the outage went unnoticed. Say which one it is.
      if (markets.length === 0) {
        const watch = predictWatchSnapshot()
        return json({
          asset,
          minHeadroomMs,
          markets,
          diagnostic: {
            reason: "PREDICT_NO_LIVE_MARKETS",
            lastMarketCreated:
              watch.newestCreatedMs === null
                ? null
                : new Date(watch.newestCreatedMs).toISOString(),
            staleForDays:
              watch.newestCreatedMs === null
                ? null
                : +((Date.now() - watch.newestCreatedMs) / 86_400_000).toFixed(
                    1
                  ),
            hint: "run `bun run check:sources` for a full diagnosis",
          },
        })
      }
      return json({ asset, minHeadroomMs, markets })
    } catch (e) {
      log.warn(`list ${asset}: ${e instanceof Error ? e.message : String(e)}`)
      return json(
        {
          error: "PREDICT_NO_LIVE_MARKETS",
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
