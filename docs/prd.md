# Flicky — Game Spec

> **This doc is the source of truth for Flicky's game design.** When the spec and any other doc disagree, this wins. Changes are tracked in the companion **Flicky — Decisions (ADR Log)**.
>
> Repo (implementation): [https://github.com/nikola0x0/flicky](https://github.com/nikola0x0/flicky)

---

## One-liner

Swipe YES/NO on 5 binary cards. Face off against another player. The Duel escrow pays the winner the side-pot; both players keep whatever their own Predict positions redeem for. Real DeepBook Predict markets under a Tinder-style UI.

## Why this exists

Prediction markets are powerful but feel like trading terminals. Swipe-based mobile betting apps (Pulse on Solana, Rush's $500M-in-a-week sub-hour BTC binaries) proved enormous retail demand for "feel-based" prediction UX — but they're shallow and have no real PvP layer. Flicky bridges them: a Tinder-style swipe deck on top of DeepBook Predict's binary-digital primitive, plus a 1v1 escrow layer so two players can put real stakes on "who reads BTC better."

## End-to-end player flow

1. **Sign in.** zkLogin via Enoki (Google / Apple OAuth → Sui address). The zkLogin address is the wallet — no separate in-app balance.
2. **Predict Manager bootstrap.** A `PredictManager` is created for the player on first sign-in, sponsored by Flicky. The player never touches SUI for gas.
3. **Practice Mode (optional).** Solo vs. a bot with virtual positions — no stake, no `predict::mint`. Full swipe + settle UX so the player learns the loop before risking dUSDC.
4. **Deposit / Swap.** To enter matching, the player tops up dUSDC. The in-app Deposit screen surfaces the player's Sui address + QR + copy, and includes a built-in **SUI ↔ dUSDC swap (1 SUI : 10 dUSDC)** so a player with only SUI can fund a stake without leaving the app.
5. **Matching.** Player picks a stake tier — **1, 3, 5, or 10 dUSDC** — and joins the queue. Entry requires `PredictManager` balance **≥ 5 dUSDC** (the per-card mint budget: up to 1 dUSDC of Predict premium × 5 cards). MMR + bucketed per-tier matching; bot-fill on ~30 s queue timeout.
6. **Play (≤10 min).** Five cards are revealed. Each card is one binary digital tied to the next 5 nearest oracle resolutions that are **>10 min** out (each card has its own expiry). A swipe is a single player-signed PTB that atomically (a) mints YES or NO via `predict::mint` on the player's own `PredictManager` and (b) calls `duel::record_swipe` on the shared `Duel`. Five swipes → five real on-chain Predict positions.
7. **Settlement.** Each card resolves at its own oracle tick. Per-card PnL = (Predict redeem value) − (premium paid). **Player score = Σ PnL across the 5 cards.** Higher total PnL wins the Duel side-pot. Tie → side-pot split.
8. **Winner redeem.** Winner claims the dUSDC Duel Pot from the `Duel` escrow on settle, and (when they choose) redeems their own 5 Predict positions via `predict::redeem_permissionless` into their `PredictManager`.
9. **Loser redeem.** Loser keeps no side-pot but still owns their Predict positions — whatever they minted on the winning side of any card pays out on redeem. The Duel outcome and the Predict outcome are independent ledgers.

---

## Game design

### Two modes

| Mode | Money flow | Predict integration | Reward |
| --- | --- | --- | --- |
| **Practice** | none | solo vs. bot, virtual swipes, scored against the live oracle | learning the loop; no on-chain reward |
| **Staked** | dUSDC stake into shared `Duel` escrow; per-card `predict::mint` on the player's own `PredictManager` | full PvP, real Predict positions, settled by oracle | winner takes side-pot; both players redeem own positions |

Practice is a single-player on-ramp — it shares the swipe UI but does not enter matchmaking or touch the chain. The real product is the Staked PvP loop.

### Stake tiers

| Tier | Stake | Pot (per duel) |
| --- | --- | --- |
| Practice queue | 1 dUSDC | 2 dUSDC |
| Casual | 3 dUSDC | 6 dUSDC |
| Standard | 5 dUSDC | 10 dUSDC |
| High Roller | 10 dUSDC | 20 dUSDC |

All tiers require `PredictManager` balance ≥ 5 dUSDC before entering the queue, because each duel mints up to 5 dUSDC of Predict premium (5 cards × max 1 dUSDC per card) regardless of side-pot size.

### Match anatomy

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

1. **Create / Join.** Both players stake dUSDC into the shared `Duel` object. Deck hash is committed on-chain (commit-reveal). Plaintext deck is revealed at swipe-phase start.
2. **Swipe phase.** Up to 10 minutes total game time. Each swipe is a single player-signed PTB: `predict::mint` (player's `PredictManager`) + `duel::record_swipe` (shared `Duel`). The swipe is atomic by Predict's `sender == manager.owner()` invariant — the keeper cannot mint for the player.
3. **Watch / wait.** Once both players have swiped all 5 cards (or the 10-min clock expires), the UI streams live oracle ticks, current marks, and emoji reactions until each card's expiry.
4. **Per-card settlement.** Each binary resolves at its own oracle tick — cards in one deck can settle at different times because they are drawn from the 5 nearest oracles >10 min out.
5. **Duel settlement.** Once all 5 cards have settled, the indexer triggers `duel::settle_duel`. The contract reads each player's per-card PnL, sums it, and releases the dUSDC side-pot to whoever has the higher total. Tie → split. Players can redeem their own Predict positions independently via `predict::redeem_permissionless`, at any time after each card settles.

### Scoring (real PnL)

```
card_pnl     = predict_redeem_value(player, card) − premium_paid(player, card)
player_score = Σ card_pnl across the 5 cards
```

- **No speed multiplier.** Scoring is the actual on-chain economic outcome — Predict's premium math is the scoring engine, not a UI-layer multiplier. A player who buys YES at 0.28 implied and wins still earns ~3× more PnL per dUSDC than buying YES at 0.88 — the economics already reward skill over consensus.
- **No odds-weighted UI score.** The `Duel` does not compute a synthetic score from `p_swiped`; it reads each player's `record_swipe` entries and asks Predict's settled state what each position redeems for.
- **Ties.** Equal total PnL → side-pot split.
- **Independence.** The dUSDC side-pot (winner takes all) and the Predict positions (both players keep their own) are independent. A player can lose the Duel and still net-positive from a single hot pick, or win the Duel and have flat individual PnL — the side-pot is the prize for ranking ahead of your opponent.

### Card generation (AI Deckmaster)

The backend generates each duel's deck from the 5 nearest DeepBook Predict oracle resolutions that are **>10 minutes** in the future at duel creation time.

- **Input:** live SVI surface, spot, list of upcoming oracle resolution timestamps, the duel's stake tier.
- **Selection rule:** pick the 5 nearest oracles strictly after `now + 10 min`. Each oracle becomes one card; the generator chooses strike + side (directional vs. range) per card to balance difficulty (mix of close-to-money hard calls and deep-OTM gimmes/traps).
- **Determinism + fairness:** generator is seeded with the on-chain duel-creation block hash + `duel_id`. Output is reproducible by anyone for audit. Deck is hashed; the hash is committed to the `Duel` object at creation. Plaintext deck is revealed at swipe-phase start.
- **Card types:** directional binaries ("BTC > strike X at expiry T?") and range cards ("BTC settles in [low, high] at expiry T?"). Each card carries its own expiry — they no longer share a single timestamp.

### Matchmaking

- **Sync-only for MVP** — both players online and in-app at the same time. Shared swipe/watch phase is half the product magic; async kills it.
- **Bot-fill on queue timeout** — if no human opponent in ~30 s, a bot with a fixed skill model fills in. Solves hackathon-scale liquidity.
- **Async mode (post-MVP)** — could be added as "Background Duel" if real-user liquidity proves insufficient.

### Anti-cheat / fairness

| Vector | Mitigation |
| --- | --- |
| Mark manipulation via whale side-trades | Scoring is the actual Predict redeem PnL. A whale's mark move does not change terminal settlement. |
| Front-running deck with parallel positions | **Commit-reveal**: deck hash committed at match creation, revealed only at swipe-phase start. |
| Two-account collusion to farm side-pot | MMR queue + zkLogin OAuth binding raises Sybil cost. Stake-locked entry, light proof-of-attention for ranked queue — post-MVP. |
| Bot-driven swiping in PvP | Same 10-min window for both players; cards are freshly revealed. Optional human-only ranked queue with proof-of-attention — post-MVP. |

---

## Identity, wallet, money flow

- **zkLogin via Enoki** (Google / Apple OAuth → Sui address) is the wallet identity. There is no separate in-app balance — the zkLogin address **is** the wallet.
- **Predict Manager** is created on first sign-in, sponsored by Flicky. The player never holds SUI for gas, never signs a manager-creation transaction outside the app.
- **Sponsored gas** covers every on-chain action a player takes (create_duel, join_duel, per-swipe mint+record, settle, redeem). The player's zkLogin wallet only ever needs dUSDC for staking and Predict premium.
- **Deposit screen** shows the zkLogin address + QR + copy. Users top up by sending dUSDC from any wallet (Suiet, Sui Wallet, CEX withdrawal).
- **In-app swap** — a SUI → dUSDC swap module at a fixed **1 SUI : 10 dUSDC** rate, so a player whose only on-chain asset is SUI can convert to dUSDC without leaving Flicky. No external on-ramp in MVP.

---

## DeepBook Predict integration

Predict is the centerpiece of the chain story. Touchpoints:

1. **`predict::mint`** — called in the player-signed swipe PTB on the player's own `PredictManager`. Sized per-card from a budget tied to stake tier (≤1 dUSDC per card).
2. **`predict::redeem_permissionless`** — each player redeems their own 5 positions after settlement. The keeper may also call this opportunistically to surface PnL into the Duel settlement view; payouts always deposit into the player's own `PredictManager`.
3. **`OracleSVI`** — read for the live mark view during the watch phase, calibrates Deckmaster difficulty, and provides each card's 0/1 settlement.
4. **`predict-server` indexer** — backend uses the event stream to detect each card's settlement and to feed the live oracle-tick view during the watch phase, and to trigger `duel::settle_duel` once all 5 cards have resolved.

### Cross-track absorption

Flicky combines three previously-proposed Predict ideas plus the novel PvP layer:

- **#30 Gamified Predict App** — Flicky is the PvP version of this.
- **#21 Settled-Redeem Keeper Network** — Flicky operates one as system infrastructure.
- **#29 Streaks Leaderboard PWA** — natural v1.1 layer once the streak / ladder retention loop ships.

---

## Component responsibilities

### Smart contracts (`apps/contracts/`)

- **`Duel` shared object.** Escrows both players' dUSDC stakes (side-pot). Records every swipe (player, card index, direction, `PredictManager` reference, premium paid). On `settle_duel`, reads per-player PnL via the recorded positions and releases the side-pot to the winner.
- **DeepBook Predict mapping.** `record_swipe` is invoked alongside `predict::mint` in the player's PTB; the `Duel` does not call Predict itself but stores the references needed to compute PnL at settlement.
- **Swap module.** Fixed-rate SUI ↔ dUSDC at 1:10, used by the Deposit/Swap screen for in-app top-ups in MVP.

### Backend (`apps/server`, Bun)

- **Card generation API.** Reads the upcoming oracle resolution schedule, picks the 5 nearest >10 min out, chooses strikes, returns the deck (with hash for commit-reveal).
- **WebSocket matchmaking + game room.** Create room, join room, broadcast match clock — match timing is authoritative from the server, not the client.
- **`Duel` indexer.** Watches Duel events (create, swipe, settle), maintains room state, fans state changes back to the WS clients.
- **PnL & settle-price tracker.** Subscribes to Predict's settle events, computes per-card PnL for each player, triggers `duel::settle_duel` once all 5 cards in a duel have settled.
- **Sponsored gas service.** Sponsors every player-signed PTB end-to-end.

### Frontend (`apps/web`, Vite + React)

- **Landing.** Brand + how-to-play + entry to login.
- **Game UI.** Swipe deck, lockup view, share card.
- **Deposit / Swap page.** Address + QR for inbound dUSDC, SUI → dUSDC swap form.
- **PTB builder.** Constructs the per-swipe `predict::mint + duel::record_swipe` PTB from backend-provided card data; signs via Enoki; submits via sponsored gas.
- **How-to-play + documentation pages.** In-app explainers.

> **Principle:** anything the frontend can read directly from the chain or compute locally, it reads/computes locally. The backend exists for things the chain can't do (matchmaking, card selection, indexing, keeper triggers).

---

## MVP scope (locked)

- 1v1 only; tournaments / brackets deferred.
- BTC-only card pool; broader oracles deferred.
- Practice (solo vs. bot) + Staked PvP (4 tiers: 1 / 3 / 5 / 10 dUSDC) on the Predict engine.
- zkLogin via Enoki + sponsored gas — load-bearing, not optional.
- Sponsored Predict Manager creation on first sign-in.
- Deposit screen + in-app SUI→dUSDC swap (1:10) as the money-in paths.
- Settled-redeem keeper.
- AI Deckmaster (open-source generator + on-chain seed + commit-reveal; Nautilus TEE attestation deferred).
- Share-card image for virality (friend lists / chat / spectate deferred).
- Sync-only matchmaking with bot-fill (async deferred).
- Sabotage skills, streaks, ladder cosmetics — all deferred.

## Deferred (post-MVP)

PLP rake loop, graduation to direct Predict trading, streaks/ladder/cosmetics, broader-oracle decks (Pyth wide / sports / weather), Nautilus TEE Deckmaster attestation, spectator markets, duel-share NFTs, async matchmaking, sabotage skills, margin tier, cross-asset cards.

---

## Open questions

- **Server key management** for the keeper (per-duel keypair vs. long-lived service keypair vs. rotating-with-TEE-attestation).
- **Swap liquidity.** Fixed 1:10 SUI/dUSDC is a hackathon simplification; production needs a real source (DeepBook spot, Cetus, sponsored treasury).
- **Async mode** — see Matchmaking section.

## Prior art

- **Pulse** (Solana, Cypherpunk) — Tinder-swipe predictions; YES/NO swipe = binary digital strike. Same UX seed, no PvP.
- **Rush** (Solana, Cypherpunk) — 10-sec BTC mobile bets, $500M volume in 1 week. Proves retail demand at this tenor.
- **Kiwi** (Radar) — TG wallet with prediction features.
- **FEEN** (Cypherpunk) — 30-sec vol races with parlays.
