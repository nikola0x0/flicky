// LEGACY 4-16 diagnostic — not migrated to 6-24 (see Plan 2)
/**
 * Inspect the deployed DeepBook Predict objects on testnet and print the
 * derived address graph (transitive deps, live BTC MarketOracle, configs)
 * needed to wire flicky::duel into DeepBook.
 *
 * Usage (from apps/server):
 *   bun run src/scripts/deepbook-discover.ts
 */
import type { GrpcTypes } from "@mysten/sui/grpc"
import { getGraphQLClient, getSuiClient } from "../lib/sui"

const PREDICT_PACKAGE =
  "0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138"
const PREDICT_REGISTRY =
  "0x43af14fed5480c20ff77e2263d5f794c35b9fab7e2212903127062f4fe2a6e64"
const PREDICT_OBJECT =
  "0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a"

async function describe(label: string, id: string) {
  const client = getSuiClient()
  console.log(`\n── ${label}  ${id}`)
  let obj
  try {
    obj = await client.core.getObject({ objectId: id, include: { json: true } })
  } catch {
    console.log("  (not found)")
    return
  }
  const data = obj.object
  console.log(`  type:  ${data.type}`)
  console.log(`  owner: ${JSON.stringify(data.owner)}`)
  // gRPC json is a FLAT Move-struct representation (no `content.fields` wrapper).
  if (data.json) {
    for (const [k, v] of Object.entries(data.json)) {
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
  const gql = getGraphQLClient()
  console.log("\n── recent MarketOracle events (last 10) ──")
  // gRPC has no filtered event API — event scans go through GraphQL, mirroring
  // keeper.ts / indexer.ts. The tx digest the old JSON-RPC dump printed is
  // cosmetic and isn't selected here (the repo's GraphQL event queries only
  // pull `contents { json }`), so we just print the parsed event body.
  for (const evtType of [
    `${PREDICT_PACKAGE}::market_oracle::MarketOracleSettled`,
    `${PREDICT_PACKAGE}::registry::MarketOracleCreated`,
    `${PREDICT_PACKAGE}::registry::OracleCreated`,
  ]) {
    try {
      const res = (await gql.query({
        query: `query Ev($type: String!) {
          events(filter: { type: $type }, last: 5) {
            nodes { contents { json } }
          }
        }`,
        variables: { type: evtType },
      })) as {
        data?: {
          events?: {
            nodes?: Array<{ contents: { json: Record<string, unknown> } }>
          }
        }
      }
      const nodes = res.data?.events?.nodes ?? []
      if (nodes.length === 0) continue
      console.log(`  ${evtType}:`)
      for (const node of nodes) {
        console.log(`    ${JSON.stringify(node.contents.json)}`)
      }
    } catch (err) {
      console.log(`  ${evtType}: ${err instanceof Error ? err.message : err}`)
    }
  }
}

async function discoverPackageDeps() {
  const client = getSuiClient()
  console.log(`\n── Predict package linkage (deps) ──`)
  // JSON-RPC's sui_getNormalizedMoveModulesByPackage has no `client.core`
  // equivalent. The gRPC MovePackageService.getPackage returns the full module
  // graph (modules → public functions → open type signatures), so we walk each
  // function's parameter/return signatures and collect the *defining package*
  // address of every datatype they reference (the `<addr>::mod::Name` prefix of
  // each open-signature `typeName`) — the same dependency set the old
  // exposedFunctions walk produced.
  try {
    const { package: pkg } = await client.movePackageService.getPackage({
      packageId: PREDICT_PACKAGE,
    }).response
    if (!pkg) {
      console.log("  (package not found)")
      return
    }
    const depAddrs = new Set<string>()
    for (const m of pkg.modules) {
      for (const fn of m.functions) {
        for (const sig of [...fn.parameters, ...fn.returns]) {
          collectAddrs(sig.body, depAddrs)
        }
      }
    }
    depAddrs.delete(PREDICT_PACKAGE.replace(/^0x/, "").padStart(64, "0"))
    depAddrs.delete(
      "0000000000000000000000000000000000000000000000000000000000000001"
    )
    depAddrs.delete(
      "0000000000000000000000000000000000000000000000000000000000000002"
    )
    console.log(
      "  external addrs referenced by predict's public fn signatures:"
    )
    for (const a of depAddrs) console.log(`    0x${a}`)
    console.log(
      `  (${pkg.modules.length} modules: ${pkg.modules.map((m) => m.name ?? "?").join(", ")})`
    )
  } catch (err) {
    console.log("  failed:", err instanceof Error ? err.message : err)
  }
}

function collectAddrs(
  body: GrpcTypes.OpenSignatureBody | undefined,
  out: Set<string>
) {
  if (!body) return
  if (body.typeName) {
    // typeName is `<defining_id>::<module>::<name>` — take the defining pkg addr.
    const addr = body.typeName
      .split("::")[0]
      ?.replace(/^0x/, "")
      .padStart(64, "0")
    if (addr) out.add(addr)
  }
  for (const inner of body.typeParameterInstantiation) collectAddrs(inner, out)
}

await describe("Predict (shared)", PREDICT_OBJECT)
await describe("PredictRegistry (shared)", PREDICT_REGISTRY)
await discoverPackageDeps()
await discoverLiveMarketOracles()
