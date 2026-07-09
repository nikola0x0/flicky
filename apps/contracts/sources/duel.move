// Copyright (c) Flicky Labs
// SPDX-License-Identifier: Apache-2.0

/// Flicky duel: a two-player, N-card prediction match escrowing stakes
/// in a shared object, scoring swipes against DeepBook Predict (6-24)
/// expiry-market outcomes. Each card pins its OWN `ExpiryMarket` (via
/// `expiry_market_id` + `strike`), so a deck of 5 cards can span 5
/// different expiry markets / strikes.
///
/// Lifecycle:
///   `PENDING` (creator staked, waiting for challenger) →
///   `ACTIVE`  (both staked, swipes in progress, then per-card settle) →
///   `COMPLETE` (finalized or refunded).
///
/// Finalization is two-phase:
///   1. `settle_card(card_idx, settlement_price, p0_premium, p1_premium)` ×
///      `deck_size` — once a card's expiry market has settled off-chain, a
///      keeper feeds the settlement price and per-player premium (6-24
///      exposes no public on-chain read for either) and anyone calls this
///      to score both players' swipes for that card and accumulate the
///      per-card payout/premium onto the Duel. Each call emits a
///      `CardSettled` event with the proof (expiry_market_id +
///      settlement_price).
///   2. `finalize(duel)` — verifies all cards are settled (or the
///      forfeit/refund branches apply), compares aggregate PnL, and
///      pays the pot.
///
/// Why two-phase: each card pins a different expiry market that settles on
/// its own clock, and settlement data is keeper-fed one card at a time, so
/// we settle one card at a time and accumulate state on the Duel itself.
/// Bonus: a slow settlement doesn't block the others, and a failed settle
/// for one card doesn't roll back the rest.
///
/// Tiers:
///   `STAKED` — players mint 6-24 `ExpiryMarket` positions off-chain via
///              `expiry_market::mint_exact_quantity`, chained into
///              `record_swipe` in the same player-signed PTB; only the
///              resulting `order_id` is recorded on-chain. Anti-replay is
///              enforced at settle time (`predict_account::has_position`),
///              not at swipe time.
///   `FREE`   — same engine, no Predict mint, no dUSDC stake. Same Duel
///              object, same scoring math, just gated money flow.
module flicky::duel;

use account::account::{Self as acct, AccountWrapper};
use deepbook_predict::predict_account;
use sui::balance::{Self, Balance};
use sui::bcs;
use std::hash;
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::event;

// === Errors ===
const ENotPlayer: u64 = 0;
const EDuelNotPending: u64 = 1;
const EDuelNotActive: u64 = 2;
const EAlreadyJoined: u64 = 3;
const ECreatorCannotJoin: u64 = 4;
const EStakeMismatch: u64 = 5;
const EInvalidDeckSize: u64 = 6;
const ECardIndexOOB: u64 = 7;
const EOutOfTurn: u64 = 9;
const EAllCardsNotSettled: u64 = 11;
const EZeroStake: u64 = 13;
const EZeroSettlement: u64 = 14;
const EInvalidDeckHash: u64 = 15;
const EDeckAlreadyRevealed: u64 = 16;
const EDeckHashMismatch: u64 = 17;
const EDeckNotRevealed: u64 = 18;
const ESwipeTimeout: u64 = 21;
const EZeroQuantity: u64 = 24;
const EWrongTier: u64 = 27;
const ERefundDuelComplete: u64 = 29;
const ERevealNotTimedOut: u64 = 30;
const EInvalidDeckSizeBounds: u64 = 31;
/// `settle_card` was called twice on the same `card_idx`.
const EAlreadySettled: u64 = 32;
/// `finalize` called before both players completed their swipes (and the
/// swipe-window forfeit branch hasn't yet kicked in).
const ESwipesNotComplete: u64 = 33;

// === Status ===
const STATUS_PENDING: u8 = 1;
const STATUS_ACTIVE: u8 = 2;
const STATUS_COMPLETE: u8 = 3;

// === Tier ===
const TIER_STAKED: u8 = 1;
const TIER_FREE: u8 = 2;

// === Constants ===
const MIN_DECK_SIZE: u64 = 1;
const MAX_DECK_SIZE: u64 = 20;
/// Default deck size kept for back-compat clients. New clients should pass
/// `deck_size` explicitly when creating a duel.
const DEFAULT_DECK_SIZE: u64 = 5;
const PROB_SCALE: u64 = 1_000_000_000;
const SWIPE_WINDOW_MS: u64 = 600_000; // 10 minutes
const REFUND_TIMEOUT_MS: u64 = 3_600_000; // 1 hour
const REVEAL_TIMEOUT_MS: u64 = 300_000; // 5 minutes — challenger can claim forfeit

// === Structs ===

public struct Card has copy, drop, store {
    /// The 6-24 `ExpiryMarket` this card is bet on. Passed in at reveal
    /// (committed via the deck hash), used for settle-time anti-replay.
    expiry_market_id: ID,
    /// Raw strike price (`tick * tick_size`). `actual_up = settlement_price > strike`.
    strike: u64,
}

public struct Swipe has copy, drop, store {
    is_up: bool,
    quantity: u64,
    /// The `order_id` returned by `expiry_market::mint_exact_quantity`,
    /// chained from the mint command in the same player-signed PTB. Used at
    /// settle time for anti-replay via `predict_account::has_position`.
    /// `0` for free-tier swipes (no mint).
    order_id: u256,
}

public struct Duel<phantom T> has key {
    id: UID,
    status: u8,
    tier: u8,
    /// Number of cards in this duel. Chosen at create-time, bounded by
    /// [`MIN_DECK_SIZE`, `MAX_DECK_SIZE`]. Each card pins its OWN expiry
    /// market — see `Card.expiry_market_id`. A 5-card duel can span 5
    /// different expiry markets.
    deck_size: u64,
    deck_hash: vector<u8>,
    cards: vector<Card>,
    creator: address,
    challenger: address,
    p0_stake: Balance<T>,
    p1_stake: Balance<T>,
    p0_swipes: vector<Option<Swipe>>,
    p1_swipes: vector<Option<Swipe>>,
    /// Per-card settlement state. All three vectors / counter have length
    /// `deck_size` after `create_duel_internal`. `cards_settled[i]` flips
    /// to true after `settle_card(i)` lands; once all true (or the
    /// forfeit/refund branches apply), `finalize` distributes the pot.
    cards_settled: vector<bool>,
    /// Per-card settlement-price snapshot — written by `settle_card` so
    /// off-chain consumers can recompute scoring without re-reading the
    /// oracle. 0 = unsettled.
    card_settlement_prices: vector<u64>,
    settled_count: u64,
    /// Aggregated PnL fields incremented per `settle_card` call. Sum across
    /// cards already settled; read by `finalize` to pick the winner.
    p0_payout: u64,
    p0_premium: u64,
    p1_payout: u64,
    p1_premium: u64,
    p0_next_card_idx: u64,
    p1_next_card_idx: u64,
    started_at_ms: u64,
}

// === Events ===

public struct DuelCreated has copy, drop {
    duel_id: ID,
    creator: address,
    stake_amount: u64,
    deck_hash: vector<u8>,
    tier: u8,
    deck_size: u64,
}

public struct DeckRevealed has copy, drop {
    duel_id: ID,
}

public struct DuelJoined has copy, drop {
    duel_id: ID,
    challenger: address,
    stake_amount: u64,
    started_at_ms: u64,
}

public struct SwipeRecorded has copy, drop {
    duel_id: ID,
    player: address,
    card_idx: u64,
    is_up: bool,
    quantity: u64,
    order_id: u256,
}

/// Per-card settlement record — emitted once per `settle_card` call. The
/// `expiry_market_id` + `settlement_price` are the proof for THIS card
/// (settlement_price is keeper-fed, not read on-chain); off-chain
/// consumers collect all `deck_size` of these to reconstruct the full PnL
/// proof. `actual_up` is `settlement_price > strike` (UP wins).
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

/// Final outcome of a duel. Aggregates payouts/premiums across all settled
/// cards. `primary_expiry_market_id` + `primary_settlement_price` echo
/// card 0's settlement as a quick proof anchor; for full per-card proof,
/// walk `CardSettled` events. Both fields are zero in the forfeit/refund
/// branches where no cards were settled.
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

public struct DuelRefunded has copy, drop {
    duel_id: ID,
    refunded_to_p0: u64,
    refunded_to_p1: u64,
}

/// Emitted when a duel ends without scoring — typically when the host
/// (creator) never reveals the deck and the challenger claims the forfeit
/// after the reveal window expires.
public struct DuelForfeited has copy, drop {
    duel_id: ID,
    winner: address,
    payout: u64,
    /// 1 = reveal timeout (host did not reveal deck in time).
    reason: u8,
}

// === Public: card construction ===

public fun new_card(expiry_market_id: ID, strike: u64): Card {
    Card { expiry_market_id, strike }
}

public fun card_expiry_market_id(card: &Card): ID { card.expiry_market_id }

public fun card_strike(card: &Card): u64 { card.strike }

// === Public: lifecycle ===

public fun create_duel<T>(
    stake: Coin<T>,
    deck_hash: vector<u8>,
    deck_size: u64,
    ctx: &mut TxContext,
): ID {
    assert!(deck_hash.length() == 32, EInvalidDeckHash);
    let stake_amount = stake.value();
    assert!(stake_amount > 0, EZeroStake);
    create_duel_internal<T>(stake.into_balance(), deck_hash, deck_size, TIER_STAKED, ctx)
}

/// Free / Social tier: no Predict mint, no dUSDC escrow. Same engine.
public fun create_duel_free<T>(
    deck_hash: vector<u8>,
    deck_size: u64,
    ctx: &mut TxContext,
): ID {
    assert!(deck_hash.length() == 32, EInvalidDeckHash);
    create_duel_internal<T>(balance::zero<T>(), deck_hash, deck_size, TIER_FREE, ctx)
}

fun create_duel_internal<T>(
    stake: Balance<T>,
    deck_hash: vector<u8>,
    deck_size: u64,
    tier: u8,
    ctx: &mut TxContext,
): ID {
    assert!(deck_size >= MIN_DECK_SIZE && deck_size <= MAX_DECK_SIZE, EInvalidDeckSizeBounds);
    let stake_amount = stake.value();
    let mut p0_swipes = vector<Option<Swipe>>[];
    let mut p1_swipes = vector<Option<Swipe>>[];
    let mut cards_settled = vector<bool>[];
    let mut card_settlement_prices = vector<u64>[];
    deck_size.do!(|_| {
        p0_swipes.push_back(option::none());
        p1_swipes.push_back(option::none());
        cards_settled.push_back(false);
        card_settlement_prices.push_back(0);
    });

    let creator = ctx.sender();
    let duel = Duel<T> {
        id: object::new(ctx),
        status: STATUS_PENDING,
        tier,
        deck_size,
        deck_hash,
        cards: vector<Card>[],
        creator,
        challenger: @0x0,
        p0_stake: stake,
        p1_stake: balance::zero<T>(),
        p0_swipes,
        p1_swipes,
        cards_settled,
        card_settlement_prices,
        settled_count: 0,
        p0_payout: 0,
        p0_premium: 0,
        p1_payout: 0,
        p1_premium: 0,
        p0_next_card_idx: 0,
        p1_next_card_idx: 0,
        started_at_ms: 0,
    };

    let duel_id = object::id(&duel);

    event::emit(DuelCreated {
        duel_id,
        creator,
        stake_amount,
        deck_hash: duel.deck_hash,
        tier,
        deck_size,
    });

    transfer::share_object(duel);
    duel_id
}

public fun reveal_deck<T>(duel: &mut Duel<T>, cards: vector<Card>) {
    assert!(duel.status == STATUS_ACTIVE, EDuelNotActive);
    assert!(duel.cards.is_empty(), EDeckAlreadyRevealed);
    assert!(cards.length() == duel.deck_size, EInvalidDeckSize);
    let serialized = bcs::to_bytes(&cards);
    let computed = hash::sha2_256(serialized);
    assert!(computed == duel.deck_hash, EDeckHashMismatch);
    duel.cards = cards;
    event::emit(DeckRevealed { duel_id: object::id(duel) });
}

public fun join_duel<T>(
    duel: &mut Duel<T>,
    stake: Coin<T>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(duel.status == STATUS_PENDING, EDuelNotPending);
    assert!(duel.tier == TIER_STAKED, EWrongTier);
    let challenger = ctx.sender();
    assert!(challenger != duel.creator, ECreatorCannotJoin);
    assert!(duel.challenger == @0x0, EAlreadyJoined);

    let stake_amount = stake.value();
    assert!(stake_amount == duel.p0_stake.value(), EStakeMismatch);

    duel.p1_stake.join(stake.into_balance());
    join_internal(duel, challenger, stake_amount, clock);
}

public fun join_duel_free<T>(
    duel: &mut Duel<T>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(duel.status == STATUS_PENDING, EDuelNotPending);
    assert!(duel.tier == TIER_FREE, EWrongTier);
    let challenger = ctx.sender();
    assert!(challenger != duel.creator, ECreatorCannotJoin);
    assert!(duel.challenger == @0x0, EAlreadyJoined);

    join_internal(duel, challenger, 0, clock);
}

fun join_internal<T>(
    duel: &mut Duel<T>,
    challenger: address,
    stake_amount: u64,
    clock: &Clock,
) {
    duel.challenger = challenger;
    duel.status = STATUS_ACTIVE;
    let now_ms = clock.timestamp_ms();
    duel.started_at_ms = now_ms;

    event::emit(DuelJoined {
        duel_id: object::id(duel),
        challenger,
        stake_amount,
        started_at_ms: now_ms,
    });
}

// === Public: swipe ===

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

// === Public: per-card settle ===

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

// === Public: finalize ===

/// Finalize the duel. Verifies every card has been settled (or that the
/// forfeit/refund branches apply via the swipe timeout), then distributes
/// the pot based on `duel.p0_payout` / `duel.p1_payout` etc. (filled
/// incrementally by `settle_card`). Permissionless.
public fun finalize<T>(
    duel: &mut Duel<T>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(duel.tier == TIER_STAKED, EWrongTier);
    finalize_internal<T>(duel, clock, ctx);
}

/// Free-tier counterpart to `finalize`.
public fun finalize_free<T>(
    duel: &mut Duel<T>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(duel.tier == TIER_FREE, EWrongTier);
    finalize_internal<T>(duel, clock, ctx);
}

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

fun finalize_internal<T>(
    duel: &mut Duel<T>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(duel.status == STATUS_ACTIVE, EDuelNotActive);

    let p0 = duel.creator;
    let p1 = duel.challenger;
    let total_p0 = duel.p0_stake.value();
    let total_p1 = duel.p1_stake.value();
    let total = total_p0 + total_p1;
    let deck_size = duel.deck_size;
    let p0_count = duel.p0_next_card_idx;
    let p1_count = duel.p1_next_card_idx;
    let now = clock.timestamp_ms();
    let time_expired = now > duel.started_at_ms + SWIPE_WINDOW_MS;

    let (payout_to_p0, payout_to_p1, winner) = if (p0_count != p1_count && time_expired) {
        // Forfeit: one player swiped more cards than the other after timeout.
        if (p0_count > p1_count) { (total, 0, p0) } else { (0, total, p1) }
    } else if (p0_count == deck_size && p1_count == deck_size) {
        // Normal resolution requires every card settled.
        assert!(duel.settled_count == deck_size, EAllCardsNotSettled);
        // Subtraction-less PnL:  payout_0 + premium_1  vs  payout_1 + premium_0
        let val0 = (duel.p0_payout as u128) + (duel.p1_premium as u128);
        let val1 = (duel.p1_payout as u128) + (duel.p0_premium as u128);
        if (val0 > val1) { (total, 0, p0) }
        else if (val1 > val0) { (0, total, p1) }
        else { (total_p0, total_p1, @0x0) }
    } else {
        // Both stuck mid-deck. Require timeout, then refund as tie.
        assert!(time_expired, ESwipesNotComplete);
        (total_p0, total_p1, @0x0)
    };

    pay_player(&mut duel.p0_stake, &mut duel.p1_stake, p0, payout_to_p0, ctx);
    pay_player(&mut duel.p0_stake, &mut duel.p1_stake, p1, payout_to_p1, ctx);

    duel.status = STATUS_COMPLETE;

    // Proof anchor: card 0's expiry market + settlement price. Zeros if
    // forfeit/refund kicked in before any card settled.
    let (primary_expiry_market_id, primary_settlement_price) = if (!duel.cards.is_empty()
        && *vector::borrow(&duel.cards_settled, 0)) {
        (duel.cards[0].expiry_market_id, *vector::borrow(&duel.card_settlement_prices, 0))
    } else {
        (object::id_from_address(@0x0), 0)
    };

    event::emit(DuelFinalized {
        duel_id: object::id(duel),
        winner,
        payout_to_p0,
        payout_to_p1,
        p0_payout_total: duel.p0_payout,
        p0_premium_total: duel.p0_premium,
        p1_payout_total: duel.p1_payout,
        p1_premium_total: duel.p1_premium,
        primary_expiry_market_id,
        primary_settlement_price,
    });
}

// === Public: refund ===

/// Refund stakes when a duel is stuck. Two paths:
///   * `STATUS_PENDING` — creator can cancel before anyone joins.
///   * `STATUS_ACTIVE`  — either player after 1h, only if at least one
///                        player has not completed all 5 swipes. Once both
///                        complete, `finalize` is the only path (anyone
///                        can call it, so a losing player cannot dodge).
public fun refund_duel<T>(duel: &mut Duel<T>, clock: &Clock, ctx: &mut TxContext) {
    let p0 = duel.creator;
    let p1 = duel.challenger;
    let sender = ctx.sender();
    let total_p0 = duel.p0_stake.value();
    let total_p1 = duel.p1_stake.value();

    if (duel.status == STATUS_PENDING) {
        assert!(sender == p0, ENotPlayer);
        pay_player(&mut duel.p0_stake, &mut duel.p1_stake, p0, total_p0, ctx);
        duel.status = STATUS_COMPLETE;
        event::emit(DuelRefunded {
            duel_id: object::id(duel),
            refunded_to_p0: total_p0,
            refunded_to_p1: 0,
        });
    } else if (duel.status == STATUS_ACTIVE) {
        let now = clock.timestamp_ms();
        assert!(now > duel.started_at_ms + REFUND_TIMEOUT_MS, ESwipeTimeout);
        assert!(sender == p0 || sender == p1, ENotPlayer);
        let both_done =
            duel.p0_next_card_idx == duel.deck_size && duel.p1_next_card_idx == duel.deck_size;
        assert!(!both_done, ERefundDuelComplete);

        pay_player(&mut duel.p0_stake, &mut duel.p1_stake, p0, total_p0, ctx);
        pay_player(&mut duel.p0_stake, &mut duel.p1_stake, p1, total_p1, ctx);
        duel.status = STATUS_COMPLETE;
        event::emit(DuelRefunded {
            duel_id: object::id(duel),
            refunded_to_p0: total_p0,
            refunded_to_p1: total_p1,
        });
    } else {
        abort EDuelNotActive
    }
}

/// Challenger-only forfeit when the host never reveals the deck. After the
/// challenger has joined and 5 minutes pass without `reveal_deck` being
/// called, the challenger can sweep the entire pot. Discourages a host from
/// griefing by withholding the deck. Works for both tiers (Free tier has
/// zero stake so the "win" is symbolic).
public fun claim_reveal_timeout<T>(duel: &mut Duel<T>, clock: &Clock, ctx: &mut TxContext) {
    assert!(duel.status == STATUS_ACTIVE, EDuelNotActive);
    assert!(duel.cards.is_empty(), EDeckAlreadyRevealed);

    let sender = ctx.sender();
    assert!(sender == duel.challenger, ENotPlayer);

    let now = clock.timestamp_ms();
    assert!(now > duel.started_at_ms + REVEAL_TIMEOUT_MS, ERevealNotTimedOut);

    let total_p0 = duel.p0_stake.value();
    let total_p1 = duel.p1_stake.value();
    let total = total_p0 + total_p1;

    pay_player(&mut duel.p0_stake, &mut duel.p1_stake, duel.challenger, total, ctx);
    duel.status = STATUS_COMPLETE;

    event::emit(DuelForfeited {
        duel_id: object::id(duel),
        winner: duel.challenger,
        payout: total,
        reason: 1,
    });
}

// === Read API ===

public fun status<T>(duel: &Duel<T>): u8 { duel.status }

public fun is_complete<T>(duel: &Duel<T>): bool { duel.status == STATUS_COMPLETE }

public fun tier<T>(duel: &Duel<T>): u8 { duel.tier }

public fun creator<T>(duel: &Duel<T>): address { duel.creator }

public fun challenger<T>(duel: &Duel<T>): address { duel.challenger }

public fun started_at_ms<T>(duel: &Duel<T>): u64 { duel.started_at_ms }

public fun deck<T>(duel: &Duel<T>): &vector<Card> { &duel.cards }

public fun deck_hash<T>(duel: &Duel<T>): vector<u8> { duel.deck_hash }

public fun p0_payout<T>(duel: &Duel<T>): u64 { duel.p0_payout }

public fun p0_premium<T>(duel: &Duel<T>): u64 { duel.p0_premium }

public fun p1_payout<T>(duel: &Duel<T>): u64 { duel.p1_payout }

public fun p1_premium<T>(duel: &Duel<T>): u64 { duel.p1_premium }

public fun p0_stake_value<T>(duel: &Duel<T>): u64 { duel.p0_stake.value() }

public fun p1_stake_value<T>(duel: &Duel<T>): u64 { duel.p1_stake.value() }

public fun p0_next_card_idx<T>(duel: &Duel<T>): u64 { duel.p0_next_card_idx }

public fun p1_next_card_idx<T>(duel: &Duel<T>): u64 { duel.p1_next_card_idx }

public fun status_pending(): u8 { STATUS_PENDING }

public fun status_active(): u8 { STATUS_ACTIVE }

public fun status_complete(): u8 { STATUS_COMPLETE }

public fun tier_staked(): u8 { TIER_STAKED }

public fun tier_free(): u8 { TIER_FREE }

public fun deck_size<T>(duel: &Duel<T>): u64 { duel.deck_size }

public fun settled_count<T>(duel: &Duel<T>): u64 { duel.settled_count }

public fun is_card_settled<T>(duel: &Duel<T>, card_idx: u64): bool {
    *vector::borrow(&duel.cards_settled, card_idx)
}

public fun card_settlement_price<T>(duel: &Duel<T>, card_idx: u64): u64 {
    *vector::borrow(&duel.card_settlement_prices, card_idx)
}

public fun prob_scale(): u64 { PROB_SCALE }

// === Internal helpers ===

fun pay_player<T>(
    p0_stake: &mut Balance<T>,
    p1_stake: &mut Balance<T>,
    recipient: address,
    amount: u64,
    ctx: &mut TxContext,
) {
    if (amount == 0) return;
    let from_p0 = if (p0_stake.value() >= amount) amount else p0_stake.value();
    let remaining = amount - from_p0;
    let mut payout = balance::zero<T>();
    if (from_p0 > 0) {
        payout.join(p0_stake.split(from_p0));
    };
    if (remaining > 0) {
        payout.join(p1_stake.split(remaining));
    };
    transfer::public_transfer(coin::from_balance(payout, ctx), recipient);
}

#[test_only]
public fun test_default_deck_size(): u64 { DEFAULT_DECK_SIZE }

#[test_only]
public fun test_prob_scale(): u64 { PROB_SCALE }
