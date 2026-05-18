// Hermes is Pyth's hosted price-update endpoint. Free, no key.
// https://hermes.pyth.network/docs
const HERMES_URL = "https://hermes.pyth.network/v2/updates/price/latest"

// Pyth feed IDs (testnet + mainnet share the same set).
// https://www.pyth.network/developers/price-feed-ids
export const PYTH_FEED_IDS = {
  BTC: "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  ETH: "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  SUI: "0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744",
  SOL: "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
} as const

export type AssetSymbol = keyof typeof PYTH_FEED_IDS

export interface HermesPrice {
  price: bigint // signed integer; multiply by 10^expo
  expo: number // typically negative
  publishTimeMs: number
}

interface HermesResponse {
  parsed: Array<{
    id: string
    price: { price: string; conf: string; expo: number; publish_time: number }
  }>
}

export async function fetchPythPrices(
  symbols: AssetSymbol[],
): Promise<Record<AssetSymbol, HermesPrice>> {
  const params = new URLSearchParams()
  for (const s of symbols) params.append("ids[]", PYTH_FEED_IDS[s])
  params.set("parsed", "true")

  const res = await fetch(`${HERMES_URL}?${params.toString()}`)
  if (!res.ok) {
    throw new Error(`hermes fetch failed: ${res.status} ${await res.text()}`)
  }
  const body = (await res.json()) as HermesResponse

  const out = {} as Record<AssetSymbol, HermesPrice>
  for (const symbol of symbols) {
    const wanted = PYTH_FEED_IDS[symbol].replace(/^0x/, "")
    const parsed = body.parsed.find((p) => p.id === wanted)
    if (!parsed) throw new Error(`no Pyth update returned for ${symbol}`)
    out[symbol] = {
      price: BigInt(parsed.price.price),
      expo: parsed.price.expo,
      publishTimeMs: parsed.price.publish_time * 1000,
    }
  }
  return out
}

/**
 * Convert a Pyth price (signed int + expo) to our oracle's 9-decimal fixed-point u64.
 * Pyth quotes USD with typically expo = -8, so 1 USD = 100_000_000.
 * Our oracle uses expo = -9, so 1 USD = 1_000_000_000.
 */
export function pythPriceTo9Decimal(p: HermesPrice): bigint {
  if (p.price <= 0n) throw new Error("non-positive Pyth price")
  const shift = 9 + p.expo // typically 9 + (-8) = 1
  if (shift >= 0) {
    return p.price * 10n ** BigInt(shift)
  } else {
    return p.price / 10n ** BigInt(-shift)
  }
}
