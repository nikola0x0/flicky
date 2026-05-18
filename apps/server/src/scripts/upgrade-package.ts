/**
 * Upgrade the deployed flicky Move package via SDK. Bypasses `sui client
 * upgrade` so this works even when the local CLI is older than the network
 * protocol version.
 *
 * Reads bytecode + digest from `sui move build --dump-bytecode-as-base64`,
 * authorizes the upgrade via the UpgradeCap with a "compatible" policy,
 * publishes the new modules, and commits the receipt.
 *
 * After success, set FLICKY_PACKAGE_ID in `.env` to the new package ID
 * printed at the end.
 *
 * Usage (from apps/server):
 *   bun run src/scripts/upgrade-package.ts
 */
import { execSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { Transaction } from "@mysten/sui/transactions"
import { getAdminKeypair, getSuiClient, requireEnv } from "../lib/sui"

// 0 = compatible, 128 = additive, 192 = dep_only.
// Adding a new module is compatible-policy-safe.
const COMPATIBLE_POLICY = 0

interface BuildOutput {
  modules: string[]
  dependencies: string[]
  digest: number[]
}

/**
 * Build the package with `Published.toml` temporarily set aside. The CLI
 * uses that file to substitute the original published-at address into the
 * bytecode, but Sui's upgrade path expects modules with `0x0` self-addresses
 * (the runtime then assigns a new package ID). We restore the file after
 * building so the local dev workflow isn't disturbed.
 */
function buildPackage(): BuildOutput {
  const packageDir = `${process.cwd()}/../../move/flicky`
  const publishedPath = `${packageDir}/Published.toml`
  const stashedPath = `${packageDir}/Published.toml.upgrading`

  let stashed: string | null = null
  try {
    stashed = readFileSync(publishedPath, "utf8")
    writeFileSync(stashedPath, stashed)
    execSync(`rm ${publishedPath}`)
  } catch {
    // file may not exist; that's fine
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
      execSync(`rm ${stashedPath}`)
    }
  }
}

function hexAddrToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex
  const padded = clean.padStart(64, "0")
  const out = new Uint8Array(32)
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

function computeDigest(modulesB64: string[], deps: string[]): number[] {
  const h = createHash("sha3-256")
  // Sort modules by bytecode bytes (Sui canonical order).
  const moduleBytes = modulesB64.map((m) => Buffer.from(m, "base64"))
  moduleBytes.sort(Buffer.compare)
  for (const m of moduleBytes) h.update(m)
  // Sort deps by raw 32-byte address (lexicographic).
  const depBytes = deps.map(hexAddrToBytes)
  depBytes.sort(Buffer.compare as (a: Uint8Array, b: Uint8Array) => number)
  for (const dep of depBytes) h.update(dep)
  return Array.from(h.digest())
}

async function main() {
  const oldPackageId = requireEnv("FLICKY_PACKAGE_ID")
  const upgradeCapId = requireEnv("UPGRADE_CAP_ID")
  const client = getSuiClient()
  const keypair = getAdminKeypair()

  console.log("building package…")
  const { modules, dependencies: rawDeps } = buildPackage()
  void oldPackageId

  // Substitute original-ids for current published-at addresses. The build
  // emits original-ids (matching the bytecode's linkage table for type
  // identity), but Sui's upgrade tx needs each dep's *current* package
  // object ID. Mainly matters for deepbook, which has been upgraded;
  // deepbook_predict is still on v1.
  const PUBLISHED_AT: Record<string, string> = {
    "0xfb28c4cbc6865bd1c897d26aecbe1f8792d1509a20ffec692c800660cbec6982":
      "0x74cd5657843c627f3d80f713b71e9f895bbbeb470956d8a8e1185badf6cc77c8",
  }
  const dependencies = rawDeps.map((d) => PUBLISHED_AT[d] ?? d)
  // Recompute the digest from the substituted deps. Sui verifies it as
  // `sha3_256(concat(modules) || concat(sort(deps).map(to_bytes)))`.
  const digest = computeDigest(modules, dependencies)

  console.log(`  modules: ${modules.length}, deps: ${dependencies.length}, digest: ${digest.length} bytes`)

  const tx = new Transaction()
  tx.setGasBudget(500_000_000)

  const ticket = tx.moveCall({
    target: "0x2::package::authorize_upgrade",
    arguments: [
      tx.object(upgradeCapId),
      tx.pure.u8(COMPATIBLE_POLICY),
      tx.pure.vector("u8", digest),
    ],
  })

  const receipt = tx.upgrade({
    modules,
    dependencies,
    package: oldPackageId,
    ticket,
  })

  tx.moveCall({
    target: "0x2::package::commit_upgrade",
    arguments: [tx.object(upgradeCapId), receipt],
  })

  console.log("submitting upgrade…")
  const res = await client.signAndExecuteTransaction({
    transaction: tx,
    signer: keypair,
    options: { showObjectChanges: true, showEffects: true },
  })
  if (res.effects?.status.status !== "success") {
    throw new Error(`upgrade failed: ${JSON.stringify(res.effects?.status)}`)
  }
  await client.waitForTransaction({ digest: res.digest })

  const published = res.objectChanges?.find((c) => c.type === "published")
  if (!published || published.type !== "published") {
    throw new Error("no published change in upgrade tx")
  }
  console.log(`\nupgraded! new package id:`)
  console.log(`FLICKY_PACKAGE_ID=${published.packageId}`)
  console.log(`\ntx digest: ${res.digest}`)
}

await main()
