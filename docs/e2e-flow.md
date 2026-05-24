# End-to-End Flow — params, gates, and what is currently shipped

A duel goes through eight phases between a player opening the lobby and
a winner receiving payout. This doc traces each phase: who acts, what
PTB / endpoint runs, which arguments are passed, what guards exist
on-chain and in the UI, and where the implementation lives.

Read alongside `docs/oracle-selection.md` (which picks the OracleSVI
the duel pins to) and `docs/prd.md` (which states the product
requirements being satisfied).

> **⚠️ Divergence from the current PRD direction.** This doc describes
> the code as **currently shipped**. The locked PRD direction (see
> `docs/prd.md`) has since diverged from it on several mechanics — the
> as-built behavior described below is being replanned to match the
> new spec. Treat sections below as "what the code does today," not
> "what the product is targeting." Key deltas:
>
> - **Stake tiers:** doc reflects 1 / 5 / 10 dUSDC; new spec is **1 / 3 / 5 / 10 dUSDC** (4 tiers), all gated by `PredictManager` balance ≥ 5 dUSDC.
> - **Scoring:** doc describes odds-weighted score (`1/p_swiped × speed_multiplier`) computed in `duel::settle_card` from a snapshotted `p_swiped` + `decide_time_ms`. New spec replaces this with **real PnL** (Σ `predict_redeem − premium_paid`) across the 5 Predict positions. `compute_card_score`, the speed multiplier, and the `Swipe.p_swiped` / `decide_time_ms` fields are legacy.
> - **Card oracles:** doc describes one oracle pinned per duel (`findLatestOracleSvi` → `argmin(expiry)`). New spec picks the **5 nearest oracle resolutions strictly >10 min out**, one per card — each card carries its own expiry. See the banner in `docs/oracle-selection.md`.
> - **Free tier vs Practice:** doc describes a Free PvP tier sharing matchmaking with virtual positions. New spec replaces this with **Practice Mode = solo vs. a bot** (no PvP queue, no on-chain state). The on-chain "free duel" path (`Duel<SUI>`, virtual swipes via `record_swipe`-only) becomes legacy.
> - **Swap module:** new spec adds a fixed-rate **1 SUI ↔ 10 dUSDC** in-app swap (`apps/contracts/sources/swap.move`) backing the Deposit screen. Not yet shipped — this doc's Phase B describes the dUSDC-only top-up path.
> - **Predict Manager bootstrap:** doc treats it as a separate user-initiated step. New spec **sponsors** manager creation on first sign-in (via Enoki + sponsored gas) so the player never signs that tx separately.
> - **Lockup phase:** doc describes a single "wait for `now > oracle.expiry`". New spec waits per-card — `duel::settle_duel` only runs once all 5 cards have settled.
>
> The Duel object's swipe ordering, commit-reveal, escrow / payout half, and the keeper-PTB shape (`settle × 5` + `redeem × N` + `finalize`, all permissionless) all carry forward unchanged.

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
   │ 1. Pick oracle (argmin expiry, headroom ≥ 90 s)            → OracleSVI
   │ 2. Generate deck (POST /deckmaster/generate)              → 5 strikes + hash
   │ 3. duel::create_duel<T>(stake, deck_hash)                 → Duel<T> PENDING
   │
   ▼
[wait]
   │
   │ 4. challenger join_duel<T>(stake)                          → Duel ACTIVE, started_at_ms
   │ 5. keeper reveal_deck<T>(plaintext)                       → cards populated
   │
   ▼
[swipe ×5 each]
   │
   │ 6. record_swipe (free)  OR  mint + record_swipe (staked)
   │    snapshots p_swiped, decide_time_ms                     → SwipeRecorded
   │
   ▼
[lockup]
   │
   │ 7. wait now > oracle.expiry
   │    DeepBook publishes settlement_price (~+8 s after expiry)
   │
   ▼
[settle + finalize + redeem — single keeper PTB]
   │
   │ 8a. settle_card × 5 (one per card.oracle_id)
   │ 8b. predict::redeem_permissionless × N (dUSDC only)
   │ 8c. duel::finalize → status = COMPLETE, payout
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

Published at `0x505cdc9868df09c5a3cbfa469971feb795a17ecd2fec35405dd951e10d624f26`.

| Module · function | Purpose | Side effect |
|---|---|---|
| `duel::create_duel<T>(stake, deck_hash)` | Open a new duel, lock creator's stake, commit deck hash | New `Duel<T>` shared object, status PENDING, escrows `p0_stake: Balance<T>` |
| `duel::join_duel<T>(duel, stake, clock)` | Challenger matches stake | status → ACTIVE, `started_at_ms` set, escrows `p1_stake` |
| `duel::reveal_deck<T>(duel, cards)` | Verify `sha2_256(bcs(cards)) == deck_hash`, populate cards | `duel.cards` filled, anti-front-run gate lifted |
| `duel::record_swipe<T>(duel, oracle, card_idx, is_up, clock)` | Snapshot `p_swiped = pricing::p_up(oracle, strike)` and `decide_time_ms`, store per-player swipe | `Swipe` appended to `p{N}_swipes[card_idx]`, idx pointer advances |
| `duel::settle_card<T>(duel, oracle, card_idx)` | Read `oracle.settlement_price`, compute card scores for both players | `card_settlements[i] = Some(price)`, `settled_count++`, scores ↑ |
| `duel::finalize<T>(duel)` | Determine winner, pay out pot via `Balance.split + transfer` | status → COMPLETE, winner gets `Coin<T>`, tie → refund |
| `duel::new_card(oracle_id, strike, ctx)` | Pure constructor for `Card` struct (used by reveal_deck callers to build the vector) | none — produces value |

**State Flicky stores per `Duel<T>`:**
- `cards: vector<Card>` — { oracle_id, strike } × 5
- `deck_hash: vector<u8>` — sha2-256 commitment
- `p0_stake, p1_stake: Balance<T>` — escrowed pot
- `p0_swipes, p1_swipes: vector<Option<Swipe>>` — { is_up, p_swiped, decide_time_ms }
- `p0_score, p1_score: u64` — 9-decimal fixed-point
- `card_settlements: vector<Option<u64>>` — terminal price per card
- `p{0,1}_last_swipe_or_start_ms: u64` — decide-time baseline
- `p{0,1}_next_card_idx: u64` — turn ordering

**Events Flicky emits:**
- `DuelCreated`, `DuelJoined`, `DeckRevealed`, `SwipeRecorded`, `CardSettled`, `DuelFinalized`

**What Flicky never touches:**
- DeepBook prices, SVI params, settlement_price (only reads via `pricing::p_up` and `oracle.settlement_price()`)
- PredictManager objects — no field references, no calls. Mint payout / redeem flow happens entirely outside the Duel.

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
| Snapshot implied probability | calls `pricing::p_up` | provides `p_up(oracle, strike)` |
| Open binary position | — | `predict::mint` ✓ |
| Score a card | `compute_card_score` (uses snapshot) ✓ | — |
| Decide winner / tie-break | `finalize` ✓ | — |
| Pay out PvP pot | `Balance.split + transfer` ✓ | — |
| Pay out binary position | — | `redeem_permissionless` ✓ |
| Anti-front-run via commit-reveal | `deck_hash` + `reveal_deck` ✓ | — |
| Oracle lifecycle (active, settle) | — | cron at `:00/:15/:30/:45` ✓ |

### Why this separation matters

- **Predict's mint invariant** (`sender == owner`) is why staked swipes must be player-signed PTBs — Flicky can't route mint through a keeper or shared bot wallet.
- **Flicky never references PredictManager** — so a player who never created one can still play free tier; and a player whose manager runs out of balance only breaks staked, not free.
- **Settlement timing is DeepBook's contract, not Flicky's** — the keeper waits for `settlement_price` to be `Some`, then runs Flicky's `settle_card` (which reads that price) + DeepBook's `redeem_permissionless` (which pays the position) in one PTB.

### Typical staked-swipe PTB (composition of both)

```text
PTB[
  market_key::up(oracle, expiry, strike)           ─┐  DeepBook
  predict::mint<DUSDC>(predict, manager, oracle, mk, qty)  ─┤  DeepBook
  duel::record_swipe<DUSDC>(duel, oracle, idx, is_up)  ─┤  Flicky
]                                                  ─┘
  ↑
  signed once by player
  atomic: any abort rolls back all three
```

### Typical settle PTB (composition of both)

```text
PTB[
  duel::settle_card<DUSDC>(duel, oracle, 0)        ─┐
  duel::settle_card<DUSDC>(duel, oracle, 1)        ─┤  Flicky × 5
  ...                                              ─┤
  duel::settle_card<DUSDC>(duel, oracle, 4)        ─┘
  market_key::up(oracle, expiry, strike_for_swipe) ─┐
  predict::redeem_permissionless<DUSDC>(predict, mgr_p0, oracle, mk, qty)  ─┤  DeepBook × N
  ...                                              ─┘  (N swipes total)
  duel::finalize<DUSDC>(duel)                      ─── Flicky
]
  ↑
  signed by keeper (any wallet — permissionless on both sides)
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

- `p_swiped = pricing::p_up(oracle, strike)` if `is_up`, else `1e9 − p_up`
- `decide_time_ms = max(0, now − baseline)` where `baseline = p{N}_last_swipe_or_start_ms`
- `p{N}_swipes[card_idx] = Some(Swipe { is_up, p_swiped, decide_time_ms })`
- `p{N}_next_card_idx += 1`
- `p{N}_last_swipe_or_start_ms = now`
- `SwipeRecorded { duel_id, player, card_idx, is_up, p_swiped, decide_time_ms }` event

| Status | ✓ shipped with hard gate for dUSDC manager + balance |

---

## Phase 7 — Lockup (wait)

| Concern | Detail |
|---|---|
| Entry | both players have swiped all 5 cards (or one is stuck — see PRD gap "forfeit on timeout") |
| Wait condition | `now > oracle.expiry` AND `oracle.settlement_price.is_some()` |
| Latency | DeepBook stops price ticks ~5 s before expiry; publishes `settlement_price` ~ +8 s after expiry. 1/6 testnet samples observed a 10 min outlier |
| UI | `LockupView` — static "🔒 watching the oracle tick toward settlement…" |
| Transactions | none from app side |
| Status | ✓ wait logic shipped · ✗ no live oracle tick streaming (PRD gap §Lockup) |

See `docs/oracle-selection.md` § "When does the oracle actually
settle?" for measured latencies.

---

## Phase 8 — Settle + redeem + finalize (single keeper PTB)

The keeper bundles three categories of move calls into one PTB to
minimise round-trips and avoid partial state.

### 8a. `duel::settle_card<T>(duel, &OracleSVI, card_idx)` × 5

| Concern | Detail |
|---|---|
| Caller | keeper (default) — `apps/server/src/scripts/keeper.ts::tryClose` |
| Move guards | `EDuelNotActive` · `EOracleNotSettled` if `oracle.settlement_price.is_none()` · `EOracleMismatch` if oracle id ≠ `duel.cards[card_idx].oracle_id` · `ECardAlreadySettled` |
| Per-card oracle | the keeper loops `duel.cards[i].oracle_id` (multi-oracle aware — see `oracle-selection.md`). Today's Deckmaster picks a single oracle for all 5 cards but the path no longer hardcodes that |
| Effect | `card_settlements[i] = Some(settlement_price)` · `settled_count += 1` · awards `card_score_from_swipe(p_swiped, decide_time_ms)` if direction correct, else 0 |
| Event | `CardSettled { duel_id, card_idx, settlement_price, p0_card_score, p1_card_score }` |

### 8b. `predict::redeem_permissionless<DUSDC>(predict, manager, oracle, key, quantity)` × N

| Concern | Detail |
|---|---|
| Only for | `stake_coin_type == DUSDC` (free tier skipped) |
| N | count of non-null swipes across both players (max 10 if both swiped all 5) |
| Quantity | matches mint quantity per (player, card) — `(playerStake × 2n) / 100n` |
| Manager discovery | keeper walks `PredictManagerCreated` events filtered by `owner == playerAddress` (same pattern as web `findPredictManager`) |
| Permission | permissionless — keeper signs, but payout goes back to manager owner's balance, not keeper |
| Effect | manager's dUSDC balance ↑ payout amount |
| Status | ✓ shipped — keeper-redeem block was the missing piece flagged in earlier audit |

### 8c. `duel::finalize<T>(duel)`

| Concern | Detail |
|---|---|
| Move guards | `EAllCardsNotSettled` if `settled_count ≠ 5` · `EDuelAlreadyFinalized` |
| Winner logic | higher score wins · score-tied ⇒ lower `total_decide_time` wins (with `None` swipes contributing the slow-cap to defeat skip-grief — see [tie-break fix](../apps/contracts/sources/duel.move)) · time-tied ⇒ each refunded own stake |
| Effect | pays winner via `Balance.split` + `transfer` · `status = COMPLETE` |
| Event | `DuelFinalized { duel_id, p0_score, p1_score, winner, payout_to_p0, payout_to_p1 }` |

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

Tracked in detail in the prior audit (`Lobby` chat). Brief list:

- ✗ Bot 30 s queue timeout (currently 5 s race-join, no human grace)
- ✗ Matchmaking queue + MMR + tier buckets
- ✗ Lockup phase live oracle ticks + emoji reactions (`/ws` is an echo server)
- ✗ AI Deckmaster v2 (SVI-informed, 2/2/1 difficulty split, on-chain-seeded RNG, template selection)
- ✗ Win counter for free tier
- ✗ On-chain forfeit-on-timeout (currently relies on oracle expiry to bound stalls)
- ◐ zkLogin: Google works; Apple env-gated; no "Sign in with Google" first-class CTA
- ◐ Share card is PNG download only (no `navigator.share`, no OG link)
- ✗ Range cards (Card has no `low/high` fields; `compute_card_score` only handles directional binaries)
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
