# @flicky/contracts

Move 2024 smart contract package for **Flicky** — a Tinder-style PvP prediction duel built on top of **DeepBook Predict** on Sui testnet.

---

## 📖 Table of Contents

- [Overview](#-overview)
- [Deployed Addresses (Testnet)](#-deployed-addresses-testnet)
- [Quick Test Guide](#-quick-test-guide)
- [Module Surface](#-module-surface)
- [Duel Lifecycle](#-duel-lifecycle)
- [Backend Integration](#-backend-integration)
- [Frontend Integration](#-frontend-integration)
- [Error Codes](#-error-codes)
- [Deployment](#-deployment)
- [Stub Packages](#-stub-packages)

---

## 🎯 Overview

Two players lock equal dUSDC stakes into a shared `Duel<T>` object, swipe UP/DOWN on **N** binary-option cards (N chosen at create time, 1–20) backed by **DeepBook Predict's `OracleSVI`** + `PredictManager`, then a **two-phase settle + finalize** sequence pays the winner.

Each card pins its **own** `OracleSVI` — a 5-card deck can span 5 different oracles with 5 different expiries. The deckmaster picks strikes per oracle to **maximise amplitude** (most aggressive offset the SVI accepts) and **balance signs** (mix of UP-favoring + DOWN-favoring strikes so a player can't win the whole deck with one direction).

Two tiers share the same engine:

| Tier | Stake | Predict mint | Anti-replay |
|---|---|---|---|
| `STAKED` | dUSDC escrow | yes (player mints positions) | yes (`PredictManager.position >= quantity`) |
| `FREE`   | none | none | n/a |

`record_swipe` snapshots `premium` and `p_swiped` **on-chain** by calling `deepbook_predict::predict::get_trade_amounts(predict, oracle, key, quantity, clock)` — the caller cannot manipulate the swipe price.

`settle_card` reads the supplied oracle's `settlement_price` and scores both players' swipes on that card, accumulating per-player payout / premium onto the `Duel<T>`. `finalize` reads those accumulated fields to pick the winner. Both are **permissionless** — anyone can submit either PTB; the contract re-verifies via chain reads so the caller cannot influence the result.

---

## 📍 Deployed Addresses (Testnet)

> Last updated: **2026-05-29**. Single source of truth — paste these into your `.env.local` files. When the contract is republished, only the **Flicky** rows change; DeepBook addresses are external and stable.

### Flicky (our package)

| Item | ID | Role |
|---|---|---|
| **Package ID** (current) | `0xaed053fcc146abd1da507eae72b4f3e9c838d83c83c7b68b230a3c9a2601a522` | Active version — call all `flicky::duel::*` entries against this |
| **Original Package ID** | `0xaed053fcc146abd1da507eae72b4f3e9c838d83c83c7b68b230a3c9a2601a522` | Type identity — stable across upgrades (currently == current) |
| **UpgradeCap** | `0x98e26cadfc6907b8030668facfeb604f86184c031873f91f98497c9d4e1edc90` | Authorizes `bun run upgrade`. Held by deployer wallet |
| **Deployer** | `0x9c08a74cca711f45a176765e9db499f01def450fa90320a4c23934b2082aa882` | The publisher account |
| **Publish digest** | `GMgK354165Bt7Za6J5u4oy6RZt6QEQb7jdbi8zdQ6Nce` | Fresh publish 2026-05-29 (per-card settle + finalize, sign-balanced amplitude deckmaster) |

Source of truth: [`deployed.json`](./deployed.json).

> **2026-05-29 republish notes.** Struct layout on `Duel<T>` changed (added `cards_settled`, `card_settlement_prices`, `settled_count`; removed legacy `decide_time_ms` / `p{0,1}_score`); finalize was split into `settle_card × N` + `finalize`. Previous package at `0x436cc562ca716a88afe17214065a31d48653d146217fa73a303220ae8330bd7e` is orphaned — duels created there can no longer be finalized through the current keeper / FE.

### DeepBook Predict (external dependency)

| Item | ID | Notes |
|---|---|---|
| **Package ID** | `0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138` | Mysten Labs' DeepBook Predict on testnet |
| **Predict shared object** | `0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a` | The global `Predict` singleton — required arg to `record_swipe`, `mint`, `redeem`, etc. |
| **Registry shared object** | `0x43af14fed5480c20ff77e2263d5f794c35b9fab7e221290312706244e2a6e64` | Oracle registry — used by `registry::create_oracle` |
| **Pyth source object** | `0xe62b6aeb669191ea11a4b6167c1ad0aaf88ab92d718fcc3b52794a131916c141` | Pyth price feed binding for BTC oracle creation |
| **Sample OracleSVI** | `0xa1088e2747d9c3a2a29d6517cefd2c58e22fa4eccdfaa55750faa3e7e5e8e6b2` | Test oracle from `init-oracle.ts` (rotate as needed) |

### DeepBook v3 core (transitive)

| Item | ID |
|---|---|
| **Package ID** | `0x74cd5657843c627f3d80f713b71e9f895bbbeb470956d8a8e1185badf6cc77c8` |

### Token / dUSDC (the stake coin)

| Item | ID |
|---|---|
| **Token package** | `0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8` |
| **dUSDC Coin type** | `0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC` |

### Swap AMM (test-only — independent of duel)

| Item | ID |
|---|---|
| **Swap package** | `0x51ea0f29321f3c25f8b2f530ecd3ed3dec569d954c8832d318de7e203653a936` |
| **UpgradeCap** | `0x676dcb5f4a83791aed86c7a2f0488a75caa93aa49f90b22b98b30a17ebe8c178` |

### System

| Item | ID |
|---|---|
| **Clock** | `0x6` |

---

### 🧩 Where to plug them — by component

> Legend: **B** = backend (`apps/server`), **F** = frontend (`apps/web`, `apps/playground`), **C** = contracts tooling (`apps/contracts/scripts`).

| Address | B | F | C | Env var(s) |
|---|:-:|:-:|:-:|---|
| Flicky **Package ID** | ✅ | ✅ | ✅ | Backend: `FLICKY_PACKAGE_ID` · Frontend web: `VITE_FLICKY_PACKAGE_ID_TESTNET` · Frontend playground: `VITE_FLICKY_PACKAGE_ID` · Contracts: written into `deployed.json` |
| Flicky **UpgradeCap** | — | — | ✅ | `scripts/upgrade.ts` reads from `deployed.json` |
| Flicky **Deployer** | ✅ | — | ✅ | Backend keeper key matches this address if the same wallet runs `finalize`. Contracts: `SUI_DEPLOYER_PRIVATE_KEY` in `apps/contracts/.env.local` |
| DeepBook Predict **Package ID** | ✅ | ✅ | — | Backend: `PREDICT_PACKAGE_ID` · Frontend: `VITE_PREDICT_PACKAGE_ID` |
| DeepBook Predict **Predict object** | ✅ | ✅ | — | Backend: `PREDICT_OBJECT_ID` · Frontend: `VITE_PREDICT_OBJECT_ID` — passed as `&Predict` arg to `record_swipe`, `mint`, `redeem`, `get_trade_amounts` |
| DeepBook Predict **Registry** | — | ✅ | — | Frontend only (oracle creation panel): `VITE_REGISTRY_ID` |
| DeepBook Predict **Pyth source** | — | ✅ | — | Frontend only: `VITE_PYTH_SOURCE_ID` |
| Sample **OracleSVI** | ✅ | ✅ | — | Backend: optional `MARKET_ORACLE_ID` default for keeper tests · Frontend: `VITE_MARKET_ORACLE_ID` (default in deck generator) |
| **dUSDC Coin type** | ✅ | ✅ | — | Backend: `DUSDC_COIN_TYPE` · Frontend: `VITE_DUSDC_PACKAGE_ID` (full type string `<pkg>::dusdc::DUSDC`) |
| **Clock** `0x6` | ✅ | ✅ | — | Hardcoded — both sides reference `'0x6'` as the system clock object |
| Swap package | — | ✅ | — | Frontend swap panel only |

### 🔁 What to do when Flicky is republished

A fresh `bun run publish` (vs `upgrade`) creates a **new** Package ID and orphans existing `Duel<T>` shared objects.

Each team must update:

- **Contracts**: nothing — `deployed.json` is auto-written, `apps/web/.env.local` is auto-patched by `publish.ts`.
- **Backend**: update `FLICKY_PACKAGE_ID` in `apps/server/.env`, restart server.
- **Frontend playground**: paste new id into `apps/playground/.env.local` → `VITE_FLICKY_PACKAGE_ID`. Restart Vite.

When it's just an `upgrade`, **type IDs stay** but the dispatch `packageId` changes — update env vars on backend + frontend, no need to recreate duels.

---

## ⚡ Quick Test Guide

### 1. Setup

```bash
# From apps/contracts/
cp .env.example .env.local
# Paste your testnet keypair into SUI_DEPLOYER_PRIVATE_KEY
```

### 2. Run Move tests (no chain interaction)

```bash
bun run test
# 30/30 PASS — covers create (+variable deck size), join, reveal, swipe,
# per-card settle, finalize, finalize_test_one_oracle, refund,
# reveal-timeout forfeit, anti-replay, free-tier.
```

### 3. Publish to testnet

```bash
bun run publish        # first time
# or
bun run upgrade        # subsequent compatible upgrades (preserves originalPackageId)
```

Output `deployed.json` carries:
- `packageId`: current version's id (changes per upgrade)
- `originalPackageId`: stable identity (frozen at first publish)
- `upgradeCap`: object id of the `0x2::package::UpgradeCap` (deployer owns it)

### 4. Fast end-to-end test in the playground

After `publish`, the script writes `VITE_FLICKY_PACKAGE_ID_TESTNET` into `apps/web/.env.local`. For the standalone duel playground, also paste it into `apps/playground/.env.local` as `VITE_FLICKY_PACKAGE_ID`.

Then from repo root:

```bash
bun --filter playground dev
```

Open `localhost:5173/duel`. Walk through:
1. **Pick deck size** (default: 5 cards, 1–20 supported) → **Generate Deck Hash** — backend picks N oracles, runs the max-amplitude probe + sign-balance allocation, hashes the deck.
2. **Create Duel** — escrow stake, share `Duel`, status `PENDING`.
3. Connect a second wallet → **Join Existing Duel** → status `ACTIVE`.
4. Host (first wallet) → **Reveal Deck**.
5. Both wallets → **Record Swipe** × N (atomic PTB: `predict::mint` + `duel::record_swipe`).
6. Finalize via **one of two paths**:
   - **🏆 Finalize (production)** — single PTB chaining `settle_card × N` (each with its own oracle) + `finalize`. Requires every card's oracle settled.
   - **⚗️ Finalize (test — single oracle)** — dev shortcut. Internally settles every card using one oracle's spot/settlement price. PnL approximate; **testnet only**.

### 5. Other test paths in the UI

- **💸 Refund / Cancel Duel** — works in PENDING (creator only) and ACTIVE-1h (either player, unless both finished swiping).
- **Reveal timeout forfeit** — if host doesn't reveal within 5 minutes after join, challenger sweeps the pot via `claim_reveal_timeout` (PTB helper available; UI button can be wired similarly).

---

## 📦 Module Surface

Located in `sources/duel.move`. One module, no internal sub-modules — all pricing math lives in `deepbook_predict` upstream.

### Public entries

**Lifecycle**
- `create_duel<T>(stake, deck_hash, deck_size, ctx) -> ID` — Staked tier. `deck_size ∈ [1, 20]`, requires `stake_amount > 0`.
- `create_duel_free<T>(deck_hash, deck_size, ctx) -> ID` — Free tier, zero stake.
- `join_duel<T>(duel, stake, clock, ctx)` — challenger matches stake.
- `join_duel_free<T>(duel, clock, ctx)` — free-tier join.
- `reveal_deck<T>(duel, cards)` — permissionless, validates `cards.length() == duel.deck_size` and `sha2_256(bcs(cards)) == deck_hash`.

**Swipe** (player-signed, atomic PTB)
- `record_swipe<T>(duel, manager, predict, oracle, card_idx, is_up, quantity, clock, ctx)` — Staked. Snapshots premium via `get_trade_amounts`; checks `manager.position(key) >= quantity`.
- `record_swipe_free<T>(duel, predict, oracle, card_idx, is_up, clock, ctx)` — Free, normalized `quantity = 1e9`.

**Settle** (typically server-signed) — one call per card, each with that card's own oracle. Permissionless. Idempotent per `card_idx` via `cards_settled[i]`.
- `settle_card<T>(duel, p0_mgr, p1_mgr, &oracle, card_idx)` — Staked tier. Reads `oracle.settlement_price`, scores both players' swipes (anti-replay via `PredictManager.position(key) >= swipe.quantity`), accumulates payout / premium onto the duel, emits `CardSettled`.
- `settle_card_free<T>(duel, &oracle, card_idx)` — Free tier (no PredictManager, no anti-replay).

**Finalize** (typically server-signed, no oracle args) — requires every card already settled (or the swipe-window forfeit / refund branches apply). Reads accumulated `p0_payout/p1_payout/p0_premium/p1_premium` to pick winner, pays out the pot.
- `finalize<T>(duel, clock, ctx)` — Staked tier.
- `finalize_free<T>(duel, clock, ctx)` — Free tier.
- `finalize_test_one_oracle<T>(duel, oracle, clock, ctx)` — **DEV ONLY**. Internally settles every unsettled card using ONE oracle's `settlement_price` (or `spot_price` fallback) regardless of per-card `oracle_id`, then finalizes. No anti-replay. PnL approximate.

**Refund / Forfeit**
- `refund_duel<T>(duel, clock, ctx)` — PENDING (creator) / ACTIVE 1h+ (either player, unless both completed).
- `claim_reveal_timeout<T>(duel, clock, ctx)` — challenger sweeps if host doesn't reveal within 5 minutes.

### Events

- `DuelCreated { duel_id, creator, stake_amount, deck_hash, tier, deck_size }`
- `DuelJoined { duel_id, challenger, stake_amount, started_at_ms }`
- `DeckRevealed { duel_id }`
- `SwipeRecorded { duel_id, player, card_idx, is_up, quantity, premium, p_swiped }`
- `CardSettled { duel_id, card_idx, oracle_id, settlement_price, actual_up, p0_payout, p0_premium, p1_payout, p1_premium }` — emitted once per `settle_card` call; off-chain consumers collect all `deck_size` of these to reconstruct full PnL proof.
- `DuelFinalized { duel_id, winner, payout_to_p0, payout_to_p1, p0_payout_total, p0_premium_total, p1_payout_total, p1_premium_total, primary_oracle_id, primary_settlement_price }` — `primary_*` echo card 0's settlement as a quick proof anchor; zeros in forfeit/refund branches.
- `DuelRefunded { duel_id, refunded_to_p0, refunded_to_p1 }`
- `DuelForfeited { duel_id, winner, payout, reason }` — `reason: 1` = reveal timeout.

### `Duel<T>` shared object fields (read-API methods)

| Field | Reader | Purpose |
|---|---|---|
| `status: u8` | `status()` | 1=PENDING, 2=ACTIVE, 3=COMPLETE |
| `tier: u8` | `tier()` | 1=STAKED, 2=FREE |
| `deck_hash: vector<u8>` | `deck_hash()` | 32-byte sha2_256 commitment |
| `deck_size: u64` | `deck_size()` | Chosen at create time, in [1, 20] |
| `cards: vector<Card>` | `deck()` | empty until reveal; each `Card { oracle_id, strike }`; length == `deck_size` |
| `creator`, `challenger` | `creator()`, `challenger()` | addresses |
| `p0_stake`, `p1_stake: Balance<T>` | `p0_stake_value()`, `p1_stake_value()` | escrowed coin |
| `p0_swipes`, `p1_swipes: vector<Option<Swipe>>` | direct | length == `deck_size`; `Swipe { is_up, quantity, premium, p_swiped }` |
| `cards_settled: vector<bool>` | `is_card_settled(i)` | flips true after `settle_card(i)` lands; length == `deck_size` |
| `card_settlement_prices: vector<u64>` | `card_settlement_price(i)` | per-card settlement price snapshot (0 = unsettled) |
| `settled_count: u64` | `settled_count()` | how many cards have been settle_carded; `finalize` requires == `deck_size` |
| `p0_payout, p0_premium, p1_*` | `p0_payout()`, etc. | incremented by each `settle_card`; final aggregate read by `finalize` |
| `started_at_ms` | `started_at_ms()` | join timestamp |

---

## 🔄 Duel Lifecycle

```
   PENDING ──[creator: refund_duel]────────────────────► COMPLETE (cancel)
       │
       │ challenger: join_duel
       ▼
   ACTIVE (cards = [], started_at = T)
       │
       │ host: reveal_deck  (or wait T+5min ─► challenger: claim_reveal_timeout ─► COMPLETE forfeit)
       ▼
   ACTIVE (cards revealed)
       │
       │ each player: record_swipe × N  (atomic PTB with predict::mint)
       ▼
   ACTIVE (both N/N swipes)
       │
       │ each oracle settles ─► server admin (or anyone): settle_card × N
       │                                                  (one PTB or many; per-card oracle)
       ▼
   ACTIVE (settled_count == deck_size)
       │
       │ server admin (or anyone): finalize  (no oracle args)
       │ OR stuck (T+1h, partial swipes) ─► refund_duel ─► COMPLETE (both refund)
       ▼
   COMPLETE
```

### Timing constants

| Constant | Value | Purpose |
|---|---|---|
| `MIN_DECK_SIZE` | 1 | Minimum cards per duel |
| `MAX_DECK_SIZE` | 20 | Maximum cards per duel |
| `DEFAULT_DECK_SIZE` | 5 | Recommended default (clients can override at create) |
| `PROB_SCALE` | 1_000_000_000 | 1e9 fixed-point scale for probabilities |
| `SWIPE_WINDOW_MS` | 600_000 | 10 min after `join` — record_swipe deadline |
| `REVEAL_TIMEOUT_MS` | 300_000 | 5 min — challenger can forfeit-claim if no reveal |
| `REFUND_TIMEOUT_MS` | 3_600_000 | 1 h — refund window for stuck ACTIVE duels |

---

## 🛠 Backend Integration

The backend (`apps/server`) hosts: WebSocket matchmaking, sponsor gas, indexer, settled-redeem keeper, deckmaster (commit-reveal storage).

### Env required

See [Deployed Addresses](#-deployed-addresses-testnet) for the ID values.

```
SUI_RPC_URL=https://fullnode.testnet.sui.io:443
SUI_KEEPER_PRIVATE_KEY=suiprivkey1q...   # signs finalize
FLICKY_PACKAGE_ID=0x4ab5...              # Flicky Package ID (current)
PREDICT_PACKAGE_ID=0xf5ea2b37...         # DeepBook Predict package
PREDICT_OBJECT_ID=0xc8736204...          # Predict shared object
DUSDC_COIN_TYPE=0xe95040...::dusdc::DUSDC
```

### Events to consume

| Event | Use it for |
|---|---|
| `DuelCreated` | open lobby card; index by `creator` + `stake_amount` + `tier` |
| `DuelJoined` | promote duel to "live", start match clock at `started_at_ms` |
| `DeckRevealed` | trigger UI reveal animation; clients can now fetch `Duel.cards` |
| `SwipeRecorded` | per-card progress display; build live PnL projection (use `quantity`, `premium`, `p_swiped`) |
| `DuelFinalized` | settle UI, update MMR, emit history. Contains oracle_id + settlement_price as proof |
| `DuelRefunded` | mark duel as cancelled in history |
| `DuelForfeited` | mark host griefing; bump challenger score |

Subscribe via `subscribeEvents` filtered by `{ MoveEventModule: { package: FLICKY_PACKAGE_ID, module: "duel" } }` or per event type.

### Server-admin actions

The server keeper holds a hot key + dUSDC for gas. It should:

1. **Settle-redeem keeper** — on `DuelFinalized` for STAKED tier, call `predict::redeem_permissionless` for each card's mint position on behalf of both players to materialize their payout from Predict. Idempotency: track finalized duel ids persistently (SQLite). See `apps/server/src/keeper.ts`.

2. **Settle + finalize trigger** — once both players are `N/N` (`N = duel.deck_size`) and **every** card's oracle has `settlement_price.is_some()`, submit one PTB: `settle_card × N` followed by `finalize`. Each `settle_card` uses that card's own `oracle_id`. PTB:
   ```ts
   const tx = new Transaction()
   duelDetails.cards.forEach((c, idx) => {
     tx.moveCall({
       target: `${FLICKY_PACKAGE_ID}::duel::settle_card`,
       typeArguments: [COIN_TYPE],
       arguments: [
         tx.object(duelId),
         tx.object(p0ManagerId),
         tx.object(p1ManagerId),
         tx.object(c.oracle_id),    // per-card oracle
         tx.pure.u64(BigInt(idx)),
       ],
     })
   })
   tx.moveCall({
     target: `${FLICKY_PACKAGE_ID}::duel::finalize`,
     typeArguments: [COIN_TYPE],
     arguments: [tx.object(duelId), tx.object('0x6')], // Clock
   })
   ```
   Resolve `p0/p1Manager` by querying `predict_manager::PredictManagerCreated` events filtered by `owner`. Settles can also be split across multiple PTBs if a subset of oracles is settled — the duel accumulates state until `finalize` runs.

3. **Reveal-timeout watchdog** — on `DuelJoined`, set a 5-minute timer; if no `DeckRevealed` event fires, call `claim_reveal_timeout` on behalf of the challenger (if you hold their session key) — or, more cleanly, surface a UI button so the challenger signs themselves.

4. **Refund watchdog** — on duels stuck in ACTIVE > 1h (no `DuelFinalized`, `DuelRefunded`, `DuelForfeited`), allow `refund_duel`. Contract rejects when both players have completed 5/5 (loser-dodge guard).

5. **Sponsored gas** — all player-signed PTBs (create/join/reveal/swipe) should go through your sponsor service. The sponsor's allowlist must include:
   ```
   ${FLICKY_PACKAGE_ID}::duel::create_duel
   ${FLICKY_PACKAGE_ID}::duel::create_duel_free
   ${FLICKY_PACKAGE_ID}::duel::join_duel
   ${FLICKY_PACKAGE_ID}::duel::join_duel_free
   ${FLICKY_PACKAGE_ID}::duel::reveal_deck
   ${FLICKY_PACKAGE_ID}::duel::record_swipe
   ${FLICKY_PACKAGE_ID}::duel::record_swipe_free
   ${FLICKY_PACKAGE_ID}::duel::settle_card        # keeper or anyone can call
   ${FLICKY_PACKAGE_ID}::duel::settle_card_free
   ${FLICKY_PACKAGE_ID}::duel::finalize
   ${FLICKY_PACKAGE_ID}::duel::finalize_free
   ${FLICKY_PACKAGE_ID}::duel::finalize_test_one_oracle
   ${FLICKY_PACKAGE_ID}::duel::claim_reveal_timeout
   ${PREDICT_PACKAGE_ID}::predict::mint           # paired with record_swipe
   ```

### Indexer schema notes

- `Duel.p0_swipes[i]` and `p1_swipes[i]` are `Option<Swipe>`. Sui RPC encodes `Some(Swipe)` as a flattened object `{ type: "...::Swipe", fields: {...} }` and `None` as `null`. Check `typeof fields.is_up === 'boolean'` before reading.
- For commit-reveal storage: the deckmaster service holds plaintext `cards[]` per `(host_addr, deck_hash)` keyed locally. Reveal endpoint must be **gated** (e.g. requires host signature) — never serve the deck publicly before `DeckRevealed` event.

---

## 🖥 Frontend Integration

The web UI (`apps/web`) and the dev playground (`apps/playground`) both interact with the same package.

### Env required

Full ID values are in [Deployed Addresses](#-deployed-addresses-testnet).

`apps/playground/.env.local`:
```
VITE_NETWORK=testnet
VITE_FLICKY_PACKAGE_ID=0xaed053fcc146abd1da507eae72b4f3e9c838d83c83c7b68b230a3c9a2601a522
VITE_PREDICT_PACKAGE_ID=0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138
VITE_PREDICT_OBJECT_ID=0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a
VITE_REGISTRY_ID=0x43af14fed5480c20ff77e2263d5f794c35b9fab7e221290312706244e2a6e64
VITE_PYTH_SOURCE_ID=0xe62b6aeb669191ea11a4b6167c1ad0aaf88ab92d718fcc3b52794a131916c141
VITE_MARKET_ORACLE_ID=0xa1088e2747d9c3a2a29d6517cefd2c58e22fa4eccdfaa55750faa3e7e5e8e6b2
VITE_DUSDC_PACKAGE_ID=0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC
VITE_SERVER_HTTP_URL=http://localhost:3001
VITE_SERVER_WS_URL=ws://localhost:3001/ws
```

`apps/web/.env.local` (web app — same IDs, different var name for Flicky):
```
VITE_FLICKY_PACKAGE_ID_TESTNET=0xaed053fcc146abd1da507eae72b4f3e9c838d83c83c7b68b230a3c9a2601a522
# + the rest of the VITE_* vars above
```

> After every `bun run publish` / `bun run upgrade`, the script **auto-updates** `VITE_FLICKY_PACKAGE_ID_TESTNET` in `apps/web/.env.local` but **not** the playground's `.env.local` — paste manually each time (or symlink the file).

### PTB helpers

Generated wrappers live in `apps/playground/src/lib/duel-txb.ts`:

| Action | Helper |
|---|---|
| Create | `txCreateDuel(tx, stakeCoin, deckHashBytes, deckSize, coinType)` |
| Create (Free) | `txCreateDuelFree(tx, deckHashBytes, deckSize, coinType)` |
| Join | `txJoinDuel(tx, duelId, stakeCoin, coinType)` |
| Join (Free) | `txJoinDuelFree(tx, duelId, coinType)` |
| Reveal | `txRevealDeck(tx, duelId, cards, coinType)` — builds `new_card × N` then `reveal_deck` |
| Swipe | `txRecordSwipe(tx, duelId, managerId, predictId, oracleId, cardIdx, isUp, quantity, coinType)` |
| Swipe (Free) | `txRecordSwipeFree(tx, duelId, predictId, oracleId, cardIdx, isUp, coinType)` |
| Settle one card | `txSettleCard(tx, duelId, p0Mgr, p1Mgr, oracleId, cardIdx, coinType)` |
| Settle one card (Free) | `txSettleCardFree(tx, duelId, oracleId, cardIdx, coinType)` |
| Finalize (no oracle args) | `txFinalizeDuel(tx, duelId, coinType)` |
| Finalize (Free) | `txFinalizeDuelFree(tx, duelId, coinType)` |
| Finalize (dev shortcut) | `txFinalizeDuelTestOneOracle(tx, duelId, oracleId, coinType)` |
| Refund | `txRefundDuel(tx, duelId, coinType)` |
| Forfeit on reveal timeout | `txClaimRevealTimeout(tx, duelId, coinType)` |

### Critical flows

**1. Generate + commit deck (client-side)**
```ts
const cards = [...]; // 5 { oracleId, strike } picked from registry::OracleCreated events
const deckHash = sha256(serializeDeck(cards))  // BCS-encoded
// Persist `cards` to localStorage or send to deckmaster server
const tx = new Transaction()
txCreateDuel(tx, stakeCoin, Array.from(deckHash), cards.length, coinType)
```

**2. Atomic swipe PTB** — must combine mint + record_swipe in ONE PTB:
```ts
const tx = new Transaction()
const mk = buildMarketKey(tx, oracleId, expiry, strike, isUp)
txMint(tx, managerId, oracleId, mk, quantity, dusdcType)  // predict::mint
txRecordSwipe(tx, duelId, managerId, predictId, oracleId, cardIdx, isUp, quantity, duelCoinType)
// Sign with player's wallet (NOT server) — Predict enforces sender == manager.owner
```

**3. Reading swipes for live PnL projection**
```ts
const swipeOpt = duelDetails.p0_swipes[i]
if (!swipeOpt) return null   // None
const f = swipeOpt.fields    // Swipe is flattened in Sui RPC output
const { is_up, quantity, premium, p_swiped } = f
```

Use the current `oracle.spotPrice` (or `settlement_price` if set) versus `card.strike` to project payout. See `DuelPanel.tsx` "Projected PnL" section.

**4. Countdown / status badges** — derive from `oracle.expiry` vs `Date.now()`:
```
status === 'Active'              → expiry > now
status === 'Pending Settlement'  → expiry <= now, settlement_price.is_none()
status === 'Settled'             → settlement_price.is_some()
```

### Things the frontend must NEVER do

- ❌ Submit `record_swipe` without `predict::mint` in the same PTB (anti-replay will fail on settle).
- ❌ Pre-compute `premium` client-side and pass it to the contract — the new `record_swipe` doesn't accept a premium parameter (snapshotted on-chain).
- ❌ Render unrevealed cards from any source — the deckmaster service stores plaintext but UI should only show cards after `DeckRevealed`.
- ❌ Skip the sponsored-gas service for player-signed PTBs — zkLogin wallets hold only dUSDC.

---

## 🚨 Error Codes

Defined in `duel.move`:

| Code | Constant | When |
|---|---|---|
| 0 | `ENotPlayer` | Caller is neither creator nor challenger |
| 1 | `EDuelNotPending` | Need PENDING but duel moved past |
| 2 | `EDuelNotActive` | Need ACTIVE for this op |
| 3 | `EAlreadyJoined` | Challenger slot taken |
| 4 | `ECreatorCannotJoin` | Creator can't be challenger |
| 5 | `EStakeMismatch` | Challenger stake != creator stake |
| 6 | `EInvalidDeckSize` | `cards.length() != 5` |
| 7 | `ECardIndexOOB` | `card_idx >= 5` |
| 8 | `EOracleMismatch` | Passed oracle id ≠ card's oracle id |
| 9 | `EOutOfTurn` | Must swipe cards 0→4 in order |
| 11 | `EAllCardsNotSettled` | Finalize precondition not met (e.g. partial swipes + no timeout) |
| 13 | `EZeroStake` | Stake must be > 0 for Staked tier |
| 14 | `EOracleNotLive` | Oracle missing `settlement_price` (or `compute_price` failed) |
| 15 | `EInvalidDeckHash` | `deck_hash.length() != 32` |
| 16 | `EDeckAlreadyRevealed` | Reveal called twice |
| 17 | `EDeckHashMismatch` | `sha2_256(bcs(cards)) != deck_hash` |
| 18 | `EDeckNotRevealed` | Trying to swipe before reveal |
| 19 | `ENotManagerOwner` | `manager.owner() != sender` |
| 20 | `EInsufficientPosition` | `position(manager, key) < quantity` |
| 21 | `ESwipeTimeout` | Past 10-min swipe window |
| 24 | `EZeroQuantity` | quantity = 0 |
| 25 | `EZeroPremium` | derived premium = 0 (extreme p_swiped) |
| 27 | `EWrongTier` | Calling staked entry on FREE duel or vice versa |
| 28 | `EInvalidProb` | p_swiped out of (0, 1e9) |
| 29 | `ERefundDuelComplete` | Both players completed N/N — finalize is the only path |
| 30 | `ERevealNotTimedOut` | Reveal-timeout claimed before 5 min |
| 31 | `EInvalidDeckSizeBounds` | `deck_size` outside `[1, 20]` at create-time |
| 32 | `EAlreadySettled` | `settle_card(i)` called twice on the same card |
| 33 | `ESwipesNotComplete` | `finalize` invoked with partial swipes before the 10-min window expired |

---

## 🛠 Deployment

Scripts in `scripts/`:

| Script | Purpose |
|---|---|
| `publish.ts` | First-time deploy. Writes `deployed.json` + `Published.toml`. |
| `upgrade.ts` | Compatible upgrade (preserves type identity via `originalPackageId`). |
| `publish-stub.ts` | Re-publish `deepbook_predict_min` stub if you ever fork from the real DeepBook Predict address. |
| `upgrade-stub.ts` | Upgrade the vendored stub (rare). |
| `init-oracle.ts` | Create a test OracleSVI via the stub's testnet admin (`new_market_oracle`). |
| `codegen` | Regenerate type-safe bindings in `apps/web/src/sui/gen/`. |

Compatible upgrades cover: adding new entry functions, new events, new public read accessors. Breaking changes (struct field reordering, removing fields, changing function signatures) require a fresh publish — and orphan all existing `Duel<T>` shared objects.

---

## 📦 Stub Packages

Local Move packages under `deepbook_predict_min/`, `deepbook_min/`, `token_min/` mirror the on-chain ABI signatures of the upstream packages so flicky can link at build time:

| Stub | Bound to | Notes |
|---|---|---|
| `deepbook_predict_min/` | `0xf5ea2b3749…` | Real DeepBook Predict testnet. `get_trade_amounts` is public; `compute_price` is friend-only — never call directly. |
| `deepbook_min/` | `0x74cd5657…` | DeepBook v3 core (transitive). |
| `token_min/` | `0x36dbef86…` | SUI/Deep token transitive deps. |

> The compiler tree-shakes stub bodies; only signatures matter at link time. On-chain execution always dispatches to the real published packages.

---

## 🪙 Standalone Swap AMM

Located in `swap/` — a constant-product (x·y=k) AMM for SUI ↔ dUSDC test swaps. Independent of the duel package.

- Testnet packageId: `0x51ea0f29321f3c25f8b2f530ecd3ed3dec569d954c8832d318de7e203653a936`
- See [`swap/README.md`](./swap/README.md) for details.
