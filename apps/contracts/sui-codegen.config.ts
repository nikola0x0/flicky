import type { SuiCodegenConfig } from "@mysten/codegen"

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
      // DeepBook Predict 8-21. Generated bindings cover the local
      // predict_account link stub; player mint calls remain raw PTB calls.
      path: "./deepbook_predict_min",
      package: "deepbook_predict",
    },
    {
      // account_min — 8-21 account link stub.
      path: "./account_min",
      package: "account",
    },
  ],

  // `sui move summary` output lands under ./package_summaries/ — don't commit it.
  generateSummaries: true,

  // Skip framework transitive types we don't directly consume.
  prune: true,
}

export default config
