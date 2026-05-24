// Copyright (c) Flicky Labs
// SPDX-License-Identifier: Apache-2.0

/// Flicky duel: a two-player, five-card prediction match escrowing stakes
/// in a shared object, consuming DeepBook Predict positions for correctness
/// and computing payout.
///
/// Lifecycle:
///   `PENDING` (creator staked, waiting for challenger) →
///   `ACTIVE`  (both staked, swipes in progress) →
///   `COMPLETE` (all cards settled and stakes paid out).
module flicky::duel;

use deepbook_predict::oracle::{Self as db_oracle, OracleSVI};
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
const ECardAlreadySettled: u64 = 10;
const EAllCardsNotSettled: u64 = 11;
const EZeroStake: u64 = 13;
const EOracleNotLive: u64 = 14;
const EInvalidDeckHash: u64 = 15;
const EDeckAlreadyRevealed: u64 = 16;
const EDeckHashMismatch: u64 = 17;
const EDeckNotRevealed: u64 = 18;
const ENotManagerOwner: u64 = 19;
const EZeroPositionQuantity: u64 = 20;
const ESwipeTimeout: u64 = 21;

// === Status ===
const STATUS_PENDING: u8 = 1;
const STATUS_ACTIVE: u8 = 2;
const STATUS_COMPLETE: u8 = 3;

// === Constants ===
const DECK_SIZE: u64 = 5;

// === Structs ===

public struct Card has copy, drop, store {
    oracle_id: ID,
    strike: u64,
}

public struct Swipe has copy, drop, store {
    is_up: bool,
    quantity: u64,
    premium: u64,
}

public struct Duel<phantom T> has key {
    id: UID,
    status: u8,
    deck_hash: vector<u8>,
    cards: vector<Card>,
    creator: address,
    challenger: address,
    p0_stake: Balance<T>,
    p1_stake: Balance<T>,
    p0_swipes: vector<Option<Swipe>>,
    p1_swipes: vector<Option<Swipe>>,
    p0_payout: u64,
    p0_premium: u64,
    p1_payout: u64,
    p1_premium: u64,
    p0_next_card_idx: u64,
    p1_next_card_idx: u64,
    card_settlements: vector<Option<u64>>,
    settled_count: u64,
    started_at_ms: u64,
}

// === Events ===

public struct DuelCreated has copy, drop {
    duel_id: ID,
    creator: address,
    stake_amount: u64,
    deck_hash: vector<u8>,
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
}

public struct CardSettled has copy, drop {
    duel_id: ID,
    card_idx: u64,
    settlement_price: u64,
}

public struct DuelFinalized has copy, drop {
    duel_id: ID,
    winner: address, // @0x0 == tie
    payout_to_p0: u64,
    payout_to_p1: u64,
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
    ctx: &mut TxContext,
): ID {
    assert!(deck_hash.length() == 32, EInvalidDeckHash);
    let stake_amount = stake.value();
    assert!(stake_amount > 0, EZeroStake);

    let mut card_settlements = vector<Option<u64>>[];
    let mut p0_swipes = vector<Option<Swipe>>[];
    let mut p1_swipes = vector<Option<Swipe>>[];
    DECK_SIZE.do!(|_| {
        card_settlements.push_back(option::none());
        p0_swipes.push_back(option::none());
        p1_swipes.push_back(option::none());
    });

    let creator = ctx.sender();
    let duel = Duel<T> {
        id: object::new(ctx),
        status: STATUS_PENDING,
        deck_hash,
        cards: vector<Card>[],
        creator,
        challenger: @0x0,
        p0_stake: stake.into_balance(),
        p1_stake: balance::zero<T>(),
        p0_swipes,
        p1_swipes,
        p0_payout: 0,
        p0_premium: 0,
        p1_payout: 0,
        p1_premium: 0,
        p0_next_card_idx: 0,
        p1_next_card_idx: 0,
        card_settlements,
        settled_count: 0,
        started_at_ms: 0,
    };

    let duel_id = object::id(&duel);

    event::emit(DuelCreated {
        duel_id,
        creator,
        stake_amount,
        deck_hash: duel.deck_hash,
    });

    transfer::share_object(duel);
    duel_id
}

public fun reveal_deck<T>(duel: &mut Duel<T>, cards: vector<Card>) {
    assert!(duel.status == STATUS_ACTIVE, EDuelNotActive);
    assert!(duel.cards.is_empty(), EDeckAlreadyRevealed);
    assert!(cards.length() == DECK_SIZE, EInvalidDeckSize);
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
    let challenger = ctx.sender();
    assert!(challenger != duel.creator, ECreatorCannotJoin);
    assert!(duel.challenger == @0x0, EAlreadyJoined);

    let stake_amount = stake.value();
    assert!(stake_amount == duel.p0_stake.value(), EStakeMismatch);

    duel.p1_stake.join(stake.into_balance());
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

public fun record_swipe<T>(
    duel: &mut Duel<T>,
    manager: &PredictManager,
    oracle: &OracleSVI,
    card_idx: u64,
    is_up: bool,
    quantity: u64,
    premium: u64,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(duel.status == STATUS_ACTIVE, EDuelNotActive);
    assert!(!duel.cards.is_empty(), EDeckNotRevealed);
    assert!(card_idx < DECK_SIZE, ECardIndexOOB);

    // Enforce 10-minute swipe window constraint
    assert!(clock.timestamp_ms() <= duel.started_at_ms + 600_000, ESwipeTimeout);

    let sender = ctx.sender();
    let is_p0 = sender == duel.creator;
    let is_p1 = sender == duel.challenger;
    assert!(is_p0 || is_p1, ENotPlayer);

    assert!(manager.owner() == sender, ENotManagerOwner);

    let card = &duel.cards[card_idx];
    assert!(card.oracle_id == db_oracle::id(oracle), EOracleMismatch);
    assert!(oracle.status(clock) == db_oracle::status_active(), EOracleNotLive);

    let next_idx = if (is_p0) duel.p0_next_card_idx else duel.p1_next_card_idx;
    assert!(card_idx == next_idx, EOutOfTurn);

    // Query PredictManager to ensure the player actually has at least this position quantity
    let expiry = db_oracle::expiry(oracle);
    let key = market_key::new(card.oracle_id, expiry, card.strike, is_up);
    let current_position_qty = predict_manager::position(manager, key);
    assert!(current_position_qty >= quantity, EZeroPositionQuantity);
    assert!(quantity > 0, EZeroPositionQuantity);

    // Verify premium is greater than zero
    assert!(premium > 0, EZeroPositionQuantity);

    let swipe = Swipe { is_up, quantity, premium };
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
    });
}

public fun settle_card<T>(duel: &mut Duel<T>, oracle: &OracleSVI, card_idx: u64) {
    assert!(duel.status == STATUS_ACTIVE, EDuelNotActive);
    assert!(card_idx < DECK_SIZE, ECardIndexOOB);
    let card = &duel.cards[card_idx];
    assert!(card.oracle_id == db_oracle::id(oracle), EOracleMismatch);
    assert!(duel.card_settlements[card_idx].is_none(), ECardAlreadySettled);

    let settlement_price_opt = db_oracle::settlement_price(oracle);
    assert!(settlement_price_opt.is_some(), EOracleNotLive);
    let settlement_price = *settlement_price_opt.borrow();
    let strike = card.strike;

    // Settle Player 0
    if (duel.p0_swipes[card_idx].is_some()) {
        let swipe = *duel.p0_swipes[card_idx].borrow();
        let actual_up = settlement_price > strike;
        let correct = actual_up == swipe.is_up;
        let payout = if (correct) swipe.quantity else 0;
        let premium = swipe.premium;
        duel.p0_payout = duel.p0_payout + payout;
        duel.p0_premium = duel.p0_premium + premium;
    };

    // Settle Player 1
    if (duel.p1_swipes[card_idx].is_some()) {
        let swipe = *duel.p1_swipes[card_idx].borrow();
        let actual_up = settlement_price > strike;
        let correct = actual_up == swipe.is_up;
        let payout = if (correct) swipe.quantity else 0;
        let premium = swipe.premium;
        duel.p1_payout = duel.p1_payout + payout;
        duel.p1_premium = duel.p1_premium + premium;
    };

    *vector::borrow_mut(&mut duel.card_settlements, card_idx) = option::some(settlement_price);
    duel.settled_count = duel.settled_count + 1;

    event::emit(CardSettled {
        duel_id: object::id(duel),
        card_idx,
        settlement_price,
    });
}

public fun finalize<T>(duel: &mut Duel<T>, ctx: &mut TxContext) {
    assert!(duel.status == STATUS_ACTIVE, EDuelNotActive);
    assert!(duel.settled_count == DECK_SIZE, EAllCardsNotSettled);

    let p0 = duel.creator;
    let p1 = duel.challenger;
    let total_p0 = duel.p0_stake.value();
    let total_p1 = duel.p1_stake.value();
    let total = total_p0 + total_p1;

    // Subtraction-less comparison for PnL: Payout_0 + Premium_1 vs Payout_1 + Premium_0
    let val0 = (duel.p0_payout as u128) + (duel.p1_premium as u128);
    let val1 = (duel.p1_payout as u128) + (duel.p0_premium as u128);

    let (payout_to_p0, payout_to_p1, winner) = if (val0 > val1) {
        (total, 0, p0)
    } else if (val1 > val0) {
        (0, total, p1)
    } else {
        // Tie
        (total_p0, total_p1, @0x0)
    };

    pay_player(&mut duel.p0_stake, &mut duel.p1_stake, p0, payout_to_p0, ctx);
    pay_player(&mut duel.p0_stake, &mut duel.p1_stake, p1, payout_to_p1, ctx);

    duel.status = STATUS_COMPLETE;

    event::emit(DuelFinalized {
        duel_id: object::id(duel),
        winner,
        payout_to_p0,
        payout_to_p1,
    });
}

// === Read API ===

public fun status<T>(duel: &Duel<T>): u8 { duel.status }

public fun is_complete<T>(duel: &Duel<T>): bool { duel.status == STATUS_COMPLETE }

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

public fun settled_count<T>(duel: &Duel<T>): u64 { duel.settled_count }

public fun p0_next_card_idx<T>(duel: &Duel<T>): u64 { duel.p0_next_card_idx }

public fun p1_next_card_idx<T>(duel: &Duel<T>): u64 { duel.p1_next_card_idx }

public fun status_pending(): u8 { STATUS_PENDING }

public fun status_active(): u8 { STATUS_ACTIVE }

public fun status_complete(): u8 { STATUS_COMPLETE }

public fun deck_size(): u64 { DECK_SIZE }

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
public fun test_deck_size(): u64 { DECK_SIZE }

public fun dummy_deps(_deep: &DEEP) {
    db_constants::float_scaling();
}

