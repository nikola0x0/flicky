# Flicky — The Prediction Arena

> Swipe YES/NO on a binary-prediction deck, face off against another player, and on-chain escrow pays the winner. A Tinder-style PvP prediction duel on **Sui**, powered by **DeepBook Predict**.

[![Demo](https://img.shields.io/badge/▶_Watch_the_demo-4_min-FF0000)](https://youtu.be/sKIKsmdRs9U)
&nbsp;·&nbsp; **Live on Sui testnet** &nbsp;·&nbsp; Built for **Sui Overflow 2026**

| | |
| --- | --- |
| 🎬 **Demo video** | https://youtu.be/sKIKsmdRs9U |
| 📦 **Package (testnet)** | [`0xe1b1853ab66c44dbe00a4b64238a3f64e226dfcd50c331d095fb38599bdc1854`](https://suiscan.xyz/testnet/object/0xe1b1853ab66c44dbe00a4b64238a3f64e226dfcd50c331d095fb38599bdc1854) |
| 🔗 **On-chain primitive** | DeepBook Predict (binary digitals) |
| 🔑 **Identity / gas** | zkLogin via Enoki · sponsored gas end-to-end |

---

## 30-second pitch

Prediction markets are powerful but look like a Bloomberg terminal — order books, Greeks, vol surfaces. Meanwhile swipe-betting apps have proven retail *loves* feel-based prediction UX (Pulse on Solana, Rush's $500M-in-a-week sub-hour BTC binaries) — but they're shallow, custodial, and have **no real opponent**.

**Flicky is both.** Two players swipe YES/NO through the same deck of binary-digital cards. Every swipe mints a *real* on-chain DeepBook Predict position — not a synthetic bet — and a Move `Duel` shared object escrows both stakes and pays the dUSDC side-pot to whoever reads the market better. zkLogin + sponsored gas mean it feels like a mobile game: no seed phrase, no wallet popups, no SUI required.

> **Two players. One deck. One question — who reads the market better?**

---

## Watch the demo (4 min)

▶️ **https://youtu.be/sKIKsmdRs9U**

What to look for — these are the things that separate Flicky from a generic Predict front-end:

1. **Real on-chain positions** — swipe right = `predict::mint` YES on testnet, not a synthetic toggle.
2. **No wallet popups** — the *absence* of signing prompts is the magic. zkLogin + sponsored gas make every swipe a one-tap, gasless transaction.
3. **One atomic swipe PTB** — a single transaction does `predict::mint` (player's own manager) **and** `record_swipe` (shared `Duel`) in the same block. See it on Suiscan in the demo.
4. **Commit-reveal deck** — cards are hashed at duel creation, revealed only at match start → provably fair, no front-running.
5. **On-chain settlement** — the oracle resolves each card 0/1; a keeper redeems and finalizes; the winner takes the pot. The full lifecycle closes on-chain.

---

## How a duel works — the player walkthrough

```
 sign in        deposit / stake      swipe phase (≤10 min)      lockup / watch        settle + payout
┌──────────┐   ┌───────────────┐    ┌──────────────────┐      ┌──────────────┐      ┌────────────────┐
│ zkLogin  │ → │ pick a tier   │ →  │ reveal deck;     │  →   │ live oracle  │  →   │ per-card 0/1;  │
│ (Google) │   │ 1/3/5/10 dUSDC│    │ swipe YES/NO →   │      │ ticks; spot  │      │ higher PnL     │
│ no seed  │   │ + queue       │    │ each = a real    │      │ vs strike;   │      │ takes the pot; │
│ phrase   │   │               │    │ Predict position │      │ emoji reacts │      │ both redeem    │
└──────────┘   └───────────────┘    └──────────────────┘      └──────────────┘      └────────────────┘
```

1. **Sign in** — zkLogin via Enoki (Google/Apple OAuth → Sui address). No seed phrase, no extension. On first sign-in, a `PredictManager` is created for you, **sponsored by Flicky**. Your wallet only ever holds dUSDC.
2. **Fund & queue** — deposit dUSDC (or swap SUI → dUSDC at a fixed 1:10 rate inside the app), pick a stake tier (**1 / 3 / 5 / 10 dUSDC**), and enter matchmaking. Entry is gated on the manager holding **≥ 5 dUSDC** (worst-case premium across a full 5-card deck).
3. **Match & reveal** — matchmaking pairs two players into a Move `Duel` shared object that escrows both stakes. The deck is **commit-reveal**: hashed at `create_duel`, revealed only at match start, so neither player can pre-stage trades.
4. **Swipe (≤ 10 min)** — swipe right = YES, left = NO, through every card in the deck. Each swipe fires a **single atomic PTB** that calls `predict::mint` on *your own* `PredictManager` (opening a real Predict position) and `record_swipe` on the shared `Duel` (logging your direction and snapshotting the probability you swiped at). No wallet popup — the PTB is gas-sponsored.
5. **Lockup / watch** — once both players finish swiping (or the 10-min clock expires), the duel enters a shared live view of spot vs. strike, ticking toward each card's expiry, with emoji reactions. Dead waiting time becomes the ritual.
6. **Settle** — each binary resolves to 0/1 at its own oracle tick. The settled-redeem keeper calls `settle_card` per card (and `redeem_permissionless` on each player's manager), then `finalize` releases the dUSDC side-pot to the higher total PnL.
7. **Payout & keep** — the **winner** takes the entire side-pot; **both** players keep and can redeem their own Predict positions whenever they want. A tie splits the pot.

### Adaptive deck size

The deck isn't a fixed 5 — it's **sized to live oracle supply** at duel creation: `deckSize = min(liveOracles, 5)`, clamped to a **3–5 band**, and built from the **soonest-settling** eligible oracles (expiry > 10 min and within a ~3h horizon). On testnet, short-dated oracle supply fluctuates between 3 and 5, so the deck flexes to whatever's live instead of failing — and always picks the fastest-resolving cards so a duel finalizes as soon as possible.

### Scoring — real PnL, no UI multipliers

```
card_pnl     = predict_redeem(player, card) − premium_paid(player, card)
player_score = Σ card_pnl  across the deck
```

Highest total PnL wins the entire dUSDC side-pot; a tie splits it. **Predict's own premium math is the scoring engine** — a correct call on a 0.28-implied YES pays out ~3× a correct call on a 0.88 YES, so a contrarian read scores more than following the crowd. No synthetic odds-weighting, no UI multiplier. The Duel side-pot and a player's individual Predict PnL are independent ledgers: you can lose the Duel but still net-positive on a hot pick, or win the Duel with flat individual PnL.

### Two tiers, one engine

- **Practice** — solo vs. a bot with virtual swipes against the *real* oracle. No stake, no `predict::mint`. The on-ramp for the swipe loop.
- **Staked PvP** — 1v1 duels with real dUSDC side-pots at fixed tiers (1 / 3 / 5 / 10 dUSDC) and ranked MMR.

Both run the exact same swipe → lockup → settle flow (the contract exposes `*_free` entrypoints that mirror the staked path); only the money flow is gated.

---

## What's actually on-chain

Flicky is not a Predict front-end with a database behind it — the duel lifecycle lives on Sui.

### DeepBook Predict touchpoints

| #   | Primitive                        | Role in Flicky |
| --- | -------------------------------- | -------------- |
| 1   | `predict::mint`                  | Called in the **player-signed swipe PTB** on the player's own `PredictManager`. Sized per-card from a stake-tier budget (≤ 1 dUSDC/card). |
| 2   | `predict::redeem_permissionless` | Each player redeems their own positions after a card settles; the keeper may call opportunistically. Payouts deposit into the player's own manager. |
| 3   | `OracleSVI` reads                | Powers the live mark view, calibrates deck difficulty, snapshots `p_swiped` at swipe time, and supplies each card's 0/1 settlement. |
| 4   | Predict indexer / settlement     | Backend detects per-card settlement → drives the keeper through `settle_card` × N then `finalize`. Also drives the lockup view. |

### Flicky's Move package (`apps/contracts/`)

- **`Duel` shared object** — escrows the dUSDC side-pot and records every swipe (card index, direction, position reference, premium paid). At settle, reads per-player PnL and releases the side-pot to the higher total. It does **not** hold Predict positions — each player owns their own manager.
- **`swap` module** — fixed-rate 1 SUI ↔ 10 dUSDC, backing the in-app Deposit/Swap screen so a SUI-only player can fund a stake without leaving Flicky.
- **`pricing` (SVI binary-digital)**, `math`, `i64` — supporting modules.
- Lifecycle entrypoints: `create_duel` / `join_duel` / `reveal_deck` / `record_swipe` / `settle_card` / `finalize`, each with a `*_free` practice-tier variant, plus `refund_duel` / `claim_reveal_timeout` safety paths. Covered by a Move unit-test suite (`tests/duel_tests.move`).

### Why these design decisions

- **Swipe PTBs are player-signed and atomic** — Predict requires `sender == manager.owner()`, so the player *must* be the signer. zkLogin + sponsored gas are what make that invisible. The mint and the `record_swipe` land in the same block, so a position can never exist without its duel record.
- **The Duel escrows the side-pot, not the positions** — players keep full custody of their Predict positions; the contract only adjudicates the side-pot from recorded PnL.
- **Commit-reveal deck** — hashing the deck at creation and revealing at match start makes it provably fair and impossible to front-run.

---

## Architecture

```
flicky/
├── apps/
│   ├── web        # Vite + React 19 — swipe UI, lockup view, share card
│   ├── server     # Bun — WebSocket relay, indexer, settled-redeem keeper,
│   │              #       sponsored-gas service, AI Deckmaster
│   └── contracts  # Move package + TS deploy/upgrade/codegen scripts
└── packages/
    └── ui         # shared shadcn/ui components
```

| Layer | Tech |
| --- | --- |
| **Web** | Vite, React 19, Tailwind v4, shadcn/ui, `@mysten/sui` v2 + `@mysten/dapp-kit` v1 |
| **Server** | Bun (TypeScript strict) — card-generation API, WebSocket matchmaking + game-room relay, `Duel` indexer, PnL/settle tracker, settled-redeem keeper, sponsored-gas service |
| **Chain** | Sui testnet, Move 2024, DeepBook Predict |
| **Contracts** | Move package (`duel`, `swap`, `pricing`) + `@mysten/codegen` typed bindings |
| **Identity** | zkLogin via **Enoki** (Google/Apple OAuth → Sui address) |
| **Gas** | sponsored end-to-end — player wallets only ever hold dUSDC |
| **Realtime** | WebSocket relay (`Bun.serve`); the match clock is authoritative on the server |

---

## Status

**Shipped — live on Sui testnet.** The full duel lifecycle works end-to-end: zkLogin sign-in, sponsored `PredictManager` bootstrap, matchmaking, commit-reveal decks (AI Deckmaster, adaptive 3–5 sizing), atomic player-signed swipe PTBs, the live lockup view, two-phase on-chain settlement (`settle_card` → `finalize`), the settled-redeem keeper, ranked MMR + leaderboard, and the in-app SUI → dUSDC swap. Both the staked and free/practice tiers run on the same engine.

The deployed package id lives in [`apps/contracts/deployed.json`](apps/contracts/deployed.json) (source of truth). Design docs: [`docs/prd.md`](docs/prd.md) and [`docs/deepbook-oracle-architecture.md`](docs/deepbook-oracle-architecture.md).

**What's next** — the duel is the first mode. The same engine opens up battle royales, daily solo gauntlets, tournaments, live events, and streak rewards. The bigger idea: **DeFi on DeepBook can be a game** — make it feel like one and you onboard everyone, not just traders.

---

## Run it locally

Developer setup, local commands, and conventions live in **[`CONTRIBUTING.md`](CONTRIBUTING.md)**. The short version:

```bash
bun install   # install all workspaces (requires Bun ≥ 1.3 + Sui CLI)
bun dev       # turbo dev — runs web (:5173) + server (:3001) in parallel
```

> First run needs a one-time `bun --filter @flicky/contracts codegen` to generate the gitignored Sui bindings — see [`CONTRIBUTING.md`](CONTRIBUTING.md#first-time-developer-onboarding).

## License

TBD
