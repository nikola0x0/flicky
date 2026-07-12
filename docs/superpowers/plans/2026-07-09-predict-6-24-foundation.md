# Predict 6-24 Migration — Plan 1: Contract Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite flicky's `duel.move` and its Move-link stubs from DeepBook Predict `4-16` (`OracleSVI`/`PredictManager`) to `6-24` (`ExpiryMarket`/`account::AccountWrapper`), get the Move test suite green, publish a fresh package to testnet, and regenerate the `flicky` TS bindings.

**Architecture:** After migration, `duel.move`'s on-chain DeepBook surface shrinks to exactly two calls — `account::account::load_account(&AccountWrapper): &Account` and `deepbook_predict::predict_account::has_position(&Account, expiry_market_id: ID, order_id: u256): bool` — used only for settle-time anti-replay. Minting, pricing, and settlement price all move off-chain / keeper-fed: `record_swipe` stores the `order_id: u256` returned by the mint (chained in the same player-signed PTB), and `settle_card` receives `settlement_price` and per-player `premium` as keeper-fed arguments. Scoring stays on-chain and deterministic.

**Tech Stack:** Move 2024 (Sui), Bun, `@mysten/codegen` (`sui-ts-codegen`), `@mysten/sui`. Sui CLI toolchain `1.64.0`, testnet framework rev `367fd808279bed26f7c64fc63160062a2ee29ab7`.

## Global Constraints

- Use `bun` (≥ 1.3.9) only; never `npm`/`pnpm`/`yarn`.
- Move edition `2024`; file-scoped module syntax (`module flicky::duel;`, no braces).
- Prettier for TS scripts: no semicolons, double quotes, 2-space, trailing comma `es5`, print width 80.
- Stub pattern (load-bearing): each stub package compiles a LOCAL body but its `Move.toml` `published-at` = the REAL on-chain 6-24 package id, so on-chain dispatch hits the genuine package while `sui move test` runs the local stub bodies.
- 6-24 IDs are testnet-provisional. Values used here are from `temp/deepbookv3` (`FETCH_HEAD` = `origin/predict-testnet-6-24`), file `packages/predict/deployment/deployment.testnet.json`. Re-verify before publishing.
- Scoring is **quantity-based** (NOT `1/p_swiped`): `payout = correct ? quantity : 0`; `premium` counts toward the opponent's value in the winner decision. `p_swiped` is NOT used in on-chain math (was informational only) and is dropped on-chain.
- Work happens on branch `feat/predict-6-24-migration` (already checked out).
- 6-24 package ids: predict `0xdb3ef5a5129920e59c9b2ae25a77eddb48acd0e1c6307b97073f0e076016446e`, account `0xb9389eac8d59170ffd1427c1a66e5c8306263464fcc6615e825c1f5b3e15da3b`.

**Scope note:** This plan delivers the *contract*. It intentionally leaves `apps/web` typecheck RED (web still imports the old `gen/deepbook_predict/predict` surface) — Plan 3 fixes the web. Verification here is scoped to `apps/contracts` (`sui move test` + contracts `tsc`). Plans 2 (server), 3 (web), 4 (E2E) follow and are authored after this lands.

---

## File structure

- `apps/contracts/account_min/` — NEW stub for the `account` package (`AccountWrapper`, `Account`, `load_account`, test helpers). Published-at = account pkg id.
- `apps/contracts/deepbook_predict_min/` — REPLACED: 6-24 stub exposing `predict_account::has_position` (delegates to the account stub). Published-at = 6-24 predict pkg id. Old modules (`predict`, `oracle`, `predict_manager`, `market_key`, `range_key`, `i64`) removed.
- `apps/contracts/deepbook_min/`, `apps/contracts/token_min/` — DELETED (no longer linked; `dummy_deps` anchor removed).
- `apps/contracts/Move.toml` — deps swapped: `account` + `deepbook_predict` only.
- `apps/contracts/sources/duel.move` — rewritten data model + settle/swipe surface.
- `apps/contracts/tests/duel_tests.move` — ported to the 6-24 stubs.
- `apps/contracts/sui-codegen.config.ts` — codegen packages updated.
- `apps/contracts/deployed.json`, `apps/web/.env.local`, `apps/web/src/lib/config.ts` — reconcile flicky package id (address-drift fix).

---

## Task 1: 6-24 Move-link stubs (`account_min` + `deepbook_predict_min`)

**Files:**
- Create: `apps/contracts/account_min/Move.toml`
- Create: `apps/contracts/account_min/sources/account.move`
- Delete then recreate: `apps/contracts/deepbook_predict_min/Move.toml`
- Create: `apps/contracts/deepbook_predict_min/sources/predict_account.move`
- Delete: `apps/contracts/deepbook_predict_min/sources/{predict,oracle,predict_manager,market_key,range_key,i64}.move`

**Interfaces:**
- Produces (account stub, module `account::account`):
  - `public struct AccountWrapper has key`
  - `public struct Account has store`
  - `public fun load_account(self: &AccountWrapper): &Account`
  - `public fun owner(self: &Account): address`
  - `public fun contains_position(self: &Account, expiry_market_id: ID, order_id: u256): bool`
  - `#[test_only] public fun new_wrapper_for_testing(owner: address, ctx: &mut TxContext): AccountWrapper`
  - `#[test_only] public fun share_for_testing(w: AccountWrapper)`
  - `#[test_only] public fun add_position_for_testing(w: &mut AccountWrapper, expiry_market_id: ID, order_id: u256)`
- Produces (predict stub, module `deepbook_predict::predict_account`):
  - `public fun has_position(account: &Account, expiry_market_id: ID, order_id: u256): bool`

- [ ] **Step 1: Create the account stub Move.toml**

Create `apps/contracts/account_min/Move.toml`:
```toml
[package]
name = "account"
edition = "2024"
published-at = "0xb9389eac8d59170ffd1427c1a66e5c8306263464fcc6615e825c1f5b3e15da3b"

[dependencies]

[addresses]
account = "0xb9389eac8d59170ffd1427c1a66e5c8306263464fcc6615e825c1f5b3e15da3b"

[dev-dependencies]

[dev-addresses]
```

- [ ] **Step 2: Create the account stub source**

Create `apps/contracts/account_min/sources/account.move`:
```move
/// Local link stub for the on-chain `account` package
/// (0xb9389eac...15da3b, predict-testnet-6-24). Only the surface flicky
/// calls on-chain is stubbed: `load_account` + a position set for
/// anti-replay reads. Bodies are local test math; on-chain dispatch hits
/// the real package via `published-at`.
module account::account;

use sui::vec_set::{Self, VecSet};

public struct PosId has copy, drop, store {
    expiry_market_id: ID,
    order_id: u256,
}

public struct Account has store {
    owner: address,
    positions: VecSet<PosId>,
}

public struct AccountWrapper has key {
    id: UID,
    account: Account,
}

public fun load_account(self: &AccountWrapper): &Account {
    &self.account
}

public fun owner(self: &Account): address {
    self.owner
}

/// Stub of the real package's position-membership read. In the real
/// package this walks the attached PredictApp data; here it reads the
/// locally-seeded set so tests can drive anti-replay.
public fun contains_position(self: &Account, expiry_market_id: ID, order_id: u256): bool {
    self.positions.contains(&PosId { expiry_market_id, order_id })
}

#[test_only]
public fun new_wrapper_for_testing(owner: address, ctx: &mut TxContext): AccountWrapper {
    AccountWrapper {
        id: object::new(ctx),
        account: Account { owner, positions: vec_set::empty() },
    }
}

#[test_only]
public fun share_for_testing(w: AccountWrapper) {
    transfer::share_object(w);
}

#[test_only]
public fun add_position_for_testing(
    w: &mut AccountWrapper,
    expiry_market_id: ID,
    order_id: u256,
) {
    w.account.positions.insert(PosId { expiry_market_id, order_id });
}
```

- [ ] **Step 3: Remove the old 4-16 predict stub modules**

Run:
```bash
cd /Users/alvin/Developer/sui-flow/flicky/apps/contracts
rm deepbook_predict_min/sources/predict.move \
   deepbook_predict_min/sources/oracle.move \
   deepbook_predict_min/sources/predict_manager.move \
   deepbook_predict_min/sources/market_key.move \
   deepbook_predict_min/sources/range_key.move \
   deepbook_predict_min/sources/i64.move
rm -rf deepbook_predict_min/build
```
Expected: files removed; only the new `predict_account.move` (next step) remains in `sources/`.

- [ ] **Step 4: Rewrite the predict stub Move.toml to 6-24**

Overwrite `apps/contracts/deepbook_predict_min/Move.toml`:
```toml
[package]
name = "deepbook_predict"
edition = "2024"
published-at = "0xdb3ef5a5129920e59c9b2ae25a77eddb48acd0e1c6307b97073f0e076016446e"

[dependencies]
account = { local = "../account_min" }

[addresses]
deepbook_predict = "0xdb3ef5a5129920e59c9b2ae25a77eddb48acd0e1c6307b97073f0e076016446e"

[dev-dependencies]

[dev-addresses]
```

- [ ] **Step 5: Create the predict_account stub source**

Create `apps/contracts/deepbook_predict_min/sources/predict_account.move`:
```move
/// Local link stub for `deepbook_predict::predict_account`
/// (0xdb3ef5a5...446e, predict-testnet-6-24). flicky's only on-chain call
/// into the predict package is `has_position` for settle-time anti-replay.
module deepbook_predict::predict_account;

use account::account::{Self, Account};

/// True iff the account still holds the open position `(expiry_market_id,
/// order_id)`. In the real package this reads the account's PredictApp
/// position table; here it delegates to the account stub's seeded set.
public fun has_position(account: &Account, expiry_market_id: ID, order_id: u256): bool {
    account::contains_position(account, expiry_market_id, order_id)
}
```

- [ ] **Step 6: Build both stubs in isolation to verify they compile**

Run:
```bash
cd /Users/alvin/Developer/sui-flow/flicky/apps/contracts/account_min && sui move build
cd /Users/alvin/Developer/sui-flow/flicky/apps/contracts/deepbook_predict_min && sui move build
```
Expected: both `BUILDING`/`Success` with no errors (deepbook_predict_min resolves the local `account` dep).

- [ ] **Step 7: Commit**

```bash
cd /Users/alvin/Developer/sui-flow/flicky
git add apps/contracts/account_min apps/contracts/deepbook_predict_min
git commit -m "feat(contracts): 6-24 account + predict_account link stubs"
```

---

## Task 2: Swap root `Move.toml` dependencies

**Files:**
- Modify: `apps/contracts/Move.toml`
- Delete: `apps/contracts/deepbook_min/`, `apps/contracts/token_min/`

**Interfaces:**
- Consumes: the stubs from Task 1.
- Produces: a flicky package that links only `account` + `deepbook_predict`.

- [ ] **Step 1: Overwrite `apps/contracts/Move.toml`**

```toml
[package]
name = "flicky"
edition = "2024"
license = "Apache-2.0"
authors = ["Flicky Labs <lequocuyit@gmail.com>"]

[dependencies]
deepbook_predict = { local = "./deepbook_predict_min" }
account = { local = "./account_min" }

[addresses]
flicky = "0x0"

[dev-dependencies]

[dev-addresses]
```

- [ ] **Step 2: Remove the now-unused transitive stubs**

Run:
```bash
cd /Users/alvin/Developer/sui-flow/flicky/apps/contracts
rm -rf deepbook_min token_min build
```
Expected: dirs removed. (`deepbook_min`/`token_min` only existed for the old `dummy_deps` linkage anchor, which Task 3 deletes.)

- [ ] **Step 3: Commit**

```bash
cd /Users/alvin/Developer/sui-flow/flicky
git add apps/contracts/Move.toml apps/contracts/deepbook_min apps/contracts/token_min
git commit -m "feat(contracts): point flicky deps at 6-24 stubs, drop deepbook/token stubs"
```

---

## Task 3: Rewrite `duel.move` data model + swipe/settle surface

This task edits one file so the whole module must compile together. Each step is a focused edit; the build runs at the end (Step 13). Do the edits in order.

**Files:**
- Modify: `apps/contracts/sources/duel.move`

**Interfaces:**
- Consumes: `account::account::{load_account, owner, AccountWrapper, Account}`, `deepbook_predict::predict_account::has_position` (Task 1).
- Produces (new public surface downstream plans rely on):
  - `public fun new_card(expiry_market_id: ID, strike: u64): Card`
  - `public fun card_expiry_market_id(card: &Card): ID`
  - `public fun card_strike(card: &Card): u64`
  - `public fun record_swipe<T>(duel: &mut Duel<T>, card_idx: u64, is_up: bool, quantity: u64, order_id: u256, clock: &Clock, ctx: &TxContext)`
  - `public fun record_swipe_free<T>(duel: &mut Duel<T>, card_idx: u64, is_up: bool, clock: &Clock, ctx: &TxContext)`
  - `public fun settle_card<T>(duel: &mut Duel<T>, p0_wrapper: &AccountWrapper, p1_wrapper: &AccountWrapper, card_idx: u64, settlement_price: u64, p0_premium: u64, p1_premium: u64)`
  - `public fun settle_card_free<T>(duel: &mut Duel<T>, card_idx: u64, settlement_price: u64, p0_premium: u64, p1_premium: u64)`
  - `public fun finalize_test_one_price<T>(duel: &mut Duel<T>, price: u64, clock: &Clock, ctx: &mut TxContext)`
  - `Swipe { is_up: bool, quantity: u64, order_id: u256 }`, `Card { expiry_market_id: ID, strike: u64 }`
  - Unchanged: `create_duel*`, `join_duel*`, `reveal_deck`, `finalize*`, `refund_duel`, `claim_reveal_timeout`, all read accessors.

- [ ] **Step 1: Replace the `use` import block (lines 37–48)**

Replace:
```move
use deepbook_predict::oracle::{Self as db_oracle, OracleSVI};
use deepbook_predict::predict::{Self as db_predict, Predict};
use deepbook_predict::predict_manager::{Self, PredictManager};
use deepbook_predict::market_key;
use sui::balance::{Self, Balance};
use deepbook::constants as db_constants;
use token::deep::DEEP;
use sui::bcs;
use std::hash;
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::event;
```
with:
```move
use account::account::{Self as acct, AccountWrapper};
use deepbook_predict::predict_account;
use sui::balance::{Self, Balance};
use sui::bcs;
use std::hash;
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::event;
```

- [ ] **Step 2: Rewrite the `Card` struct (lines 106–109)**

Replace:
```move
public struct Card has copy, drop, store {
    oracle_id: ID,
    strike: u64,
}
```
with:
```move
public struct Card has copy, drop, store {
    /// The 6-24 `ExpiryMarket` this card is bet on. Passed in at reveal
    /// (committed via the deck hash), used for settle-time anti-replay.
    expiry_market_id: ID,
    /// Raw strike price (`tick * tick_size`). `actual_up = settlement_price > strike`.
    strike: u64,
}
```

- [ ] **Step 3: Rewrite the `Swipe` struct (lines 111–118)**

Replace:
```move
public struct Swipe has copy, drop, store {
    is_up: bool,
    quantity: u64,
    premium: u64,
    /// Probability of the swiped direction, snapshotted from the oracle SVI
    /// surface inside the swipe PTB. Scaled by `PROB_SCALE` (1e9).
    p_swiped: u64,
}
```
with:
```move
public struct Swipe has copy, drop, store {
    is_up: bool,
    quantity: u64,
    /// The `order_id` returned by `expiry_market::mint_exact_quantity`,
    /// chained from the mint command in the same player-signed PTB. Used at
    /// settle time for anti-replay via `predict_account::has_position`.
    /// `0` for free-tier swipes (no mint).
    order_id: u256,
}
```

- [ ] **Step 4: Rewrite the `SwipeRecorded` event (lines 179–187)**

Replace:
```move
public struct SwipeRecorded has copy, drop {
    duel_id: ID,
    player: address,
    card_idx: u64,
    is_up: bool,
    quantity: u64,
    premium: u64,
    p_swiped: u64,
}
```
with:
```move
public struct SwipeRecorded has copy, drop {
    duel_id: ID,
    player: address,
    card_idx: u64,
    is_up: bool,
    quantity: u64,
    order_id: u256,
}
```

- [ ] **Step 5: Rewrite the `CardSettled` event (lines 193–203)**

Replace the `oracle_id: ID,` field with `expiry_market_id: ID,`:
```move
public struct CardSettled has copy, drop {
    duel_id: ID,
    card_idx: u64,
    expiry_market_id: ID,
    settlement_price: u64,
    actual_up: bool,
    p0_payout: u64,
    p0_premium: u64,
    p1_payout: u64,
    p1_premium: u64,
}
```

- [ ] **Step 6: Rewrite the `DuelFinalized` event (lines 210–221)**

Rename `primary_oracle_id` → `primary_expiry_market_id`:
```move
public struct DuelFinalized has copy, drop {
    duel_id: ID,
    winner: address, // @0x0 == tie
    payout_to_p0: u64,
    payout_to_p1: u64,
    p0_payout_total: u64,
    p0_premium_total: u64,
    p1_payout_total: u64,
    p1_premium_total: u64,
    primary_expiry_market_id: ID,
    primary_settlement_price: u64,
}
```

- [ ] **Step 7: Rewrite `new_card` + card accessors (lines 242–248)**

Replace:
```move
public fun new_card(oracle: &OracleSVI, strike: u64): Card {
    Card { oracle_id: db_oracle::id(oracle), strike }
}

public fun card_oracle_id(card: &Card): ID { card.oracle_id }

public fun card_strike(card: &Card): u64 { card.strike }
```
with:
```move
public fun new_card(expiry_market_id: ID, strike: u64): Card {
    Card { expiry_market_id, strike }
}

public fun card_expiry_market_id(card: &Card): ID { card.expiry_market_id }

public fun card_strike(card: &Card): u64 { card.strike }
```

- [ ] **Step 8: Rewrite `record_swipe`, `record_swipe_free`, `preflight_swipe`; delete `derive_p_swiped`; rewrite `record_swipe_internal` (lines 400–530)**

Replace the whole block (from the doc-comment above `record_swipe` through the end of `record_swipe_internal`) with:
```move
/// Record a player's swipe on `card_idx`. `order_id` is the id returned by
/// `expiry_market::mint_exact_quantity`, chained from the mint command in
/// the SAME player-signed PTB — so a genuine mint backs every staked swipe.
/// Premium/p_swiped are no longer snapshotted here (6-24 exposes no public
/// on-chain quote); premium is keeper-fed at settle time.
public fun record_swipe<T>(
    duel: &mut Duel<T>,
    card_idx: u64,
    is_up: bool,
    quantity: u64,
    order_id: u256,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(duel.tier == TIER_STAKED, EWrongTier);
    assert!(quantity > 0, EZeroQuantity);
    let sender = ctx.sender();
    preflight_swipe(duel, card_idx, clock, sender);
    record_swipe_internal(duel, card_idx, is_up, quantity, order_id, sender);
}

/// Free-tier swipe — no mint, no anti-replay. Normalized quantity =
/// `PROB_SCALE`, `order_id = 0`.
public fun record_swipe_free<T>(
    duel: &mut Duel<T>,
    card_idx: u64,
    is_up: bool,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(duel.tier == TIER_FREE, EWrongTier);
    let sender = ctx.sender();
    preflight_swipe(duel, card_idx, clock, sender);
    record_swipe_internal(duel, card_idx, is_up, PROB_SCALE, 0, sender);
}

/// Common pre-flight checks: duel active, deck revealed, in-window, in-turn.
fun preflight_swipe<T>(
    duel: &Duel<T>,
    card_idx: u64,
    clock: &Clock,
    sender: address,
) {
    assert!(duel.status == STATUS_ACTIVE, EDuelNotActive);
    assert!(!duel.cards.is_empty(), EDeckNotRevealed);
    assert!(card_idx < duel.deck_size, ECardIndexOOB);
    assert!(clock.timestamp_ms() <= duel.started_at_ms + SWIPE_WINDOW_MS, ESwipeTimeout);

    let is_p0 = sender == duel.creator;
    let is_p1 = sender == duel.challenger;
    assert!(is_p0 || is_p1, ENotPlayer);

    let next_idx = if (is_p0) duel.p0_next_card_idx else duel.p1_next_card_idx;
    assert!(card_idx == next_idx, EOutOfTurn);
}

fun record_swipe_internal<T>(
    duel: &mut Duel<T>,
    card_idx: u64,
    is_up: bool,
    quantity: u64,
    order_id: u256,
    sender: address,
) {
    let is_p0 = sender == duel.creator;
    let swipe = Swipe { is_up, quantity, order_id };
    if (is_p0) {
        *vector::borrow_mut(&mut duel.p0_swipes, card_idx) = option::some(swipe);
        duel.p0_next_card_idx = card_idx + 1;
    } else {
        *vector::borrow_mut(&mut duel.p1_swipes, card_idx) = option::some(swipe);
        duel.p1_next_card_idx = card_idx + 1;
    };

    event::emit(SwipeRecorded {
        duel_id: object::id(duel),
        player: sender,
        card_idx,
        is_up,
        quantity,
        order_id,
    });
}
```

- [ ] **Step 9: Rewrite `settle_card`, `settle_card_free`, `preflight_settle`, `score_staked_card`, `score_free_card` (lines 544–632)**

Replace that block with:
```move
/// Settle one card. `settlement_price` (keeper-fed from the `MarketSettled`
/// event) and per-player `premium` (keeper-fed from `OrderMinted`) are
/// supplied as arguments — 6-24 exposes no public on-chain read for either.
/// Scores both players' swipes (UP wins if `settlement_price > strike`) and
/// accumulates payout/premium onto the duel. Idempotent via
/// `cards_settled[card_idx]`. Anti-replay: `predict_account::has_position`
/// on each player's `AccountWrapper` — a player who redeemed their 6-24
/// position before settle has their payout zeroed (premium still counts).
public fun settle_card<T>(
    duel: &mut Duel<T>,
    p0_wrapper: &AccountWrapper,
    p1_wrapper: &AccountWrapper,
    card_idx: u64,
    settlement_price: u64,
    p0_premium: u64,
    p1_premium: u64,
) {
    assert!(duel.tier == TIER_STAKED, EWrongTier);
    let (card, actual_up) = preflight_settle(duel, card_idx, settlement_price);
    let p0_pay = score_staked_card(&duel.p0_swipes, p0_wrapper, card, card_idx, actual_up);
    let p1_pay = score_staked_card(&duel.p1_swipes, p1_wrapper, card, card_idx, actual_up);
    let p0_prem = if (duel.p0_swipes[card_idx].is_some()) p0_premium else 0;
    let p1_prem = if (duel.p1_swipes[card_idx].is_some()) p1_premium else 0;
    commit_card_settlement(
        duel, card_idx, settlement_price, card.expiry_market_id, actual_up,
        p0_pay, p0_prem, p1_pay, p1_prem,
    );
}

/// Per-card settle for Free tier. No AccountWrapper / anti-replay (free
/// swipes never minted). `premium` values are keeper-computed notionals.
public fun settle_card_free<T>(
    duel: &mut Duel<T>,
    card_idx: u64,
    settlement_price: u64,
    p0_premium: u64,
    p1_premium: u64,
) {
    assert!(duel.tier == TIER_FREE, EWrongTier);
    let (card, actual_up) = preflight_settle(duel, card_idx, settlement_price);
    let p0_pay = score_free_card(&duel.p0_swipes, card_idx, actual_up);
    let p1_pay = score_free_card(&duel.p1_swipes, card_idx, actual_up);
    let p0_prem = if (duel.p0_swipes[card_idx].is_some()) p0_premium else 0;
    let p1_prem = if (duel.p1_swipes[card_idx].is_some()) p1_premium else 0;
    commit_card_settlement(
        duel, card_idx, settlement_price, card.expiry_market_id, actual_up,
        p0_pay, p0_prem, p1_pay, p1_prem,
    );
}

/// Common pre-flight for both settle variants. Returns the card and whether
/// UP won. `settlement_price` is the keeper-fed argument (0 is rejected).
fun preflight_settle<T>(
    duel: &Duel<T>,
    card_idx: u64,
    settlement_price: u64,
): (Card, bool) {
    assert!(duel.status == STATUS_ACTIVE, EDuelNotActive);
    assert!(!duel.cards.is_empty(), EDeckNotRevealed);
    assert!(card_idx < duel.deck_size, ECardIndexOOB);
    assert!(!*vector::borrow(&duel.cards_settled, card_idx), EAlreadySettled);
    assert!(settlement_price > 0, EZeroSettlement);

    let card = duel.cards[card_idx];
    let actual_up = settlement_price > card.strike;
    (card, actual_up)
}

/// Score one player's swipe on a single card. Anti-replay: if the account no
/// longer holds the position (`!has_position`), the swipe is treated as
/// redeemed-early and pays 0. Returns payout only; premium is keeper-fed.
fun score_staked_card(
    swipes: &vector<Option<Swipe>>,
    wrapper: &AccountWrapper,
    card: Card,
    card_idx: u64,
    actual_up: bool,
): u64 {
    let slot = vector::borrow(swipes, card_idx);
    if (slot.is_none()) return 0;
    let swipe = *slot.borrow();
    let account = acct::load_account(wrapper);
    let has_redeemed_early =
        !predict_account::has_position(account, card.expiry_market_id, swipe.order_id);
    score_payout(&swipe, actual_up, has_redeemed_early)
}

/// Free-tier scorer — no wrapper, no anti-replay.
fun score_free_card(
    swipes: &vector<Option<Swipe>>,
    card_idx: u64,
    actual_up: bool,
): u64 {
    let slot = vector::borrow(swipes, card_idx);
    if (slot.is_none()) return 0;
    let swipe = *slot.borrow();
    score_payout(&swipe, actual_up, false)
}
```

- [ ] **Step 10: Rewrite `commit_card_settlement` + `score_swipe` (lines 636–671)**

Replace that block with:
```move
/// Apply a per-card settle to the duel + emit the proof event. Shared
/// between `settle_card`, `settle_card_free`, and `finalize_test_one_price`.
fun commit_card_settlement<T>(
    duel: &mut Duel<T>,
    card_idx: u64,
    settlement_price: u64,
    expiry_market_id: ID,
    actual_up: bool,
    p0_pay: u64,
    p0_prem: u64,
    p1_pay: u64,
    p1_prem: u64,
) {
    duel.p0_payout = duel.p0_payout + p0_pay;
    duel.p0_premium = duel.p0_premium + p0_prem;
    duel.p1_payout = duel.p1_payout + p1_pay;
    duel.p1_premium = duel.p1_premium + p1_prem;
    *vector::borrow_mut(&mut duel.cards_settled, card_idx) = true;
    *vector::borrow_mut(&mut duel.card_settlement_prices, card_idx) = settlement_price;
    duel.settled_count = duel.settled_count + 1;
    event::emit(CardSettled {
        duel_id: object::id(duel),
        card_idx,
        expiry_market_id,
        settlement_price,
        actual_up,
        p0_payout: p0_pay,
        p0_premium: p0_prem,
        p1_payout: p1_pay,
        p1_premium: p1_prem,
    });
}

/// Payout for one swipe: `quantity` if the direction matched the outcome and
/// the position wasn't redeemed early, else 0.
fun score_payout(swipe: &Swipe, actual_up: bool, has_redeemed_early: bool): u64 {
    let correct = !has_redeemed_early && (actual_up == swipe.is_up);
    if (correct) swipe.quantity else 0
}
```

- [ ] **Step 11: Rewrite `finalize_test_one_oracle` → `finalize_test_one_price` (lines 702–732)**

Replace the whole `finalize_test_one_oracle` function (doc-comment through closing brace) with:
```move
/// **TEST/DEV ONLY** — settle every still-unsettled card against ONE fed
/// `price` (free-style scoring: no anti-replay, premium 0), then finalize.
/// PnL is approximate — never use on mainnet.
public fun finalize_test_one_price<T>(
    duel: &mut Duel<T>,
    price: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(duel.status == STATUS_ACTIVE, EDuelNotActive);
    assert!(!duel.cards.is_empty(), EDeckNotRevealed);
    assert!(price > 0, EZeroSettlement);
    let mut i = 0;
    while (i < duel.deck_size) {
        if (!*vector::borrow(&duel.cards_settled, i)) {
            let card = duel.cards[i];
            let actual_up = price > card.strike;
            let p0_pay = score_free_card(&duel.p0_swipes, i, actual_up);
            let p1_pay = score_free_card(&duel.p1_swipes, i, actual_up);
            commit_card_settlement(
                duel, i, price, card.expiry_market_id, actual_up,
                p0_pay, 0, p1_pay, 0,
            );
        };
        i = i + 1;
    };
    finalize_internal<T>(duel, clock, ctx);
}
```

- [ ] **Step 12: Update `finalize_internal`'s `DuelFinalized` emit + delete `dummy_deps`**

In `finalize_internal` (around line 780–800), find where `DuelFinalized` is emitted and rename the field `primary_oracle_id:` to `primary_expiry_market_id:`. The value expression that reads card 0 currently uses `duel.cards[0].oracle_id` (or a settled snapshot) — change `.oracle_id` to `.expiry_market_id`. (Read the exact emit block in the file; there is one `DuelFinalized {` construction inside `finalize_internal`.)

Then delete the linkage anchor at the end of the file (lines ~959–961):
```move
public fun dummy_deps(_deep: &DEEP) {
    db_constants::float_scaling();
}
```
(Both `account` and `deepbook_predict` are now genuine deps referenced by `settle_card`, so no anchor is needed.)

- [ ] **Step 13: Fix error-code constants (lines 51–82)**

Remove the now-unused codes and add one new code. Delete these lines:
```move
const EOracleMismatch: u64 = 8;
const EOracleNotLive: u64 = 14;
const ENotManagerOwner: u64 = 19;
const EInsufficientPosition: u64 = 20;
const EZeroPremium: u64 = 25;
const EInvalidProb: u64 = 28;
```
Add (reuse retired slot 14 semantics for a zero settlement price):
```move
const EZeroSettlement: u64 = 14;
```
(Leave all other error codes untouched. If the Move compiler flags any remaining reference to a deleted constant, that reference is dead code from the old oracle path — remove it.)

- [ ] **Step 14: Build the flicky package**

Run:
```bash
cd /Users/alvin/Developer/sui-flow/flicky/apps/contracts && sui move build
```
Expected: `Success`. If there are unused-constant or unused-import warnings-as-errors, resolve by removing the specific dead reference the compiler names. Do NOT change function behavior to silence errors.

- [ ] **Step 15: Commit**

```bash
cd /Users/alvin/Developer/sui-flow/flicky
git add apps/contracts/sources/duel.move
git commit -m "feat(contracts): rewrite duel.move for 6-24 (keeper-fed settle, order_id anti-replay)"
```

---

## Task 4: Port the Move test suite to the 6-24 stubs

**Files:**
- Modify: `apps/contracts/tests/duel_tests.move`

**Interfaces:**
- Consumes: the new `duel.move` surface (Task 3) + account stub test helpers (Task 1).

The old suite builds `OracleSVI` / `Predict` / `PredictManager` and drives price via `set_test_price` / `settle_for_testing` / `set_manager_qty`. The new model has none of those: cards carry an `expiry_market_id: ID` + `strike`, swipes carry an `order_id`, settle takes a fed `settlement_price` + fed premiums, and anti-replay reads `AccountWrapper` positions seeded via `add_position_for_testing`.

- [ ] **Step 1: Rewrite the test helpers block**

Replace the old fixture helpers (the `use` imports for `db_oracle`/`db_predict`/`predict_manager`, and the `create_seeded_oracle` / `take_predict` / `set_oracle_p_up` / `create_manager_for` / `set_manager_qty` helpers) with these. Keep `START_MS`, `STAKE_AMOUNT`, `ATM_STRIKE`, `deck_hash_of`, and the scenario scaffolding.

```move
use account::account::{Self, AccountWrapper};

// A deterministic fake ExpiryMarket id for a card. `seed` distinguishes
// multiple cards in a deck.
fun fake_market_id(seed: u64): ID {
    object::id_from_address(sui::address::from_u256(seed as u256))
}

// Build a card from a market seed + strike (mirrors production `new_card`).
fun seeded_card(seed: u64, strike: u64): flicky::duel::Card {
    flicky::duel::new_card(fake_market_id(seed), strike)
}

// Create + share an AccountWrapper for `player`, seeded with the given
// (market seed, order_id) positions so anti-replay `has_position` passes.
fun create_wrapper_with_positions(
    scenario: &mut Scenario,
    player: address,
    positions: vector<u64>,  // one order_id per card index; 0 = no position seeded
    seeds: vector<u64>,
) {
    scenario.next_tx(player);
    let mut w = account::new_wrapper_for_testing(player, scenario.ctx());
    let mut i = 0;
    while (i < positions.length()) {
        let oid = positions[i];
        if (oid != 0) {
            account::add_position_for_testing(&mut w, fake_market_id(seeds[i]), oid as u256);
        };
        i = i + 1;
    };
    account::share_for_testing(w);
}
```

- [ ] **Step 2: Update the record_swipe call sites**

Everywhere a test recorded a staked swipe, change the call from the old
`duel::record_swipe(duel, &manager, &predict, &oracle, card_idx, is_up, quantity, &clock, ctx)`
to:
```move
duel::record_swipe(&mut duel_obj, card_idx, is_up, quantity, order_id, &clock, scenario.ctx());
```
where `order_id` is a nonzero `u256` the test also seeds into the player's wrapper (Step 1). For free swipes:
```move
duel::record_swipe_free(&mut duel_obj, card_idx, is_up, &clock, scenario.ctx());
```

- [ ] **Step 3: Update the settle + finalize call sites**

Change staked settles from the old `settle_card(duel, &p0_mgr, &p1_mgr, &oracle, card_idx)` to:
```move
scenario.next_tx(admin);
let p0_w = scenario.take_shared_by_id<AccountWrapper>(p0_wrapper_id);
let p1_w = scenario.take_shared_by_id<AccountWrapper>(p1_wrapper_id);
duel::settle_card(&mut duel_obj, &p0_w, &p1_w, card_idx, settlement_price, p0_premium, p1_premium);
test_scenario::return_shared(p0_w);
test_scenario::return_shared(p1_w);
```
Free settles: `duel::settle_card_free(&mut duel_obj, card_idx, settlement_price, p0_premium, p1_premium)`.
Replace any `finalize_test_one_oracle(duel, &oracle, &clock, ctx)` with `duel::finalize_test_one_price(&mut duel_obj, price, &clock, scenario.ctx())`.

- [ ] **Step 4: Rework the behavior of the four scoring-sensitive tests**

These tests assert on payout/premium math and must be re-expressed in the fed model. Apply exactly:

- `full_duel_alice_wins_when_settlement_above_strike`: seed both wrappers with positions for every card; call `settle_card` with `settlement_price = ATM_STRIKE + 1` and per-player `premium` matching the old `derive_p_swiped` inputs (use `premium = quantity / 2` for both, matching the stub's 0.5 default price). Assert Alice (UP swiper) wins.
- `full_duel_bob_wins_when_settlement_below_strike`: same but `settlement_price = ATM_STRIKE - 1`, assert Bob (DOWN swiper) wins.
- `full_duel_tie_refunds_stakes`: symmetric swipes + equal fed premiums → `winner == @0x0`, both stakes refunded.
- `early_redemption_penalty` (was `record_swipe`-manager based): seed the loser's wrapper with the position but then DO NOT seed the winner's position for the winning card (simulating early redemption) — call `settle_card`; assert the un-seeded player's payout for that card is 0 while premium still counts.

- [ ] **Step 5: Rename `record_swipe_snapshots_p_swiped_from_oracle`**

This test asserted the on-chain `p_swiped` snapshot, which no longer exists. Replace it with `record_swipe_stores_order_id`:
```move
#[test]
fun record_swipe_stores_order_id() {
    // create staked duel, join, reveal 1 card, seed p0 wrapper position 42
    // record_swipe(card 0, is_up = true, quantity = STAKE_AMOUNT, order_id = 42)
    // settle_card with settlement_price above strike, premium = 0
    // assert p0_payout == STAKE_AMOUNT (correct + position present => paid)
    // (full body: follow the same scaffold as full_duel_alice_wins...)
}
```
(Write the body following the same scenario scaffold used by `full_duel_alice_wins_when_settlement_above_strike`, single card.)

- [ ] **Step 6: Delete the now-impossible tests**

Remove `record_swipe_rejects_after_expiry` (no oracle expiry to trip) — the swipe-window timeout test `record_swipe_rejects_after_10_minutes` still covers timing. Keep everything else.

- [ ] **Step 7: Run the Move test suite**

Run:
```bash
cd /Users/alvin/Developer/sui-flow/flicky/apps/contracts && bun run test
```
Expected: all tests PASS (the suite is smaller by the deleted tests; every remaining test green).

- [ ] **Step 8: Commit**

```bash
cd /Users/alvin/Developer/sui-flow/flicky
git add apps/contracts/tests/duel_tests.move
git commit -m "test(contracts): port duel tests to 6-24 fed-settle model"
```

---

## Task 5: Codegen config, address reconciliation, publish, regenerate bindings

**Files:**
- Modify: `apps/contracts/sui-codegen.config.ts`
- Modify (written by publish): `apps/contracts/deployed.json`, `apps/contracts/Published.toml`, `apps/web/.env.local`
- Modify: `apps/web/src/lib/config.ts`

**Interfaces:**
- Consumes: the green package from Tasks 1–4.
- Produces: a published testnet flicky package + regenerated `apps/web/src/sui/gen/flicky`.

- [ ] **Step 1: Update the codegen config**

Overwrite the `packages` array in `apps/contracts/sui-codegen.config.ts` so it points at the migrated package + the two 6-24 stubs (drop `swap` if the web no longer needs it — keep it if `apps/web/src/sui/gen/swap` is still imported; verify with `grep -r "gen/swap" apps/web/src`). Minimum:
```ts
packages: [
  { path: "./", package: "flicky" },
  { path: "./deepbook_predict_min", package: "deepbook_predict" },
  { path: "./account_min", package: "account" },
],
```
(The full 6-24 mint bindings the web needs are added in Plan 3 by pointing codegen at the real 6-24 sources; this task only needs `flicky` regenerated correctly.)

- [ ] **Step 2: Confirm the deployer key + funds**

Run:
```bash
cd /Users/alvin/Developer/sui-flow/flicky/apps/contracts
grep -q SUI_DEPLOYER_PRIVATE_KEY .env.local && echo "key present" || echo "MISSING KEY — set SUI_DEPLOYER_PRIVATE_KEY in apps/contracts/.env.local"
sui client gas --json | head
```
Expected: "key present" and at least one gas coin with a few SUI on testnet. If missing, stop and obtain a funded testnet key before publishing.

- [ ] **Step 3: Publish the migrated package**

Run:
```bash
cd /Users/alvin/Developer/sui-flow/flicky/apps/contracts && bun run publish
```
Expected: prints a new `packageId`, writes `deployed.json` (new `packageId` == `originalPackageId`), updates `Published.toml`, and patches `apps/web/.env.local` `VITE_FLICKY_PACKAGE_ID_TESTNET`. Record the new package id.

- [ ] **Step 4: Reconcile the address-drift fallback**

The web `config.ts` has a hardcoded fallback package id that predates this publish. Update it so the fallback matches the freshly published id. In `apps/web/src/lib/config.ts`, find the `VITE_FLICKY_PACKAGE_ID_TESTNET` read (around lines 18–20) and replace the hardcoded fallback string with the new package id from Step 3. Verify the three sources now agree:
```bash
cd /Users/alvin/Developer/sui-flow/flicky
grep FLICKY apps/web/.env.local
grep -o '0x[0-9a-f]\{64\}' apps/contracts/deployed.json | head -1
grep -o '0x[0-9a-f]\{64\}' apps/web/src/lib/config.ts | head -3
```
Expected: `deployed.json` packageId, `.env.local` `VITE_FLICKY_PACKAGE_ID_TESTNET`, and the `config.ts` fallback are the SAME id.

- [ ] **Step 5: Regenerate the flicky bindings**

Run:
```bash
cd /Users/alvin/Developer/sui-flow/flicky/apps/contracts && bun run codegen
```
Expected: `apps/web/src/sui/gen/flicky/duel.ts` regenerates with the new `Card`/`Swipe` shapes and the new `settle_card`/`record_swipe` signatures. `gen/deepbook_predict` now contains only `predict_account`; `gen/account` is created. (Web app typecheck will be RED here — expected, fixed in Plan 3.)

- [ ] **Step 6: Verify the contract-side deliverable**

Run:
```bash
cd /Users/alvin/Developer/sui-flow/flicky/apps/contracts
bun run test        # Move suite green
bun run typecheck   # contracts TS scripts compile
```
Expected: Move tests PASS; contracts `tsc --noEmit` clean. (Do NOT run root `bun typecheck` — the web is intentionally mid-migration.)

- [ ] **Step 7: Commit**

```bash
cd /Users/alvin/Developer/sui-flow/flicky
git add apps/contracts/sui-codegen.config.ts apps/contracts/deployed.json apps/contracts/Published.toml apps/web/.env.local apps/web/src/lib/config.ts apps/web/src/sui/gen
git commit -m "feat(contracts): publish 6-24 flicky package + regenerate flicky bindings"
```

---

## Verification (whole plan)

- `cd apps/contracts && bun run test` — Move suite green on the 6-24 model.
- `cd apps/contracts && bun run build` — package compiles.
- `cd apps/contracts && bun run typecheck` — contracts scripts compile.
- `deployed.json`, `apps/web/.env.local`, and `config.ts` fallback all carry the SAME freshly-published flicky package id.
- `apps/web/src/sui/gen/flicky/duel.ts` reflects the new `Card { expiry_market_id, strike }`, `Swipe { is_up, quantity, order_id }`, and the fed-argument `settle_card` / `record_swipe` signatures.

**Known-red (expected):** `apps/web` typecheck fails — it still imports the removed `gen/deepbook_predict/predict`, `market_key`, `predict_manager`. Plan 3 (web) resolves this by generating full 6-24 mint bindings and rewriting `lib/deepbook.ts` / `lib/flicky.ts`.

## Downstream (not in this plan)
- **Plan 2 — Server:** `MarketCreated` discovery, the mint PTB builder (`generate_auth` → `load_live_pricer` → `mint_exact_quantity` → `record_swipe`), keeper reading `OrderMinted`/`MarketSettled` and feeding `settle_card`, `redeem_settled`, `PREDICT_SETTLEMENT_MODE` env.
- **Plan 3 — Web:** full 6-24 codegen, `lib/deepbook.ts` mint PTB, account onboarding UI, `lib/flicky.ts` reads.
- **Plan 4 — E2E + onboarding:** testnet create→join→reveal→atomic sponsored swipe→settle→payout in a 5-min window.
