/**
 * Deployed flicky package + the DeepBook Predict targets on testnet. Override
 * at build time via VITE_* env if you redeploy.
 */

export const CONFIG = {
  /**
   * Flicky package on testnet — first published 2026-05-20.
   * `apps/contracts/deployed.json` is the source of truth.
   */
  packageId:
    import.meta.env.VITE_FLICKY_PACKAGE_ID_TESTNET ??
    "0xa18ba03dbe2ba299e04588e9ac36a36dfec7e8e07cfcefec6c0f8e40f17e09b4",

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

  /** Default duel stake coin type. */
  stakeType: "0x2::sui::SUI" as const,

  /** 9-decimal fixed point unit (1.0 == 1e9). */
  ONE_E9: 1_000_000_000n,

  /** Default per-side stake in mist (0.01 SUI). User can override in the UI. */
  defaultStakeMist: 10_000_000n,

  /** Minimum allowed stake (must be > 0). */
  minStakeMist: 1_000_000n,
} as const;
