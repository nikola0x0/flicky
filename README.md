# Flicky — The Prediction Arena

> Swipe YES/NO on a binary-prediction deck, face off against another player, and on-chain escrow pays the winner. A Tinder-style PvP prediction duel on **Sui**, powered by **DeepBook Predict**.

[![Demo](https://img.shields.io/badge/▶_Watch_the_demo-4_min-FF0000)](https://youtu.be/sKIKsmdRs9U)
&nbsp;·&nbsp; **Live on Sui testnet** &nbsp;·&nbsp; Built for **Sui Overflow 2026**

| | |
| --- | --- |
| 🎬 **Demo video** | https://youtu.be/sKIKsmdRs9U |
| 📦 **Package (testnet)** | [`0x5ceae1cacbba1862e0f0c4e8861280b8a1e9530ce4049317daf5d3951778582f`](https://suiscan.xyz/testnet/object/0x5ceae1cacbba1862e0f0c4e8861280b8a1e9530ce4049317daf5d3951778582f) |
| 🔗 **On-chain primitive** | DeepBook Predict (binary digitals) |
| 🔑 **Identity / gas** | zkLogin via Enoki, or connect a wallet · sponsored gas end-to-end |

---

## 30-second pitch

Prediction markets are powerful but look like a Bloomberg terminal — order books, Greeks, vol surfaces. Meanwhile swipe-betting apps have proven retail *loves* feel-based prediction UX (Pulse on Solana, Rush's $500M-in-a-week sub-hour BTC binaries) — but they're shallow, custodial, and have **no real opponent**.

**Flicky is both.** Two players swipe YES/NO through the same deck of binary-digital cards. Every swipe mints a *real* on-chain DeepBook Predict position — not a synthetic bet — and a Move `Duel` shared object escrows both stakes and pays the dUSDC side-pot to whoever reads the market better. zkLogin + sponsored gas mean it feels like a mobile game: no seed phrase, no wallet popups, no SUI required.

> **Two players. One deck. One question — who reads the market better?**

---

## Watch the demo (4 min)

▶️ **https://youtu.be/sKIKsmdRs9U**

What to look for — these are the things that separate Flicky from a generic Predict front-end:

1. **Real on-chain positions** — swipe right = a real DeepBook Predict mint on testnet, not a synthetic toggle.
2. **No wallet popups** — the *absence* of signing prompts is the magic. zkLogin + sponsored gas make every swipe a one-tap, gasless transaction.
3. **One atomic swipe PTB** — a single transaction mints on the player's own Predict account **and** calls `record_swipe` on the shared `Duel`, in the same block. See it on Suiscan in the demo.
4. **Commit-reveal deck** — cards are hashed at duel creation, revealed only at match start → provably fair, no front-running.
5. **On-chain settlement** — a settled-redeem keeper posts each card's real-world settlement price, redeems positions, and finalizes the duel. The full lifecycle closes on-chain.

---

## How a duel works — the player walkthrough

```
 sign in        deposit / stake      swipe phase (≤5 min)       lockup / watch        settle + payout
┌──────────┐   ┌───────────────┐    ┌──────────────────┐      ┌──────────────┐      ┌────────────────┐
│ zkLogin  │ → │ pick a tier   │ →  │ reveal deck;     │  →   │ live oracle  │  →   │ keeper posts   │
│ (Google) │   │ 1/3/5/10 dUSDC│    │ swipe YES/NO →   │      │ ticks; spot  │      │ each card's    │
│ no seed  │   │ + queue       │    │ each = a real    │      │ vs strike;   │      │ price; higher  │
│ phrase   │   │               │    │ Predict position │      │ live PnL     │      │ PnL takes pot  │
└──────────┘   └───────────────┘    └──────────────────┘      └──────────────┘      └────────────────┘
```

1. **Sign in** — zkLogin via Enoki (Google OAuth → Sui address), or connect an existing wallet. No seed phrase, no extension required either way. On first sign-in, a Predict funding account is created for you, **sponsored by Flicky** — the app calls it your "manager." Your wallet only ever holds dUSDC.
2. **Fund & queue** — deposit dUSDC (or swap SUI → dUSDC at a fixed 1:10 rate inside the app), pick a stake tier (**1 / 3 / 5 / 10 dUSDC**), and enter matchmaking, which pairs you against an opponent close to your rating. Entry is gated on the manager holding **≥ 5 dUSDC** (worst-case premium across a full 5-card deck).
3. **Match & reveal** — matchmaking pairs two players into a Move `Duel` shared object that escrows both stakes. The deck is **commit-reveal**: hashed at `create_duel`, revealed only at match start, so neither player can pre-stage trades.
4. **Swipe (≤ 5 min)** — swipe right = YES, left = NO, through every card in the deck. Each swipe fires a **single atomic PTB** that mints on *your own* Predict account (opening a real Predict position) and calls `record_swipe` on the shared `Duel` (logging your direction and the mint's order id, so the swipe can never be replayed or forged). No wallet popup — the PTB is gas-sponsored.
5. **Lockup / watch** — once both players finish swiping (or the clock expires), the duel enters a shared live view of spot vs. strike, ticking toward each card's expiry, with live per-card PnL for both players. Dead waiting time becomes the ritual.
6. **Settle** — the settled-redeem keeper posts each card's real-world settlement price and both players' premiums to `settle_card` (the DeepBook Predict deployment Flicky runs against doesn't expose either as a public on-chain read, so the keeper sources them from Predict's own indexer), redeems each player's position, then `finalize` releases the dUSDC side-pot to the higher total PnL.
7. **Payout & keep** — the **winner** takes the entire side-pot; **both** players keep and can redeem their own Predict positions whenever they want. A tie splits the pot.

### Adaptive deck size

The deck isn't a fixed 5 — it's **sized to live oracle supply** at duel creation: `deckSize = min(liveOracles, 5)`, clamped to a **3–5 band**, and built from the **soonest-settling** eligible markets (expiry > 10 min and within a ~3h horizon). On testnet, short-dated market supply fluctuates between 3 and 5, so the deck flexes to whatever's live instead of failing — and always picks the fastest-resolving cards so a duel finalizes as soon as possible.

### Scoring — real PnL, no UI multipliers

```
card_pnl     = predict_redeem(player, card) − premium_paid(player, card)
player_score = Σ card_pnl  across the deck
```

Highest total PnL wins the entire dUSDC side-pot; a tie splits it. **Predict's own premium math is the scoring engine** — a correct call on a 0.28-implied YES pays out ~3× a correct call on a 0.88 YES, so a contrarian read scores more than following the crowd. No synthetic odds-weighting, no UI multiplier. The settlement price and both premiums are supplied by the settled-redeem keeper rather than read live on-chain (see "why these design decisions" below) — but the payout formula itself is still Predict's, not a UI multiplier. The Duel side-pot and a player's individual Predict PnL are independent ledgers: you can lose the Duel but still net-positive on a hot pick, or win the Duel with flat individual PnL.

### Modes

- **Practice** — solo vs. a bot, swiping a synthetic deck priced off live BTC spot. No stake, no chain calls at all — the on-ramp for the swipe loop, and where the onboarding tour lives.
- **Staked PvP** — 1v1 duels with real dUSDC side-pots at fixed tiers (1 / 3 / 5 / 10 dUSDC) and ranked MMR.
- The contract also exposes a free/social PvP path (`*_free` entrypoints — join, swipe, settle, finalize) that mirrors staked play with the stake removed, so a no-stake head-to-head mode is a UI toggle away rather than a new engine.

Staked and free/social PvP run the exact same swipe → lockup → settlement flow on-chain; only the money flow is gated. Practice is a separate, fully off-chain mode built for onboarding.

---

## What's actually on-chain

Flicky is not a Predict front-end with a database behind it — the duel lifecycle lives on Sui.

### DeepBook Predict touchpoints

| #   | Primitive                        | Role in Flicky |
| --- | --------------------------------- | --------------- |
| 1   | Predict mint (`mint_exact_quantity`) | Called in the **player-signed swipe PTB** against the player's own Predict account. Sized per-card from a stake-tier budget (≤ 1 dUSDC/card). The returned `order_id` is passed into `record_swipe` in the same transaction as anti-replay proof. |
| 2   | Position redemption               | The settled-redeem keeper redeems each player's positions after a card settles. Payouts deposit into the player's own account. |
| 3   | Predict's off-chain indexer       | The deckmaster reads it for live market discovery, spot price, and strike placement when building a deck. The settled-redeem keeper reads it for each card's settlement price and both players' premiums — the DeepBook Predict deployment Flicky is pinned to doesn't expose either as a public on-chain read. |
| 4   | Predict indexer / settlement      | Backend detects per-card real-world settlement → drives the keeper through `settle_card` × N then `finalize`. Also drives the lockup view's live PnL. |

### Flicky's Move package (`apps/contracts/`)

- **`duel` module** — the whole engine. A shared `Duel` object escrows the dUSDC side-pot and records every swipe (card index, direction, mint order id, premium paid). It does **not** hold Predict positions — each player owns their own account. Lifecycle entrypoints: `create_duel` / `join_duel` / `reveal_deck` / `record_swipe` / `settle_card` / `finalize`, each with a `*_free` variant for the no-stake tier, plus `refund_duel` / `claim_reveal_timeout` safety paths. Covered by a 29-test Move unit-test suite (`tests/duel_tests.move`).
- **Two independent side-packages**: `season::prize_pool` (admin-operated escrow that pays out ranked-leaderboard prizes each season) and `swap::swap` (a small constant-product SUI ↔ dUSDC AMM backing the in-app Deposit/Swap screen).
- **Local link-stub packages** (`account`, `deepbook_predict`) that dispatch to the real deployed Predict/account packages via `published-at` — currently pinned to the `predict-testnet-6-24` branch snapshot. This pin has moved before (upstream keeps changing what it exposes on-chain) and will again; check git history around any `duel.move` rewrite before assuming the current shape is permanent.

### Why these design decisions

- **Swipe PTBs are player-signed and atomic** — Predict requires the sender to own the account being minted from, so the player *must* be the signer. zkLogin + sponsored gas are what make that invisible. The mint and the `record_swipe` land in the same block, so a position can never exist without its duel record.
- **The Duel escrows the side-pot, not the positions** — players keep full custody of their Predict positions; the contract only adjudicates the side-pot from recorded PnL.
- **Commit-reveal deck** — hashing the deck at creation and revealing at match start makes it provably fair and impossible to front-run.
- **Settlement is keeper-fed, not on-chain-read** — the DeepBook Predict deployment Flicky runs against doesn't expose on-chain reads for market price or premium, so `settle_card` takes them as keeper-supplied arguments instead of reading an oracle object on-chain. That's a real trust-model tradeoff versus reading everything on-chain — worth knowing if you're relying on this for anything beyond a testnet demo.

---

## Architecture

```
flicky/
├── apps/
│   ├── web        # Vite + React 19 — swipe UI, lockup view, share card
│   ├── server     # Bun — WebSocket relay, indexer, settled-redeem keeper,
│   │              #       sponsored-gas service, AI Deckmaster
│   └── contracts  # Move package (duel engine + season/swap side-packages)
│                  #   + TS deploy/upgrade/codegen scripts
└── packages/
    └── ui         # shared shadcn/ui components
```

| Layer | Tech |
| --- | --- |
| **Web** | Vite, React 19, Tailwind v4, shadcn/ui, `@mysten/sui` v2 + `@mysten/dapp-kit-react` v2 (`dapp-kit-core`, gRPC-based) |
| **Server** | Bun (TypeScript strict) — deck-generation API, WebSocket matchmaking + game-room relay, lobby chat, `Duel` indexer, PnL/settle tracker, settled-redeem keeper, sponsored-gas service, ranked MMR + leaderboard, avatar service |
| **Persistence** | Postgres (Railway) via Bun's native `Bun.sql` — no ORM |
| **Chain** | Sui testnet, Move 2024, DeepBook Predict — gRPC for objects/transactions, GraphQL RPC for event queries (JSON-RPC is retired) |
| **Contracts** | Move package (`duel` + standalone `season`/`swap` packages) + `@mysten/codegen` typed bindings |
| **Identity** | zkLogin via **Enoki** (Google OAuth → Sui address), or connect an existing wallet |
| **Gas** | sponsored end-to-end via a self-built address-balance sponsor service — player wallets only ever hold dUSDC |
| **Realtime** | WebSocket relay (`Bun.serve`); the match clock is authoritative on the server |
| **Testing** | `bun test` per workspace (server + web) and `sui move test` (contracts), wired through `turbo test` |

---

## Status

**Shipped — live on Sui testnet.** The full duel lifecycle works end-to-end: zkLogin sign-in, sponsored Predict-account bootstrap, matchmaking, commit-reveal decks (deckmaster, adaptive 3–5 sizing), atomic player-signed swipe PTBs, the live lockup view, keeper-fed settlement (`settle_card` → `finalize`), ranked MMR + leaderboard with on-chain Season prize payouts, player avatars, a global lobby chat, game audio, shareable result cards, a solo practice mode, and the in-app SUI → dUSDC swap. Staked and free/social PvP run on the same engine.

The deployed package id lives in [`apps/contracts/deployed.json`](apps/contracts/deployed.json) (source of truth).

**What's next** — the duel is the first mode. The same engine opens up battle royales, daily solo gauntlets, tournaments, live events, and streak rewards. The bigger idea: **DeFi on DeepBook can be a game** — make it feel like one and you onboard everyone, not just traders.

---

## Run it locally

Developer setup, local commands, and conventions live in **[`CONTRIBUTING.md`](CONTRIBUTING.md)**. The short version:

```bash
bun install   # install all workspaces (requires Bun ≥ 1.3 + Sui CLI)
bun dev       # turbo dev — runs web (:5173) + server (:3001) in parallel
bun test      # turbo test — bun test (server, web) + sui move test (contracts)
```

> First run needs a one-time `bun --filter @flicky/contracts codegen` to generate the gitignored Sui bindings — see [`CONTRIBUTING.md`](CONTRIBUTING.md#first-time-developer-onboarding).

## License

TBD
