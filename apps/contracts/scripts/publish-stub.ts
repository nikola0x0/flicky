/**
 * One-shot publisher for the vendored `deepbook_predict_min` stub.
 *
 *   bun run scripts/publish-stub.ts
 *
 * Steps:
 *   1. Sets `deepbook_predict_min/Move.toml` address to 0x0 and clears
 *      the build cache so the Sui CLI emits a fresh, unpublished bytecode.
 *   2. Compiles with `sui move build --dump-bytecode-as-base64`.
 *   3. Publishes via the TS SDK using SUI_DEPLOYER_PRIVATE_KEY.
 *   4. Writes the new package id back into Move.toml (both `published-at`
 *      and the `[addresses]` entry).
 */
import { execSync } from "node:child_process"
import { readFileSync, writeFileSync, rmSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import { config as loadEnv } from "dotenv"

import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc"
import { Transaction } from "@mysten/sui/transactions"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography"

loadEnv({ path: resolve(import.meta.dir, "../.env") })
loadEnv({ path: resolve(import.meta.dir, "../.env.local"), override: true })

const NETWORK = (process.env.SUI_NETWORK ?? "testnet") as
  | "testnet"
  | "mainnet"
  | "devnet"
  | "localnet"

const STUB_DIR = resolve(import.meta.dir, "../deepbook_predict_min")
const STUB_TOML = resolve(STUB_DIR, "Move.toml")
const STUB_BUILD = resolve(STUB_DIR, "build")

function loadDeployerKeypair(): Ed25519Keypair {
  const privKey = process.env.SUI_DEPLOYER_PRIVATE_KEY
  if (!privKey) {
    console.error("SUI_DEPLOYER_PRIVATE_KEY not set in apps/contracts/.env.local")
    process.exit(1)
  }
  const { secretKey } = decodeSuiPrivateKey(privKey)
  return Ed25519Keypair.fromSecretKey(secretKey)
}

function setStubAddress(addr: string): void {
  const toml = readFileSync(STUB_TOML, "utf-8")
  const next = toml
    .replace(/published-at = "0x[0-9a-fA-F]+"/, `published-at = "${addr}"`)
    .replace(
      /deepbook_predict = "0x[0-9a-fA-F]+"/,
      `deepbook_predict = "${addr}"`,
    )
  writeFileSync(STUB_TOML, next)
}

function removePublishedAtIfZero(): void {
  // The Sui CLI rejects `published-at = "0x0"` when building an unpublished
  // package — it expects the field absent until publish.
  const toml = readFileSync(STUB_TOML, "utf-8")
  const next = toml.replace(/^published-at = "0x0+"\n/m, "")
  writeFileSync(STUB_TOML, next)
}

function restorePublishedAt(addr: string): void {
  const toml = readFileSync(STUB_TOML, "utf-8")
  if (toml.includes("published-at")) {
    setStubAddress(addr)
    return
  }
  // Insert published-at after the edition line.
  const next = toml.replace(
    /(edition = "2024"\n)/,
    `$1published-at = "${addr}"\n`,
  )
  writeFileSync(STUB_TOML, next)
}

async function main() {
  const keypair = loadDeployerKeypair()
  const address = keypair.toSuiAddress()
  const client = new SuiJsonRpcClient({
    url: process.env.SUI_RPC_URL ?? getJsonRpcFullnodeUrl(NETWORK),
    network: NETWORK,
  })

  console.log(`Deployer: ${address}`)
  console.log(`Network:  ${NETWORK}`)

  // 1. Reset stub address to 0x0 and clear build cache.
  setStubAddress("0x0")
  removePublishedAtIfZero()
  if (existsSync(STUB_BUILD)) rmSync(STUB_BUILD, { recursive: true, force: true })

  // 2. Build.
  let buildOutput: { modules: string[]; dependencies: string[] }
  try {
    buildOutput = JSON.parse(
      execSync("sui move build --dump-bytecode-as-base64 --path .", {
        cwd: STUB_DIR,
        env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` },
      }).toString(),
    )
  } catch (err: any) {
    console.error("Build failed.")
    console.error(err.stdout?.toString?.() ?? err.message ?? err)
    process.exit(1)
  }

  console.log(
    `Compiled ${buildOutput.modules.length} modules, ${buildOutput.dependencies.length} deps`,
  )

  // 3. Publish.
  const tx = new Transaction()
  const upgradeCap = tx.publish({
    modules: buildOutput.modules,
    dependencies: buildOutput.dependencies,
  })
  tx.transferObjects([upgradeCap], address)
  tx.setSender(address)

  const result = await client.signAndExecuteTransaction({
    transaction: tx,
    signer: keypair,
    options: { showEffects: true, showObjectChanges: true },
  })

  if (result.effects?.status?.status !== "success") {
    console.error("Publish failed:", result.effects?.status)
    process.exit(1)
  }

  const packageChange = (result.objectChanges ?? []).find(
    (c) => c.type === "published",
  ) as { packageId: string } | undefined
  if (!packageChange) {
    console.error("No package id in objectChanges.")
    process.exit(1)
  }
  const packageId = packageChange.packageId
  console.log(`\nPublished deepbook_predict stub:`)
  console.log(`  packageId:   ${packageId}`)
  console.log(`  txDigest:    ${result.digest}`)

  // 4. Write the new id back into Move.toml.
  restorePublishedAt(packageId)
  setStubAddress(packageId)
  console.log(`Updated ${STUB_TOML}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
