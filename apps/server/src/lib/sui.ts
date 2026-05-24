/**
 * Sui client + keypair helpers shared across the backend.
 *
 * - `getSuiClient` is memoized so the WS layer, keeper, and indexer all
 *   share a single underlying transport.
 * - Keypair helpers fail lazily so HTTP/WS can boot without signers
 *   (e.g. when running deck + sponsor only, with keeper disabled).
 */
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography"

export type Network = "mainnet" | "testnet" | "devnet" | "localnet"

export function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`missing env: ${name}`)
  return v
}

let _client: SuiClient | null = null

export function getSuiClient(): SuiClient {
  if (_client) return _client
  const network = (process.env.SUI_NETWORK ?? "testnet") as Network
  const url = process.env.SUI_RPC_URL ?? getFullnodeUrl(network)
  _client = new SuiClient({ url })
  return _client
}

export function getAdminKeypair(): Ed25519Keypair {
  const bech32 = requireEnv("ADMIN_SECRET_KEY")
  const { secretKey } = decodeSuiPrivateKey(bech32)
  return Ed25519Keypair.fromSecretKey(secretKey)
}

/**
 * Load a keypair from any bech32 `suiprivkey1…` env var, returning null
 * when unset so callers can decide whether to disable themselves
 * gracefully (used by the keeper service).
 */
export function loadKeypairFromEnv(name: string): Ed25519Keypair | null {
  const key = process.env[name]
  if (!key) return null
  if (!key.startsWith("suiprivkey1")) {
    throw new Error(`${name} must be a bech32 suiprivkey1… key`)
  }
  const { secretKey } = decodeSuiPrivateKey(key)
  return Ed25519Keypair.fromSecretKey(secretKey)
}

/**
 * Decode a bech32 key into a keypair, throwing on bad format. Used when
 * the caller has already pulled the value out of env (e.g. via
 * `env.keeperSecretKey`) and just needs the decode.
 */
export function decodeKeypair(bech32: string): Ed25519Keypair {
  const { secretKey } = decodeSuiPrivateKey(bech32)
  return Ed25519Keypair.fromSecretKey(secretKey)
}
