/**
 * Client for the DeepBook Predict indexed server — the canonical
 * oracle-discovery path.
 *
 * gRPC/GraphQL can't cheaply answer "which oracles are live" now that the
 * on-chain `oracle::OraclePricesUpdated` tick events are quiet, but the
 * server's `GET /predicts/:id/oracles` returns every oracle (id, expiry,
 * strike grid, status) for a Predict object. Discovery uses this first and
 * falls back to the event scan when the server is unreachable.
 *
 * Deployment-agnostic: point `PREDICT_SERVER_URL` + `DEEPBOOK_PREDICT_OBJECT_ID`
 * at whichever deployment you target (e.g. predict-testnet-4-16 vs -6-24).
 */
import { normalizeSuiObjectId } from "@mysten/sui/utils"
import { env } from "../env"

/** One oracle row as returned by `/predicts/:id/oracles`. */
interface PredictOracleRow {
  oracle_id: string
  underlying_asset: string
  expiry: number
  min_strike: number
  tick_size: number
  status: string // "active" | "settled" | …
  settlement_price?: number | null
}

/**
 * Normalized candidate straight from the server: id + strike-grid params.
 * Live prices (spot/forward) are read separately from the oracle object,
 * since the list endpoint doesn't carry them.
 */
export interface PredictOracleCandidate {
  id: string
  expiry: bigint
  minStrike: bigint
  tickSize: bigint
}

/**
 * List the currently-`active` oracles for `asset` from the Predict server.
 * Throws on network error / non-2xx / bad shape so callers can fall back to
 * the on-chain event scan.
 */
export async function fetchActivePredictOracles(
  asset: string,
): Promise<PredictOracleCandidate[]> {
  const url = `${env.predictServerUrl}/predicts/${env.deepbookPredictObjectId}/oracles`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`predict server ${res.status} for ${url}`)
  const rows = (await res.json()) as PredictOracleRow[]
  if (!Array.isArray(rows)) {
    throw new Error("predict server: unexpected /oracles shape")
  }
  return rows
    .filter((r) => r.underlying_asset === asset && r.status === "active")
    .map((r) => ({
      id: normalizeSuiObjectId(r.oracle_id),
      expiry: BigInt(Math.trunc(r.expiry)),
      minStrike: BigInt(Math.trunc(r.min_strike)),
      tickSize: BigInt(Math.trunc(r.tick_size)),
    }))
}
