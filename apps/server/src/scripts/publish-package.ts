/**
 * Publish the flicky Move package as a fresh package (not an upgrade).
 *
 * Use this when:
 *   - Local Sui CLI is too old for `sui client publish`.
 *   - You've added new modules and an SDK upgrade is fighting digest checks.
 *   - You want to start fresh (loses upgrade-cap continuity from the old
 *     package; the old objects remain but reference the old code).
 *
 * After success, update `.env`:
 *   FLICKY_PACKAGE_ID=<new package id>
 *   UPGRADE_CAP_ID=<new upgrade cap id>
 *   ORACLE_ADMIN_CAP_ID=<new oracle admin cap from init()>
 * Then re-run `oracles:create` to mint fresh oracles under the new package.
 *
 * Usage (from apps/server):
 *   bun run src/scripts/publish-package.ts
 */
import { execSync } from "node:child_process"
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs"
import { Transaction } from "@mysten/sui/transactions"
import { getAdminKeypair, getSuiClient } from "../lib/sui"

interface BuildOutput {
  modules: string[]
  dependencies: string[]
  digest: number[]
}

/**
 * Build the package with `flicky = "0x0"` self-address. Stash Published.toml
 * during the build so the CLI doesn't substitute the previous publish's
 * address into our module bytecode.
 */
function buildPackage(): BuildOutput {
  const packageDir = `${process.cwd()}/../../move/flicky`
  const publishedPath = `${packageDir}/Published.toml`
  let stashed: string | null = null
  if (existsSync(publishedPath)) {
    stashed = readFileSync(publishedPath, "utf8")
    unlinkSync(publishedPath)
  }
  try {
    const json = execSync(
      `sui move build --dump-bytecode-as-base64 --path ${packageDir}`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
    )
    const line = json.trim().split("\n").pop() ?? ""
    return JSON.parse(line) as BuildOutput
  } finally {
    if (stashed !== null) {
      writeFileSync(publishedPath, stashed)
    }
  }
}

async function main() {
  const client = getSuiClient()
  const keypair = getAdminKeypair()

  console.log("building package…")
  const { modules, dependencies } = buildPackage()
  // Sui requires the *transitive closure* of all dep package addresses in
  // the publish tx, even those flicky doesn't reference directly. deepbook_predict
  // was published with linkage to deepbook + token, so they're inherited.
  const TRANSITIVE = [
    "0x74cd5657843c627f3d80f713b71e9f895bbbeb470956d8a8e1185badf6cc77c8", // deepbook latest (testnet)
    "0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8", // token (testnet)
  ]
  const deps = Array.from(new Set([...dependencies, ...TRANSITIVE]))
  console.log(`  modules: ${modules.length}, deps:`)
  for (const d of deps) console.log(`    ${d}`)

  const tx = new Transaction()
  tx.setGasBudget(500_000_000)
  const upgradeCap = tx.publish({ modules, dependencies: deps })
  // Transfer the UpgradeCap to the publisher.
  tx.transferObjects([upgradeCap], tx.pure.address(keypair.toSuiAddress()))

  console.log("submitting publish…")
  const res = await client.signAndExecuteTransaction({
    transaction: tx,
    signer: keypair,
    options: { showObjectChanges: true, showEffects: true },
  })
  if (res.effects?.status.status !== "success") {
    throw new Error(`publish failed: ${JSON.stringify(res.effects?.status)}`)
  }
  await client.waitForTransaction({ digest: res.digest })

  const published = res.objectChanges?.find((c) => c.type === "published")
  if (!published || published.type !== "published") {
    throw new Error("no published change in tx")
  }
  const packageId = published.packageId

  const upgradeCapChange = res.objectChanges?.find(
    (c) => c.type === "created" && c.objectType === "0x2::package::UpgradeCap",
  )
  const oracleAdminCap = res.objectChanges?.find(
    (c) => c.type === "created" && c.objectType.endsWith("::oracle::OracleAdminCap"),
  )

  console.log(`\npublished! new ids:`)
  console.log(`FLICKY_PACKAGE_ID=${packageId}`)
  if (upgradeCapChange && upgradeCapChange.type === "created") {
    console.log(`UPGRADE_CAP_ID=${upgradeCapChange.objectId}`)
  }
  if (oracleAdminCap && oracleAdminCap.type === "created") {
    console.log(`ORACLE_ADMIN_CAP_ID=${oracleAdminCap.objectId}`)
  }
  console.log(`\ntx digest: ${res.digest}`)
}

await main()
