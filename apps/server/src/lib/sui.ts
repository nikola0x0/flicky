/**
 * Sui client + keypair helpers shared across the backend.
 *
 * - `getSuiClient` is memoized so the WS layer, keeper, and indexer all
 *   share a single underlying transport.
 * - Keypair helpers fail lazily so HTTP/WS can boot without signers
 *   (e.g. when running deck + sponsor only, with keeper disabled).
 */
import { SuiGrpcClient } from "@mysten/sui/grpc"
import { SuiGraphQLClient } from "@mysten/sui/graphql"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography"

export type Network = "mainnet" | "testnet" | "devnet" | "localnet"

export function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`missing env: ${name}`)
  return v
}

const GRPC_DEFAULTS: Record<Network, string> = {
  mainnet: "https://fullnode.mainnet.sui.io:443",
  testnet: "https://fullnode.testnet.sui.io:443",
  devnet: "https://fullnode.devnet.sui.io:443",
  localnet: "http://127.0.0.1:9000",
}
const GRAPHQL_DEFAULTS: Record<Network, string> = {
  mainnet: "https://graphql.mainnet.sui.io/graphql",
  testnet: "https://graphql.testnet.sui.io/graphql",
  devnet: "https://graphql.devnet.sui.io/graphql",
  localnet: "http://127.0.0.1:9125/graphql",
}

function network(): Network {
  return (process.env.SUI_NETWORK ?? "testnet") as Network
}

let _grpc: SuiGrpcClient | null = null

export function getSuiClient(): SuiGrpcClient {
  if (_grpc) return _grpc
  const net = network()
  const baseUrl = process.env.SUI_GRPC_URL ?? GRPC_DEFAULTS[net]
  _grpc = new SuiGrpcClient({ network: net, baseUrl })
  return _grpc
}

let _gql: SuiGraphQLClient | null = null

export function getGraphQLClient(): SuiGraphQLClient {
  if (_gql) return _gql
  const net = network()
  const url = process.env.SUI_GRAPHQL_URL ?? GRAPHQL_DEFAULTS[net]
  _gql = new SuiGraphQLClient({ url, network: net })
  return _gql
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
