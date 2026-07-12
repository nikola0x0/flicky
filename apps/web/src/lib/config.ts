/**
 * Deployed flicky package + the DeepBook Predict targets on testnet. Override
 * at build time via VITE_* env if you redeploy.
 */

export const CONFIG = {
  /**
   * Flicky package on testnet. Source of truth is
   * `apps/contracts/deployed.json`; if that drifts from this default,
   * update here so fresh checkouts without
   * `VITE_FLICKY_PACKAGE_ID_TESTNET` in `.env.local` still work.
   *
   * Settlement: per-card `settle_card(card_idx, &oracle)` × `deck_size`
   * accumulates payout/premium onto the Duel, then `finalize` distributes
   * the pot. `record_swipe` records the swipe's DeepBook `order_id`
   * on-chain (chained from the mint in the same PTB); premium is fed in
   * later by the keeper at settlement, not snapshotted at swipe time —
   * 6-24 dropped the `predict::get_trade_amounts` / `p_swiped` mechanism.
   */
  packageId:
    import.meta.env.VITE_FLICKY_PACKAGE_ID_TESTNET ??
    "0x5ceae1cacbba1862e0f0c4e8861280b8a1e9530ce4049317daf5d3951778582f",

  /** DeepBook Predict package on testnet (6-24 version). */
  deepbookPredictPackageId:
    import.meta.env.VITE_DEEPBOOK_PREDICT_PACKAGE_ID ??
    "0xdb3ef5a5129920e59c9b2ae25a77eddb48acd0e1c6307b97073f0e076016446e",

  /** DeepBook Predict ProtocolConfig shared object (6-24). */
  protocolConfigId:
    import.meta.env.VITE_DEEPBOOK_PROTOCOL_CONFIG_ID ??
    "0x2325224629b4bd96d1f1d7ee937e07f8a06f861018a130bbb26db09cb0394cb6",

  /** DeepBook Predict PoolVault shared object (6-24). */
  poolVaultId:
    import.meta.env.VITE_DEEPBOOK_POOL_VAULT_ID ??
    "0xfde98c636eb8a7aba59c3a238cfee6b576b7118d1e5ffa2952876c4b270a3a2a",

  /** DeepBook Predict Registry shared object (6-24). */
  predictRegistryId:
    import.meta.env.VITE_DEEPBOOK_PREDICT_REGISTRY_ID ??
    "0x54afbf245caf42466cedb5756ed7816f34f544afdfa13579a862eccf3afa21ca",

  /** DeepBook Account package (6-24). */
  accountPackageId:
    import.meta.env.VITE_DEEPBOOK_ACCOUNT_PACKAGE_ID ??
    "0xb9389eac8d59170ffd1427c1a66e5c8306263464fcc6615e825c1f5b3e15da3b",

  /** DeepBook Account Registry shared object (6-24). */
  accountRegistryId:
    import.meta.env.VITE_DEEPBOOK_ACCOUNT_REGISTRY_ID ??
    "0x3c54d5b8b6bca376fc289121838ad02f8a5b3843242b9ad7e8f8245720e685a2",

  /** DeepBook Oracle Registry shared object (6-24). */
  oracleRegistryId:
    import.meta.env.VITE_DEEPBOOK_ORACLE_REGISTRY_ID ??
    "0xf3deaff68cbd081a35ec21653af6f671d2ad5f012f3b4d817d81752843374136",

  /** Pyth BTC feed object id (6-24). */
  pythFeedId:
    import.meta.env.VITE_DEEPBOOK_PYTH_FEED_ID ??
    "0xc78d7de16217d46d21b92ae475da799448be30b71a758dc6d7bb3ac2f1c35afb",

  /** BlockScholes Spot feed object id (6-24). */
  bsSpotFeedId:
    import.meta.env.VITE_DEEPBOOK_BS_SPOT_FEED_ID ??
    "0xcdc5fa7364e60fd2504aa96f65b707dc0734e507a919b1a7d7d63164fd67b745",

  /** BlockScholes Forward feed object id (6-24). */
  bsForwardFeedId:
    import.meta.env.VITE_DEEPBOOK_BS_FORWARD_FEED_ID ??
    "0xe72c734ea8d8dcbc9183d9d8f96f51aaa1fb5034d5ed33ac60d67d261e15b48a",

  /** BlockScholes SVI feed object id (6-24). */
  bsSviFeedId:
    import.meta.env.VITE_DEEPBOOK_BS_SVI_FEED_ID ??
    "0xdc2f8270676bd05fb28491e8d4a41a495722fda7a454926dd66dbba256a21c69",

  /** AccumulatorRoot object id (required for all mint/redeem/deposit/withdraw). */
  accumulatorRootId:
    import.meta.env.VITE_DEEPBOOK_ACCUMULATOR_ROOT_ID ?? "0xacc",

  /** DeepBook Predict indexer base URL (6-24). */
  predictIndexerUrl:
    import.meta.env.VITE_DEEPBOOK_PREDICT_INDEXER_URL ??
    "https://predict-server-beta.testnet.mystenlabs.com",

  serverHttpUrl:
    import.meta.env.VITE_SERVER_HTTP_URL || "http://localhost:3001",
  serverWsUrl: import.meta.env.VITE_SERVER_WS_URL || "ws://localhost:3001/ws",

  CLOCK_ID: "0x6",

  /** Default duel stake coin type. */
  stakeType: "0x2::sui::SUI" as const,

  /** 9-decimal fixed point unit (1.0 == 1e9). */
  ONE_E9: 1_000_000_000n,

  /** Default per-side stake in mist (0.01 SUI). User can override in the UI. */
  defaultStakeMist: 10_000_000n,

  /** Minimum allowed stake (must be > 0). */
  minStakeMist: 1_000_000n,
} as const
