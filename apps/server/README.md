# apps/server

Bun runtime backend. Currently:

- minimal `Bun.serve` HTTP + WebSocket scaffolding (`src/index.ts`)
- DeepBook discovery + duel demo scripts (`src/scripts/`)
- Sui keypair + client helpers (`src/lib/sui.ts`)

Real Phase 2 services (matchmaking relay, sponsored gas, settled-redeem keeper, AI Deckmaster) attach here.

## Commands

```bash
bun --filter server dev               # bun --hot src/index.ts (default :3001)
bun --filter server start             # production-style run
bun --filter server test              # unit tests (fast, no network)
bun --filter server test:e2e          # live testnet E2E (requires ADMIN_SECRET_KEY)
bun --filter server typecheck         # tsc --noEmit

bun --filter server deepbook:discover # list active DeepBook OracleSVI on testnet
bun --filter server demo:duel         # end-to-end DeepBook-backed duel demo
bun --filter server bot               # matchmaking bot (auto-joins + swipes PENDING duels)
bun --filter server keeper            # settled-redeem keeper (auto-settle + finalize on settled oracles)
```

The `bot` is what makes the single-player demo work: spin it up in one
terminal, launch `bun --filter web dev` in another, click a stake tier,
and the bot will pick up the new duel within ~5s, join with a matching
stake, and play out its 5 swipes. Requires `BOT_SECRET_KEY` in
`.env.local` and ≥ 0.2 testnet SUI on the bot wallet.

The `keeper` closes the loop on the other side: it polls ACTIVE duels
and, once the backing oracle has settled, bundles every not-yet-settled
`settle_card` + `finalize` into a single PTB. Players never need to
click the "settle + finalize" button; payouts appear unprompted. Reuses
`BOT_SECRET_KEY` by default; override with `KEEPER_SECRET_KEY` to run
the two services with separate wallets. Keeper functions are
permissionless on chain — any funded wallet works.

## Env

Copy `.env.example` → `.env.local` and fill what the script you're running needs.

| Var | Used by | Notes |
| --- | --- | --- |
| `SUI_NETWORK` | `lib/sui.ts` | defaults to `testnet` |
| `SUI_RPC_URL` | `lib/sui.ts` | optional override; defaults to the public fullnode for `SUI_NETWORK` |
| `ADMIN_SECRET_KEY` | `lib/sui.ts::getAdminKeypair` | bech32 `suiprivkey1…`; required only by scripts that sign transactions |

## Tests

Two tiers:

**Unit** (`bun --filter server test`) — `src/lib/*.test.ts`. Fast, no network. 7 tests on env helpers + keypair derivation.

**E2E** (`bun --filter server test:e2e`) — `src/scripts/e2e.test.ts`. Runs the full duel lifecycle (create → join → 5 swipes/player → settle → finalize) against live Sui testnet. Asserts the on-chain payout matches the expected winner.

The E2E test requires:

- `ADMIN_SECRET_KEY` (bech32 suiprivkey1…) in `.env.local` — the test creator + funder. **Skipped automatically when missing**, so default `bun test` in CI stays green.
- The admin wallet needs ≥ 0.2 testnet SUI (gas + challenger fund + stake).
- A SETTLED BTC `OracleSVI` on DeepBook Predict testnet. The test discovers one; if none exists, the suite logs and exits cleanly.

The test reads the flicky `packageId` from `apps/contracts/deployed.json`, so re-publishing the Move package doesn't require any test edit. Tests are written with Bun's built-in runner — no extra deps.

## Layout

```
src/
├── index.ts             # Bun.serve entrypoint
├── lib/
│   ├── sui.ts           # SuiClient + Ed25519 keypair helpers
│   └── sui.test.ts      # 7 unit tests
└── scripts/
    ├── deepbook-discover.ts  # list/inspect DeepBook OracleSVI on testnet
    ├── demo-duel.ts          # interactive duel against a real OracleSVI
    ├── bot.ts                # matchmaking bot — auto-joins + swipes
    ├── keeper.ts             # settled-redeem keeper — auto settle + finalize
    └── e2e.test.ts           # automated live-testnet E2E (opt-in via test:e2e)
```
