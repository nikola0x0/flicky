/**
 * Per-network chain config resolution.
 *
 * One server process serves every enabled network — there is no second
 * deploy and no second Railway environment. So every on-chain id has to be
 * resolvable per network rather than baked in once at boot.
 *
 * Env convention:
 *   testnet → `FOO` (or `FOO_TESTNET` where that name already existed),
 *             falling back to the baked-in testnet default.
 *   mainnet → `FOO_MAINNET`, falling back to nothing.
 *
 * Mainnet NEVER falls back to a testnet value. That fallback is precisely how
 * a mainnet PTB ends up targeting a testnet package — or, worse, how the
 * sponsor allowlists one. An unconfigured mainnet id stays {@link UNSET_ID}
 * and `predictAvailable` goes false, which is what gates the duel surfaces.
 *
 * NOTE: DeepBook Predict is testnet-only today (mainnet slated for later in
 * 2026), so in practice the mainnet block below resolves to unset and the
 * server answers `network_unavailable` for every Predict-backed endpoint.
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

export type Network = "mainnet" | "testnet" | "devnet" | "localnet"

/**
 * Placeholder for an id that isn't deployed on a network. Chosen over `null`
 * so the many `tx.object(env.foo)` / `${env.foo}::module::fn` call sites keep
 * their `string` types; anything actually built against it aborts on-chain
 * instead of silently hitting a real object.
 */
export const UNSET_ID = "0x0"

/** RFC 2606 reserved TLD — never resolves, so a stray fetch fails fast. */
const UNSET_URL = "https://unconfigured.invalid"

const SUFFIX: Record<Network, string> = {
  mainnet: "MAINNET",
  testnet: "TESTNET",
  devnet: "DEVNET",
  localnet: "LOCALNET",
}

/**
 * Historical spellings that must keep resolving. The canonical base is on the
 * left; each alias is tried with the same suffix rules.
 *
 * These exist because the `_MAINNET` names were already documented in
 * `.env.example` (and read by `sponsor.ts`) with the `_ID` dropped, while the
 * testnet names carry it. Renaming either side would silently stop resolving
 * a var that may already be set on a deploy, so both spellings are accepted.
 */
const ALIASES: Record<string, string[]> = {
  FLICKY_PACKAGE: ["FLICKY_PACKAGE_ID"],
  DEEPBOOK_PREDICT_PACKAGE: ["DEEPBOOK_PREDICT_PACKAGE_ID"],
  ACCOUNT_PACKAGE: ["ACCOUNT_PACKAGE_ID"],
  SWAP_PACKAGE: ["SWAP_PACKAGE_ID"],
}

/**
 * Resolve one env key for `net`.
 *
 * Testnet (and the other dev networks) accept the bare name so existing
 * single-network deploys keep working untouched; every network also accepts
 * its own explicit `_<NETWORK>` suffix. Mainnet accepts ONLY the suffixed
 * form — see the module docstring for why the bare name must not leak there.
 *
 * NOT memoized. These are a handful of string lookups per call, and caching
 * them would make a mutated `process.env` invisible — which is both a
 * confusing foot-gun and something the sponsor tests legitimately rely on.
 */
export function pick(key: string, net: Network): string | undefined {
  const names = [key, ...(ALIASES[key] ?? [])]
  for (const name of names) {
    const suffixed = process.env[`${name}_${SUFFIX[net]}`]
    if (suffixed) return suffixed
  }
  if (net === "mainnet") return undefined
  for (const name of names) {
    if (process.env[name]) return process.env[name]
  }
  return undefined
}

interface DeployedJson {
  network?: string
  packageId: string | null
}

/**
 * Flicky package id for `net`.
 *
 * `apps/contracts/deployed.json` is only consulted for the network it records
 * (testnet today). Using it as a blanket fallback would hand a testnet package
 * id to a mainnet PTB — see `publish.ts`, which writes one file per publish.
 */
function loadFlickyPackageId(net: Network): string | null {
  const override = pick("FLICKY_PACKAGE", net)
  if (override) return override
  try {
    const path = resolve(import.meta.dir, "../../contracts/deployed.json")
    const deployed = JSON.parse(readFileSync(path, "utf-8")) as DeployedJson
    if (deployed.network && deployed.network !== net) return null
    return deployed.packageId ?? null
  } catch {
    return null
  }
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

/**
 * Baked-in testnet defaults (DeepBook Predict 8-21). Only applied on
 * non-mainnet networks — mainnet gets `UNSET_ID` unless a `_MAINNET` var
 * supplies a real value.
 */
const TESTNET_DEFAULTS = {
  DEEPBOOK_PREDICT_PACKAGE:
    "0x421041754244cf0e985fb9c9f5e1f49428caf3df4cde3a7b266d8e18ea63597b",
  PROTOCOL_CONFIG_ID:
    "0x7ef1ac99c2f0a77e7aa2602b5ea7bff68750cff0d80f09bdf827bfb345128f33",
  POOL_VAULT_ID:
    "0x2a31f592d8fd3d0781e2233770d02d67797890ac82c3d18796d7eb0997896602",
  PREDICT_REGISTRY_ID:
    "0x3d486bd50bb5bb5450ddbcb4f74776b6135f416c09024a6674ac266e77e1870a",
  ACCOUNT_PACKAGE:
    "0xa94ec89b6cbb3e2609c7ca65bd77885b7513f852922ebdf8e766851fb6f85259",
  ACCOUNT_REGISTRY_ID:
    "0x5682c73d657de1546374e632369a25c82744c8a20e9b4f47e6558e3d4bde88d3",
  PROPBOOK_PACKAGE_ID:
    "0xd8b402609b1728f60cf20bfaaec5255701df54350ec13e93aac39463b00bf97b",
  ORACLE_REGISTRY_ID:
    "0x715f5ae4aac0078f4d0c6bf9ea2815614e799e909a90b577aeb8de9ad8bab142",
  BTC_PYTH_FEED_ID:
    "0xea8fd4624002516b28b495051c838b2c9a34a4f22ae281d328e1bec47f54cd24",
  BTC_BS_VALUE_STORE_ID:
    "0x9b64cc860ac09e6dcd675fc579c1048792ddce51cc018f2ca16aeb4a1a5684a3",
  BTC_BS_SVI_STORE_ID:
    "0xd5bc586e99c8d595e0ba5e0a2ef2295e652db8934ffbeda630d60e207bedab8f",
  ACCUMULATOR_ROOT_ID:
    "0x0000000000000000000000000000000000000000000000000000000000000acc",
  PREDICT_INDEXER_URL: "https://predict-server-v4.testnet.mystenlabs.com",
  PROPBOOK_INDEXER_URL: "https://propbook-server-v4.testnet.mystenlabs.com",
  DUSDC_COIN_TYPE:
    "0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC",
  SWAP_PACKAGE:
    "0x51ea0f29321f3c25f8b2f530ecd3ed3dec569d954c8832d318de7e203653a936",
} as const

type DefaultKey = keyof typeof TESTNET_DEFAULTS

/** Resolve an id, applying the testnet default only off mainnet. */
function id(key: DefaultKey, net: Network): string {
  const v = pick(key, net)
  if (v) return v
  return net === "mainnet" ? UNSET_ID : TESTNET_DEFAULTS[key]
}

/** Same, for URL-shaped values (unset resolves to a host that never resolves). */
function url(key: DefaultKey, net: Network): string {
  const v = pick(key, net)
  if (v) return v
  return net === "mainnet" ? UNSET_URL : TESTNET_DEFAULTS[key]
}

export interface NetworkEnv {
  network: Network
  /** Node endpoints. */
  rpcUrl: string | undefined
  grpcUrl: string
  graphqlUrl: string
  /** Flicky duel package — null when nothing is deployed for this network. */
  flickyPackageId: string | null
  /** DeepBook Predict package + shared objects. */
  deepbookPredictPackageId: string
  protocolConfigId: string
  poolVaultId: string
  predictRegistryId: string
  accountPackageId: string
  accountRegistryId: string
  propbookPackageId: string
  oracleRegistryId: string
  pythFeedId: string
  bsValueStoreId: string
  bsSviStoreId: string
  accumulatorRootId: string
  predictIndexerUrl: string
  propbookIndexerUrl: string
  dusdcCoinType: string
  swapPackageId: string
  probeWrapperId: string | undefined
  /** Season prize escrow (season::prize_pool). */
  seasonPackageId: string | undefined
  seasonPoolId: string | undefined
  seasonAdminCapId: string | undefined
  /** Signers. Both may be the same key, but each chain must be funded. */
  keeperSecretKey: string | undefined
  sponsorSecretKey: string | undefined
  /**
   * Whether the DeepBook Predict deployment this network needs actually
   * resolves. False → deck generation, the oracle stream, and the keeper have
   * nothing to read, and the HTTP layer answers `network_unavailable`.
   */
  predictAvailable: boolean
}

function build(net: Network): NetworkEnv {
  const deepbookPredictPackageId = id("DEEPBOOK_PREDICT_PACKAGE", net)
  const flickyPackageId = loadFlickyPackageId(net)
  return {
    network: net,
    rpcUrl: pick("SUI_RPC_URL", net),
    grpcUrl: pick("SUI_GRPC_URL", net) ?? GRPC_DEFAULTS[net],
    graphqlUrl: pick("SUI_GRAPHQL_URL", net) ?? GRAPHQL_DEFAULTS[net],
    flickyPackageId,
    deepbookPredictPackageId,
    protocolConfigId: id("PROTOCOL_CONFIG_ID", net),
    poolVaultId: id("POOL_VAULT_ID", net),
    predictRegistryId: id("PREDICT_REGISTRY_ID", net),
    accountPackageId: id("ACCOUNT_PACKAGE", net),
    accountRegistryId: id("ACCOUNT_REGISTRY_ID", net),
    propbookPackageId: id("PROPBOOK_PACKAGE_ID", net),
    oracleRegistryId: id("ORACLE_REGISTRY_ID", net),
    pythFeedId: id("BTC_PYTH_FEED_ID", net),
    bsValueStoreId: id("BTC_BS_VALUE_STORE_ID", net),
    bsSviStoreId: id("BTC_BS_SVI_STORE_ID", net),
    accumulatorRootId: id("ACCUMULATOR_ROOT_ID", net),
    predictIndexerUrl: url("PREDICT_INDEXER_URL", net),
    propbookIndexerUrl: url("PROPBOOK_INDEXER_URL", net),
    dusdcCoinType: id("DUSDC_COIN_TYPE", net),
    swapPackageId: id("SWAP_PACKAGE", net),
    probeWrapperId: pick("PROBE_WRAPPER_ID", net),
    seasonPackageId: pick("SEASON_PACKAGE_ID", net),
    seasonPoolId: pick("SEASON_POOL_ID", net),
    seasonAdminCapId: pick("SEASON_ADMIN_CAP_ID", net),
    keeperSecretKey:
      pick("KEEPER_SECRET_KEY", net) ?? pick("BOT_SECRET_KEY", net),
    sponsorSecretKey: pick("SPONSOR_SECRET_KEY", net),
    predictAvailable:
      deepbookPredictPackageId !== UNSET_ID && flickyPackageId !== null,
  }
}

/**
 * Chain-scoped config for `net`, resolved fresh on each call.
 *
 * Deliberately uncached: the whole body is env lookups and an object literal,
 * it's called at most once per request, and a cache would silently serve
 * stale config after any `process.env` mutation.
 */
export function networkEnv(net: Network): NetworkEnv {
  return build(net)
}

export function isNetwork(v: string): v is Network {
  return (
    v === "mainnet" || v === "testnet" || v === "devnet" || v === "localnet"
  )
}
