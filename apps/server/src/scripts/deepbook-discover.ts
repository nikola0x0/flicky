/**
 * Inspect the deployed DeepBook Predict objects on testnet and print the
 * derived address graph (transitive deps, live BTC MarketOracle, configs)
 * needed to wire flicky::duel into DeepBook.
 *
 * Usage (from apps/server):
 *   bun run src/scripts/deepbook-discover.ts
 */
import { getSuiClient } from "../lib/sui"

const PREDICT_PACKAGE = "0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138"
const PREDICT_REGISTRY = "0x43af14fed5480c20ff77e2263d5f794c35b9fab7e2212903127062f4fe2a6e64"
const PREDICT_OBJECT = "0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a"

async function describe(label: string, id: string) {
  const client = getSuiClient()
  console.log(`\n── ${label}  ${id}`)
  const obj = await client.getObject({
    id,
    options: { showContent: true, showType: true, showOwner: true },
  })
  if (!obj.data) {
    console.log("  (not found)")
    return
  }
  console.log(`  type:  ${obj.data.type}`)
  console.log(`  owner: ${JSON.stringify(obj.data.owner)}`)
  if (obj.data.content?.dataType === "moveObject") {
    const fields = obj.data.content.fields as Record<string, unknown>
    for (const [k, v] of Object.entries(fields)) {
      console.log(`  ${k}: ${preview(v)}`)
    }
  }
}

function preview(v: unknown): string {
  if (v === null || v === undefined) return String(v)
  if (typeof v === "string") return v.length > 96 ? v.slice(0, 96) + "…" : v
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  if (Array.isArray(v))
    return v.length > 6 ? `[${v.length} items]` : JSON.stringify(v)
  // Nested move struct
  const obj = v as Record<string, unknown>
  if ("id" in obj && typeof (obj as { id: { id?: string } }).id === "object") {
    return `<id: ${(obj as { id: { id: string } }).id.id}>`
  }
  return JSON.stringify(obj).slice(0, 200)
}

async function discoverLiveMarketOracles() {
  const client = getSuiClient()
  console.log("\n── recent MarketOracle events (last 10) ──")
  for (const evtType of [
    `${PREDICT_PACKAGE}::market_oracle::MarketOracleSettled`,
    `${PREDICT_PACKAGE}::registry::MarketOracleCreated`,
    `${PREDICT_PACKAGE}::registry::OracleCreated`,
  ]) {
    try {
      const evts = await client.queryEvents({
        query: { MoveEventType: evtType },
        limit: 5,
        order: "descending",
      })
      if (evts.data.length === 0) continue
      console.log(`  ${evtType}:`)
      for (const e of evts.data) {
        console.log(
          `    tx=${e.id.txDigest.slice(0, 10)}…  ${JSON.stringify(e.parsedJson)}`,
        )
      }
    } catch (err) {
      console.log(`  ${evtType}: ${err instanceof Error ? err.message : err}`)
    }
  }
}

async function discoverPackageDeps() {
  const client = getSuiClient()
  console.log(`\n── Predict package linkage (deps) ──`)
  // sui_getNormalizedMoveModulesByPackage returns module info including
  // friend_modules + module dependencies, with package addresses for each.
  try {
    const modules = await client.getNormalizedMoveModulesByPackage({
      package: PREDICT_PACKAGE,
    })
    const depAddrs = new Set<string>()
    for (const m of Object.values(modules)) {
      for (const fn of Object.values(m.exposedFunctions ?? {})) {
        for (const t of [...(fn.parameters ?? []), ...(fn.return ?? [])]) {
          collectAddrs(t, depAddrs)
        }
      }
    }
    depAddrs.delete(PREDICT_PACKAGE.replace(/^0x/, ""))
    depAddrs.delete("0000000000000000000000000000000000000000000000000000000000000001")
    depAddrs.delete("0000000000000000000000000000000000000000000000000000000000000002")
    console.log("  external addrs referenced by predict's public fn signatures:")
    for (const a of depAddrs) console.log(`    0x${a}`)
  } catch (err) {
    console.log("  failed:", err instanceof Error ? err.message : err)
  }
}

function collectAddrs(t: unknown, out: Set<string>) {
  if (!t || typeof t !== "object") return
  const obj = t as Record<string, unknown>
  if (typeof obj.Struct === "object" && obj.Struct !== null) {
    const s = obj.Struct as { address: string; typeArguments?: unknown[] }
    out.add(s.address.replace(/^0x/, "").padStart(64, "0"))
    for (const ta of s.typeArguments ?? []) collectAddrs(ta, out)
  }
  if (obj.Reference) collectAddrs(obj.Reference, out)
  if (obj.MutableReference) collectAddrs(obj.MutableReference, out)
  if (obj.Vector) collectAddrs(obj.Vector, out)
}

await describe("Predict (shared)", PREDICT_OBJECT)
await describe("PredictRegistry (shared)", PREDICT_REGISTRY)
await discoverPackageDeps()
await discoverLiveMarketOracles()
