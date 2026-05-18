/**
 * Deployed flicky package + the testnet oracles the web app talks to.
 * Override at build time via VITE_* env if you redeploy.
 */
export const ASSETS = ["BTC", "ETH", "SOL", "SUI"] as const
export type AssetSymbol = (typeof ASSETS)[number]

/**
 * Selectable oracle source in the lobby. `DEEPBOOK_BTC` consumes DeepBook
 * Predict's real on-chain BTC `OracleSVI`; the others use our keeper-fed
 * `flicky::oracle::FlickyOracle`.
 */
export const ORACLE_SOURCES = [
  "DEEPBOOK_BTC",
  "BTC",
  "ETH",
  "SOL",
  "SUI",
] as const
export type OracleSource = (typeof ORACLE_SOURCES)[number]

export const CONFIG = {
  packageId:
    import.meta.env.VITE_FLICKY_PACKAGE_ID ??
    "0xaf8924792f606a929438fe507eaf314e8888666e2722643cbf4c697450ba7a75",
  /// DeepBook Predict package on testnet (provides `oracle::OracleSVI`).
  deepbookPredictPackageId:
    import.meta.env.VITE_DEEPBOOK_PREDICT_PACKAGE_ID ??
    "0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138",
  /// Latest known BTC `OracleSVI` on testnet. Auto-refresh at runtime via
  /// `findLatestDeepbookOracle()`; this is a fallback when the query fails.
  fallbackDeepbookOracleId:
    import.meta.env.VITE_DEEPBOOK_BTC_ORACLE_ID ??
    "0xdc8ae118f2770366e0f0a91deb5dd8533150cb79b343f83e800a9a951aca6cba",
  oracles: {
    BTC:
      import.meta.env.VITE_BTC_ORACLE_ID ??
      "0x0838ee523d261e655645a4628e9457285b50be2bf08cb969b8878543cb1ed4dd",
    ETH:
      import.meta.env.VITE_ETH_ORACLE_ID ??
      "0x4cfd475b4949abd28d1ded5f428f3a9db20196dae554cdd4717064954bb8be7a",
    SOL:
      import.meta.env.VITE_SOL_ORACLE_ID ??
      "0x99b9c681b8ba0aababecb90f630aafbae4cb358b2ba099721b3b191db1b51f8d",
    SUI:
      import.meta.env.VITE_SUI_ORACLE_ID ??
      "0xc2936338da147365372bf1e25c820caa34afadc812cecdfb57fc23de0eed56bb",
  } satisfies Record<AssetSymbol, string>,
  stakeType: "0x2::sui::SUI" as const,
  /// 9-decimal fixed point unit (1.0 == 1e9).
  ONE_E9: 1_000_000_000n,
  /// Default per-side stake in mist (0.01 SUI). User can override in the UI.
  defaultStakeMist: 10_000_000n,
  /// Minimum allowed stake (must be > 0).
  minStakeMist: 1_000_000n, // 0.001 SUI
} as const

export function sourceLabel(s: OracleSource): string {
  return s === "DEEPBOOK_BTC" ? "BTC · DeepBook" : `${s} · Flicky`
}
