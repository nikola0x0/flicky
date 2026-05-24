import type { SuiCodegenConfig } from "@mysten/codegen";

/**
 * Sui TypeScript codegen — emits typed bindings for every Move function +
 * struct so `apps/web` can import generated builders directly:
 *
 *   import { duel } from "@/sui/gen/flicky";
 *   duel.record_swipe(tx, { ... }, [stakeCoinType]);
 *
 *   import { predict } from "@/sui/gen/deepbook_predict";
 *   predict.mint(tx, { ... }, [dusdcType]);
 *
 * Run after `bun run publish` (first deploy) or any `bun run upgrade`.
 */
const config: SuiCodegenConfig = {
  output: "../web/src/sui/gen",

  packages: [
    {
      // Local flicky package — source of truth for the generated TS layer.
      // After first publish, swap "flicky" for the deployed packageId from
      // deployed.json or rely on Move.toml's named-address resolution.
      path: "./",
      package: "flicky",
    },
    {
      // DeepBook Predict — the on-chain `0xf5ea2b3749…` package. Generated
      // bindings cover predict::mint, predict_manager::deposit, etc.
      path: "./deepbook_predict_min",
      package: "deepbook_predict",
    },
    {
      // SUI ↔ dUSDC AMM swap module — separate package on chain at
      // `0x51ea0f2932…`. Generates `swap.swap_x_for_y` / `swap_y_for_x`
      // bindings the deposit screen uses for the top-up flow.
      path: "./swap",
      package: "swap",
    },
  ],

  // `sui move summary` output lands under ./package_summaries/ — don't commit it.
  generateSummaries: true,

  // Skip framework transitive types we don't directly consume.
  prune: true,
};

export default config;
