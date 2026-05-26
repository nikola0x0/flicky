/**
 * Upgrade the vendored `deepbook_predict_min` stub. Preserves the package id,
 * adds the new public functions (oracle constructor / admin) to the on-chain
 * package.
 *
 *   bun run scripts/upgrade-stub.ts
 *
 * Reads the original package id from Move.toml (`published-at`) and the
 * UpgradeCap id from STUB_UPGRADE_CAP env var. Compiles current stub sources
 * and submits a COMPATIBLE upgrade.
 */
import { execSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { config as loadEnv } from "dotenv"

import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc"
import { Transaction, UpgradePolicy } from "@mysten/sui/transactions"
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
const UPGRADE_CAP =
  process.env.STUB_UPGRADE_CAP ??
  "0x8ab672c0de0475c7b823499ef20a058283b626bba066684087a1c5a42904f69b"

function loadDeployerKeypair(): Ed25519Keypair {
  const privKey = process.env.SUI_DEPLOYER_PRIVATE_KEY
  if (!privKey) {
    console.error("SUI_DEPLOYER_PRIVATE_KEY not set in apps/contracts/.env.local")
    process.exit(1)
  }
  const { secretKey } = decodeSuiPrivateKey(privKey)
  return Ed25519Keypair.fromSecretKey(secretKey)
}

function readPublishedAt(): string {
  const toml = readFileSync(STUB_TOML, "utf-8")
  const m = toml.match(/published-at = "(0x[0-9a-fA-F]+)"/)
  if (!m) {
    console.error("published-at not found in stub Move.toml")
    process.exit(1)
  }
  return m![1]
}

async function main() {
  const keypair = loadDeployerKeypair()
  const address = keypair.toSuiAddress()
  const client = new SuiJsonRpcClient({
    url: process.env.SUI_RPC_URL ?? getJsonRpcFullnodeUrl(NETWORK),
    network: NETWORK,
  })

  const packageId = readPublishedAt()
  console.log(`Deployer:          ${address}`)
  console.log(`Network:           ${NETWORK}`)
  console.log(`Stub packageId:    ${packageId}`)
  console.log(`UpgradeCap:        ${UPGRADE_CAP}`)

  const buildOutput = JSON.parse(
    execSync("sui move build --dump-bytecode-as-base64 --path .", {
      cwd: STUB_DIR,
      env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` },
    }).toString(),
  ) as { modules: string[]; dependencies: string[]; digest: number[] }

  console.log(
    `Compiled ${buildOutput.modules.length} modules, ${buildOutput.dependencies.length} deps`,
  )

  const tx = new Transaction()
  const ticket = tx.moveCall({
    target: "0x2::package::authorize_upgrade",
    arguments: [
      tx.object(UPGRADE_CAP),
      tx.pure.u8(UpgradePolicy.COMPATIBLE),
      tx.pure.vector("u8", buildOutput.digest),
    ],
  })
  const receipt = tx.upgrade({
    modules: buildOutput.modules,
    dependencies: buildOutput.dependencies,
    package: packageId,
    ticket,
  })
  tx.moveCall({
    target: "0x2::package::commit_upgrade",
    arguments: [tx.object(UPGRADE_CAP), receipt],
  })
  tx.setSender(address)

  const result = await client.signAndExecuteTransaction({
    transaction: tx,
    signer: keypair,
    options: { showEffects: true, showObjectChanges: true },
  })

  if (result.effects?.status?.status !== "success") {
    console.error("Upgrade failed:", result.effects?.status)
    process.exit(1)
  }

  const packageChange = (result.objectChanges ?? []).find(
    (c) => c.type === "published",
  ) as { packageId: string } | undefined
  console.log(`\nUpgraded stub. New on-chain version published at:`)
  console.log(`  ${packageChange?.packageId}`)
  console.log(`Original packageId (use this for type refs and Move.toml): ${packageId}`)
  console.log(`txDigest: ${result.digest}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
