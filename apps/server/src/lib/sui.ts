import { SuiClient, getFullnodeUrl } from "@mysten/sui/client"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography"

export type Network = "mainnet" | "testnet" | "devnet" | "localnet"

export function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`missing env: ${name}`)
  return v
}

export function getSuiClient(): SuiClient {
  const network = (process.env.SUI_NETWORK ?? "testnet") as Network
  const url = process.env.SUI_RPC_URL ?? getFullnodeUrl(network)
  return new SuiClient({ url })
}

export function getAdminKeypair(): Ed25519Keypair {
  const bech32 = requireEnv("ADMIN_SECRET_KEY")
  const { secretKey } = decodeSuiPrivateKey(bech32)
  return Ed25519Keypair.fromSecretKey(secretKey)
}
