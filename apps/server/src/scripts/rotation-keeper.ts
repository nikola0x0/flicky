/**
 * Long-running rotation keeper for Flicky oracles.
 *
 * Replaces the manual `oracles:create + oracles:keeper + oracles:settle` cycle
 * with a single daemon that runs forever and keeps every asset's oracle
 * lifecycle on rails:
 *
 * On every tick (every TICK_INTERVAL_MS):
 *   1. Discover all flicky oracles via OracleCreated events.
 *   2. Settle any oracle whose expiry has passed but isn't settled yet,
 *      using the current Pyth price as the canonical settlement value.
 *   3. Push the latest Pyth spot+forward to every ACTIVE oracle (keeps
 *      `forward_price()` fresh so swipes get meaningful p_swiped).
 *   4. Create a new oracle for any asset whose most-active oracle is
 *      below the rotation threshold (so new duels always have plenty
 *      of TTL ahead of them).
 *
 * Per-asset target state: at any moment, 1-2 oracles ACTIVE, overlapping
 * by ~70% of TTL (default 7-min overlap on a 10-min lifetime).
 *
 * Usage:
 *   bun run oracles:rotation          # default config
 *   ORACLE_TTL_MIN=15 bun run oracles:rotation   # override TTL via env
 */
import { Transaction } from "@mysten/sui/transactions"
import { SUI_CLOCK_OBJECT_ID, normalizeSuiObjectId } from "@mysten/sui/utils"
import type { SuiClient } from "@mysten/sui/client"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { getAdminKeypair, getSuiClient, requireEnv } from "../lib/sui"
import { fetchPythPrices, pythPriceTo9Decimal, type AssetSymbol } from "../lib/pyth"

const ASSETS: AssetSymbol[] = ["BTC", "ETH", "SOL", "SUI"]
const TTL_MIN = Number(process.env.ORACLE_TTL_MIN ?? 10)
const TTL_MS = TTL_MIN * 60_000
const ROTATION_AT_REMAINING_MS = Math.max(60_000, Math.floor(TTL_MS * 0.3))
const TICK_INTERVAL_MS = Number(process.env.TICK_INTERVAL_MS ?? 30_000)
const SETTLEMENT_FRESHNESS_MS = BigInt(Math.max(120_000, Math.floor(TTL_MS * 0.5)))
const MAX_SPOT_DEVIATION = 200_000_000n // 20%
const VOLATILITY = 600_000_000n // 60%
const ONE_E9 = 1_000_000_000n

interface OracleInfo {
  id: string
  asset: AssetSymbol
  expiry: number
  isSettled: boolean
}

function fmtSpot(p: bigint) {
  return `$${(Number(p) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
}

function nowIso() {
  return new Date().toISOString()
}

function buildGrid(spot9: bigint) {
  const minStrike = spot9 / 2n
  const numTicks = 100n
  const tickSize = spot9 / numTicks
  return { minStrike, tickSize, numTicks }
}

async function discoverOracles(
  client: SuiClient,
  packageId: string,
): Promise<Map<AssetSymbol, OracleInfo[]>> {
  // Query the last ~50 OracleCreated events from our package, then resolve
  // each one's current chain state to know settled-ness.
  const events = await client.queryEvents({
    query: { MoveEventType: `${packageId}::oracle::OracleCreated` },
    limit: 50,
    order: "descending",
  })
  const out = new Map<AssetSymbol, OracleInfo[]>()
  for (const asset of ASSETS) out.set(asset, [])

  const interesting = events.data.filter((e) => {
    const p = e.parsedJson as { asset: string; expiry: string }
    return ASSETS.includes(p.asset as AssetSymbol)
  })
  if (interesting.length === 0) return out

  const objs = await client.multiGetObjects({
    ids: interesting.map((e) => (e.parsedJson as { oracle_id: string }).oracle_id),
    options: { showContent: true },
  })
  for (let i = 0; i < interesting.length; i++) {
    const p = interesting[i].parsedJson as {
      oracle_id: string
      asset: AssetSymbol
      expiry: string
    }
    const obj = objs[i]
    if (obj.data?.content?.dataType !== "moveObject") continue
    const f = obj.data.content.fields as { settlement: unknown }
    out.get(p.asset)!.push({
      id: normalizeSuiObjectId(p.oracle_id),
      asset: p.asset,
      expiry: Number(p.expiry),
      isSettled: f.settlement !== null,
    })
  }
  // Most-recent first per asset (events were already descending by tx time).
  return out
}

async function submit(
  client: SuiClient,
  keypair: Ed25519Keypair,
  tx: Transaction,
  label: string,
): Promise<string | null> {
  try {
    const res = await client.signAndExecuteTransaction({
      transaction: tx,
      signer: keypair,
      options: { showEffects: true },
    })
    if (res.effects?.status.status !== "success") {
      console.error(`[${nowIso()}] ${label} FAILED: ${JSON.stringify(res.effects?.status)}`)
      return null
    }
    await client.waitForTransaction({ digest: res.digest })
    return res.digest
  } catch (err) {
    console.error(`[${nowIso()}] ${label} error:`, err instanceof Error ? err.message : err)
    return null
  }
}

async function tick(
  client: SuiClient,
  keypair: Ed25519Keypair,
  packageId: string,
  adminCapId: string,
) {
  const now = Date.now()

  // 1. Fetch live Pyth spots once for the tick.
  let prices
  try {
    prices = await fetchPythPrices(ASSETS)
  } catch (err) {
    console.error(`[${nowIso()}] Pyth fetch failed:`, err instanceof Error ? err.message : err)
    return
  }

  const oraclesByAsset = await discoverOracles(client, packageId)

  // 2. Settle any expired-but-not-settled oracles. Source timestamp must be
  // strictly > oracle.expiry and within settlement_freshness window.
  const toSettle = [...oraclesByAsset.values()]
    .flat()
    .filter((o) => !o.isSettled && o.expiry < now)
  if (toSettle.length > 0) {
    const tx = new Transaction()
    for (const o of toSettle) {
      const p = prices[o.asset]
      const price9 = pythPriceTo9Decimal(p)
      const sourceTs = Math.max(p.publishTimeMs, o.expiry + 1)
      tx.moveCall({
        target: `${packageId}::oracle::settle`,
        arguments: [
          tx.object(o.id),
          tx.object(adminCapId),
          tx.pure.u64(price9),
          tx.pure.u64(BigInt(sourceTs)),
          tx.object(SUI_CLOCK_OBJECT_ID),
        ],
      })
    }
    const digest = await submit(client, keypair, tx, `settle ${toSettle.length}`)
    if (digest)
      console.log(
        `[${nowIso()}] settled ${toSettle.length} oracle(s): ${toSettle.map((o) => `${o.asset}(${o.id.slice(0, 8)})`).join(" ")} · ${digest.slice(0, 10)}`,
      )
  }

  // 3. Push live price to every still-active oracle (expiry in the future).
  const toUpdate = [...oraclesByAsset.values()]
    .flat()
    .filter((o) => !o.isSettled && o.expiry > now)
  if (toUpdate.length > 0) {
    const tx = new Transaction()
    for (const o of toUpdate) {
      const p = prices[o.asset]
      const price9 = pythPriceTo9Decimal(p)
      tx.moveCall({
        target: `${packageId}::oracle::update_price`,
        arguments: [
          tx.object(o.id),
          tx.object(adminCapId),
          tx.pure.u64(price9),
          tx.pure.u64(price9),
          tx.pure.u64(VOLATILITY),
          tx.pure.u64(BigInt(p.publishTimeMs)),
          tx.object(SUI_CLOCK_OBJECT_ID),
        ],
      })
    }
    const digest = await submit(client, keypair, tx, `update ${toUpdate.length}`)
    if (digest)
      console.log(
        `[${nowIso()}] pushed price to ${toUpdate.length} oracle(s) · ${digest.slice(0, 10)}`,
      )
  }

  // 4. Create new oracle for any asset whose freshest active oracle is below
  //    the rotation threshold. Uses current Pyth spot to size the strike grid.
  const toCreate: AssetSymbol[] = []
  for (const asset of ASSETS) {
    const active = (oraclesByAsset.get(asset) ?? []).filter(
      (o) => !o.isSettled && o.expiry > now,
    )
    const maxRemain = active.reduce((m, o) => Math.max(m, o.expiry - now), 0)
    if (maxRemain < ROTATION_AT_REMAINING_MS) toCreate.push(asset)
  }
  if (toCreate.length > 0) {
    const tx = new Transaction()
    const expiryMs = BigInt(now + TTL_MS)
    for (const asset of toCreate) {
      const p = prices[asset]
      const spot9 = pythPriceTo9Decimal(p)
      const grid = buildGrid(spot9)
      tx.moveCall({
        target: `${packageId}::oracle::create_oracle`,
        arguments: [
          tx.object(adminCapId),
          tx.pure.string(asset),
          tx.pure.u64(expiryMs),
          tx.pure.u64(grid.minStrike),
          tx.pure.u64(grid.tickSize),
          tx.pure.u64(grid.numTicks),
          tx.pure.u64(SETTLEMENT_FRESHNESS_MS),
          tx.pure.u64(MAX_SPOT_DEVIATION),
          tx.object(SUI_CLOCK_OBJECT_ID),
        ],
      })
    }
    const digest = await submit(client, keypair, tx, `create ${toCreate.length}`)
    if (digest)
      console.log(
        `[${nowIso()}] created ${toCreate.length} oracle(s): ${toCreate.join(",")} · expiry ${new Date(Number(expiryMs)).toISOString()} · ${digest.slice(0, 10)}`,
      )
  }

  if (toSettle.length === 0 && toUpdate.length === 0 && toCreate.length === 0) {
    void ONE_E9
    console.log(
      `[${nowIso()}] tick idle · ${ASSETS.map((a) => `${a}=${fmtSpot(pythPriceTo9Decimal(prices[a]))}`).join(" ")}`,
    )
  }
}

async function main() {
  const packageId = requireEnv("FLICKY_PACKAGE_ID")
  const adminCapId = requireEnv("ORACLE_ADMIN_CAP_ID")
  const client = getSuiClient()
  const keypair = getAdminKeypair()
  console.log(`[${nowIso()}] rotation-keeper starting`)
  console.log(`  package:      ${packageId}`)
  console.log(`  admin cap:    ${adminCapId}`)
  console.log(`  admin:        ${keypair.toSuiAddress()}`)
  console.log(`  ttl/oracle:   ${TTL_MIN}min  rotation at: ${ROTATION_AT_REMAINING_MS / 60_000}min remaining`)
  console.log(`  tick:         ${TICK_INTERVAL_MS / 1000}s`)
  console.log("")

  while (true) {
    const t0 = Date.now()
    try {
      await tick(client, keypair, packageId, adminCapId)
    } catch (err) {
      console.error(`[${nowIso()}] tick crashed:`, err instanceof Error ? err.message : err)
    }
    const elapsed = Date.now() - t0
    const wait = Math.max(0, TICK_INTERVAL_MS - elapsed)
    await Bun.sleep(wait)
  }
}

await main()
