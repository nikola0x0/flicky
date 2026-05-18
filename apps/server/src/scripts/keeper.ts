/**
 * Single-cycle keeper: fetch latest Pyth prices for BTC/ETH/SOL/SUI and push
 * them into each oracle via `update_price`.
 *
 * Usage:
 *   bun run apps/server/src/scripts/keeper.ts          # one cycle
 *   bun run apps/server/src/scripts/keeper.ts --loop    # repeat every 30s
 *
 * For each asset we set `forward = spot` (no futures basis in the POC) and
 * volatility = 60% (the oracle's DEFAULT_VOLATILITY). A real keeper would
 * pull realized vol from a separate feed.
 */
import { getAdminKeypair, getSuiClient, requireEnv } from "../lib/sui"
import { updatePrice } from "../lib/oracle"
import { fetchPythPrices, pythPriceTo9Decimal, type AssetSymbol } from "../lib/pyth"

const ASSETS: AssetSymbol[] = ["BTC", "ETH", "SOL", "SUI"]
const VOLATILITY = 600_000_000n // 60% in 9-decimal — matches oracle DEFAULT_VOLATILITY
const LOOP_INTERVAL_MS = 30_000

async function cycle() {
  const packageId = requireEnv("FLICKY_PACKAGE_ID")
  const adminCapId = requireEnv("ORACLE_ADMIN_CAP_ID")
  const client = getSuiClient()
  const keypair = getAdminKeypair()
  const cfg = { packageId, adminCapId, client, keypair }

  const oracleIds: Record<AssetSymbol, string> = {
    BTC: requireEnv("BTC_ORACLE_ID"),
    ETH: requireEnv("ETH_ORACLE_ID"),
    SOL: requireEnv("SOL_ORACLE_ID"),
    SUI: requireEnv("SUI_ORACLE_ID"),
  }

  const prices = await fetchPythPrices(ASSETS)
  for (const asset of ASSETS) {
    const p = prices[asset]
    const spot9 = pythPriceTo9Decimal(p)
    try {
      const digest = await updatePrice(cfg, oracleIds[asset], {
        spot: spot9,
        forward: spot9,
        volatility: VOLATILITY,
        sourceTimestampMs: BigInt(p.publishTimeMs),
      })
      console.log(
        `[${new Date().toISOString()}] ${asset} spot=$${(Number(spot9) / 1e9).toFixed(2)} digest=${digest}`,
      )
    } catch (err) {
      console.error(`[${asset}] update_price failed:`, err instanceof Error ? err.message : err)
    }
  }
}

async function main() {
  const loop = process.argv.includes("--loop")
  if (!loop) {
    await cycle()
    return
  }
  while (true) {
    await cycle()
    await Bun.sleep(LOOP_INTERVAL_MS)
  }
}

await main()
