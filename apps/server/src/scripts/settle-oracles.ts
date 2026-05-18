/**
 * Admin script: settle any expired-but-unsettled FlickyOracles by pushing the
 * latest Pyth spot as the canonical settlement price.
 *
 * Usage (from apps/server):
 *   bun run oracles:settle          # try to settle all 4 oracles
 *   bun run oracles:settle --asset BTC
 *
 * Requires ORACLE_ADMIN_CAP_ID + ADMIN_SECRET_KEY. Oracle must be past expiry
 * (PENDING_SETTLEMENT) — calling on an ACTIVE oracle aborts.
 */
import { Transaction } from "@mysten/sui/transactions"
import { SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils"
import { getAdminKeypair, getSuiClient, requireEnv } from "../lib/sui"
import { fetchPythPrices, pythPriceTo9Decimal, type AssetSymbol } from "../lib/pyth"

const ALL_ASSETS: AssetSymbol[] = ["BTC", "ETH", "SOL", "SUI"]

function parseAssets(): AssetSymbol[] {
  const i = process.argv.indexOf("--asset")
  if (i === -1 || i === process.argv.length - 1) return ALL_ASSETS
  const v = process.argv[i + 1].toUpperCase() as AssetSymbol
  if (!ALL_ASSETS.includes(v)) {
    throw new Error(`unknown asset: ${v} (expected one of ${ALL_ASSETS.join(",")})`)
  }
  return [v]
}

interface OracleSnapshot {
  asset: AssetSymbol
  id: string
  expiry: number
  isSettled: boolean
  active: boolean
}

async function snapshot(client: ReturnType<typeof getSuiClient>, asset: AssetSymbol, id: string): Promise<OracleSnapshot> {
  const obj = await client.getObject({ id, options: { showContent: true } })
  if (obj.data?.content?.dataType !== "moveObject") throw new Error(`oracle ${id} not found`)
  const f = obj.data.content.fields as {
    expiry: string
    settlement: unknown
  }
  return {
    asset,
    id,
    expiry: Number(f.expiry),
    isSettled: f.settlement !== null,
    active: f.settlement === null && Number(f.expiry) > Date.now(),
  }
}

async function main() {
  const packageId = requireEnv("FLICKY_PACKAGE_ID")
  const adminCapId = requireEnv("ORACLE_ADMIN_CAP_ID")
  const client = getSuiClient()
  const keypair = getAdminKeypair()
  const assets = parseAssets()

  const idByAsset: Record<AssetSymbol, string> = {
    BTC: requireEnv("BTC_ORACLE_ID"),
    ETH: requireEnv("ETH_ORACLE_ID"),
    SOL: requireEnv("SOL_ORACLE_ID"),
    SUI: requireEnv("SUI_ORACLE_ID"),
  }

  const snapshots = await Promise.all(
    assets.map((a) => snapshot(client, a, idByAsset[a])),
  )

  const expired = snapshots.filter((s) => !s.isSettled && !s.active)
  const stillActive = snapshots.filter((s) => s.active)
  const alreadySettled = snapshots.filter((s) => s.isSettled)

  if (stillActive.length > 0) {
    console.log("still ACTIVE (skipping):")
    for (const s of stillActive) {
      const remainSec = Math.max(0, Math.floor((s.expiry - Date.now()) / 1000))
      console.log(`  ${s.asset.padEnd(3)} expires in ${remainSec}s — wait for expiry`)
    }
  }
  if (alreadySettled.length > 0) {
    console.log("already SETTLED (skipping):")
    for (const s of alreadySettled) console.log(`  ${s.asset.padEnd(3)} ${s.id}`)
  }
  if (expired.length === 0) {
    console.log("\nnothing to settle.")
    return
  }

  console.log(`\nfetching Pyth settle prices for ${expired.map((s) => s.asset).join(", ")}…`)
  const prices = await fetchPythPrices(expired.map((s) => s.asset))

  for (const s of expired) {
    const p = prices[s.asset]
    const price9 = pythPriceTo9Decimal(p)
    // Source timestamp must be strictly > expiry per oracle.move guard.
    // Use the max of Pyth publish time and expiry+1 to satisfy both:
    // (a) source_timestamp_ms > expiry, (b) source_timestamp_ms <= now.
    const sourceTs = Math.max(p.publishTimeMs, s.expiry + 1)

    const tx = new Transaction()
    tx.moveCall({
      target: `${packageId}::oracle::settle`,
      arguments: [
        tx.object(s.id),
        tx.object(adminCapId),
        tx.pure.u64(price9),
        tx.pure.u64(BigInt(sourceTs)),
        tx.object(SUI_CLOCK_OBJECT_ID),
      ],
    })
    try {
      const res = await client.signAndExecuteTransaction({
        transaction: tx,
        signer: keypair,
        options: { showEffects: true },
      })
      if (res.effects?.status.status !== "success") {
        throw new Error(JSON.stringify(res.effects?.status))
      }
      await client.waitForTransaction({ digest: res.digest })
      const usd = (Number(price9) / 1e9).toFixed(2)
      console.log(`✓ ${s.asset.padEnd(3)} settled @ $${usd}  tx=${res.digest}`)
    } catch (err) {
      console.error(`✗ ${s.asset}: ${err instanceof Error ? err.message : err}`)
    }
  }
}

await main()
