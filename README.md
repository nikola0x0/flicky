# Flicky

> Swipe YES/NO on a 5-card binary-prediction deck; face off against another player; on-chain escrow pays the winner.

A Tinder-style PvP prediction duel built on Sui, powered by DeepBook Predict. Two players swipe through a 5-card deck of binary digitals; the on-chain `Duel` shared object escrows both stakes and releases the dUSDC side-pot to whoever ends with the higher total PnL across their 5 Predict positions.

## What Problem It Solves

Prediction markets today feel like trading terminals — order books and surfaces intimidate non-quants, and there is no head-to-head social loop. Meanwhile, swipe-based mobile betting apps (Pulse on Solana, Rush's $500M-in-a-week sub-hour BTC binaries) have proven enormous retail demand for "feel-based" prediction UX — but they're shallow and have no real PvP layer. Flicky combines DeepBook Predict's real on-chain binary-digital primitive with a Tinder-style swipe deck **and** a 1v1 escrow layer on top, so two players can put real stakes on "who reads BTC better."

## Core Features

- **Swipe-deck UI** — each card is one binary digital (YES/NO at strike X, expiry T). Swipe right = mint YES via `predict::mint`; swipe left = mint NO. Real on-chain Predict positions, not synthetic.
- **Duel escrow** — Move shared `Duel` object holds both players' dUSDC side-pots. Each player keeps and redeems their own Predict positions; the Duel only adjudicates the side-pot.
- **Two modes**:
  - **Practice** — solo vs. a bot with virtual swipes against the real oracle. No stake, no `predict::mint`. On-ramp for the swipe loop.
  - **Staked PvP** — 1v1 duels with real dUSDC side-pots at fixed tiers (**1 / 3 / 5 / 10 dUSDC**) and ranked MMR.
- **Commit-reveal deck** — deck cards are hashed at duel creation and revealed at match start, so neither player can front-run with parallel positions.
- **PnL-based scoring** — winner is the player with higher total redeem PnL across all 5 Predict positions. No UI multipliers, no synthetic odds-weighting — Predict's premium math is the scoring engine.
- **In-app SUI ↔ dUSDC swap** — fixed 1:10 rate inside the Deposit screen so a player whose only asset is SUI can fund a stake without leaving Flicky.

## End-to-end player flow

1. Sign in (zkLogin via Enoki).
2. Predict Manager created on first sign-in, **sponsored by Flicky**.
3. Practice Mode (optional) — solo vs. bot, virtual positions, learn the swipe loop.
4. Deposit dUSDC (or swap SUI → dUSDC at 1:10 in-app) to enter matching.
5. Pick a stake tier (**1 / 3 / 5 / 10 dUSDC**) and queue. Entry gated on `PredictManager` balance **≥ 5 dUSDC** (max per-card mint × 5 cards).
6. Play (up to 10 min). Five cards = the 5 nearest oracle resolutions strictly **>10 min out**, each with its own expiry. Each swipe is a single player-signed PTB: `predict::mint` + `duel::record_swipe`. Five swipes → five real Predict positions.
7. Per-card settlement at each card's own oracle tick. `player_score = Σ (redeem − premium)` across the 5 cards.
8. **Winner** takes the dUSDC Duel Pot and may redeem their 5 Predict positions whenever they want.
9. **Loser** keeps no side-pot but still owns their Predict positions — anything that settled in their favor is redeemable.

## Match Anatomy

```
t = 0s               t ≤ 10 min            per-card oracle tick    after final card settles
┌────────────────┐   ┌────────────────┐    ┌────────────────┐      ┌────────────────┐
│  Swipe phase   │ → │ Watch / wait   │  → │  Per-card      │  →   │  Settle duel   │
│  reveal deck;  │   │  live oracle   │    │  settlement    │      │  pot → winner; │
│  5 cards each  │   │  ticks; spot   │    │  PnL locks per │      │  players redeem│
│  mint a Predict│   │  vs. strikes;  │    │  card at its   │      │  their own     │
│  position      │   │  emoji reacts  │    │  expiry        │      │  positions     │
└────────────────┘   └────────────────┘    └────────────────┘      └────────────────┘
```

1. **Stake** — at duel creation each player escrows a stake (1 / 3 / 5 / 10 dUSDC) into the shared `Duel` object and binds their `PredictManager` ID to their player slot.
2. **Swipe phase (≤10 min)** — both players swipe YES/NO on each of 5 cards. Each swipe is a single **player-signed PTB** that atomically calls `predict::mint` on the player's own `PredictManager` and `duel::record_swipe` on the shared `Duel`. The PTB is gas-sponsored by the app — the player's zkLogin wallet only needs dUSDC, never SUI. Atomicity is forced by Predict's `sender == manager.owner()` invariant.
3. **Watch / wait** — once both players have swiped or the 10-min clock expires, the UI streams live oracle ticks, marks, and emoji reactions until each card's expiry.
4. **Per-card settlement** — each binary resolves at its own oracle tick. Cards in one deck can settle at different times because they are drawn from the 5 nearest oracles >10 min out.
5. **Payout** — once all 5 cards have settled, the indexer triggers `duel::settle_duel`. The contract reads each player's per-card PnL, sums it, and releases the dUSDC side-pot to whoever has the higher total. Tie → side-pot split. Each player redeems their own Predict positions independently via `predict::redeem_permissionless`.

### Scoring rule (real PnL)

```
card_pnl     = predict_redeem(player, card) − premium_paid(player, card)
player_score = Σ card_pnl across the 5 cards
```

Highest total PnL wins the entire dUSDC side-pot. Tie → side-pot split. Predict's own premium math already rewards skill: a correct call on a 0.28 implied YES pays out ~3× a correct call on a 0.88 YES — no extra UI multiplier needed. The Duel side-pot and a player's individual Predict PnL are independent ledgers: a player can lose the Duel and still net-positive on a hot pick, or win the Duel with flat individual PnL.

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

- `sources/` — flicky Move modules: `duel` (escrow + PnL settle), `swap` (fixed 1:10 SUI ↔ dUSDC), `pricing` (SVI binary-digital), `math`, `i64`
- `deepbook_predict_min/`, `deepbook_min/`, `token_min/` — local stub packages that bind the on-chain DeepBook addresses for the Move compiler; see `apps/contracts/README.md` for why
- `scripts/` — `publish.ts`, `upgrade.ts` (writes `deployed.json` + mirrors `packageId` into `apps/web/.env.local`)
- `tests/duel_tests.move` — Move unit tests covering lifecycle, PnL settlement, ordering guards

Current testnet deployment lives in [`apps/contracts/deployed.json`](apps/contracts/deployed.json) — the file is the source of truth, regenerated by `bun --filter @flicky/contracts publish` / `upgrade`.

### DeepBook Predict touchpoints (MVP)

| #   | Primitive                        | Purpose                                                                                                                       |
| --- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 1   | `predict::mint`                  | Called in the player-signed swipe PTB on the player's own `PredictManager`. Sized per-card from a stake-tier budget (≤1 dUSDC/card). |
| 2   | `predict::redeem_permissionless` | Each player redeems their own positions after card settle; keeper may call opportunistically. Payouts deposit into the player's own manager. |
| 3   | `OracleSVI` reads                | Powers the live mark view, calibrates deck difficulty, and supplies each card's 0/1 settlement.                                |
| 4   | `predict-server` indexer         | Backend detects per-card settlement → triggers `duel::settle_duel` once all 5 cards have resolved. Also drives the lockup view. |

Plus, on our side:

- **`Duel` shared object** — escrows the dUSDC side-pot, records every swipe (card index, direction, position reference, premium paid). At settle, reads per-player PnL from the recorded positions and releases the side-pot to the higher total. Does **not** hold Predict positions itself.
- **`Swap` module** — fixed-rate 1 SUI ↔ 10 dUSDC, backing the in-app Deposit/Swap screen.
- **`PredictManager`-per-user** — created on first sign-in, **sponsored by Flicky**, reused across all duels.
- **Player-signed swipe PTBs** — `predict::mint` + `duel::record_swipe`, atomic.
- **Keeper PTBs** — `duel::settle_duel` (and opportunistic `predict::redeem_permissionless`).
- **zkLogin (Enoki) + sponsored gas** — MVP-required. zkLogin = wallet identity. Sponsored gas covers every PTB (manager creation, create_duel, join_duel, per-swipe, settle, redeem), so the zkLogin wallet only ever needs dUSDC.

## Funding the Wallet

The zkLogin address **is** the wallet. There is no separate in-app balance.

- **Practice** — no funding required. Solo vs. bot with virtual positions.
- **Staked PvP** — the zkLogin address must hold dUSDC to stake, and the `PredictManager` must hold **≥5 dUSDC** to cover up to 5 dUSDC of per-card Predict premium across the deck. The in-app **Deposit / Swap screen** shows the player's Sui address + QR + copy button, and includes a **SUI → dUSDC swap at a fixed 1:10 rate** so a player whose only on-chain asset is SUI can fund a stake without leaving Flicky. Users can also top up by sending dUSDC from any external wallet (Suiet, Sui Wallet, CEX withdrawal). No external on-ramp in MVP.

## Tech Stack

- **Monorepo** — Bun workspaces + Turborepo
- **Web** — Vite, React 19, Tailwind v4, shadcn/ui, `@mysten/sui` v2 + `@mysten/dapp-kit` v1
- **Server** — Bun runtime, TypeScript strict — hosts the card-generation API, WebSocket matchmaking + game-room relay, `Duel` indexer, PnL/settle tracker, settled-redeem keeper, and sponsored-gas service
- **Chain** — Sui testnet, Move 2024, DeepBook Predict
- **Contracts** — Move package (`duel`, `swap`, `pricing`) + `@mysten/codegen` typed bindings auto-generated into `apps/web/src/sui/gen/`
- **Identity** — zkLogin via **Enoki** (Google/Apple OAuth → Sui address)
- **Gas** — sponsored end-to-end (player wallets only ever hold dUSDC)
- **Realtime** — WebSocket relay (`Bun.serve`); match clock is authoritative on the server

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

- **Phase 1 (done)** — Move package shipped to testnet (`apps/contracts/deployed.json` for the live id), Move test suite, server cleanup, web rewired around generated codegen bindings, end-to-end typecheck + tests green.
- **Phase 2 (next)** — PRD-spec UI (Practice on-ramp → 4 stake tiers → matchmaking → swipe + watch → settle + redeem → share card), WebSocket matchmaking + game-room relay, sponsored-gas service, `Duel` indexer + PnL/settle tracker, settled-redeem keeper.
- **Phase 3** — AI Deckmaster (5-nearest-oracle generation, commit-reveal) and `swap` module wiring on the Deposit page.
- **Phase 4** — zkLogin via Enoki + sponsored Predict Manager bootstrap + Deposit/Swap screen.

Design docs live in [`docs/prd.md`](docs/prd.md) and [`docs/deepbook-oracle-architecture.md`](docs/deepbook-oracle-architecture.md).

## License

TBD
