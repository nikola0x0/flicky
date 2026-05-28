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
   * the pot. `record_swipe` snapshots premium + p_swiped on-chain via
   * `predict::get_trade_amounts` inside the swipe PTB.
   */
  packageId:
    import.meta.env.VITE_FLICKY_PACKAGE_ID_TESTNET ??
    "0xaed053fcc146abd1da507eae72b4f3e9c838d83c83c7b68b230a3c9a2601a522",

  /** DeepBook Predict package on testnet (provides `oracle::OracleSVI`). */
  deepbookPredictPackageId:
    import.meta.env.VITE_DEEPBOOK_PREDICT_PACKAGE_ID ??
    "0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138",

  /**
   * Latest known BTC `OracleSVI` on testnet — fallback when registry query
   * fails. Refreshed at runtime via `findLatestOracleSVI()`.
   */
  fallbackOracleSviId:
    import.meta.env.VITE_DEEPBOOK_BTC_ORACLE_ID ??
    "0xdc8ae118f2770366e0f0a91deb5dd8533150cb79b343f83e800a9a951aca6cba",

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
} as const;
