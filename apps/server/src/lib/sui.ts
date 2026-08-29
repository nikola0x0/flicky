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

import { env } from "../env"
import { networkEnv, type Network } from "../network-env"

export type { Network }

export function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`missing env: ${name}`)
  return v
}

// One client per network, not one per process — this server answers for
// every network in `env.enabledNetworks`, and a client is bound to the
// endpoint it was constructed with. Callers that don't care get the default
// network, which is what every pre-multi-network call site meant.
const grpcClients = new Map<Network, SuiGrpcClient>()

export function getSuiClient(net: Network = env.network): SuiGrpcClient {
  const hit = grpcClients.get(net)
  if (hit) return hit
  const client = new SuiGrpcClient({
    network: net,
    baseUrl: networkEnv(net).grpcUrl,
  })
  grpcClients.set(net, client)
  return client
}

const gqlClients = new Map<Network, SuiGraphQLClient>()

export function getGraphQLClient(net: Network = env.network): SuiGraphQLClient {
  const hit = gqlClients.get(net)
  if (hit) return hit
  const client = new SuiGraphQLClient({
    url: networkEnv(net).graphqlUrl,
    network: net,
  })
  gqlClients.set(net, client)
  return client
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
