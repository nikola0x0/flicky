/**
 * Read state for each oracle + sample 5 implied UP probabilities across the
 * strike grid. Useful to sanity-check that the keeper has pushed and that
 * the probability surface looks reasonable.
 *
 * Usage:
 *   bun run apps/server/src/scripts/read-oracles.ts
 */
import { getSuiClient, requireEnv } from "../lib/sui"
import { impliedProbabilityUp, readOracleState } from "../lib/oracle"
import type { AssetSymbol } from "../lib/pyth"

const ASSETS: AssetSymbol[] = ["BTC", "ETH", "SOL", "SUI"]

function fmtUsd(n9: bigint): string {
  return `$${(Number(n9) / 1e9).toFixed(2)}`
}

function fmtPct(p9: bigint): string {
  return `${(Number(p9) / 1e7).toFixed(2)}%`
}

function statusLabel(s: number): string {
  return s === 1 ? "ACTIVE" : s === 2 ? "PENDING_SETTLEMENT" : "SETTLED"
}

async function main() {
  const packageId = requireEnv("FLICKY_PACKAGE_ID")
  const client = getSuiClient()
  const oracleIds: Record<AssetSymbol, string> = {
    BTC: requireEnv("BTC_ORACLE_ID"),
    ETH: requireEnv("ETH_ORACLE_ID"),
    SOL: requireEnv("SOL_ORACLE_ID"),
    SUI: requireEnv("SUI_ORACLE_ID"),
  }

  for (const asset of ASSETS) {
    const oracleId = oracleIds[asset]
    const state = await readOracleState(client, packageId, oracleId)
    console.log(`\n=== ${asset}  (${oracleId.slice(0, 10)}…)`)
    console.log(
      `  status=${statusLabel(state.status)}  spot=${fmtUsd(state.spot)}  forward=${fmtUsd(state.forward)}`,
    )
    console.log(`  expiry=${new Date(Number(state.expiry)).toISOString()}`)
    console.log(`  last source push: ${new Date(Number(state.priceSourceTimestampMs)).toISOString()}`)
    console.log(`  grid: ${fmtUsd(state.minStrike)} – ${fmtUsd(state.maxStrike)} (${state.numTicks} ticks)`)

    if (state.spot === 0n) {
      console.log("  (no price seeded yet — run keeper.ts)")
      continue
    }

    // Sample 5 strikes evenly across the grid.
    const probs: Array<{ strike: bigint; pUp: bigint }> = []
    for (let i = 0; i < 5; i++) {
      const strike =
        state.minStrike + ((state.maxStrike - state.minStrike) * BigInt(i)) / 4n
      const pUp = await impliedProbabilityUp(client, packageId, oracleId, strike)
      probs.push({ strike, pUp })
    }
    console.log("  implied p(UP) across grid:")
    for (const { strike, pUp } of probs) {
      console.log(`    strike=${fmtUsd(strike).padStart(12)}   p(UP)=${fmtPct(pUp).padStart(7)}`)
    }
  }
}

await main()
