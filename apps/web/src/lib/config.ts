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
  bsSpotFeedId: string
  bsForwardFeedId: string
  bsSviFeedId: string
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
 * Testnet — DeepBook Predict 6-24. Source of truth for `packageId` is
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
    "0x5ceae1cacbba1862e0f0c4e8861280b8a1e9530ce4049317daf5d3951778582f"
  ),
  deepbookPredictPackageId: envOr(
    import.meta.env.VITE_DEEPBOOK_PREDICT_PACKAGE_ID,
    "0xdb3ef5a5129920e59c9b2ae25a77eddb48acd0e1c6307b97073f0e076016446e"
  ),
  protocolConfigId: envOr(
    import.meta.env.VITE_DEEPBOOK_PROTOCOL_CONFIG_ID,
    "0x2325224629b4bd96d1f1d7ee937e07f8a06f861018a130bbb26db09cb0394cb6"
  ),
  poolVaultId: envOr(
    import.meta.env.VITE_DEEPBOOK_POOL_VAULT_ID,
    "0xfde98c636eb8a7aba59c3a238cfee6b576b7118d1e5ffa2952876c4b270a3a2a"
  ),
  predictRegistryId: envOr(
    import.meta.env.VITE_DEEPBOOK_PREDICT_REGISTRY_ID,
    "0x54afbf245caf42466cedb5756ed7816f34f544afdfa13579a862eccf3afa21ca"
  ),
  accountPackageId: envOr(
    import.meta.env.VITE_DEEPBOOK_ACCOUNT_PACKAGE_ID,
    "0xb9389eac8d59170ffd1427c1a66e5c8306263464fcc6615e825c1f5b3e15da3b"
  ),
  accountRegistryId: envOr(
    import.meta.env.VITE_DEEPBOOK_ACCOUNT_REGISTRY_ID,
    "0x3c54d5b8b6bca376fc289121838ad02f8a5b3843242b9ad7e8f8245720e685a2"
  ),
  oracleRegistryId: envOr(
    import.meta.env.VITE_DEEPBOOK_ORACLE_REGISTRY_ID,
    "0xf3deaff68cbd081a35ec21653af6f671d2ad5f012f3b4d817d81752843374136"
  ),
  pythFeedId: envOr(
    import.meta.env.VITE_DEEPBOOK_PYTH_FEED_ID,
    "0xc78d7de16217d46d21b92ae475da799448be30b71a758dc6d7bb3ac2f1c35afb"
  ),
  bsSpotFeedId: envOr(
    import.meta.env.VITE_DEEPBOOK_BS_SPOT_FEED_ID,
    "0xcdc5fa7364e60fd2504aa96f65b707dc0734e507a919b1a7d7d63164fd67b745"
  ),
  bsForwardFeedId: envOr(
    import.meta.env.VITE_DEEPBOOK_BS_FORWARD_FEED_ID,
    "0xe72c734ea8d8dcbc9183d9d8f96f51aaa1fb5034d5ed33ac60d67d261e15b48a"
  ),
  bsSviFeedId: envOr(
    import.meta.env.VITE_DEEPBOOK_BS_SVI_FEED_ID,
    "0xdc2f8270676bd05fb28491e8d4a41a495722fda7a454926dd66dbba256a21c69"
  ),
  accumulatorRootId: envOr(
    import.meta.env.VITE_DEEPBOOK_ACCUMULATOR_ROOT_ID,
    "0xacc"
  ),
  predictIndexerUrl: envOr(
    import.meta.env.VITE_DEEPBOOK_PREDICT_INDEXER_URL,
    "https://predict-server-beta.testnet.mystenlabs.com"
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
  bsSpotFeedId: envOr(
    import.meta.env.VITE_DEEPBOOK_BS_SPOT_FEED_ID_MAINNET,
    UNSET_ID
  ),
  bsForwardFeedId: envOr(
    import.meta.env.VITE_DEEPBOOK_BS_FORWARD_FEED_ID_MAINNET,
    UNSET_ID
  ),
  bsSviFeedId: envOr(
    import.meta.env.VITE_DEEPBOOK_BS_SVI_FEED_ID_MAINNET,
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
