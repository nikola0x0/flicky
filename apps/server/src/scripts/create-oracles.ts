/**
 * Create one FlickyOracle per supported asset on testnet.
 *
 * Usage:
 *   bun run apps/server/src/scripts/create-oracles.ts [--ttl <minutes>]
 *
 * Examples:
 *   bun run oracles:create              # default 75-minute TTL (DeepBook cadence)
 *   bun run oracles:create --ttl 5      # 5-minute TTL for quick local testing
 *
 * Reads FLICKY_PACKAGE_ID, ORACLE_ADMIN_CAP_ID, ADMIN_SECRET_KEY from env.
 * Prints `<SYMBOL>_ORACLE_ID=<id>` for each created oracle — paste into .env.
 */
import { getAdminKeypair, getSuiClient, requireEnv } from "../lib/sui"
import { createOracles, type CreateOracleArgs } from "../lib/oracle"
import { fetchPythPrices, pythPriceTo9Decimal, type AssetSymbol } from "../lib/pyth"

const ASSETS: AssetSymbol[] = ["BTC", "ETH", "SOL", "SUI"]
const DEFAULT_TTL_MINUTES = 75
const MAX_SPOT_DEVIATION = 200_000_000n // 20% in 9-decimal
const ONE_E9 = 1_000_000_000n

function parseTtlMinutes(): number {
  const argv = process.argv
  const i = argv.indexOf("--ttl")
  if (i === -1 || i === argv.length - 1) return DEFAULT_TTL_MINUTES
  const v = Number(argv[i + 1])
  if (!Number.isFinite(v) || v <= 0) {
    throw new Error(`invalid --ttl: ${argv[i + 1]} (must be positive number of minutes)`)
  }
  return v
}

// Strike grid sized to ±50% around spot, 100 ticks total.
function buildGrid(spot9: bigint): { minStrike: bigint; tickSize: bigint; numTicks: bigint } {
  const minStrike = spot9 / 2n // 50% of spot
  const range = spot9 // ±50% means range = spot
  const numTicks = 100n
  const tickSize = range / numTicks
  return { minStrike, tickSize, numTicks }
}

async function main() {
  const packageId = requireEnv("FLICKY_PACKAGE_ID")
  const adminCapId = requireEnv("ORACLE_ADMIN_CAP_ID")
  const client = getSuiClient()
  const keypair = getAdminKeypair()
  const cfg = { packageId, adminCapId, client, keypair }

  const ttlMin = parseTtlMinutes()
  // Settlement freshness must comfortably cover the swipe window — use the
  // larger of 60s or 1/5 of the TTL so 5-minute test oracles don't trip the
  // freshness guard during settle.
  const settlementFreshnessMs =
    BigInt(Math.max(60_000, Math.floor((ttlMin * 60_000) / 5)))

  console.log(`admin address: ${keypair.toSuiAddress()}`)
  console.log(`TTL: ${ttlMin}min · settlement freshness: ${Number(settlementFreshnessMs) / 1000}s`)
  console.log(`fetching Pyth spots for ${ASSETS.join(", ")}...`)
  const prices = await fetchPythPrices(ASSETS)

  const expiryMs = BigInt(Date.now() + ttlMin * 60_000)
  console.log(`expiry: ${new Date(Number(expiryMs)).toISOString()}`)

  const argsList: CreateOracleArgs[] = ASSETS.map((asset) => {
    const spot9 = pythPriceTo9Decimal(prices[asset])
    const grid = buildGrid(spot9)
    return {
      asset,
      expiryMs,
      minStrike: grid.minStrike,
      tickSize: grid.tickSize,
      numTicks: grid.numTicks,
      settlementFreshnessMs,
      maxSpotDeviation: MAX_SPOT_DEVIATION,
    }
  })

  const oracleIds = await createOracles(cfg, argsList)

  for (let i = 0; i < ASSETS.length; i++) {
    const asset = ASSETS[i]
    const args = argsList[i]
    const oracleId = oracleIds[asset]
    if (!oracleId) throw new Error(`missing oracle id for ${asset}`)
    const spot9 = pythPriceTo9Decimal(prices[asset])
    const spotUsd = Number(spot9) / Number(ONE_E9)
    const minUsd = Number(args.minStrike) / Number(ONE_E9)
    const maxUsd = (Number(args.minStrike) + Number(args.tickSize) * Number(args.numTicks)) / Number(ONE_E9)
    console.log(
      `${asset}_ORACLE_ID=${oracleId}   # spot≈$${spotUsd.toFixed(2)}, grid=$${minUsd.toFixed(2)}–$${maxUsd.toFixed(2)}`,
    )
  }
}

await main()
