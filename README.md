# Flicky

> Swipe YES/NO on a shared deck of binary predictions; face off against another player; on-chain escrow pays the winner.

A Tinder-style PvP prediction duel built on Sui, powered by DeepBook Predict. Two players swipe through a 5-card deck of binary digitals; the on-chain `Duel` object holds both stakes, owns the Predict positions, and pays the entire pot to whoever reads the market better.

## What Problem It Solves

Prediction markets today feel like trading terminals — order books and surfaces intimidate non-quants, and there is no head-to-head social loop. Meanwhile, swipe-based mobile betting apps (Pulse on Solana, Rush's $500M-in-a-week sub-hour BTC binaries) have proven enormous retail demand for "feel-based" prediction UX — but they're shallow and have no real PvP layer. Flicky combines DeepBook Predict's real on-chain binary-digital primitive with a Tinder-style swipe deck **and** a 1v1 escrow layer on top, so two players can put real stakes on "who reads BTC better."

## Core Features

- **Swipe-deck UI** — each card is one binary digital (YES/NO at strike X, expiry T). Swipe right = mint YES via `predict::mint`; swipe left = mint NO. Real on-chain Predict positions, not synthetic.
- **Duel objects** — Move shared object holds both players' stakes and owns the Predict positions for the match. Winner takes the entire pot after settlement.
- **Two duel modes**:
  - **Free / Social tier** — full 1v1 PvP with the same swipe + lockup + settlement flow, but no dUSDC stake and no `predict::mint`. Same engine, same card pool — only money flow is removed. Winner gets a win-counter increment.
  - **Staked tier** — opt-in 1v1 duels with real dUSDC side-pots at fixed tiers (Practice 1 / Standard 5 / High Roller 10 dUSDC) and ranked MMR.
- **Commit-reveal deck** — deck cards are hashed at duel creation and revealed at match start, so neither player can front-run with parallel positions.
- **Lockup / "watch the oracle" phase** — after the 60-second swipe phase, both players share a live view of the deck ticking toward settlement.

## Match Anatomy

```
t = 0s              t = 60s             t = ~10 min         t = ~10 min + 1 block
┌───────────────┐   ┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│  Swipe phase  │ → │ Lockup phase  │ → │  Settlement   │ → │   Payout      │
│  ~60 seconds  │   │  ~10 minutes  │   │  oracle ticks │   │  pot released │
│  5-card deck  │   │  live view +  │   │  binaries     │   │  to winner    │
│  commit-reveal│   │  reactions    │   │  resolve 0/1  │   │               │
└───────────────┘   └───────────────┘   └───────────────┘   └───────────────┘
```

1. **Stake** — at duel creation each player escrows a single stake (1 / 5 / 10 dUSDC) into the `Duel` shared object and binds their `PredictManager` ID to their player slot.
2. **Swipe phase (~60 s)** — both players swipe YES/NO on each of 5 cards. Each swipe is a single **player-signed PTB** that atomically calls `predict::mint` on the player's own `PredictManager` and `duel::record_swipe` on the shared `Duel` (records direction + snapshotted `p_swiped`). The PTB is gas-sponsored by the app — the player's zkLogin wallet only needs dUSDC, never SUI. Forced by Predict's `sender == manager.owner()` invariant.
3. **Lockup phase (~10 min)** — swipes are frozen. Shared UI shows spot vs. strike, time-to-expiry, reactions, and current mark (vibes only — mark does not affect scoring).
4. **Settlement** — oracle ticks; each binary resolves to 0 or 1. Player score = sum of `card_score` across the 5 cards.
5. **Payout** — keeper calls `predict::redeem_permissionless` on each player's `PredictManager` (Predict premium → into each player's own manager) and `duel::settle_duel` on the shared `Duel` (computes scores → releases the dUSDC side-pot to the winner). Tie → side-pot split.

### Scoring rule (odds-weighted)

```
card_score = correct ? (1 / p_swiped) × speed_multiplier(time_to_decide) : 0

p_swiped         = implied probability of the side swiped, snapshotted
                   from Predict's SVI surface at the moment of swipe.

speed_multiplier:
  decided in   0 –  5 s   → 1.5
  decided in   5 – 20 s   → 1.0
  decided in  20 – 60 s   → 0.75
  no swipe                → 0  (counts as wrong)

player_score     = Σ card_score across the 5 cards
```

Highest score wins the entire pot. Tie → lowest total swipe time wins. Still tied → pot split. Picking a 28% underdog correctly is worth ~3× picking the 88% favorite correctly — rewards skill, not consensus.

## Architecture

```
flicky/
├── apps/
│   ├── web        # Vite + React 19 — swipe UI, lockup view, share card
│   ├── server     # Bun — WebSocket relay, settled-redeem keeper, AI Deckmaster
│   └── contracts  # Move package + TS deploy/upgrade/codegen scripts
└── packages/
    └── ui         # shared shadcn/ui components
```

`apps/contracts/` contains:

- `sources/` — flicky Move modules: `duel`, `pricing` (SVI binary-digital), `math`, `i64`
- `deepbook_predict_min/`, `deepbook_min/`, `token_min/` — local stub packages that bind the on-chain DeepBook addresses for the Move compiler; see `apps/contracts/README.md` for why
- `scripts/` — `publish.ts`, `upgrade.ts` (writes `deployed.json` + mirrors `packageId` into `apps/web/.env.local`)
- `tests/duel_tests.move` — 20 unit tests covering lifecycle, scoring, settlement, ordering guards

Current testnet deployment lives in [`apps/contracts/deployed.json`](apps/contracts/deployed.json) — the file is the source of truth, regenerated by `bun --filter @flicky/contracts publish` / `upgrade`.

### DeepBook Predict touchpoints (MVP)

| #   | Primitive                        | Purpose                                                                                                                 |
| --- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1   | `predict::mint`                  | Called in the player-signed swipe PTB on the player's own `PredictManager`. Sized from a per-card budget tied to stake. |
| 2   | `predict::redeem_permissionless` | Keeper calls per player manager once oracle settles. Predict premium deposits into each player's own manager.           |
| 3   | `OracleSVI` reads                | Snapshot `p_swiped` recorded in `duel::record_swipe`. Also calibrates deck difficulty.                                  |
| 4   | `predict-server` indexer         | Backend detects settlement → triggers keeper redeem + `settle_duel`. Frontend renders lockup oracle ticks.              |

Plus, on our side:

- **`Duel` shared object** — escrows dUSDC stakes, records every swipe (key + `p_swiped` + decide-time), computes scores at settlement, pays the side-pot to the winner. Does **not** hold Predict positions.
- **`PredictManager`-per-user** — created on first staked-tier sign-in; reused across all duels.
- **Player-signed swipe PTBs** — `predict::mint` + `duel::record_swipe`, atomic.
- **Keeper PTBs** — `predict::redeem_permissionless` per manager + `duel::settle_duel`.
- **zkLogin + sponsored gas** — MVP-required. zkLogin = wallet identity. Sponsored gas covers every PTB (create_duel, join_duel, per-swipe, settle), so the zkLogin wallet only ever needs dUSDC.

## Funding the Wallet

The zkLogin address **is** the wallet. There is no separate in-app balance.

- **Free tier** — no funding required. Sponsored gas covers everything; `predict::mint` is skipped (positions are virtual).
- **Staked tier** — the zkLogin address must hold dUSDC to stake. The in-app **Deposit screen** shows the player's Sui address + QR + copy button. Users top up by sending dUSDC from any wallet (Suiet, Sui Wallet, CEX withdrawal). No faucet, no in-app on-ramp in MVP.

## Tech Stack

- **Monorepo** — Bun workspaces + Turborepo
- **Web** — Vite, React 19, Tailwind v4, shadcn/ui, `@mysten/sui` v2 + `@mysten/dapp-kit` v1
- **Server** — Bun runtime, TypeScript strict — will host WebSocket relay, settled-redeem keeper, sponsored-gas service, AI Deckmaster
- **Chain** — Sui testnet, Move 2024, DeepBook Predict
- **Contracts** — Move package + `@mysten/codegen` typed bindings auto-generated into `apps/web/src/sui/gen/`
- **Identity** — zkLogin (Google/Apple OAuth → Sui address); Phase 4
- **Gas** — sponsored end-to-end (player wallets only ever hold dUSDC); Phase 2
- **Realtime** — WebSocket relay (`Bun.serve`)

## Getting Started

Requires [Bun](https://bun.sh) ≥ 1.3 and the [Sui CLI](https://docs.sui.io/guides/developer/getting-started/sui-install) (for `sui move build` / `test` / `publish`).

```bash
bun install                          # install all workspace deps
bun dev                              # turbo dev — runs web + server in parallel
```

Individual apps:

```bash
bun --filter web dev                 # Vite dev server (default :5173)
bun --filter server dev              # Bun --hot server (default :3001)
bun --filter @flicky/contracts test  # sui move test (Move unit tests)
```

Working with the Move package (first-time setup or after any Move change):

```bash
# inside apps/contracts/
bun run test                         # sui move test --gas-limit 100000000000
bun run build                        # sui move build
bun run publish                      # first deploy to testnet (writes deployed.json)
bun run upgrade                      # subsequent upgrades (preserves originalPackageId)
bun run codegen                      # regenerate TS bindings → apps/web/src/sui/gen/
```

Once published, `apps/web/src/sui/gen/` holds typed `moveCall` builders for both the flicky package and DeepBook Predict. **The directory is gitignored — every developer regenerates locally after `bun install`.**

Other workspace tasks:

```bash
bun typecheck      # turbo typecheck across all workspaces
bun test           # bun-test in each app (server + web) — see each app README
bun lint
bun format
bun build
```

### First-time developer onboarding

1. `bun install`
2. `cd apps/contracts && cp .env.example .env.local && cp .env.example .env` — fill `SUI_DEPLOYER_PRIVATE_KEY` only if you intend to publish/upgrade. For read-only dev, you can skip.
3. `bun --filter @flicky/contracts codegen` — generates `apps/web/src/sui/gen/` against the currently-deployed package id from `deployed.json`. Required before `bun --filter web dev` typechecks.
4. `bun dev` to spin up web + server.

## Adding shadcn Components

```bash
bunx --bun shadcn@latest add button -c apps/web
```

Components land in `packages/ui/src/components` and are imported as:

```tsx
import { Button } from "@workspace/ui/components/button"
```

## Status

Hackathon MVP in progress.

- **Phase 1 (done)** — Move package shipped to testnet (`apps/contracts/deployed.json` for the live id), 20-test Move suite, server cleanup, web rewired around generated codegen bindings, end-to-end typecheck + tests green.
- **Phase 2 (next)** — real PRD-spec UI (3 stake tiers → matchmaking → swipe phase → lockup → share card), WebSocket relay matchmaking, sponsored-gas service, settled-redeem keeper.
- **Phase 3** — AI Deckmaster + commit-reveal deck.
- **Phase 4** — zkLogin + deposit screen.

Design docs live in [`docs/prd.md`](docs/prd.md) and [`docs/deepbook-oracle-architecture.md`](docs/deepbook-oracle-architecture.md).

## License

TBD
