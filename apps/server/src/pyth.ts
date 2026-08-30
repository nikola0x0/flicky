/**
 * On-chain Pyth BTC price reads.
 *
 * The spot price used to come from Mysten's propbook indexer
 * (`GET /oracles/{feed}/pyth/latest`). That host no longer resolves, which
 * is one of the two reasons the game went down — so spot is now read
 * straight from the `pyth_feed::PythFeed` shared object instead. The object
 * is updated by Pyth's own pusher and keeps ticking regardless of whether
 * DeepBook Predict is creating markets, which is exactly the property we
 * need: no Mysten-operated HTTP service in the path.
 *
 * Object shape (verified live 2026-08-30):
 *
 *   lane.latest.source_timestamp_ms : "1785970324800"
 *   lane.latest.value.price_magnitude      : "6461886680934"
 *   lane.latest.value.exponent_magnitude   : 8
 *   lane.latest.value.exponent_is_negative : true
 *   lane.latest.value.price_is_negative    : false
 *
 * i.e. price = 6461886680934 × 10⁻⁸ = $64,618.86680934.
 */
import type { SuiGrpcClient } from "@mysten/sui/grpc"
import { getSuiClient } from "./lib/sui"
import { env } from "./env"
/** The 1e9-fixed USD unit used everywhere else (`MarketSnapshot.tickSize`). */
const ONE_E9 = 1_000_000_000n

export interface PythSpot {
  /** Price in 1e9-fixed USD — same scale the deck/strike code expects. */
  price: bigint
  /** Feed's own source timestamp (ms). Used for the staleness guard. */
  sourceTimestampMs: number
  /** Age at read time, ms. */
  ageMs: number
}

/** Raw `lane.latest` shape we depend on. Anything else is a parse failure. */
interface FeedJson {
  lane?: {
    latest?: {
      source_timestamp_ms?: string
      value?: {
        price_magnitude?: string
        exponent_magnitude?: number
        exponent_is_negative?: boolean
        price_is_negative?: boolean
      }
    }
  }
}

/**
 * Convert Pyth's (magnitude, signed exponent) pair to 1e9-fixed USD.
 *
 * Exported for testing — the exponent handling is the part most likely to be
 * silently wrong, and a wrong scale here misprices every strike in the deck.
 */
export function pythPriceTo1e9(
  priceMagnitude: bigint,
  exponentMagnitude: number,
  exponentIsNegative: boolean
): bigint {
  if (exponentMagnitude < 0 || exponentMagnitude > 30) {
    throw new Error(`pyth: implausible exponent magnitude ${exponentMagnitude}`)
  }
  const scale = 10n ** BigInt(exponentMagnitude)
  // price = magnitude × 10^(±exp); we want that × 1e9, integer-only.
  return exponentIsNegative
    ? (priceMagnitude * ONE_E9) / scale
    : priceMagnitude * scale * ONE_E9
}

/**
 * Read BTC spot from the on-chain Pyth feed.
 *
 * Throws on a stale, negative, or unparseable price rather than returning a
 * number a caller might quietly build a deck (or settle a card) from. The
 * keeper's fail-closed contract depends on this throwing.
 */
export async function readPythSpot(
  client: SuiGrpcClient = getSuiClient(),
  feedId: string = env.pythFeedId,
  nowMs: number = Date.now()
): Promise<PythSpot> {
  const res = await client.core.getObject({
    objectId: feedId,
    include: { json: true },
  })
  const json = res.object?.json as FeedJson | undefined
  const latest = json?.lane?.latest
  const value = latest?.value

  if (!value?.price_magnitude || latest?.source_timestamp_ms === undefined) {
    throw new Error(
      `pyth feed ${feedId}: no lane.latest price (object shape changed?)`
    )
  }
  if (value.price_is_negative) {
    throw new Error(`pyth feed ${feedId}: negative price`)
  }

  const price = pythPriceTo1e9(
    BigInt(value.price_magnitude),
    value.exponent_magnitude ?? 0,
    value.exponent_is_negative ?? false
  )
  if (price <= 0n) throw new Error(`pyth feed ${feedId}: non-positive price`)

  const sourceTimestampMs = Number(latest.source_timestamp_ms)
  const ageMs = nowMs - sourceTimestampMs
  if (ageMs > env.pythMaxStalenessMs) {
    throw new Error(
      `pyth feed ${feedId}: price is ${Math.round(ageMs / 1000)}s stale ` +
        `(max ${Math.round(env.pythMaxStalenessMs / 1000)}s) — refusing to use it`
    )
  }

  return { price, sourceTimestampMs, ageMs }
}

/** Convenience wrapper returning just the 1e9-fixed price. */
export async function readBtcSpotOnChain(
  client?: SuiGrpcClient
): Promise<bigint> {
  const { price } = await readPythSpot(client)
  return price
}
