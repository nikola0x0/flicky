// Copyright (c) Flicky Labs
// SPDX-License-Identifier: Apache-2.0

/// Flicky duel: a two-player, five-card prediction match escrowing stakes
/// in a shared object, consuming DeepBook Predict positions for correctness
/// and computing payout.
///
/// Lifecycle:
///   `PENDING` (creator staked, waiting for challenger) →
///   `ACTIVE`  (both staked, swipes in progress) →
///   `COMPLETE` (finalized or refunded).
///
/// Finalization is one-shot: after both players complete their swipes and
/// the oracle settles, anyone (typically the server admin) calls
/// `finalize`, which reads the supplied oracle's settlement_price, scores
/// all 5 cards inline, compares PnL, and distributes the stake. The
/// `DuelFinalized` event carries the oracle id + settlement_price as
/// on-chain proof of the computation.
///
/// Tiers:
///   `STAKED` — players mint Predict positions; `record_swipe` enforces
///              `manager.owner() == sender` and anti-replay vs PredictManager.
///   `FREE`   — same engine, no Predict mint, no dUSDC stake. Same Duel
///              object, same scoring math, just gated money flow.
module flicky::duel;

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

// === Errors ===
const ENotPlayer: u64 = 0;
const EDuelNotPending: u64 = 1;
const EDuelNotActive: u64 = 2;
const EAlreadyJoined: u64 = 3;
const ECreatorCannotJoin: u64 = 4;
const EStakeMismatch: u64 = 5;
const EInvalidDeckSize: u64 = 6;
const ECardIndexOOB: u64 = 7;
const EOracleMismatch: u64 = 8;
const EOutOfTurn: u64 = 9;
const EAllCardsNotSettled: u64 = 11;
const EZeroStake: u64 = 13;
const EOracleNotLive: u64 = 14;
const EInvalidDeckHash: u64 = 15;
const EDeckAlreadyRevealed: u64 = 16;
const EDeckHashMismatch: u64 = 17;
const EDeckNotRevealed: u64 = 18;
const ENotManagerOwner: u64 = 19;
const EInsufficientPosition: u64 = 20;
const ESwipeTimeout: u64 = 21;
const EZeroQuantity: u64 = 24;
const EZeroPremium: u64 = 25;
const EWrongTier: u64 = 27;
const EInvalidProb: u64 = 28;
const ERefundDuelComplete: u64 = 29;
const ERevealNotTimedOut: u64 = 30;
const EInvalidDeckSizeBounds: u64 = 31;

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
    oracle_id: ID,
    strike: u64,
}

public struct Swipe has copy, drop, store {
    is_up: bool,
    quantity: u64,
    premium: u64,
    /// Probability of the swiped direction, snapshotted from the oracle SVI
    /// surface inside the swipe PTB. Scaled by `PROB_SCALE` (1e9).
    p_swiped: u64,
}

public struct Duel<phantom T> has key {
    id: UID,
    status: u8,
    tier: u8,
    /// Number of cards in this duel. Chosen at create-time, bounded by
    /// [`MIN_DECK_SIZE`, `MAX_DECK_SIZE`]. All cards share one oracle.
    deck_size: u64,
    deck_hash: vector<u8>,
    cards: vector<Card>,
    creator: address,
    challenger: address,
    p0_stake: Balance<T>,
    p1_stake: Balance<T>,
    p0_swipes: vector<Option<Swipe>>,
    p1_swipes: vector<Option<Swipe>>,
    /// Aggregated PnL fields written by `finalize`. Zero until then.
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
    premium: u64,
    p_swiped: u64,
}

/// Final outcome of a duel. The `oracle_id` and `settlement_price` are the
/// proof artifacts: any off-chain consumer can re-fetch the oracle at
/// `oracle_id` and recompute payout-vs-premium from the on-chain swipes to
/// independently verify `winner`.
public struct DuelFinalized has copy, drop {
    duel_id: ID,
    winner: address, // @0x0 == tie
    payout_to_p0: u64,
    payout_to_p1: u64,
    p0_payout_total: u64,
    p0_premium_total: u64,
    p1_payout_total: u64,
    p1_premium_total: u64,
    oracle_id: ID,
    settlement_price: u64,
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

public fun new_card(oracle: &OracleSVI, strike: u64): Card {
    Card { oracle_id: db_oracle::id(oracle), strike }
}

public fun card_oracle_id(card: &Card): ID { card.oracle_id }

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
    deck_size.do!(|_| {
        p0_swipes.push_back(option::none());
        p1_swipes.push_back(option::none());
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

/// Record a player's swipe on `card_idx`. Snapshots `premium` and `p_swiped`
/// from `predict::get_trade_amounts` inside the PTB — caller cannot supply
/// these. Premium is the dUSDC cost the player would pay to mint the
/// `quantity` Predict position at the current SVI price.
public fun record_swipe<T>(
    duel: &mut Duel<T>,
    manager: &PredictManager,
    predict: &Predict,
    oracle: &OracleSVI,
    card_idx: u64,
    is_up: bool,
    quantity: u64,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(duel.tier == TIER_STAKED, EWrongTier);
    let sender = ctx.sender();
    assert!(manager.owner() == sender, ENotManagerOwner);
    assert!(quantity > 0, EZeroQuantity);

    let (card, key) = preflight_swipe(duel, oracle, card_idx, is_up, clock, sender);

    // Anti-replay: ensure the player actually minted at least `quantity` of
    // the relevant Predict position before swiping.
    let current_position_qty = predict_manager::position(manager, key);
    assert!(current_position_qty >= quantity, EInsufficientPosition);

    let (premium, _max_payout) =
        db_predict::get_trade_amounts(predict, oracle, key, quantity, clock);
    assert!(premium > 0, EZeroPremium);
    let p_swiped = derive_p_swiped(premium, quantity);

    let _ = card; // silence unused
    record_swipe_internal(duel, card_idx, is_up, quantity, premium, p_swiped, sender);
}

/// Free-tier swipe — no PredictManager, no anti-replay. Premium and
/// `p_swiped` still come from real Predict pricing via
/// `predict::get_trade_amounts` so scoring stays consistent with Staked
/// tier. Uses normalized quantity = `PROB_SCALE`.
public fun record_swipe_free<T>(
    duel: &mut Duel<T>,
    predict: &Predict,
    oracle: &OracleSVI,
    card_idx: u64,
    is_up: bool,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(duel.tier == TIER_FREE, EWrongTier);
    let sender = ctx.sender();

    let (_card, key) = preflight_swipe(duel, oracle, card_idx, is_up, clock, sender);

    let (premium, _max_payout) =
        db_predict::get_trade_amounts(predict, oracle, key, PROB_SCALE, clock);
    assert!(premium > 0, EZeroPremium);
    let p_swiped = derive_p_swiped(premium, PROB_SCALE);

    record_swipe_internal(duel, card_idx, is_up, PROB_SCALE, premium, p_swiped, sender);
}

/// Common pre-flight checks. Returns the card and its market_key for `is_up`.
fun preflight_swipe<T>(
    duel: &Duel<T>,
    oracle: &OracleSVI,
    card_idx: u64,
    is_up: bool,
    clock: &Clock,
    sender: address,
): (Card, market_key::MarketKey) {
    assert!(duel.status == STATUS_ACTIVE, EDuelNotActive);
    assert!(!duel.cards.is_empty(), EDeckNotRevealed);
    assert!(card_idx < duel.deck_size, ECardIndexOOB);
    assert!(clock.timestamp_ms() <= duel.started_at_ms + SWIPE_WINDOW_MS, ESwipeTimeout);

    let is_p0 = sender == duel.creator;
    let is_p1 = sender == duel.challenger;
    assert!(is_p0 || is_p1, ENotPlayer);

    let card = duel.cards[card_idx];
    assert!(card.oracle_id == db_oracle::id(oracle), EOracleMismatch);
    assert!(oracle.status(clock) == db_oracle::status_active(), EOracleNotLive);

    let next_idx = if (is_p0) duel.p0_next_card_idx else duel.p1_next_card_idx;
    assert!(card_idx == next_idx, EOutOfTurn);

    let expiry = db_oracle::expiry(oracle);
    let key = market_key::new(card.oracle_id, expiry, card.strike, is_up);
    (card, key)
}

/// p_swiped (scaled by PROB_SCALE) = premium * PROB_SCALE / quantity.
/// Inverts the Predict pricing equation: premium = quantity * p_swiped / 1e9.
fun derive_p_swiped(premium: u64, quantity: u64): u64 {
    let p = (((premium as u128) * (PROB_SCALE as u128)) / (quantity as u128)) as u64;
    assert!(p > 0 && p < PROB_SCALE, EInvalidProb);
    p
}

fun record_swipe_internal<T>(
    duel: &mut Duel<T>,
    card_idx: u64,
    is_up: bool,
    quantity: u64,
    premium: u64,
    p_swiped: u64,
    sender: address,
) {
    assert!(premium > 0, EZeroPremium);

    let is_p0 = sender == duel.creator;
    let swipe = Swipe { is_up, quantity, premium, p_swiped };
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
        premium,
        p_swiped,
    });
}

// === Public: finalize (one-shot, no per-card settle) ===

/// One-shot finalize for Staked tier. Reads the supplied oracle's
/// settlement_price, scores all 5 cards inline, compares PnL, and
/// distributes the stake. All 5 cards in the deck must reference
/// `oracle.id`. Permissionless — the oracle read makes the result
/// deterministic, so the caller (typically the server admin) cannot
/// influence the outcome.
public fun finalize<T>(
    duel: &mut Duel<T>,
    p0_manager: &PredictManager,
    p1_manager: &PredictManager,
    oracle: &OracleSVI,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(duel.tier == TIER_STAKED, EWrongTier);
    let (settlement_price, oracle_id) = read_settlement(oracle);
    let (p0_payout, p0_premium, p1_payout, p1_premium) =
        aggregate_outcomes_staked(duel, oracle, settlement_price, p0_manager, p1_manager);
    finalize_with_aggregate(
        duel,
        p0_payout,
        p0_premium,
        p1_payout,
        p1_premium,
        oracle_id,
        settlement_price,
        clock,
        ctx,
    );
}

/// **TEST/DEV ONLY** — finalize using a single oracle's price applied to
/// ALL 5 cards regardless of each card's actual `oracle_id`. Uses
/// `settlement_price` if the oracle has settled; otherwise falls back to
/// `spot_price` (current SVI underlying) so devs can finalize without
/// waiting for any oracle to settle. Skips anti-replay (no `PredictManager`
/// check). PnL is approximate — never use this on mainnet.
public fun finalize_test_one_oracle<T>(
    duel: &mut Duel<T>,
    oracle: &OracleSVI,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let price_opt = db_oracle::settlement_price(oracle);
    let price = if (price_opt.is_some()) {
        *price_opt.borrow()
    } else {
        db_oracle::spot_price(oracle)
    };
    let oracle_id = db_oracle::id(oracle);
    let (p0_payout, p0_premium, p1_payout, p1_premium) =
        aggregate_outcomes_force(duel, price);
    finalize_with_aggregate(
        duel,
        p0_payout,
        p0_premium,
        p1_payout,
        p1_premium,
        oracle_id,
        price,
        clock,
        ctx,
    );
}

/// Free-tier counterpart to `finalize`. No managers, no anti-replay.
public fun finalize_free<T>(
    duel: &mut Duel<T>,
    oracle: &OracleSVI,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(duel.tier == TIER_FREE, EWrongTier);
    let (settlement_price, oracle_id) = read_settlement(oracle);
    let (p0_payout, p0_premium, p1_payout, p1_premium) =
        aggregate_outcomes_free(duel, oracle, settlement_price);
    finalize_with_aggregate(
        duel,
        p0_payout,
        p0_premium,
        p1_payout,
        p1_premium,
        oracle_id,
        settlement_price,
        clock,
        ctx,
    );
}

fun read_settlement(oracle: &OracleSVI): (u64, ID) {
    let settlement_price_opt = db_oracle::settlement_price(oracle);
    assert!(settlement_price_opt.is_some(), EOracleNotLive);
    let settlement_price = *settlement_price_opt.borrow();
    (settlement_price, db_oracle::id(oracle))
}

fun aggregate_outcomes_staked<T>(
    duel: &Duel<T>,
    oracle: &OracleSVI,
    settlement_price: u64,
    p0_manager: &PredictManager,
    p1_manager: &PredictManager,
): (u64, u64, u64, u64) {
    let oracle_id = db_oracle::id(oracle);
    let expiry = db_oracle::expiry(oracle);
    let mut p0_payout = 0u64;
    let mut p0_premium = 0u64;
    let mut p1_payout = 0u64;
    let mut p1_premium = 0u64;
    let mut i = 0;
    while (i < duel.deck_size) {
        let card = &duel.cards[i];
        assert!(card.oracle_id == oracle_id, EOracleMismatch);
        let actual_up = settlement_price > card.strike;
        if (duel.p0_swipes[i].is_some()) {
            let swipe = *duel.p0_swipes[i].borrow();
            let key = market_key::new(card.oracle_id, expiry, card.strike, swipe.is_up);
            let has_redeemed_early = predict_manager::position(p0_manager, key) < swipe.quantity;
            let (pay, prem) = score_swipe(&swipe, actual_up, has_redeemed_early);
            p0_payout = p0_payout + pay;
            p0_premium = p0_premium + prem;
        };
        if (duel.p1_swipes[i].is_some()) {
            let swipe = *duel.p1_swipes[i].borrow();
            let key = market_key::new(card.oracle_id, expiry, card.strike, swipe.is_up);
            let has_redeemed_early = predict_manager::position(p1_manager, key) < swipe.quantity;
            let (pay, prem) = score_swipe(&swipe, actual_up, has_redeemed_early);
            p1_payout = p1_payout + pay;
            p1_premium = p1_premium + prem;
        };
        i = i + 1;
    };
    (p0_payout, p0_premium, p1_payout, p1_premium)
}

fun aggregate_outcomes_free<T>(
    duel: &Duel<T>,
    oracle: &OracleSVI,
    settlement_price: u64,
): (u64, u64, u64, u64) {
    let oracle_id = db_oracle::id(oracle);
    let mut p0_payout = 0u64;
    let mut p0_premium = 0u64;
    let mut p1_payout = 0u64;
    let mut p1_premium = 0u64;
    let mut i = 0;
    while (i < duel.deck_size) {
        let card = &duel.cards[i];
        assert!(card.oracle_id == oracle_id, EOracleMismatch);
        let actual_up = settlement_price > card.strike;
        if (duel.p0_swipes[i].is_some()) {
            let swipe = *duel.p0_swipes[i].borrow();
            let (pay, prem) = score_swipe(&swipe, actual_up, false);
            p0_payout = p0_payout + pay;
            p0_premium = p0_premium + prem;
        };
        if (duel.p1_swipes[i].is_some()) {
            let swipe = *duel.p1_swipes[i].borrow();
            let (pay, prem) = score_swipe(&swipe, actual_up, false);
            p1_payout = p1_payout + pay;
            p1_premium = p1_premium + prem;
        };
        i = i + 1;
    };
    (p0_payout, p0_premium, p1_payout, p1_premium)
}

/// TEST helper: aggregate using `settlement_price` for every card, ignoring
/// `card.oracle_id` mismatches and skipping anti-replay. Used only by
/// `finalize_test_one_oracle`.
fun aggregate_outcomes_force<T>(
    duel: &Duel<T>,
    settlement_price: u64,
): (u64, u64, u64, u64) {
    let mut p0_payout = 0u64;
    let mut p0_premium = 0u64;
    let mut p1_payout = 0u64;
    let mut p1_premium = 0u64;
    let mut i = 0;
    while (i < duel.deck_size) {
        let card = &duel.cards[i];
        let actual_up = settlement_price > card.strike;
        if (duel.p0_swipes[i].is_some()) {
            let swipe = *duel.p0_swipes[i].borrow();
            let (pay, prem) = score_swipe(&swipe, actual_up, false);
            p0_payout = p0_payout + pay;
            p0_premium = p0_premium + prem;
        };
        if (duel.p1_swipes[i].is_some()) {
            let swipe = *duel.p1_swipes[i].borrow();
            let (pay, prem) = score_swipe(&swipe, actual_up, false);
            p1_payout = p1_payout + pay;
            p1_premium = p1_premium + prem;
        };
        i = i + 1;
    };
    (p0_payout, p0_premium, p1_payout, p1_premium)
}

fun score_swipe(swipe: &Swipe, actual_up: bool, has_redeemed_early: bool): (u64, u64) {
    let correct = !has_redeemed_early && (actual_up == swipe.is_up);
    let payout = if (correct) swipe.quantity else 0;
    (payout, swipe.premium)
}

fun finalize_with_aggregate<T>(
    duel: &mut Duel<T>,
    p0_payout: u64,
    p0_premium: u64,
    p1_payout: u64,
    p1_premium: u64,
    oracle_id: ID,
    settlement_price: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(duel.status == STATUS_ACTIVE, EDuelNotActive);

    let p0 = duel.creator;
    let p1 = duel.challenger;
    let total_p0 = duel.p0_stake.value();
    let total_p1 = duel.p1_stake.value();
    let total = total_p0 + total_p1;

    let p0_count = duel.p0_next_card_idx;
    let p1_count = duel.p1_next_card_idx;
    let now = clock.timestamp_ms();
    let time_expired = now > duel.started_at_ms + SWIPE_WINDOW_MS;

    let (payout_to_p0, payout_to_p1, winner) = if (p0_count != p1_count && time_expired) {
        // Forfeit: one player swiped more cards than the other after timeout.
        if (p0_count > p1_count) { (total, 0, p0) } else { (0, total, p1) }
    } else if (p0_count == duel.deck_size && p1_count == duel.deck_size) {
        // Normal resolution. Subtraction-less PnL:
        //   payout_0 + premium_1  vs  payout_1 + premium_0
        let val0 = (p0_payout as u128) + (p1_premium as u128);
        let val1 = (p1_payout as u128) + (p0_premium as u128);
        if (val0 > val1) { (total, 0, p0) }
        else if (val1 > val0) { (0, total, p1) }
        else { (total_p0, total_p1, @0x0) }
    } else {
        // Both stuck mid-deck. Require timeout, then refund as tie.
        assert!(time_expired, EAllCardsNotSettled);
        (total_p0, total_p1, @0x0)
    };

    // Mirror aggregated PnL onto the Duel for read-API consistency.
    duel.p0_payout = p0_payout;
    duel.p0_premium = p0_premium;
    duel.p1_payout = p1_payout;
    duel.p1_premium = p1_premium;

    pay_player(&mut duel.p0_stake, &mut duel.p1_stake, p0, payout_to_p0, ctx);
    pay_player(&mut duel.p0_stake, &mut duel.p1_stake, p1, payout_to_p1, ctx);

    duel.status = STATUS_COMPLETE;

    event::emit(DuelFinalized {
        duel_id: object::id(duel),
        winner,
        payout_to_p0,
        payout_to_p1,
        p0_payout_total: p0_payout,
        p0_premium_total: p0_premium,
        p1_payout_total: p1_payout,
        p1_premium_total: p1_premium,
        oracle_id,
        settlement_price,
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

public fun dummy_deps(_deep: &DEEP) {
    db_constants::float_scaling();
}
