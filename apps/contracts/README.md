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

Two players lock equal dUSDC stakes into a shared `Duel<T>` object, swipe UP/DOWN on 5 binary-option cards backed by **DeepBook Predict's `OracleSVI`** + `PredictManager`, then a one-shot `finalize` reads each oracle's `settlement_price` and pays the winner.

Two tiers share the same engine:

| Tier | Stake | Predict mint | Anti-replay |
|---|---|---|---|
| `STAKED` | dUSDC escrow | yes (player mints positions) | yes (`PredictManager.position >= quantity`) |
| `FREE`   | none | none | n/a |

`record_swipe` snapshots `premium` and `p_swiped` **on-chain** by calling `deepbook_predict::predict::get_trade_amounts(predict, oracle, key, quantity, clock)` — the caller cannot manipulate the swipe price.

`finalize` is **permissionless**. Any caller (typically the server admin) submits the PTB; the contract re-verifies via oracle reads, so the caller cannot influence the result.

---

## 📍 Deployed Addresses (Testnet)

> Last updated: **2026-05-26**. Single source of truth — paste these into your `.env.local` files. When the contract is republished, only the **Flicky** rows change; DeepBook addresses are external and stable.

### Flicky (our package)

| Item | ID | Role |
|---|---|---|
| **Package ID** (current) | `0x4ab595f3b0276c50eeff2181905cabc1d94ca3fd6b7aafe1a01d12869f258c44` | Active version — call all `flicky::duel::*` entries against this |
| **Original Package ID** | `0x4ab595f3b0276c50eeff2181905cabc1d94ca3fd6b7aafe1a01d12869f258c44` | Type identity — stable across upgrades (currently == current) |
| **UpgradeCap** | `0x87a4a7b59a32a0e0f361c8b974817bb4d48ceaeff24a380646b3fe3b9c7898af` | Authorizes `bun run upgrade`. Held by deployer wallet |
| **Deployer** | `0x9826b0895f3adc08f2f4c8907640adf2f29351ec7829281050ded1020e296d5a` | The publisher account |
| **Publish digest** | `DdML89kVkeb5acnYdcyU2BsoQ4RdZvnhWcPanKhrvY21` | First-publish tx |

Source of truth: [`deployed.json`](./deployed.json).

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
# 28/28 PASS — covers create, join, reveal, swipe, finalize (single/multi/test),
# refund, reveal-timeout forfeit, anti-replay, free-tier.
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
1. **Generate Deck Hash** — picks 5 oracles + 5 strikes, hashes the deck.
2. **Create Duel** — escrow stake, share `Duel`, status `PENDING`.
3. Connect a second wallet → **Join Existing Duel** → status `ACTIVE`.
4. Host (first wallet) → **Reveal Deck**.
5. Both wallets → **Record Swipe** × 5 (atomic PTB: `predict::mint` + `duel::record_swipe`).
6. Finalize via **one of three paths**:
   - **🏆 Finalize (1 oracle)** — when deck shares one oracle (rare).
   - **🎯 Finalize (multi-oracle: 5/5 settled)** — production path; waits for all 5.
   - **⚗️ Finalize (test — single oracle)** — dev shortcut. Uses spot price if no oracle settled yet. PnL approximate; **testnet only**.

### 5. Other test paths in the UI

- **💸 Refund / Cancel Duel** — works in PENDING (creator only) and ACTIVE-1h (either player, unless both finished swiping).
- **Reveal timeout forfeit** — if host doesn't reveal within 5 minutes after join, challenger sweeps the pot via `claim_reveal_timeout` (PTB helper available; UI button can be wired similarly).

---

## 📦 Module Surface

Located in `sources/duel.move`. One module, no internal sub-modules — all pricing math lives in `deepbook_predict` upstream.

### Public entries

**Lifecycle**
- `create_duel<T>(stake, deck_hash, ctx) -> ID` — Staked tier, requires `stake_amount > 0`.
- `create_duel_free<T>(deck_hash, ctx) -> ID` — Free tier, zero stake.
- `join_duel<T>(duel, stake, clock, ctx)` — challenger matches stake.
- `join_duel_free<T>(duel, clock, ctx)` — free-tier join.
- `reveal_deck<T>(duel, cards)` — permissionless, validates `sha2_256(bcs(cards)) == deck_hash`.

**Swipe** (player-signed, atomic PTB)
- `record_swipe<T>(duel, manager, predict, oracle, card_idx, is_up, quantity, clock, ctx)` — Staked. Snapshots premium via `get_trade_amounts`; checks `manager.position(key) >= quantity`.
- `record_swipe_free<T>(duel, predict, oracle, card_idx, is_up, clock, ctx)` — Free, normalized `quantity = 1e9`.

**Finalize** (typically server-signed)
- `finalize<T>(duel, p0_mgr, p1_mgr, oracle, clock, ctx)` — Staked, single-oracle deck.
- `finalize_multi<T>(duel, p0_mgr, p1_mgr, oracle_0..oracle_4, clock, ctx)` — Staked, deck with 5 different oracles. All 5 must be settled.
- `finalize_free<T>(duel, oracle, clock, ctx)` — Free tier.
- `finalize_test_one_oracle<T>(duel, oracle, clock, ctx)` — **DEV ONLY**. Uses one oracle's settlement_price (or spot fallback) for all 5 cards. No anti-replay.

**Refund / Forfeit**
- `refund_duel<T>(duel, clock, ctx)` — PENDING (creator) / ACTIVE 1h+ (either player, unless both completed).
- `claim_reveal_timeout<T>(duel, clock, ctx)` — challenger sweeps if host doesn't reveal within 5 minutes.

### Events

- `DuelCreated { duel_id, creator, stake_amount, deck_hash, tier }`
- `DuelJoined { duel_id, challenger, stake_amount, started_at_ms }`
- `DeckRevealed { duel_id }`
- `SwipeRecorded { duel_id, player, card_idx, is_up, quantity, premium, p_swiped }`
- `DuelFinalized { duel_id, winner, payout_to_p0, payout_to_p1, p0_payout_total, p0_premium_total, p1_payout_total, p1_premium_total, oracle_id, settlement_price }`
- `DuelRefunded { duel_id, refunded_to_p0, refunded_to_p1 }`
- `DuelForfeited { duel_id, winner, payout, reason }` — `reason: 1` = reveal timeout.

### `Duel<T>` shared object fields (read-API methods)

| Field | Reader | Purpose |
|---|---|---|
| `status: u8` | `status()` | 1=PENDING, 2=ACTIVE, 3=COMPLETE |
| `tier: u8` | `tier()` | 1=STAKED, 2=FREE |
| `deck_hash: vector<u8>` | `deck_hash()` | 32-byte sha2_256 commitment |
| `cards: vector<Card>` | `deck()` | empty until reveal; each `Card { oracle_id, strike }` |
| `creator`, `challenger` | `creator()`, `challenger()` | addresses |
| `p0_stake`, `p1_stake: Balance<T>` | `p0_stake_value()`, `p1_stake_value()` | escrowed coin |
| `p0_swipes`, `p1_swipes: vector<Option<Swipe>>` | direct | length 5; `Swipe { is_up, quantity, premium, p_swiped }` |
| `p0_payout, p0_premium, p1_*` | `p0_payout()`, etc. | zero until `finalize`; mirror of aggregated PnL |
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
       │ each player: record_swipe × 5  (atomic PTB with predict::mint)
       ▼
   ACTIVE (both 5/5 swipes)
       │
       │ oracles settle ─► server admin (or anyone): finalize / finalize_multi
       │ OR stuck (T+1h) ─► refund_duel ─► COMPLETE (both refund)
       ▼
   COMPLETE
```

### Timing constants

| Constant | Value | Purpose |
|---|---|---|
| `DECK_SIZE` | 5 | Cards per duel |
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
SUI_KEEPER_PRIVATE_KEY=suiprivkey1q...   # signs finalize/finalize_multi
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

2. **Finalize trigger** — once both players are `5/5` and all relevant oracles have `settlement_price.is_some()`, submit `finalize` (single-oracle) or `finalize_multi` (5-oracle). PTB:
   ```ts
   tx.moveCall({
     target: `${FLICKY_PACKAGE_ID}::duel::finalize_multi`,
     typeArguments: [COIN_TYPE],
     arguments: [
       tx.object(duelId),
       tx.object(p0ManagerId),
       tx.object(p1ManagerId),
       tx.object(oracle0Id), tx.object(oracle1Id), tx.object(oracle2Id),
       tx.object(oracle3Id), tx.object(oracle4Id),
       tx.object('0x6'),  // Clock
     ],
   })
   ```
   Resolve `p0/p1Manager` by querying `predict_manager::PredictManagerCreated` events filtered by `owner`.

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
VITE_FLICKY_PACKAGE_ID=0x4ab595f3b0276c50eeff2181905cabc1d94ca3fd6b7aafe1a01d12869f258c44
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
VITE_FLICKY_PACKAGE_ID_TESTNET=0x4ab595f3b0276c50eeff2181905cabc1d94ca3fd6b7aafe1a01d12869f258c44
# + the rest of the VITE_* vars above
```

> After every `bun run publish` / `bun run upgrade`, the script **auto-updates** `VITE_FLICKY_PACKAGE_ID_TESTNET` in `apps/web/.env.local` but **not** the playground's `.env.local` — paste manually each time (or symlink the file).

### PTB helpers

Generated wrappers live in `apps/playground/src/lib/duel-txb.ts`:

| Action | Helper |
|---|---|
| Create | `txCreateDuel(tx, stakeCoin, deckHashBytes, coinType)` |
| Create (Free) | `txCreateDuelFree(tx, deckHashBytes, coinType)` |
| Join | `txJoinDuel(tx, duelId, stakeCoin, coinType)` |
| Join (Free) | `txJoinDuelFree(tx, duelId, coinType)` |
| Reveal | `txRevealDeck(tx, duelId, cards, coinType)` — builds `new_card × 5` then `reveal_deck` |
| Swipe | `txRecordSwipe(tx, duelId, managerId, predictId, oracleId, cardIdx, isUp, quantity, coinType)` |
| Swipe (Free) | `txRecordSwipeFree(tx, duelId, predictId, oracleId, cardIdx, isUp, coinType)` |
| Finalize (1 oracle) | `txFinalizeDuel(tx, duelId, p0Mgr, p1Mgr, oracleId, coinType)` |
| Finalize (5 oracles) | `txFinalizeDuelMulti(tx, duelId, p0Mgr, p1Mgr, [o0..o4], coinType)` |
| Finalize (test) | `txFinalizeDuelTestOneOracle(tx, duelId, oracleId, coinType)` |
| Refund | `txRefundDuel(tx, duelId, coinType)` |
| Forfeit on reveal timeout | `txClaimRevealTimeout(tx, duelId, coinType)` |

### Critical flows

**1. Generate + commit deck (client-side)**
```ts
const cards = [...]; // 5 { oracleId, strike } picked from registry::OracleCreated events
const deckHash = sha256(serializeDeck(cards))  // BCS-encoded
// Persist `cards` to localStorage or send to deckmaster server
const tx = new Transaction()
txCreateDuel(tx, stakeCoin, Array.from(deckHash), coinType)
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
| 29 | `ERefundDuelComplete` | Both players completed 5/5 — finalize is the only path |
| 30 | `ERevealNotTimedOut` | Reveal-timeout claimed before 5 min |

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
