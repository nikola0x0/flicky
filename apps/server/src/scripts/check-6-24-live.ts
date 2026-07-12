/**
 * Deploy-gate verification for the DeepBook Predict 6-24 migration.
 *
 * Confirms the ids baked into `env.ts` actually resolve on testnet and the
 * off-chain surfaces the server depends on (predict indexer `/markets`,
 * the `cashflow.net_premium` field the keeper's `readOrderPremium` reads,
 * `load_live_pricer` feed freshness) are structurally live — before
 * running the E2E duel flow against them.
 *
 * Gates 1-2 are HARD: any failure exits non-zero. Gates 3-4 are SOFT
 * (⚠️ not ❌) — they probe shapes/freshness that can legitimately be empty
 * or transiently stale without meaning the deploy is broken.
 *
 * Usage (from apps/server): bun run check:6-24
 */
import { Transaction } from "@mysten/sui/transactions"
import { normalizeSuiAddress } from "@mysten/sui/utils"
import { getSuiClient } from "../lib/sui"
import { env } from "../env"
import type { MarketRow } from "../deckmaster"

const client = getSuiClient()

let hardFailures = 0

function pass(msg: string) {
  console.log(`✅ ${msg}`)
}
function fail(msg: string) {
  console.log(`❌ ${msg}`)
  hardFailures++
}
function warn(msg: string) {
  console.log(`⚠️  ${msg}`)
}

console.log(`network:            ${env.network}`)
console.log(`predictIndexerUrl:  ${env.predictIndexerUrl}`)
console.log()

// ─── Gate 1 (hard): 6-24 shared objects resolve with the expected type ───

console.log("── Gate 1: shared object resolution (gRPC getObject) ──")

const OBJECTS: Array<{ label: string; id: string; expectSubstr: string }> = [
  {
    label: "ProtocolConfig",
    id: env.protocolConfigId,
    expectSubstr: "protocol_config::ProtocolConfig",
  },
  {
    label: "AccountRegistry",
    id: env.accountRegistryId,
    expectSubstr: "account_registry::AccountRegistry",
  },
  {
    label: "OracleRegistry",
    id: env.oracleRegistryId,
    expectSubstr: "registry::OracleRegistry",
  },
  {
    label: "PoolVault",
    id: env.poolVaultId,
    expectSubstr: "plp::PoolVault",
  },
  {
    label: "AccumulatorRoot",
    id: env.accumulatorRootId,
    expectSubstr: "accumulator::AccumulatorRoot",
  },
]

for (const o of OBJECTS) {
  try {
    const res = await client.core.getObject({ objectId: o.id })
    // gRPC `Object.type` — the CLI's `objType` field; the TS gRPC client
    // surfaces it as `.object.type` (confirmed against
    // node_modules/@mysten/sui/dist/client/types.d.mts `interface Object`).
    const objType = res.object.type
    if (objType.includes(o.expectSubstr)) {
      pass(`${o.label.padEnd(16)} ${o.id.slice(0, 14)}…  type=${objType}`)
    } else {
      fail(
        `${o.label.padEnd(16)} ${o.id.slice(0, 14)}…  type=${objType}  (expected substring "${o.expectSubstr}")`
      )
    }
  } catch (e) {
    fail(
      `${o.label.padEnd(16)} ${o.id.slice(0, 14)}…  getObject failed: ${e instanceof Error ? e.message : String(e)}`
    )
  }
}
console.log()

// ─── Gate 2 (hard): predict indexer has ≥1 live BTC market ───

console.log("── Gate 2: predict indexer /markets — live BTC markets ──")

let liveMarkets: MarketRow[] = []
try {
  const res = await fetch(`${env.predictIndexerUrl}/markets`)
  if (!res.ok) {
    fail(`GET /markets → HTTP ${res.status}`)
  } else {
    const rows = (await res.json()) as MarketRow[]
    const now = Date.now()
    liveMarkets = rows.filter(
      (r) => r.propbook_underlying_id === 1 && Number(r.expiry) > now
    )
    if (liveMarkets.length >= 1) {
      const soonest = liveMarkets.reduce((a, b) =>
        Number(a.expiry) < Number(b.expiry) ? a : b
      )
      const remainingMin = Math.floor((Number(soonest.expiry) - now) / 60_000)
      pass(
        `${liveMarkets.length} live BTC market(s) (propbook_underlying_id=1, expiry>now); soonest expiry in ~${remainingMin}min (${soonest.expiry_market_id.slice(0, 14)}…)`
      )
    } else {
      fail(
        `0 live BTC markets in ${rows.length} total /markets rows (propbook_underlying_id=1 && expiry>now)`
      )
    }
  }
} catch (e) {
  fail(`GET /markets failed: ${e instanceof Error ? e.message : String(e)}`)
}
console.log()

// ─── Gate 3 (soft): cashflow.net_premium field probe ───

console.log("── Gate 3 (soft): cashflow endpoint — net_premium field probe ──")

if (liveMarkets.length === 0) {
  warn("skipped — no live market id available from gate 2")
} else {
  const probeMarketId = liveMarkets[0].expiry_market_id
  const probeOrderId = 1
  const url = `${env.predictIndexerUrl}/markets/${probeMarketId}/positions/${probeOrderId}/cashflow`
  try {
    const res = await fetch(url)
    const bodyText = await res.text()
    let parsed: unknown = bodyText
    try {
      parsed = JSON.parse(bodyText)
    } catch {
      // leave as raw text
    }
    console.log(`  GET ${url}`)
    console.log(`  HTTP ${res.status}`)
    console.log(`  body: ${JSON.stringify(parsed)}`)
    const hasNetPremium = containsKey(parsed, "net_premium")
    if (hasNetPremium) {
      pass("net_premium field present in response")
    } else {
      warn(
        "net_premium field NOT observed in response (may be empty/no such order — endpoint shape unconfirmed for this probe)"
      )
    }
  } catch (e) {
    warn(`GET cashflow failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}
console.log()

/** Recursively search `value` (bounded depth) for an own property named `key`. */
function containsKey(value: unknown, key: string, depth = 0): boolean {
  if (depth > 4 || value == null || typeof value !== "object") return false
  if (Array.isArray(value)) {
    return value.some((v) => containsKey(v, key, depth + 1))
  }
  const obj = value as Record<string, unknown>
  if (Object.prototype.hasOwnProperty.call(obj, key)) return true
  return Object.values(obj).some((v) => containsKey(v, key, depth + 1))
}

// ─── Gate 4 (soft): feed freshness via load_live_pricer devInspect ───

console.log("── Gate 4 (soft): load_live_pricer devInspect (feed freshness) ──")

if (liveMarkets.length === 0) {
  warn("skipped — no live market id available from gate 2")
} else {
  const marketId = liveMarkets[0].expiry_market_id
  const dummySender = normalizeSuiAddress("0x1")
  try {
    const tx = new Transaction()
    tx.moveCall({
      target: `${env.deepbookPredictPackageId}::expiry_market::load_live_pricer`,
      arguments: [
        tx.object(marketId),
        tx.object(env.protocolConfigId),
        tx.object(env.oracleRegistryId),
        tx.object(env.pythFeedId),
        tx.object(env.bsSpotFeedId),
        tx.object(env.bsForwardFeedId),
        tx.object(env.bsSviFeedId),
        tx.object("0x6"),
      ],
    })
    tx.setSender(dummySender)
    const res = await client.core.simulateTransaction({
      transaction: tx,
      include: { effects: true },
    })
    if (res.$kind === "Transaction") {
      pass(
        `load_live_pricer devInspect succeeded against ${marketId.slice(0, 14)}… (feeds live)`
      )
    } else {
      const err = res.FailedTransaction.effects?.status
      const reason =
        err && !err.success ? err.error.message : "(no effects status)"
      warn(
        `load_live_pricer devInspect FAILED against ${marketId.slice(0, 14)}…: ${reason}`
      )
    }
  } catch (e) {
    warn(
      `load_live_pricer devInspect threw: ${e instanceof Error ? e.message : String(e)}`
    )
  }
}
console.log()

// ─── Summary ───

if (hardFailures > 0) {
  console.log(`RESULT: ${hardFailures} hard gate failure(s) — deploy NOT ready.`)
  process.exit(1)
} else {
  console.log("RESULT: all hard gates passed.")
}
