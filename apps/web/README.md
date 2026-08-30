# apps/web

Vite + React 19 + Tailwind v4 + shadcn/ui. Currently:

- minimal smoke-test UI exercising the post-Phase-1 libs (`src/App.tsx`)
- thin lib wrappers around generated codegen bindings (`src/lib/{flicky,deepbook,config}.ts`)
- generated typed `moveCall` builders auto-emitted into `src/sui/gen/` by `@mysten/codegen`

Real PRD-spec gameplay UI (3 stake tiers → matchmaking → swipe phase → lockup → share card) replaces `App.tsx` in Phase 2.

## Commands

```bash
bun --filter web dev          # vite (default :5173)
bun --filter web build        # tsc -b && vite build
bun --filter web test         # bun test src/lib
bun --filter web typecheck    # tsc --noEmit -p tsconfig.app.json
bun --filter web knip         # scan for unused files/exports/deps
bun --filter web preview      # serve the production build
```

## First-time setup

`src/sui/gen/` is **gitignored** and required for both typecheck and dev. Regenerate it after `bun install`:

```bash
bun --filter @flicky/contracts codegen
```

This reads the currently-deployed `packageId` from `apps/contracts/deployed.json` plus the local stub Move packages, and writes typed bindings (`flicky/duel.ts`, `deepbook_predict/predict.ts`, etc.) into `src/sui/gen/`. Re-run after any Move signature change or contract upgrade.

## Env

Optional overrides in `.env.local`:

| Var                                 | Used by         | Default                                                            |
| ----------------------------------- | --------------- | ------------------------------------------------------------------ |
| `VITE_FLICKY_PACKAGE_ID_TESTNET`    | `lib/config.ts` | mirrored automatically by `bun --filter @flicky/contracts upgrade` |
| `VITE_DEEPBOOK_PREDICT_PACKAGE_ID`  | `lib/config.ts` | Predict 8-21 testnet package                                       |
| `VITE_DEEPBOOK_ACCOUNT_PACKAGE_ID`  | `lib/config.ts` | Account 8-21 testnet package                                       |
| `VITE_DEEPBOOK_ACCOUNT_REGISTRY_ID` | `lib/config.ts` | AccountRegistry 8-21 object                                        |
| `VITE_DEEPBOOK_BS_VALUE_STORE_ID`   | `lib/config.ts` | BTC Block Scholes value store                                      |
| `VITE_DEEPBOOK_BS_SVI_STORE_ID`     | `lib/config.ts` | BTC Block Scholes SVI store                                        |

## Tests

`bun test` runs `src/lib/flicky.test.ts`:

- `oracleStrikes` math correctness
- `parseDuel` JSON → typed `DuelState` shape
- All four PTB builders (`buildCreateDuelTx`, `buildJoinDuelTx`, `buildSwipeTx`, `buildSettleAndFinalizeTx`) assert the resulting `Transaction` contains the right `moveCall` targets

Tests bypass React entirely — pure module imports against the Bun runner. No vitest, no jsdom.

## Layout

```
src/
├── main.tsx            # React entrypoint + dapp-kit providers
├── App.tsx             # Phase-1 smoke-test view (replaced in Phase 2)
├── components/
│   └── theme-provider.tsx
├── lib/
│   ├── config.ts       # package + oracle ids, network config
│   ├── flicky.ts       # PTB builders + Duel/Oracle reads
│   ├── deepbook.ts     # DeepBook Predict mint/redeem builders, dUSDC helpers
│   └── flicky.test.ts  # 15 unit tests
└── sui/
    └── gen/            # @mysten/codegen output (gitignored)
        ├── flicky/
        └── deepbook_predict/
```
