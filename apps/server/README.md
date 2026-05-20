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
bun --filter server test              # bun test
bun --filter server typecheck         # tsc --noEmit

bun --filter server deepbook:discover # list active DeepBook OracleSVI on testnet
bun --filter server demo:duel         # end-to-end DeepBook-backed duel demo
```

## Env

Copy `.env.example` → `.env.local` and fill what the script you're running needs.

| Var | Used by | Notes |
| --- | --- | --- |
| `SUI_NETWORK` | `lib/sui.ts` | defaults to `testnet` |
| `SUI_RPC_URL` | `lib/sui.ts` | optional override; defaults to the public fullnode for `SUI_NETWORK` |
| `ADMIN_SECRET_KEY` | `lib/sui.ts::getAdminKeypair` | bech32 `suiprivkey1…`; required only by scripts that sign transactions |

## Tests

`bun test` runs `src/lib/sui.test.ts` (env helpers + keypair derivation). Tests use Bun's built-in runner — no extra deps.

## Layout

```
src/
├── index.ts             # Bun.serve entrypoint
├── lib/
│   ├── sui.ts           # SuiClient + Ed25519 keypair helpers
│   └── sui.test.ts      # 7 unit tests
└── scripts/
    ├── deepbook-discover.ts  # list/inspect DeepBook OracleSVI on testnet
    └── demo-duel.ts          # end-to-end duel against a real OracleSVI
```
