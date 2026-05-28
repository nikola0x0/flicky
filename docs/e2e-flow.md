# End-to-End Flow — params, gates, and what is currently shipped

A duel goes through eight phases between a player opening the lobby and
a winner receiving payout. This doc traces each phase: who acts, what
PTB / endpoint runs, which arguments are passed, what guards exist
on-chain and in the UI, and where the implementation lives.

Read alongside `docs/oracle-selection.md` (which picks the OracleSVI
the duel pins to) and `docs/prd.md` (which states the product
requirements being satisfied).

> **✓ Re-aligned with the contract refactor (2026-05-29).** This doc was
> previously diverged from the PRD on settlement mechanics. The contract
> rewrite landed those updates:
>
> - **Scoring** — now real PnL: `Swipe { is_up, quantity, premium, p_swiped }` snapshotted on-chain by `predict::get_trade_amounts`. Per-card payout = correct? quantity : 0; per-card premium = swipe.premium. `settle_card(card_idx, &oracle)` accumulates these onto the Duel. `finalize` compares aggregate `val0 = p0_payout + p1_premium` vs `val1 = p1_payout + p0_premium`. No more speed multiplier or `decide_time_ms`.
> - **Card oracles** — each `Card { oracle_id, strike }` pins its OWN oracle. A 5-card deck spans 5 different oracles with 5 different expiries. `settle_card` is called once per card.
> - **Deckmaster amplitude** — backend now probes ±0.5%–±20% in parallel per oracle and picks the most aggressive viable offset. Deck-level sign balance ensures every duel mixes UP-favoring + DOWN-favoring strikes (never all one side).
> - **Variable deck size** — `deck_size` chosen at create-time, bounded `[1, 20]`. Default 5.
>
> Still diverged from PRD (out of scope of this refactor):
>
> - **Stake tiers** — code currently uses whatever the FE picks; PRD spec is **1 / 3 / 5 / 10 dUSDC** (4 tiers) gated by `PredictManager` balance ≥ 5 dUSDC.
> - **Free tier vs Practice** — on-chain Free tier exists (`create_duel_free` / `settle_card_free` / `finalize_free`); PRD replaces with solo-vs-bot Practice Mode (no chain).
> - **Swap module** — separate package at `0x51ea0f29…` already published, FE not fully wired.
> - **Predict Manager bootstrap** — PRD says sponsor it on first sign-in; today still a separate user step.
>
> The Duel object's swipe ordering, commit-reveal, escrow / payout half, and the keeper PTB shape (`settle_card × N` + `redeem × N` + `finalize`, all permissionless) match the current code.

> **Status legend:** ✓ shipped · ◐ partial · ✗ not implemented · 🜲 superseded by new PRD direction

---

## Phase overview

```
[wallet]                                                       [chain]
   │
   │ A. zkLogin / extension connect                           ─→ Sui address
   │
   │ B. PredictManager onboarding (dUSDC only, one-time per address)
   │    ① predict::create_manager                              → shared PredictManager
   │    ② predict_manager::deposit<DUSDC>(amount)              → balance funded
   │
   ▼
[lobby]
   │
   │ 1. Pick N oracles (nearest-expiry BTC, headroom ≥ 10 min)  → OracleSVI[N]
   │ 2. Generate deck (POST /deckmaster/generate)
   │    - per oracle: probe ±0.5%–±20% in parallel, pick most aggressive viable
   │    - deck-level: balanced sign mix (e.g. 3 UP-fav + 2 DOWN-fav for N=5)
   │                                                            → N strikes + hash
   │ 3. duel::create_duel<T>(stake, deck_hash, deck_size)       → Duel<T> PENDING
   │
   ▼
[wait]
   │
   │ 4. challenger join_duel<T>(stake)                          → Duel ACTIVE, started_at_ms
   │ 5. keeper reveal_deck<T>(plaintext)                        → cards populated
   │
   ▼
[swipe × N each]
   │
   │ 6. record_swipe (free)  OR  mint + record_swipe (staked)
   │    snapshots quantity, premium, p_swiped on-chain          → SwipeRecorded
   │
   ▼
[lockup]
   │
   │ 7. wait for EACH card's oracle to publish settlement_price
   │    (different cards may settle at different times — that's fine,
   │    settle_card is per-card)
   │
   ▼
[settle + finalize + redeem — single keeper PTB once all oracles settled]
   │
   │ 8a. settle_card × N (one per card with its own oracle)     → CardSettled events
   │ 8b. duel::finalize (no oracle args)                         → status = COMPLETE, payout
   │ 8c. predict::redeem_permissionless × M (dUSDC only)         → Predict positions paid
   │
   ▼
[result]
```

---

## Contract responsibilities — Flicky vs DeepBook Predict

Two distinct Move packages compose into every staked duel. Flicky owns
the **PvP score-based payout** layer; DeepBook Predict owns the
**oracle data + real binary market positions** layer. They share only
one piece of data: the `OracleSVI` object id (and its `expiry`/`strike`
indexing key into MarketKey).

Knowing which side a function lives on tells you who guards what.

### Flicky package (`apps/contracts/sources/`)

Source of truth for the current `packageId` is [`apps/contracts/deployed.json`](../apps/contracts/deployed.json).

| Module · function | Purpose | Side effect |
|---|---|---|
| `duel::create_duel<T>(stake, deck_hash, deck_size)` | Open a new duel, lock creator's stake, commit deck hash, pick deck size [1, 20] | New `Duel<T>` shared object, status PENDING, escrows `p0_stake` |
| `duel::create_duel_free<T>(deck_hash, deck_size)` | Free-tier counterpart, zero stake | New `Duel<T>` with `tier = FREE` |
| `duel::join_duel<T>(duel, stake, clock)` | Challenger matches stake | status → ACTIVE, `started_at_ms` set, escrows `p1_stake` |
| `duel::join_duel_free<T>(duel, clock)` | Free-tier join | same, no stake |
| `duel::reveal_deck<T>(duel, cards)` | Verify `sha2_256(bcs(cards)) == deck_hash` + `cards.length() == deck_size`, populate cards | `duel.cards` filled |
| `duel::record_swipe<T>(duel, mgr, predict, oracle, card_idx, is_up, quantity, clock)` | Snapshot `premium` from `predict::get_trade_amounts`, derive `p_swiped`, store per-player swipe; checks `mgr.position(key) >= quantity` (anti-replay) | `Swipe { is_up, quantity, premium, p_swiped }` appended to `p{N}_swipes[card_idx]` |
| `duel::record_swipe_free<T>(duel, predict, oracle, card_idx, is_up, clock)` | Free-tier swipe — same pricing snapshot, no manager check, normalized `quantity = 1e9` | same as above |
| `duel::settle_card<T>(duel, p0_mgr, p1_mgr, oracle, card_idx)` | Read `oracle.settlement_price`, score both players' swipes on this card, accumulate per-player payout / premium on the duel. Anti-replay via `mgr.position(key)` | `cards_settled[i] = true`, `card_settlement_prices[i] = price`, `settled_count++`, `p{0,1}_payout/_premium` ↑. Emits `CardSettled` |
| `duel::settle_card_free<T>(duel, oracle, card_idx)` | Free-tier counterpart, no managers | same |
| `duel::finalize<T>(duel, clock)` | Compare `val0 = p0_payout + p1_premium` vs `val1 = p1_payout + p0_premium`, distribute pot | status → COMPLETE, winner gets pot via `Balance.split + transfer`. Emits `DuelFinalized` |
| `duel::finalize_free<T>(duel, clock)` | Same, free tier (no stake transfers) | status → COMPLETE |
| `duel::finalize_test_one_oracle<T>(duel, oracle, clock)` | **DEV**: internally settles every unsettled card with one oracle's `settlement_price` (or `spot_price` fallback), then finalizes. Skips anti-replay | full settle + finalize in one call |
| `duel::refund_duel<T>(duel, clock)` | PENDING: creator cancels; ACTIVE 1h+: either player refunds (blocked if both N/N — finalize is the only path) | status → COMPLETE, stakes returned |
| `duel::claim_reveal_timeout<T>(duel, clock)` | Challenger sweeps pot if host didn't reveal within 5 min of join | status → COMPLETE, pot → challenger. Emits `DuelForfeited` |
| `duel::new_card(oracle, strike)` | Pure constructor for `Card` (used by reveal callers to build the vector) | none — produces value |

**State Flicky stores per `Duel<T>`:**
- `cards: vector<Card>` — `{ oracle_id, strike } × deck_size`
- `deck_hash: vector<u8>` — sha2-256 commitment
- `deck_size: u64` — chosen at create-time, [1, 20]
- `tier: u8` — 1=STAKED, 2=FREE
- `p0_stake, p1_stake: Balance<T>` — escrowed pot
- `p0_swipes, p1_swipes: vector<Option<Swipe>>` — `Swipe { is_up, quantity, premium, p_swiped }`
- `cards_settled: vector<bool>` — flips true per `settle_card`
- `card_settlement_prices: vector<u64>` — per-card settlement_price snapshot (0 = unsettled)
- `settled_count: u64` — `finalize` requires == `deck_size`
- `p0_payout, p0_premium, p1_payout, p1_premium: u64` — accumulated per `settle_card`
- `p{0,1}_next_card_idx: u64` — turn ordering
- `started_at_ms: u64` — set when challenger joins

**Events Flicky emits:**
- `DuelCreated`, `DuelJoined`, `DeckRevealed`, `SwipeRecorded`, `CardSettled`, `DuelFinalized`, `DuelRefunded`, `DuelForfeited`

**What Flicky never touches:**
- DeepBook prices, SVI params, settlement_price (only reads via `predict::get_trade_amounts` and `oracle::settlement_price`)
- PredictManager **mutation** — only reads `position(key)` for anti-replay. Redeem flow happens entirely outside the Duel (via `predict::redeem_permissionless`, keeper-driven).

---

### DeepBook Predict package (external)

Published at `0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138`.

| Module · function | Purpose | Side effect |
|---|---|---|
| `predict::create_manager(ctx)` | Mint a new `PredictManager` shared object owned (logically) by sender | New PredictManager with `owner = sender`. `PredictManagerCreated` event |
| `predict::mint<T>(predict, manager, oracle, key, quantity, clock, ctx)` | Open a binary position (UP/DOWN) on `oracle@strike` for `quantity` dUSDC | Manager balance ↓ quantity, position recorded at `MarketKey(oracle, expiry, strike, is_up)`. **Invariant: `sender == manager.owner`** |
| `predict::redeem<T>(predict, manager, oracle, key, quantity, clock)` | Settle owner's position post-expiry | Owner's manager balance ↑ payout. Requires `sender == manager.owner` |
| `predict::redeem_permissionless<T>(predict, manager, oracle, key, quantity, clock)` | Settle anyone's position post-expiry | Manager balance ↑ payout. **Permissionless caller** — keeper uses this |
| `predict::mint_range<T>`, `redeem_range<T>` | Range card variants | (Flicky doesn't use these yet — PRD gap) |
| `predict_manager::deposit<T>(manager, coin, ctx)` | Top up the manager's spendable balance | Manager balance ↑ |
| `predict_manager::withdraw<T>(manager, amount, ctx)` | Pull spendable balance back to wallet | Returns `Coin<T>` |
| `predict_manager::balance<T>(manager)` | Read-only balance query | none (used via devInspect) |
| `market_key::up(oracle, expiry, strike)` | Construct UP MarketKey | Pure value — passed as input to mint/redeem |
| `market_key::down(oracle, expiry, strike)` | Construct DOWN MarketKey | Pure value |
| `range_key::lo_hi(oracle, expiry, lo, hi)` | Construct range MarketKey | (unused by Flicky today) |
| `pricing::p_up(oracle, strike) → u64` | Compute implied probability of UP based on oracle's SVI surface | Pure read — Flicky calls inside `record_swipe` to snapshot `p_swiped` |
| `oracle::*` accessors | `id`, `expiry`, `is_active`, `prices`, `settlement_price`, `svi` | Pure reads |

**State DeepBook stores:**
- `OracleSVI` (shared): prices, expiry, settlement_price, SVI parameters — DeepBook operator pushes ticks every ~1 s
- `PredictManager` (shared): balance per coin type, positions per MarketKey, range_positions per RangeKey, owner field
- `Predict` (singleton shared): protocol state

**Events DeepBook emits:**
- `registry::OracleCreated` — every cron tick (`:00, :15, :30, :45`)
- `oracle::OraclePricesUpdated` — every price tick (~1 s)
- `predict_manager::PredictManagerCreated` — when `create_manager` runs
- `predict_manager::BalanceEvent`, `predict::BalanceEvent` — per deposit/withdraw/mint/redeem
- `predict::RangeRedeemed` — for range positions

**Invariants enforced by DeepBook (load-bearing for Flicky's design):**
1. `predict::mint` requires `sender == manager.owner` — forces the **player** (not Flicky, not keeper) to sign every staked swipe
2. `PredictManager` is a **shared object** with internal `owner: address` field — allows permissionless keeper redeem while still gating mint
3. `OracleSVI.settlement_price: Option<u64>` — None during liveness, Some after operator publishes (~+8 s after `expiry`)

---

### Who-does-what summary

| Concern | Flicky | DeepBook |
|---|---|---|
| Lock player stake | `p{0,1}_stake: Balance<T>` ✓ | — |
| Match opponent (PvP) | `creator + challenger` fields ✓ | — |
| Read live oracle price | — | `OracleSVI.prices` ✓ |
| Snapshot premium + implied prob | reads `predict::get_trade_amounts` inside `record_swipe` | provides `get_trade_amounts(predict, oracle, key, qty, clock) → (ask, bid)` |
| Open binary position | — | `predict::mint` ✓ |
| Anti-replay | `record_swipe` + `settle_card` read `mgr.position(key)` | provides `predict_manager::position(mgr, key)` |
| Score a card | `settle_card` → real PnL `payout - premium` per side ✓ | — |
| Decide winner / tie-break | `finalize` compares `val0 vs val1` ✓ | — |
| Pay out PvP pot | `Balance.split + transfer` ✓ | — |
| Pay out binary position | — | `redeem_permissionless` ✓ |
| Anti-front-run via commit-reveal | `deck_hash` + `reveal_deck` ✓ | — |
| Oracle lifecycle (active, settle) | — | cron at `:00/:15/:30/:45` ✓ |

### Why this separation matters

- **Predict's mint invariant** (`sender == owner`) is why staked swipes must be player-signed PTBs — Flicky can't route mint through a keeper or shared bot wallet.
- **Each card pins its own oracle** — different expiries within one deck. `settle_card` is per-card so the keeper can settle each as its oracle's `settlement_price` becomes available, without blocking on the slowest one.
- **Settlement timing is DeepBook's contract, not Flicky's** — the keeper waits for each card's oracle to publish `settlement_price` (~+8 s after expiry), then runs `settle_card` (which reads that price). Once `settled_count == deck_size`, anyone can call `finalize` to distribute the pot. `predict::redeem_permissionless` materialises each player's Predict position payout into their PredictManager.

### Typical staked-swipe PTB (composition of both)

```text
PTB[
  market_key::up(oracle, expiry, strike)           ─┐  DeepBook
  predict::mint<DUSDC>(predict, manager, oracle, mk, qty)  ─┤  DeepBook
  duel::record_swipe<DUSDC>(duel, mgr, predict, oracle, idx, is_up, qty)  ─┤  Flicky
]                                                  ─┘
  ↑
  signed once by player
  atomic: any abort rolls back all three
  manager.owner() == sender enforced by record_swipe (anti-spoof)
```

### Typical close-out PTB (composition of both)

```text
PTB[
  duel::settle_card<DUSDC>(duel, p0_mgr, p1_mgr, oracle_0, 0)      ─┐
  duel::settle_card<DUSDC>(duel, p0_mgr, p1_mgr, oracle_1, 1)      ─┤  Flicky × deck_size
  …                                                                ─┤
  duel::settle_card<DUSDC>(duel, p0_mgr, p1_mgr, oracle_(N-1), N-1)─┘
  duel::finalize<DUSDC>(duel, clock)                               ─── Flicky
  market_key::up(oracle_i, expiry_i, strike_i)                     ─┐
  predict::redeem_permissionless<DUSDC>(predict, mgr_x, oracle_i, mk, qty)  ─┤  DeepBook × M
  …                                                                ─┘  (M = total swipes both sides)
]
  ↑
  signed by keeper (any wallet — permissionless on every step)
  settle_card MUST run before finalize; finalize MUST run before redeem (so
  finalize's anti-replay read sees live positions, not zeroed ones).
```

---

## Phase A — Wallet connection

| Concern | Detail |
|---|---|
| Implementations | `@mysten/dapp-kit` extension wallets + Enoki zkLogin (Google, Facebook) |
| Code | `apps/web/src/main.tsx`, `apps/web/src/App.tsx::WalletButton` |
| Gates | none — opens app to any address |
| Output | `address: string` (Sui address) |
| Status | ✓ extension + Google zkLogin · ◐ Apple zkLogin (env-gated, not wired in UI per PRD) |

zkLogin caveat: same Google account + Enoki config always derives the
same Sui address, so the rest of the flow is device-portable. See the
Q&A trail leading to `docs/oracle-selection.md` for details.

---

## Phase B — PredictManager onboarding (dUSDC only)

### B1. `predict::create_manager`

| Concern | Detail |
|---|---|
| Builder | `buildCreateManagerTx()` — `apps/web/src/lib/deepbook.ts:104` |
| Params | none — `predict::create_manager(ctx)` |
| Result | new **shared** `PredictManager` object with internal `owner: address` field; `PredictManagerCreated { manager_id, owner }` event |
| Discovery after the fact | `findPredictManager` — walks `PredictManagerCreated` events, matches `owner == address`, caches into `localStorage["flicky.predictManager.v1"]` |
| One-per-address | enforced socially (UI gate) — DeepBook does not on-chain dedupe |
| Status | ✓ shipped with localStorage cache + UI checklist row + tx digest toast |

`extractManagerIdFromChanges` reads the freshly-created id from the
PTB's `objectChanges` so the UI updates within ~1 s of tx finality
(no waiting for the polling tick).

### B2. `predict_manager::deposit<DUSDC>`

| Concern | Detail |
|---|---|
| Builder | `buildDepositDusdcTx(client, owner, managerId, amountMicroDusdc)` — `apps/web/src/lib/deepbook.ts:114` |
| Params | `amountMicroDusdc: bigint` (6-decimal dUSDC) |
| Pre-reqs | wallet holds ≥ amount dUSDC |
| Action | merge dUSDC coins → split `amount` → `predict_manager::deposit(manager, coin, ctx)` |
| Result | manager's internal dUSDC balance ↑ amount; `BalanceEvent` emitted |
| Status | ✓ shipped with inline input + UI checklist row + tx digest toast |

DepositPanel lives in `apps/web/src/App.tsx::DepositPanel`. It surfaces
both steps as a 2-row checklist and is rendered in Lobby regardless of
tier selection so the player can pre-fund.

---

## Phase 1 — Oracle selection

| Concern | Detail |
|---|---|
| Helper | `findLatestOracleSvi(client, "BTC")` — `apps/web/src/lib/flicky.ts:500` |
| Strategy | `argmin(expiry)` among DeepBook BTC OracleSVI objects that are `active && !settled && (expiry − now) ≥ 90 s` |
| Headroom constant | `ORACLE_MIN_HEADROOM_MS = 90_000n` — covers 60 s swipe phase + 30 s margin |
| Fallback | `CONFIG.fallbackOracleSviId` if no eligible oracle |
| Status | ✓ shipped — see `docs/oracle-selection.md` for the picker rationale |

---

## Phase 2 — Deck generation

| Concern | Detail |
|---|---|
| Endpoint | `POST /deckmaster/generate { oracle_id, reference }` — `apps/server/src/index.ts:49` |
| Server logic | `buildDeck(oracleId, reference)` — `apps/server/src/deckmaster.ts:39`. Strikes = `reference × [95, 98, 100, 102, 105] / 100` |
| Response | `{ cards: [{oracle_id, strike}], hash }` where `hash = sha2_256(bcs::to_bytes(&cards))` |
| Persistence | `rememberDeck(hash, cards)` writes to `apps/server/.data/decks.json` so server restart doesn't strand the plaintext |
| Reveal endpoint | `GET /deckmaster/reveal?hash=0x…` — returns plaintext for keeper / fallback reveal |
| Status | ✓ pipeline shipped · ◐ deck quality is phase-1 placeholder (not SVI-informed, no 2/2/1 difficulty split, no `(blockHash, duel_id)` seed) — see PRD gap §AI Deckmaster |

---

## Phase 3 — Create duel

### `duel::create_duel<T>(stake_coin, deck_hash)`

| Concern | Detail |
|---|---|
| Builders | `buildCreateDuelTx(deckHash, stake, type)` (SUI) · `buildCreateDuelDusdcTx(client, owner, deckHash, stake, type)` (dUSDC) — `apps/web/src/lib/flicky.ts:123` |
| Params on-chain | `Balance<T>` (stake), `vector<u8>` (deck_hash, 32 bytes) |
| Move guards | `EZeroStake` if stake.value == 0 · `EDeckHashWrongLength` if hash ≠ 32 bytes — `apps/contracts/sources/duel.move::create_duel` |
| UI gates (dUSDC) | DepositPanel must show `stakedReady = hasManager && managerBalance > 0` · wallet must hold ≥ stake dUSDC · `apps/web/src/App.tsx::Lobby` |
| Result | Duel<T> shared object created with `status = PENDING`, `creator = sender`, `p0_stake = Balance<T>`, `card_settlements = [None×5]`. `DuelCreated { duel_id, creator, stake_amount, deck_hash }` event |
| Signing | sponsor-or-fallback via `useFlickySign` (`apps/web/src/lib/use-flicky-sign.ts`) |
| Status | ✓ shipped with hard gates |

---

## Phase 4 — Join duel

### `duel::join_duel<T>(duel, stake_coin, &Clock)`

| Concern | Detail |
|---|---|
| Builders | `buildJoinDuelTx(duelId, stake, type)` · `buildJoinDuelDusdcTx(...)` — `apps/web/src/lib/flicky.ts` |
| Params on-chain | `&mut Duel<T>`, `Coin<T>` matching `p0_stake`, `&Clock` |
| Move guards | `EJoinerIsCreator` · `EDuelNotPending` · `EStakeMismatch` — `apps/contracts/sources/duel.move::join_duel` |
| UI gates | Plaintext deck must exist (`GET /deckmaster/reveal` → 404 ⇒ block) · for dUSDC: joiner has PredictManager + dUSDC balance ≥ stake · `apps/web/src/App.tsx::JoinView` |
| State transition | `status: PENDING → ACTIVE` · `challenger = sender` · `started_at_ms = Clock.timestamp_ms` · `p0_last_swipe_or_start_ms = p1_last_swipe_or_start_ms = started_at_ms` |
| Result | `DuelJoined { duel_id, challenger, started_at_ms }` event |
| Status | ✓ shipped with reveal-prefetch gate + dUSDC manager gate |

---

## Phase 5 — Reveal deck

### `duel::reveal_deck<T>(duel, vector<Card>)`

| Concern | Detail |
|---|---|
| Builder | `buildRevealDeckTx(duelId, cards, type)` — `apps/web/src/lib/flicky.ts:147` |
| Params | `&mut Duel<T>`, `vector<Card>` (length 5, each `{ oracle_id: ID, strike: u64 }`) |
| Permission | permissionless — any address can call |
| Move guards | `EDuelNotActive` if status ≠ ACTIVE · `EDeckAlreadyRevealed` if cards already non-empty · `EDeckHashMismatch` if `sha2_256(bcs::to_bytes(&cards)) ≠ duel.deck_hash` — `apps/contracts/sources/duel.move::reveal_deck` |
| Callers | keeper auto (primary, `apps/server/src/scripts/keeper.ts::tryReveal`) · player manual fallback button (`apps/web/src/App.tsx::RevealingView`) |
| Plaintext source | fetched from `/deckmaster/reveal?hash=…`. Keeper polls; manual fallback uses same endpoint |
| Result | `DeckRevealed { duel_id }` · `duel.cards` populated |
| Latency | typically < 10 s (keeper poll) · fallback button visible if it sticks |
| Status | ✓ keeper + manual fallback both shipped |

---

## Phase 6 — Swipe (×5 per player)

Each card is one PTB. Order is enforced: player N's i-th swipe must
have `card_idx == p{N}_next_card_idx`.

### Free tier (`Duel<SUI>`) — `record_swipe` only

| Concern | Detail |
|---|---|
| Builder | `buildSwipeTx(duelId, oracleId, cardIdx, isUp, type)` — `apps/web/src/lib/flicky.ts:265` |
| Params on-chain | `&mut Duel<T>`, `&OracleSVI`, `card_idx: u64`, `is_up: bool`, `&Clock`, `&TxContext` |

### Staked tier (`Duel<DUSDC>`) — atomic mint + record_swipe

| Concern | Detail |
|---|---|
| Builder | `buildStakedSwipeTx({ duelId, oracleSviId, managerId, oracleExpiry, strike, isUp, quantity, cardIdx })` — `apps/web/src/lib/deepbook.ts:168` |
| PTB shape | ① `market_key::up/down(oracle, expiry, strike)` → MarketKey · ② `predict::mint<DUSDC>(predict, manager, oracle, mk, quantity)` ← real DeepBook position · ③ `duel::record_swipe<DUSDC>(duel, oracle, card_idx, is_up)` |
| `quantity` formula | `(duel.p0Stake * 2n) / 100n` — 2 % of own stake per card |
| Atomicity | single PTB; abort on any step rolls back all three. DeepBook's `sender == manager.owner` invariant forces the player (not a relayer) to sign |
| UI gate | `managerReady = !!manager && balance >= quantity` — buttons disabled, drag refused, inline amber banner if not ready (`apps/web/src/App.tsx::SwipingView`). The old silent-fallback to plain `buildSwipeTx` for missing manager has been removed (defense in depth: throws clear error) |

### Common (Move side — `duel::record_swipe`)

| Guard | Code |
|---|---|
| Status == ACTIVE | `EDuelNotActive` |
| Sender is creator or challenger | `ENotPlayer` |
| `card_idx == p{0,1}_next_card_idx` | `EOutOfTurn` |
| `now ≤ oracle.expiry` | `EOracleNotLive` |
| oracle matches `duel.cards[card_idx].oracle_id` | `EOracleMismatch` |

Successful effects (`apps/contracts/sources/duel.move::record_swipe`):

- `(premium, _) = predict::get_trade_amounts(predict, oracle, key, quantity, clock)` (asserts `premium > 0`)
- `p_swiped = premium × 1e9 / quantity` (asserts `0 < p_swiped < 1e9`)
- `assert mgr.position(key) >= quantity` (anti-replay — player must have minted in the same PTB)
- `p{N}_swipes[card_idx] = Some(Swipe { is_up, quantity, premium, p_swiped })`
- `p{N}_next_card_idx = card_idx + 1`
- `SwipeRecorded { duel_id, player, card_idx, is_up, quantity, premium, p_swiped }` event

| Status | ✓ shipped with hard gate for dUSDC manager + balance |

---

## Phase 7 — Lockup (wait)

| Concern | Detail |
|---|---|
| Entry | both players have swiped all `deck_size` cards |
| Wait condition | for EACH card: `oracle.settlement_price.is_some()`. Cards on different oracles may satisfy this at different times |
| Latency | DeepBook stops price ticks ~5 s before expiry; publishes `settlement_price` ~ +8 s after expiry. 1/6 testnet samples observed a 10 min outlier |
| UI | `LockupView` — shows per-card settle progress as oracles tick into `Some` |
| Transactions | none from app side (keeper drives `settle_card` as each oracle becomes ready) |
| Status | ✓ wait logic shipped · ◐ per-card UI surfaces via `CardSettled` event stream |

See `docs/oracle-selection.md` § "When does the oracle actually
settle?" for measured latencies.

---

## Phase 8 — Settle + finalize + redeem (single keeper PTB once ready)

The keeper builds one PTB containing all three categories of move calls
once every card's oracle has settled. Settle MUST run before finalize
(finalize reads accumulated `p{0,1}_payout/_premium`), and finalize
MUST run before redeem (redeem zeroes the Predict positions that
`settle_card`'s anti-replay check reads).

### 8a. `duel::settle_card<T>(duel, p0_mgr, p1_mgr, &OracleSVI, card_idx)` × deck_size

| Concern | Detail |
|---|---|
| Caller | keeper (default) — `apps/server/src/scripts/keeper.ts::tryClose` · also exposed in playground / web "Finalize" buttons |
| Move guards | `EDuelNotActive` · `EWrongTier` · `EDeckNotRevealed` · `ECardIndexOOB` · `EAlreadySettled` · `EOracleMismatch` if `oracle_id ≠ duel.cards[card_idx].oracle_id` · `EOracleNotLive` if `settlement_price.is_none()` |
| Per-card oracle | the keeper loops `duel.cards[i].oracle_id` — each card pins its own oracle |
| Anti-replay | `score_swipe` checks `mgr.position(key) < swipe.quantity` ⇒ player redeemed early ⇒ payout = 0 (premium still counts) |
| Effect | `cards_settled[i] = true`, `card_settlement_prices[i] = price`, `settled_count += 1`, accumulates `p{0,1}_payout/_premium` |
| Event | `CardSettled { duel_id, card_idx, oracle_id, settlement_price, actual_up, p0_payout, p0_premium, p1_payout, p1_premium }` |

### 8b. `duel::finalize<T>(duel, clock)` — no oracle args

| Concern | Detail |
|---|---|
| Move guards | `EWrongTier` · `EDuelNotActive` · `EAllCardsNotSettled` if `settled_count ≠ deck_size` (normal path) · `ESwipesNotComplete` if partial swipes + window not expired (refund path) |
| Winner logic | normal: compare `val0 = p0_payout + p1_premium` vs `val1 = p1_payout + p0_premium`; higher takes pot, tie refunds. Forfeit: one side swiped more after 10-min window ⇒ that side wins. Refund: both stuck mid-deck after timeout ⇒ tie refund |
| Effect | pays winner via `Balance.split` + `transfer` · `status = COMPLETE` |
| Event | `DuelFinalized { duel_id, winner, payout_to_p0, payout_to_p1, p0_payout_total, p0_premium_total, p1_payout_total, p1_premium_total, primary_oracle_id, primary_settlement_price }` |

### 8c. `predict::redeem_permissionless<DUSDC>(predict, manager, oracle, key, quantity)` × M

| Concern | Detail |
|---|---|
| Only for | `stake_coin_type == DUSDC` (free tier skipped) |
| M | count of non-null swipes across both players (max `2 × deck_size`) |
| Quantity | matches mint quantity per (player, card), recorded in `Swipe.quantity` |
| Manager discovery | keeper walks `PredictManagerCreated` events filtered by `owner == playerAddress` (same pattern as web `findPredictManager`) |
| Permission | permissionless — keeper signs, but payout goes back to manager owner's balance, not keeper |
| Effect | manager's dUSDC balance ↑ payout amount |
| Status | ✓ shipped — keeper bundles after finalize |

| Status of phase 8 | ✓ all three sub-phases shipped in one keeper PTB |

---

## Phase 8.x — Payout reception

For both tiers, the winner sees the new `Coin<T>` in their wallet on
the next refresh.

For staked tier, the player ALSO receives their Predict positions'
payout into their PredictManager (deposited there by step 8b's
`redeem_permissionless`). They can withdraw via `buildWithdrawDusdcTx`
(builder shipped — `apps/web/src/lib/deepbook.ts:139`) but no UI surfaces
this yet. Players who want to convert dUSDC back to wallet-spendable
balance currently need to issue a withdraw PTB manually.

| Status | ✓ payout received via balanceChanges · ◐ withdraw button missing from UI |

---

## Failure paths + recovery

| Failure | Symptom | Recovery |
|---|---|---|
| Sponsor service down / 503 | tx flow proceeds via `useFlickySign` fallback | wallet-paid gas, no user action needed |
| Keeper offline | duel stuck on RevealingView or LockupView | RevealingView shows manual "reveal now" button after fetching plaintext · LockupView is just waiting — anyone (including the player) can call settle_card + finalize; keeper just hasn't yet |
| Deckmaster server restart with old in-mem store | plaintext lost | mitigated by file persistence at `apps/server/.data/decks.json` · JoinView refuses to join unrevealable duels (404 gate) |
| Player's PredictManager missing / under-funded | swipe would abort `predict::mint` | UI gates at Lobby + JoinView + SwipingView prevent reaching swipe phase · SwipingView's error message tells them to deposit |
| Oracle deactivated between picker and create_duel | `create_duel` succeeds but `record_swipe` aborts `EOracleNotLive` | low-probability race; user retries with fresh oracle via lobby flow |
| Hash mismatch on reveal | `EDeckHashMismatch` abort | unrecoverable for this duel; creator must create a new one. Server's persisted hash → plaintext map means this shouldn't happen for keeper-driven reveals |

---

## What is NOT yet implemented (PRD gap delta)

- ✗ Bot 30 s queue timeout (currently 5 s race-join, no human grace)
- ◐ Matchmaking queue + MMR + tier buckets (basic queue + MMR shipped; tier buckets per PRD spec partial)
- ✗ Lockup phase live oracle ticks + emoji reactions (`/ws` is an echo server)
- ◐ AI Deckmaster v2 — max-amplitude probe + sign-balance shipped (`buildAndProbeDeck`). SVI-informed difficulty split + on-chain-seeded RNG still PRD gaps.
- ✗ Win counter for free tier
- ✓ On-chain forfeit-on-timeout — `claim_reveal_timeout` (5 min, challenger sweeps) + finalize's swipe-window forfeit branch (10 min)
- ◐ zkLogin: Google works; Apple env-gated; no "Sign in with Google" first-class CTA
- ◐ Share card is PNG download only (no `navigator.share`, no OG link)
- ✗ Range cards (`Card` has no `low/high` fields; `score_swipe` only handles directional binaries)
- ◐ PredictManager withdraw button (builder shipped, no UI)

---

## File-by-file reference

| File | Role |
|---|---|
| `apps/contracts/sources/duel.move` | Duel<T> + entry funcs + scoring + tie-break |
| `apps/contracts/tests/duel_tests.move` | 27 Move tests covering full flow + edge cases |
| `apps/web/src/lib/flicky.ts` | Web-side builders + parseDuel + oracle picker + deck hash |
| `apps/web/src/lib/deepbook.ts` | DeepBook Predict integration: manager discovery (event scan + localStorage cache), mint+swipe PTB, deposit, withdraw, redeem builders |
| `apps/web/src/lib/use-flicky-sign.ts` | Sponsor-or-fallback signing entrypoint |
| `apps/web/src/lib/sponsor.ts` | `signAndExecuteWithSponsorOrFallback` core |
| `apps/web/src/App.tsx` | All UI views: Lobby, DepositPanel, JoinView, RevealingView, SwipingView, LockupView, SettlingView, ResultView |
| `apps/server/src/index.ts` | HTTP endpoints (/health, /deckmaster/*, /sponsor) + WS echo (placeholder) |
| `apps/server/src/sponsor.ts` | Enoki sponsor: allowlist + create/execute pair |
| `apps/server/src/deckmaster.ts` | Deck generator + persisted plaintext store |
| `apps/server/src/scripts/keeper.ts` | Reveal + settle + redeem + finalize keeper (auto-started by `bun dev`) |
| `apps/server/src/scripts/bot.ts` | FIFO bot-fill for free-tier duels |
