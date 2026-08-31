/**
 * Deployed flicky package + the DeepBook Predict targets, per network.
 *
 * The active network is decided once at boot by `lib/network.ts`; `CONFIG` is
 * that network's slice, frozen for the life of the page. Every call site keeps
 * reading `CONFIG.foo` — switching networks reloads (see `setNetwork`), so a
 * const is correct and there is nothing reactive to thread through.
 *
 * Env convention:
 *   testnet → `VITE_FOO` (or `VITE_FOO_TESTNET` where that name already
 *             existed), falling back to the baked-in testnet default below.
 *   mainnet → `VITE_FOO_MAINNET`, falling back to {@link UNSET_ID} / an
 *             unresolvable host.
 *
 * Mainnet NEVER falls back to a testnet value. A silent fallback is exactly
 * how you'd end up building a mainnet transaction against a testnet package,
 * so an unconfigured mainnet id stays visibly unset and `DUELS_ENABLED` goes
 * false, which gates the duel routes in the UI.
 */
import { ACTIVE_NETWORK, type FlickyNetwork } from "@/lib/network"

/**
 * Placeholder for an on-chain id that isn't deployed on this network. Any PTB
 * built against it fails loudly on-chain rather than silently targeting
 * something real — but every path that would do so is gated behind
 * `DUELS_ENABLED`, so it should never be reached.
 */
const UNSET_ID = "0x0"

/** RFC 2606 reserved TLD — guaranteed not to resolve, so a stray fetch fails fast. */
const UNSET_URL = "https://unconfigured.invalid"

/**
 * Resolve an env value, treating an EMPTY STRING as unset.
 *
 * This is the whole reason `??` isn't used below. A `.env` file that declares
 * a placeholder (`VITE_FOO_MAINNET=`) makes Vite inline `""`, and `"" ?? x`
 * is `""`, not `x` — which silently produced an empty package id and, worse,
 * a `predictAvailable` that computed to true because `"" !== "0x0"`. The
 * mainnet gate would then never engage. Empty means unset, always.
 */
function envOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value : fallback
}

interface NetworkConfig {
  /** Flicky duel package. */
  packageId: string
  /** DeepBook Predict package + its shared objects. */
  deepbookPredictPackageId: string
  protocolConfigId: string
  poolVaultId: string
  predictRegistryId: string
  accountPackageId: string
  accountRegistryId: string
  oracleRegistryId: string
  pythFeedId: string
  bsValueStoreId: string
  bsSviStoreId: string
  accumulatorRootId: string
  predictIndexerUrl: string
  /** dUSDC (testnet faucet token) / native USDC (mainnet). */
  dusdcCoinType: string
  /** SUI ↔ dUSDC AMM. */
  swapPackageId: string
  swapPoolId: string
  /** Sui node endpoints. */
  grpcUrl: string
  graphqlUrl: string
  /** Path segment suiscan.xyz uses for this network. */
  explorerNetwork: string
  /**
   * False when DeepBook Predict isn't deployed here. Drives the duel-route
   * gate — see `components/network-gate.tsx`.
   */
  predictAvailable: boolean
}

/**
 * Testnet — DeepBook Predict 8-21. Source of truth for `packageId` is
 * `apps/contracts/deployed.json`; if that drifts from this default, update
 * here so fresh checkouts without a `.env.local` still work.
 *
 * Settlement: per-card `settle_card(card_idx, &oracle)` × `deck_size`
 * accumulates payout/premium onto the Duel, then `finalize` distributes the
 * pot. `record_swipe` records the swipe's DeepBook `order_id` on-chain
 * (chained from the mint in the same PTB); premium is fed in later by the
 * keeper at settlement, not snapshotted at swipe time — 6-24 dropped the
 * `predict::get_trade_amounts` / `p_swiped` mechanism.
 */
const TESTNET: NetworkConfig = {
  packageId: envOr(
    import.meta.env.VITE_FLICKY_PACKAGE_ID_TESTNET,
    "0x23650c9d799238da660c602a6fe02074f864ce3ff2cc90f569a8eaa754b0418b"
  ),
  deepbookPredictPackageId: envOr(
    import.meta.env.VITE_DEEPBOOK_PREDICT_PACKAGE_ID,
    "0x421041754244cf0e985fb9c9f5e1f49428caf3df4cde3a7b266d8e18ea63597b"
  ),
  protocolConfigId: envOr(
    import.meta.env.VITE_DEEPBOOK_PROTOCOL_CONFIG_ID,
    "0x7ef1ac99c2f0a77e7aa2602b5ea7bff68750cff0d80f09bdf827bfb345128f33"
  ),
  poolVaultId: envOr(
    import.meta.env.VITE_DEEPBOOK_POOL_VAULT_ID,
    "0x2a31f592d8fd3d0781e2233770d02d67797890ac82c3d18796d7eb0997896602"
  ),
  predictRegistryId: envOr(
    import.meta.env.VITE_DEEPBOOK_PREDICT_REGISTRY_ID,
    "0x3d486bd50bb5bb5450ddbcb4f74776b6135f416c09024a6674ac266e77e1870a"
  ),
  accountPackageId: envOr(
    import.meta.env.VITE_DEEPBOOK_ACCOUNT_PACKAGE_ID,
    "0xa94ec89b6cbb3e2609c7ca65bd77885b7513f852922ebdf8e766851fb6f85259"
  ),
  accountRegistryId: envOr(
    import.meta.env.VITE_DEEPBOOK_ACCOUNT_REGISTRY_ID,
    "0x5682c73d657de1546374e632369a25c82744c8a20e9b4f47e6558e3d4bde88d3"
  ),
  oracleRegistryId: envOr(
    import.meta.env.VITE_DEEPBOOK_ORACLE_REGISTRY_ID,
    "0x715f5ae4aac0078f4d0c6bf9ea2815614e799e909a90b577aeb8de9ad8bab142"
  ),
  pythFeedId: envOr(
    import.meta.env.VITE_DEEPBOOK_PYTH_FEED_ID,
    "0xea8fd4624002516b28b495051c838b2c9a34a4f22ae281d328e1bec47f54cd24"
  ),
  bsValueStoreId: envOr(
    import.meta.env.VITE_DEEPBOOK_BS_VALUE_STORE_ID,
    "0x9b64cc860ac09e6dcd675fc579c1048792ddce51cc018f2ca16aeb4a1a5684a3"
  ),
  bsSviStoreId: envOr(
    import.meta.env.VITE_DEEPBOOK_BS_SVI_STORE_ID,
    "0xd5bc586e99c8d595e0ba5e0a2ef2295e652db8934ffbeda630d60e207bedab8f"
  ),
  accumulatorRootId: envOr(
    import.meta.env.VITE_DEEPBOOK_ACCUMULATOR_ROOT_ID,
    "0x0000000000000000000000000000000000000000000000000000000000000acc"
  ),
  predictIndexerUrl: envOr(
    import.meta.env.VITE_DEEPBOOK_PREDICT_INDEXER_URL,
    "https://predict-server-v4.testnet.mystenlabs.com"
  ),
  dusdcCoinType: envOr(
    import.meta.env.VITE_DUSDC_COIN_TYPE,
    "0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC"
  ),
  swapPackageId: envOr(
    import.meta.env.VITE_SWAP_PACKAGE_ID,
    "0x51ea0f29321f3c25f8b2f530ecd3ed3dec569d954c8832d318de7e203653a936"
  ),
  swapPoolId: envOr(
    import.meta.env.VITE_SWAP_POOL_ID,
    "0x778c0b0570a541ec38463a9e2f1596e25777570a466da0ba1796bdbe2846bdcd"
  ),
  grpcUrl: envOr(
    import.meta.env.VITE_SUI_GRPC_URL,
    "https://fullnode.testnet.sui.io:443"
  ),
  graphqlUrl: envOr(
    import.meta.env.VITE_SUI_GRAPHQL_URL,
    "https://graphql.testnet.sui.io/graphql"
  ),
  explorerNetwork: "testnet",
  predictAvailable: true,
}

/**
 * Mainnet — DeepBook Predict is NOT deployed there yet (the protocol is
 * testnet-only; Mysten has mainnet slated for later in 2026, with contracts
 * that may still change). So every Predict-derived id below is unset unless a
 * `_MAINNET` env var supplies it, and `predictAvailable` is derived from the
 * one that matters most.
 *
 * What DOES work on mainnet today: wallet connect, SUI balance, profile. The
 * duel routes render `<NetworkGate />` instead. Filling these vars in (once
 * Predict ships) is all it takes to light the client up — see
 * docs/network-switching.md for the full flip checklist.
 */
const MAINNET: NetworkConfig = {
  packageId: envOr(import.meta.env.VITE_FLICKY_PACKAGE_ID_MAINNET, UNSET_ID),
  deepbookPredictPackageId: envOr(
    import.meta.env.VITE_DEEPBOOK_PREDICT_PACKAGE_ID_MAINNET,
    UNSET_ID
  ),
  protocolConfigId: envOr(
    import.meta.env.VITE_DEEPBOOK_PROTOCOL_CONFIG_ID_MAINNET,
    UNSET_ID
  ),
  poolVaultId: envOr(
    import.meta.env.VITE_DEEPBOOK_POOL_VAULT_ID_MAINNET,
    UNSET_ID
  ),
  predictRegistryId: envOr(
    import.meta.env.VITE_DEEPBOOK_PREDICT_REGISTRY_ID_MAINNET,
    UNSET_ID
  ),
  accountPackageId: envOr(
    import.meta.env.VITE_DEEPBOOK_ACCOUNT_PACKAGE_ID_MAINNET,
    UNSET_ID
  ),
  accountRegistryId: envOr(
    import.meta.env.VITE_DEEPBOOK_ACCOUNT_REGISTRY_ID_MAINNET,
    UNSET_ID
  ),
  oracleRegistryId: envOr(
    import.meta.env.VITE_DEEPBOOK_ORACLE_REGISTRY_ID_MAINNET,
    UNSET_ID
  ),
  pythFeedId: envOr(
    import.meta.env.VITE_DEEPBOOK_PYTH_FEED_ID_MAINNET,
    UNSET_ID
  ),
  bsValueStoreId: envOr(
    import.meta.env.VITE_DEEPBOOK_BS_VALUE_STORE_ID_MAINNET,
    UNSET_ID
  ),
  bsSviStoreId: envOr(
    import.meta.env.VITE_DEEPBOOK_BS_SVI_STORE_ID_MAINNET,
    UNSET_ID
  ),
  accumulatorRootId: envOr(
    import.meta.env.VITE_DEEPBOOK_ACCUMULATOR_ROOT_ID_MAINNET,
    UNSET_ID
  ),
  predictIndexerUrl: envOr(
    import.meta.env.VITE_DEEPBOOK_PREDICT_INDEXER_URL_MAINNET,
    UNSET_URL
  ),
  dusdcCoinType: envOr(import.meta.env.VITE_DUSDC_COIN_TYPE_MAINNET, UNSET_ID),
  swapPackageId: envOr(import.meta.env.VITE_SWAP_PACKAGE_ID_MAINNET, UNSET_ID),
  swapPoolId: envOr(import.meta.env.VITE_SWAP_POOL_ID_MAINNET, UNSET_ID),
  grpcUrl: envOr(
    import.meta.env.VITE_SUI_GRPC_URL_MAINNET,
    "https://fullnode.mainnet.sui.io:443"
  ),
  graphqlUrl: envOr(
    import.meta.env.VITE_SUI_GRAPHQL_URL_MAINNET,
    "https://graphql.mainnet.sui.io/graphql"
  ),
  explorerNetwork: "mainnet",
  // Placeholder — replaced below. Deriving it from the RESOLVED fields rather
  // than re-reading env means it can't drift from what the app will actually
  // build transactions with.
  predictAvailable: false,
}

// Derived after the fact so there is exactly one source of truth: if both the
// Predict package and the flicky package resolved to something real, the duel
// routes stop being gated. Supplying the env vars is the whole switch.
MAINNET.predictAvailable =
  MAINNET.deepbookPredictPackageId !== UNSET_ID &&
  MAINNET.packageId !== UNSET_ID

const NETWORKS: Record<FlickyNetwork, NetworkConfig> = {
  testnet: TESTNET,
  mainnet: MAINNET,
}

/**
 * gRPC endpoint for EVERY network, not just the active one — dApp Kit is
 * registered with both and wants a client factory that can answer for either.
 */
export const GRPC_URLS: Record<FlickyNetwork, string> = {
  testnet: TESTNET.grpcUrl,
  mainnet: MAINNET.grpcUrl,
}

export const CONFIG = {
  ...NETWORKS[ACTIVE_NETWORK],

  /** The network this page load is pinned to. */
  network: ACTIVE_NETWORK,

  // ─── Not network-scoped ──────────────────────────────────────────────
  //
  // One backend serves every network (it resolves per-network config
  // itself and takes `?network=` on its read endpoints), so these stay
  // single-valued regardless of the active chain.
  serverHttpUrl:
    import.meta.env.VITE_SERVER_HTTP_URL || "http://localhost:3001",
  serverWsUrl: import.meta.env.VITE_SERVER_WS_URL || "ws://localhost:3001/ws",

  CLOCK_ID: "0x6",

  /** Default duel stake coin type. SUI exists on every network. */
  stakeType: "0x2::sui::SUI" as const,

  /** 9-decimal fixed point unit (1.0 == 1e9). */
  ONE_E9: 1_000_000_000n,

  /** Default per-side stake in mist (0.01 SUI). User can override in the UI. */
  defaultStakeMist: 10_000_000n,

  /** Minimum allowed stake (must be > 0). */
  minStakeMist: 1_000_000n,
} as const

/**
 * Whether the full duel engine (swipe / stake / settle) can run on the active
 * network. False on any network without a DeepBook Predict deployment — the
 * duel routes render `<NetworkGate />` in that case.
 */
export const DUELS_ENABLED = CONFIG.predictAvailable

/**
 * Build a backend URL carrying the active network.
 *
 * One server serves every network, so a read that doesn't say which chain it
 * means gets the server's DEFAULT network — which, for a client sitting on
 * mainnet, is the wrong answer delivered silently. Every chain-scoped
 * endpoint (`/duels/*`, `/leaderboard*`, `/manager`, `/oracle/*`,
 * `/deckmaster/*`) should go through this.
 */
export function apiUrl(path: string): string {
  const sep = path.includes("?") ? "&" : "?"
  return `${CONFIG.serverHttpUrl}${path}${sep}network=${CONFIG.network}`
}

/** Suiscan object URL on the active network. */
export function explorerObjectUrl(id: string): string {
  return `https://suiscan.xyz/${CONFIG.explorerNetwork}/object/${id}`
}
