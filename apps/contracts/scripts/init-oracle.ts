/**
 * Create + share a fresh OracleSVI on testnet using the vendored stub.
 *
 *   bun run scripts/init-oracle.ts [ttl_ms]
 *
 * ttl_ms defaults to 86_400_000 (24h). Prints the shared object id so the
 * Flicky playground can paste it into "Oracle ID".
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { config as loadEnv } from "dotenv"

import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc"
import { Transaction } from "@mysten/sui/transactions"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography"

loadEnv({ path: resolve(import.meta.dir, "../.env") })
loadEnv({ path: resolve(import.meta.dir, "../.env.local"), override: true })

const NETWORK = (process.env.SUI_NETWORK ?? "testnet") as
  | "testnet" | "mainnet" | "devnet" | "localnet"

const STUB_TOML = resolve(import.meta.dir, "../deepbook_predict_min/Move.toml")
const TTL_MS = BigInt(process.argv[2] ?? "86400000")
const INITIAL_PRICE = BigInt(process.argv[3] ?? "500000000") // 0.5 in 1e9 scale

function loadDeployerKeypair(): Ed25519Keypair {
  const privKey = process.env.SUI_DEPLOYER_PRIVATE_KEY
  if (!privKey) {
    console.error("SUI_DEPLOYER_PRIVATE_KEY not set")
    process.exit(1)
  }
  return Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(privKey).secretKey)
}

function readStubPackage(): string {
  // Latest upgraded version: new public functions like `new_market_oracle`
  // are only callable here. The originalPackageId in Move.toml is the type
  // identity, but PTB moveCalls must dispatch to the latest version.
  const env = process.env.STUB_LATEST_PACKAGE_ID
  if (env) return env
  const m = readFileSync(STUB_TOML, "utf-8").match(/published-at = "(0x[0-9a-fA-F]+)"/)
  if (!m) { console.error("published-at not found"); process.exit(1) }
  return m![1]
}

async function main() {
  const keypair = loadDeployerKeypair()
  const sender = keypair.toSuiAddress()
  const client = new SuiJsonRpcClient({
    url: process.env.SUI_RPC_URL ?? getJsonRpcFullnodeUrl(NETWORK),
    network: NETWORK,
  })

  const pkg = readStubPackage()
  console.log(`Deployer:    ${sender}`)
  console.log(`Stub:        ${pkg}`)
  console.log(`TTL:         ${TTL_MS}ms`)

  const now = BigInt(Date.now())
  const expiry = now + TTL_MS

  const tx = new Transaction()
  const oracle = tx.moveCall({
    target: `${pkg}::oracle::new_market_oracle`,
    arguments: [tx.pure.u64(expiry)],
  })
  tx.moveCall({
    target: `${pkg}::oracle::set_compute_price`,
    arguments: [oracle, tx.pure.u64(INITIAL_PRICE)],
  })
  tx.moveCall({
    target: `${pkg}::oracle::share`,
    arguments: [oracle],
  })
  tx.setSender(sender)

  const result = await client.signAndExecuteTransaction({
    transaction: tx,
    signer: keypair,
    options: { showEffects: true, showObjectChanges: true },
  })

  if (result.effects?.status?.status !== "success") {
    console.error("init-oracle failed:", result.effects?.status)
    process.exit(1)
  }

  const oracleObj = (result.objectChanges ?? []).find(
    (c: any) => c.type === "created" && c.objectType?.endsWith("::oracle::OracleSVI"),
  ) as { objectId: string } | undefined

  if (!oracleObj) {
    console.error("No OracleSVI created in tx — check objectChanges:")
    console.error(JSON.stringify(result.objectChanges, null, 2))
    process.exit(1)
  }

  console.log(`\nOracleSVI shared at:`)
  console.log(`  ${oracleObj.objectId}`)
  console.log(`expiry_ms:   ${expiry}`)
  console.log(`p_up (×1e9): ${INITIAL_PRICE}`)
  console.log(`txDigest:    ${result.digest}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
