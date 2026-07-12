// Copyright (c) Flicky Labs
// SPDX-License-Identifier: Apache-2.0

#[test_only]
module flicky::duel_tests;

use account::account::{Self, AccountWrapper};
use flicky::duel::{Self, Duel};
use std::hash;
use std::unit_test::{assert_eq, destroy};
use sui::bcs;
use sui::clock::{Self, Clock};
use sui::coin;
use sui::sui::SUI;
use sui::test_scenario::{Self as ts, Scenario};

// === Test fixtures ===

const ADMIN: address = @0xA;
const ALICE: address = @0xA11CE;
const BOB: address = @0xB0B;
const EVE: address = @0xE1E;

const START_MS: u64 = 1_000_000;
const STAKE_AMOUNT: u64 = 100_000_000;
const ATM_STRIKE: u64 = 80_000_000_000_000;

fun setup_scenario(): (Scenario, Clock) {
    let mut scenario = ts::begin(ADMIN);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(START_MS);
    (scenario, clock)
}

fun teardown(scenario: Scenario, clock: Clock) {
    destroy(clock);
    scenario.end();
}

// A deterministic fake ExpiryMarket id for a card. `seed` distinguishes
// multiple cards in a deck.
fun fake_market_id(seed: u64): ID {
    object::id_from_address(sui::address::from_u256(seed as u256))
}

// Build a card from a market seed + strike (mirrors production `new_card`).
fun seeded_card(seed: u64, strike: u64): duel::Card {
    duel::new_card(fake_market_id(seed), strike)
}

// A deck of `n` cards, each pinned to market seed `i + 1` (i is the card
// index) with the ATM strike.
fun sized_deck(n: u64): vector<duel::Card> {
    let mut cards = vector<duel::Card>[];
    let mut i = 0;
    while (i < n) {
        cards.push_back(seeded_card(i + 1, ATM_STRIKE));
        i = i + 1;
    };
    cards
}

fun atm_deck(): vector<duel::Card> {
    sized_deck(duel::test_default_deck_size())
}

fun deck_hash_of(cards: &vector<duel::Card>): vector<u8> {
    hash::sha2_256(bcs::to_bytes(cards))
}

// Create + share an AccountWrapper for `player`, seeded with the given
// (market seed, order_id) positions so anti-replay `has_position` passes.
// `positions[i]` is the order_id for card index `i` (0 = no position seeded),
// `seeds[i]` is the market seed for that card. Returns the wrapper id so the
// caller can `take_shared_by_id` it at settle time.
fun create_wrapper_with_positions(
    scenario: &mut Scenario,
    player: address,
    positions: vector<u64>,
    seeds: vector<u64>,
): ID {
    scenario.next_tx(player);
    let mut w = account::new_wrapper_for_testing(player, scenario.ctx());
    let id = object::id(&w);
    let mut i = 0;
    while (i < positions.length()) {
        let oid = positions[i];
        if (oid != 0) {
            account::add_position_for_testing(&mut w, fake_market_id(seeds[i]), oid as u256);
        };
        i = i + 1;
    };
    account::share_for_testing(w);
    id
}

// Build parallel (order_id, seed) vectors seeding every card: card `i` gets
// order_id `base + i` on market seed `i + 1`.
fun full_positions(deck_size: u64, base: u64): (vector<u64>, vector<u64>) {
    let mut oids = vector<u64>[];
    let mut seeds = vector<u64>[];
    let mut i = 0;
    while (i < deck_size) {
        oids.push_back(base + i);
        seeds.push_back(i + 1);
        i = i + 1;
    };
    (oids, seeds)
}

fun take_duel(scenario: &mut Scenario, sender: address): Duel<SUI> {
    scenario.next_tx(sender);
    scenario.take_shared<Duel<SUI>>()
}

fun mint_sui(amount: u64, scenario: &mut Scenario): coin::Coin<SUI> {
    coin::mint_for_testing<SUI>(amount, scenario.ctx())
}

fun create_duel_with_alice(scenario: &mut Scenario): ID {
    scenario.next_tx(ALICE);
    let cards = atm_deck();
    let h = deck_hash_of(&cards);
    duel::create_duel<SUI>(mint_sui(STAKE_AMOUNT, scenario), h, 5, scenario.ctx())
}

fun reveal_atm_deck(scenario: &mut Scenario) {
    let cards = atm_deck();
    let mut duel = take_duel(scenario, ADMIN);
    duel.reveal_deck(cards);
    ts::return_shared(duel);
}

fun get_payout_amount(player: address, scenario: &mut Scenario): u64 {
    scenario.next_tx(player);
    if (ts::has_most_recent_for_address<coin::Coin<SUI>>(player)) {
        let coin = scenario.take_from_address<coin::Coin<SUI>>(player);
        let val = coin.value();
        ts::return_to_address(player, coin);
        val
    } else {
        0
    }
}

/// Settle every card via the keeper-fed `settle_card`. Feeds a single
/// `settlement_price` + per-player premium to each card (matching this
/// file's single-strike decks).
fun settle_all_cards(
    scenario: &mut Scenario,
    duel_id: ID,
    p0_wrapper_id: ID,
    p1_wrapper_id: ID,
    deck_size: u64,
    settlement_price: u64,
    p0_premium: u64,
    p1_premium: u64,
) {
    let mut k = 0;
    while (k < deck_size) {
        scenario.next_tx(ADMIN);
        let p0_w = scenario.take_shared_by_id<AccountWrapper>(p0_wrapper_id);
        let p1_w = scenario.take_shared_by_id<AccountWrapper>(p1_wrapper_id);
        let mut d = scenario.take_shared_by_id<Duel<SUI>>(duel_id);
        d.settle_card(&p0_w, &p1_w, k, settlement_price, p0_premium, p1_premium);
        ts::return_shared(d);
        ts::return_shared(p0_w);
        ts::return_shared(p1_w);
        k = k + 1;
    }
}

/// Free-tier counterpart to `settle_all_cards` — no AccountWrappers.
fun settle_all_cards_free(
    scenario: &mut Scenario,
    duel_id: ID,
    deck_size: u64,
    settlement_price: u64,
    p0_premium: u64,
    p1_premium: u64,
) {
    let mut k = 0;
    while (k < deck_size) {
        scenario.next_tx(ADMIN);
        let mut d = scenario.take_shared_by_id<Duel<SUI>>(duel_id);
        d.settle_card_free(k, settlement_price, p0_premium, p1_premium);
        ts::return_shared(d);
        k = k + 1;
    }
}

// === create_duel ===

#[test]
fun create_duel_starts_pending_with_empty_deck() {
    let (mut scenario, clock) = setup_scenario();
    create_duel_with_alice(&mut scenario);

    let duel = take_duel(&mut scenario, ALICE);
    assert_eq!(duel.status(), duel::status_pending());
    assert_eq!(duel.tier(), duel::tier_staked());
    assert_eq!(duel.creator(), ALICE);
    assert_eq!(duel.challenger(), @0x0);
    assert_eq!(duel.p0_stake_value(), STAKE_AMOUNT);
    assert_eq!(duel.p1_stake_value(), 0);
    assert_eq!(duel.started_at_ms(), 0);
    assert_eq!(duel.deck().length(), 0);
    assert_eq!(duel.deck_hash().length(), 32);

    ts::return_shared(duel);
    teardown(scenario, clock);
}

#[test, expected_failure(abort_code = duel::EInvalidDeckHash)]
fun create_duel_rejects_wrong_hash_length() {
    let (mut scenario, _clock) = setup_scenario();
    scenario.next_tx(ALICE);
    let bad = vector[0u8, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
    duel::create_duel<SUI>(mint_sui(STAKE_AMOUNT, &mut scenario), bad, 5, scenario.ctx());
    abort 999
}

#[test, expected_failure(abort_code = duel::EZeroStake)]
fun create_duel_rejects_zero_stake() {
    let (mut scenario, _clock) = setup_scenario();
    scenario.next_tx(ALICE);
    let h = deck_hash_of(&atm_deck());
    duel::create_duel<SUI>(mint_sui(0, &mut scenario), h, 5, scenario.ctx());
    abort 999
}

// === join_duel ===

#[test]
fun join_duel_starts_active() {
    let (mut scenario, mut clock) = setup_scenario();
    create_duel_with_alice(&mut scenario);

    clock.set_for_testing(START_MS + 1_000);
    let mut duel = take_duel(&mut scenario, BOB);
    duel.join_duel(mint_sui(STAKE_AMOUNT, &mut scenario), &clock, scenario.ctx());

    assert_eq!(duel.status(), duel::status_active());
    assert_eq!(duel.challenger(), BOB);
    assert_eq!(duel.p1_stake_value(), STAKE_AMOUNT);
    assert_eq!(duel.started_at_ms(), START_MS + 1_000);

    ts::return_shared(duel);
    teardown(scenario, clock);
}

#[test, expected_failure(abort_code = duel::ECreatorCannotJoin)]
fun join_duel_rejects_creator_self_join() {
    let (mut scenario, clock) = setup_scenario();
    create_duel_with_alice(&mut scenario);

    let mut duel = take_duel(&mut scenario, ALICE);
    duel.join_duel(mint_sui(STAKE_AMOUNT, &mut scenario), &clock, scenario.ctx());
    abort 999
}

#[test, expected_failure(abort_code = duel::EStakeMismatch)]
fun join_duel_rejects_stake_mismatch() {
    let (mut scenario, clock) = setup_scenario();
    create_duel_with_alice(&mut scenario);

    let mut duel = take_duel(&mut scenario, BOB);
    duel.join_duel(mint_sui(STAKE_AMOUNT - 1, &mut scenario), &clock, scenario.ctx());
    abort 999
}

#[test, expected_failure(abort_code = duel::EDuelNotPending)]
fun join_duel_rejects_second_join() {
    let (mut scenario, clock) = setup_scenario();
    create_duel_with_alice(&mut scenario);

    let mut duel = take_duel(&mut scenario, BOB);
    duel.join_duel(mint_sui(STAKE_AMOUNT, &mut scenario), &clock, scenario.ctx());
    ts::return_shared(duel);

    let mut duel2 = take_duel(&mut scenario, EVE);
    duel2.join_duel(mint_sui(STAKE_AMOUNT, &mut scenario), &clock, scenario.ctx());
    abort 999
}

// === reveal_deck ===

#[test]
fun reveal_deck_populates_cards() {
    let (mut scenario, clock) = setup_scenario();
    create_duel_with_alice(&mut scenario);

    let mut duel = take_duel(&mut scenario, BOB);
    duel.join_duel(mint_sui(STAKE_AMOUNT, &mut scenario), &clock, scenario.ctx());
    ts::return_shared(duel);

    reveal_atm_deck(&mut scenario);

    let duel = take_duel(&mut scenario, ALICE);
    assert_eq!(duel.deck().length(), 5);
    ts::return_shared(duel);
    teardown(scenario, clock);
}

// === record_swipe ===

#[test]
fun record_swipe_stores_order_id() {
    let (mut scenario, mut clock) = setup_scenario();

    // p0 wrapper seeded with position (market seed 1, order_id 42) for card 0.
    let p0_wrapper_id =
        create_wrapper_with_positions(&mut scenario, ALICE, vector[42u64], vector[1u64]);
    // p1 wrapper (Bob never swipes; empty is fine).
    let p1_wrapper_id =
        create_wrapper_with_positions(&mut scenario, BOB, vector[0u64], vector[1u64]);

    // One-card staked duel.
    scenario.next_tx(ALICE);
    let cards = sized_deck(1);
    let h = deck_hash_of(&cards);
    let duel_id = duel::create_duel<SUI>(mint_sui(STAKE_AMOUNT, &mut scenario), h, 1, scenario.ctx());

    scenario.next_tx(BOB);
    let mut duel = scenario.take_shared_by_id<Duel<SUI>>(duel_id);
    duel.join_duel(mint_sui(STAKE_AMOUNT, &mut scenario), &clock, scenario.ctx());
    ts::return_shared(duel);

    scenario.next_tx(ADMIN);
    let mut duel = scenario.take_shared_by_id<Duel<SUI>>(duel_id);
    duel.reveal_deck(cards);
    ts::return_shared(duel);

    clock.set_for_testing(START_MS + 2_000);
    scenario.next_tx(ALICE);
    let mut duel = scenario.take_shared_by_id<Duel<SUI>>(duel_id);
    duel.record_swipe(0, true, STAKE_AMOUNT, 42, &clock, scenario.ctx());
    assert_eq!(duel.p0_next_card_idx(), 1);
    ts::return_shared(duel);

    // Settle card 0 above strike, premium 0 → correct + position present pays
    // the full quantity.
    scenario.next_tx(ADMIN);
    let p0_w = scenario.take_shared_by_id<AccountWrapper>(p0_wrapper_id);
    let p1_w = scenario.take_shared_by_id<AccountWrapper>(p1_wrapper_id);
    let mut d = scenario.take_shared_by_id<Duel<SUI>>(duel_id);
    d.settle_card(&p0_w, &p1_w, 0, ATM_STRIKE + 1, 0, 0);
    assert_eq!(d.p0_payout(), STAKE_AMOUNT);
    ts::return_shared(d);
    ts::return_shared(p0_w);
    ts::return_shared(p1_w);

    teardown(scenario, clock);
}

// === full duel (per-card fed settle) ===

/// Drive a full 5-card staked duel: seed both players' wrappers for every
/// card, run swipes, feed `settlement_price` + per-player premiums to each
/// card, finalize, and return (alice_payout, bob_payout).
fun run_full_duel(
    scenario: &mut Scenario,
    clock: &mut Clock,
    alice_is_up: bool,
    alice_qty: u64,
    bob_is_up: bool,
    bob_qty: u64,
    settlement_price: u64,
    p0_premium: u64,
    p1_premium: u64,
): (u64, u64) {
    let deck_size = duel::test_default_deck_size();
    let (a_oids, a_seeds) = full_positions(deck_size, 100);
    let (b_oids, b_seeds) = full_positions(deck_size, 200);
    let p0_wrapper_id = create_wrapper_with_positions(scenario, ALICE, a_oids, a_seeds);
    let p1_wrapper_id = create_wrapper_with_positions(scenario, BOB, b_oids, b_seeds);

    let duel_id = create_duel_with_alice(scenario);

    scenario.next_tx(BOB);
    let mut duel = scenario.take_shared_by_id<Duel<SUI>>(duel_id);
    duel.join_duel(mint_sui(STAKE_AMOUNT, scenario), clock, scenario.ctx());
    ts::return_shared(duel);
    reveal_atm_deck(scenario);

    let mut t = clock.timestamp_ms();
    let mut i = 0;
    while (i < deck_size) {
        t = t + 2_000;
        clock.set_for_testing(t);

        let mut duel_a = take_duel(scenario, ALICE);
        duel_a.record_swipe(i, alice_is_up, alice_qty, (100 + i) as u256, clock, scenario.ctx());
        ts::return_shared(duel_a);

        let mut duel_b = take_duel(scenario, BOB);
        duel_b.record_swipe(i, bob_is_up, bob_qty, (200 + i) as u256, clock, scenario.ctx());
        ts::return_shared(duel_b);

        i = i + 1;
    };

    settle_all_cards(
        scenario, duel_id, p0_wrapper_id, p1_wrapper_id, deck_size,
        settlement_price, p0_premium, p1_premium,
    );

    scenario.next_tx(ADMIN);
    let mut d = scenario.take_shared_by_id<Duel<SUI>>(duel_id);
    d.finalize(clock, scenario.ctx());
    assert_eq!(d.status(), duel::status_complete());
    ts::return_shared(d);

    let alice_payout = get_payout_amount(ALICE, scenario);
    let bob_payout = get_payout_amount(BOB, scenario);
    (alice_payout, bob_payout)
}

#[test]
fun full_duel_alice_wins_when_settlement_above_strike() {
    let (mut scenario, mut clock) = setup_scenario();
    // Alice UP, Bob DOWN, settlement above strike → UP wins. premium = qty/2.
    let (a, b) = run_full_duel(
        &mut scenario,
        &mut clock,
        true, 100,
        false, 100,
        ATM_STRIKE + 1,
        50, 50,
    );
    assert_eq!(a, STAKE_AMOUNT * 2);
    assert_eq!(b, 0);

    teardown(scenario, clock);
}

#[test]
fun full_duel_bob_wins_when_settlement_below_strike() {
    let (mut scenario, mut clock) = setup_scenario();
    // Alice UP, Bob DOWN, settlement below strike → DOWN wins.
    let (a, b) = run_full_duel(
        &mut scenario,
        &mut clock,
        true, 100,
        false, 100,
        ATM_STRIKE - 1,
        50, 50,
    );
    assert_eq!(a, 0);
    assert_eq!(b, STAKE_AMOUNT * 2);

    teardown(scenario, clock);
}

#[test]
fun full_duel_tie_refunds_stakes() {
    let (mut scenario, mut clock) = setup_scenario();
    // Symmetric swipes (both UP) + equal premiums → tie, stakes refunded.
    let (a, b) = run_full_duel(
        &mut scenario,
        &mut clock,
        true, 100,
        true, 100,
        ATM_STRIKE + 1,
        50, 50,
    );
    assert_eq!(a, STAKE_AMOUNT);
    assert_eq!(b, STAKE_AMOUNT);

    teardown(scenario, clock);
}

#[test, expected_failure(abort_code = duel::ESwipeTimeout)]
fun record_swipe_rejects_after_10_minutes() {
    let (mut scenario, mut clock) = setup_scenario();
    create_duel_with_alice(&mut scenario);

    {
        let mut duel = take_duel(&mut scenario, BOB);
        duel.join_duel(mint_sui(STAKE_AMOUNT, &mut scenario), &clock, scenario.ctx());
        ts::return_shared(duel);
    };
    reveal_atm_deck(&mut scenario);

    // 11 minutes after start — past the 10-minute swipe window.
    clock.set_for_testing(START_MS + 660_000);
    let mut duel = take_duel(&mut scenario, ALICE);
    duel.record_swipe(0, true, 100, 42, &clock, scenario.ctx());

    ts::return_shared(duel);
    teardown(scenario, clock);
}

#[test]
fun early_redemption_penalty() {
    let (mut scenario, mut clock) = setup_scenario();
    let deck_size = duel::test_default_deck_size();

    // Alice's card-0 position is deliberately NOT seeded (order_id 0) —
    // simulates redeeming that position early. Her swipe still records
    // order_id 100 for card 0, which won't match → payout 0 for that card.
    let a_oids = vector[0u64, 101, 102, 103, 104];
    let seeds = vector[1u64, 2, 3, 4, 5];
    let b_oids = vector[200u64, 201, 202, 203, 204];
    let p0_wrapper_id = create_wrapper_with_positions(&mut scenario, ALICE, a_oids, seeds);
    let p1_wrapper_id = create_wrapper_with_positions(&mut scenario, BOB, b_oids, seeds);

    let duel_id = create_duel_with_alice(&mut scenario);
    scenario.next_tx(BOB);
    let mut duel = scenario.take_shared_by_id<Duel<SUI>>(duel_id);
    duel.join_duel(mint_sui(STAKE_AMOUNT, &mut scenario), &clock, scenario.ctx());
    ts::return_shared(duel);
    reveal_atm_deck(&mut scenario);

    let mut t = clock.timestamp_ms();
    let mut i = 0;
    while (i < deck_size) {
        t = t + 2_000;
        clock.set_for_testing(t);

        let mut duel_a = take_duel(&mut scenario, ALICE);
        duel_a.record_swipe(i, true, 100, (100 + i) as u256, &clock, scenario.ctx());
        ts::return_shared(duel_a);

        let mut duel_b = take_duel(&mut scenario, BOB);
        duel_b.record_swipe(i, true, 100, (200 + i) as u256, &clock, scenario.ctx());
        ts::return_shared(duel_b);

        i = i + 1;
    };

    // Settlement above strike → UP correct on every card, but Alice's card-0
    // payout is voided by the missing position (premium still counts).
    settle_all_cards(
        &mut scenario, duel_id, p0_wrapper_id, p1_wrapper_id, deck_size,
        ATM_STRIKE + 1_000_000, 50, 50,
    );

    scenario.next_tx(ADMIN);
    let mut d = scenario.take_shared_by_id<Duel<SUI>>(duel_id);
    d.finalize(&clock, scenario.ctx());
    assert_eq!(d.status(), duel::status_complete());
    ts::return_shared(d);

    let alice_payout = get_payout_amount(ALICE, &mut scenario);
    let bob_payout = get_payout_amount(BOB, &mut scenario);
    // Alice: 4 cards paid (400) vs Bob: 5 cards paid (500); equal premiums →
    // Bob wins the pot.
    assert_eq!(alice_payout, 0);
    assert_eq!(bob_payout, STAKE_AMOUNT * 2);

    teardown(scenario, clock);
}

#[test]
fun finalize_forfeit_wins() {
    let (mut scenario, mut clock) = setup_scenario();
    create_duel_with_alice(&mut scenario);

    let mut duel = take_duel(&mut scenario, BOB);
    duel.join_duel(mint_sui(STAKE_AMOUNT, &mut scenario), &clock, scenario.ctx());
    ts::return_shared(duel);
    reveal_atm_deck(&mut scenario);

    let mut t = clock.timestamp_ms();

    // Alice swipes 2 cards.
    let mut i = 0;
    while (i < 2) {
        t = t + 2_000;
        clock.set_for_testing(t);
        let mut duel_a = take_duel(&mut scenario, ALICE);
        duel_a.record_swipe(i, true, 100, (100 + i) as u256, &clock, scenario.ctx());
        ts::return_shared(duel_a);
        i = i + 1;
    };

    // Bob only swipes card 0.
    t = t + 2_000;
    clock.set_for_testing(t);
    let mut duel_b = take_duel(&mut scenario, BOB);
    duel_b.record_swipe(0, true, 100, 200, &clock, scenario.ctx());
    ts::return_shared(duel_b);

    // Past the 10-minute window — finalize hits the forfeit branch without
    // needing any cards settled.
    clock.set_for_testing(START_MS + 660_000);

    scenario.next_tx(ADMIN);
    let mut d = take_duel(&mut scenario, ADMIN);
    d.finalize(&clock, scenario.ctx());
    assert_eq!(d.status(), duel::status_complete());
    ts::return_shared(d);

    let alice_payout = get_payout_amount(ALICE, &mut scenario);
    let bob_payout = get_payout_amount(BOB, &mut scenario);
    assert_eq!(alice_payout, STAKE_AMOUNT * 2);
    assert_eq!(bob_payout, 0);

    teardown(scenario, clock);
}

// === variable deck size ===

#[test]
fun variable_deck_size_three_cards_works() {
    // Create a 3-card duel; verify full lifecycle works with N != 5.
    let (mut scenario, mut clock) = setup_scenario();
    let (a_oids, a_seeds) = full_positions(3, 100);
    let (b_oids, b_seeds) = full_positions(3, 200);
    let p0_wrapper_id = create_wrapper_with_positions(&mut scenario, ALICE, a_oids, a_seeds);
    let p1_wrapper_id = create_wrapper_with_positions(&mut scenario, BOB, b_oids, b_seeds);

    // Build a 3-card deck.
    scenario.next_tx(ALICE);
    let cards = sized_deck(3);
    let h = deck_hash_of(&cards);
    let duel_id = duel::create_duel<SUI>(mint_sui(STAKE_AMOUNT, &mut scenario), h, 3, scenario.ctx());

    // Bob joins.
    scenario.next_tx(BOB);
    let mut duel = scenario.take_shared_by_id<Duel<SUI>>(duel_id);
    duel.join_duel(mint_sui(STAKE_AMOUNT, &mut scenario), &clock, scenario.ctx());
    assert_eq!(duel.deck_size(), 3);
    ts::return_shared(duel);

    // Reveal.
    scenario.next_tx(ADMIN);
    let mut duel = scenario.take_shared_by_id<Duel<SUI>>(duel_id);
    duel.reveal_deck(cards);
    ts::return_shared(duel);

    // Both players swipe 3 cards each (Alice UP, Bob DOWN).
    let mut t = clock.timestamp_ms();
    let mut i = 0;
    while (i < 3) {
        t = t + 2_000;
        clock.set_for_testing(t);

        let mut duel_a = take_duel(&mut scenario, ALICE);
        duel_a.record_swipe(i, true, 100, (100 + i) as u256, &clock, scenario.ctx());
        ts::return_shared(duel_a);

        let mut duel_b = take_duel(&mut scenario, BOB);
        duel_b.record_swipe(i, false, 100, (200 + i) as u256, &clock, scenario.ctx());
        ts::return_shared(duel_b);

        i = i + 1;
    };

    // Settle each card above strike, then finalize.
    settle_all_cards(
        &mut scenario, duel_id, p0_wrapper_id, p1_wrapper_id, 3,
        ATM_STRIKE + 1_000_000, 50, 50,
    );

    scenario.next_tx(ADMIN);
    let mut d = scenario.take_shared_by_id<Duel<SUI>>(duel_id);
    d.finalize(&clock, scenario.ctx());
    assert_eq!(d.status(), duel::status_complete());
    ts::return_shared(d);

    let alice_payout = get_payout_amount(ALICE, &mut scenario);
    let bob_payout = get_payout_amount(BOB, &mut scenario);
    // Settlement > strike → all UP correct → Alice wins.
    assert_eq!(alice_payout, STAKE_AMOUNT * 2);
    assert_eq!(bob_payout, 0);

    teardown(scenario, clock);
}

#[test, expected_failure(abort_code = duel::EInvalidDeckSizeBounds)]
fun create_duel_rejects_deck_size_zero() {
    let (mut scenario, _clock) = setup_scenario();
    scenario.next_tx(ALICE);
    let h = deck_hash_of(&atm_deck());
    duel::create_duel<SUI>(mint_sui(STAKE_AMOUNT, &mut scenario), h, 0, scenario.ctx());
    abort 999
}

#[test, expected_failure(abort_code = duel::EInvalidDeckSizeBounds)]
fun create_duel_rejects_deck_size_above_max() {
    let (mut scenario, _clock) = setup_scenario();
    scenario.next_tx(ALICE);
    let h = deck_hash_of(&atm_deck());
    duel::create_duel<SUI>(mint_sui(STAKE_AMOUNT, &mut scenario), h, 21, scenario.ctx());
    abort 999
}

// === finalize_test_one_price (DEV ONLY) ===

#[test]
fun finalize_test_one_price_resolves_without_wrappers() {
    // Same duel setup as the staked happy-path, but instead of per-card
    // `settle_card` + `finalize`, call `finalize_test_one_price` with a single
    // fed price (free-style scoring: no anti-replay, premium 0).
    let (mut scenario, mut clock) = setup_scenario();
    create_duel_with_alice(&mut scenario);

    let mut duel = take_duel(&mut scenario, BOB);
    duel.join_duel(mint_sui(STAKE_AMOUNT, &mut scenario), &clock, scenario.ctx());
    ts::return_shared(duel);
    reveal_atm_deck(&mut scenario);

    let mut t = clock.timestamp_ms();
    let deck_size = duel::test_default_deck_size();
    let mut i = 0;
    while (i < deck_size) {
        t = t + 2_000;
        clock.set_for_testing(t);

        let mut duel_a = take_duel(&mut scenario, ALICE);
        duel_a.record_swipe(i, true, 100, (100 + i) as u256, &clock, scenario.ctx());
        ts::return_shared(duel_a);

        let mut duel_b = take_duel(&mut scenario, BOB);
        duel_b.record_swipe(i, false, 100, (200 + i) as u256, &clock, scenario.ctx());
        ts::return_shared(duel_b);

        i = i + 1;
    };

    // Price UP — Alice (UP) correct on all cards, Bob (DOWN) wrong.
    scenario.next_tx(ADMIN);
    let mut d = take_duel(&mut scenario, ADMIN);
    d.finalize_test_one_price(ATM_STRIKE + 1_000_000, &clock, scenario.ctx());
    assert_eq!(d.status(), duel::status_complete());
    ts::return_shared(d);

    let alice_payout = get_payout_amount(ALICE, &mut scenario);
    let bob_payout = get_payout_amount(BOB, &mut scenario);
    assert_eq!(alice_payout, STAKE_AMOUNT * 2);
    assert_eq!(bob_payout, 0);

    teardown(scenario, clock);
}

// === claim_reveal_timeout ===

#[test]
fun reveal_timeout_lets_challenger_claim_forfeit() {
    let (mut scenario, mut clock) = setup_scenario();
    let duel_id = create_duel_with_alice(&mut scenario);

    scenario.next_tx(BOB);
    let mut duel = scenario.take_shared_by_id<Duel<SUI>>(duel_id);
    duel.join_duel(mint_sui(STAKE_AMOUNT, &mut scenario), &clock, scenario.ctx());
    let started = duel.started_at_ms();
    ts::return_shared(duel);

    // Alice never reveals; Bob waits 5 min + 1s and claims forfeit.
    clock.set_for_testing(started + 300_001);
    scenario.next_tx(BOB);
    let mut duel = scenario.take_shared_by_id<Duel<SUI>>(duel_id);
    duel.claim_reveal_timeout(&clock, scenario.ctx());
    assert_eq!(duel.status(), duel::status_complete());
    ts::return_shared(duel);

    let alice_payout = get_payout_amount(ALICE, &mut scenario);
    let bob_payout = get_payout_amount(BOB, &mut scenario);
    assert_eq!(alice_payout, 0);
    assert_eq!(bob_payout, STAKE_AMOUNT * 2);

    teardown(scenario, clock);
}

#[test, expected_failure(abort_code = duel::ERevealNotTimedOut)]
fun reveal_timeout_rejects_before_5min() {
    let (mut scenario, mut clock) = setup_scenario();
    let duel_id = create_duel_with_alice(&mut scenario);

    scenario.next_tx(BOB);
    let mut duel = scenario.take_shared_by_id<Duel<SUI>>(duel_id);
    duel.join_duel(mint_sui(STAKE_AMOUNT, &mut scenario), &clock, scenario.ctx());
    let started = duel.started_at_ms();
    ts::return_shared(duel);

    clock.set_for_testing(started + 299_999); // 1ms before window expires
    scenario.next_tx(BOB);
    let mut duel = scenario.take_shared_by_id<Duel<SUI>>(duel_id);
    duel.claim_reveal_timeout(&clock, scenario.ctx());
    abort 999
}

#[test, expected_failure(abort_code = duel::EDeckAlreadyRevealed)]
fun reveal_timeout_rejects_after_reveal() {
    let (mut scenario, mut clock) = setup_scenario();
    let duel_id = create_duel_with_alice(&mut scenario);

    scenario.next_tx(BOB);
    let mut duel = scenario.take_shared_by_id<Duel<SUI>>(duel_id);
    duel.join_duel(mint_sui(STAKE_AMOUNT, &mut scenario), &clock, scenario.ctx());
    let started = duel.started_at_ms();
    ts::return_shared(duel);
    reveal_atm_deck(&mut scenario);

    clock.set_for_testing(started + 300_001);
    scenario.next_tx(BOB);
    let mut duel = scenario.take_shared_by_id<Duel<SUI>>(duel_id);
    duel.claim_reveal_timeout(&clock, scenario.ctx());
    abort 999
}

#[test, expected_failure(abort_code = duel::ENotPlayer)]
fun reveal_timeout_rejects_non_challenger() {
    let (mut scenario, mut clock) = setup_scenario();
    let duel_id = create_duel_with_alice(&mut scenario);

    scenario.next_tx(BOB);
    let mut duel = scenario.take_shared_by_id<Duel<SUI>>(duel_id);
    duel.join_duel(mint_sui(STAKE_AMOUNT, &mut scenario), &clock, scenario.ctx());
    let started = duel.started_at_ms();
    ts::return_shared(duel);

    clock.set_for_testing(started + 300_001);
    // ALICE (the host) tries to claim — should abort.
    scenario.next_tx(ALICE);
    let mut duel = scenario.take_shared_by_id<Duel<SUI>>(duel_id);
    duel.claim_reveal_timeout(&clock, scenario.ctx());
    abort 999
}

// === refund_duel ===

#[test]
fun refund_pending_by_creator() {
    let (mut scenario, clock) = setup_scenario();
    let duel_id = create_duel_with_alice(&mut scenario);

    scenario.next_tx(ALICE);
    let mut duel = scenario.take_shared_by_id<Duel<SUI>>(duel_id);
    duel.refund_duel(&clock, scenario.ctx());
    assert_eq!(duel.status(), duel::status_complete());
    ts::return_shared(duel);

    let alice_refund = get_payout_amount(ALICE, &mut scenario);
    assert_eq!(alice_refund, STAKE_AMOUNT);

    teardown(scenario, clock);
}

#[test]
fun refund_active_after_one_hour_timeout() {
    let (mut scenario, mut clock) = setup_scenario();
    let duel_id = create_duel_with_alice(&mut scenario);

    scenario.next_tx(BOB);
    let mut duel = scenario.take_shared_by_id<Duel<SUI>>(duel_id);
    duel.join_duel(mint_sui(STAKE_AMOUNT, &mut scenario), &clock, scenario.ctx());
    let started_at = duel.started_at_ms();
    ts::return_shared(duel);

    clock.set_for_testing(started_at + 3_601_000);

    scenario.next_tx(BOB);
    let mut duel = scenario.take_shared_by_id<Duel<SUI>>(duel_id);
    duel.refund_duel(&clock, scenario.ctx());
    assert_eq!(duel.status(), duel::status_complete());
    ts::return_shared(duel);

    let alice_refund = get_payout_amount(ALICE, &mut scenario);
    let bob_refund = get_payout_amount(BOB, &mut scenario);
    assert_eq!(alice_refund, STAKE_AMOUNT);
    assert_eq!(bob_refund, STAKE_AMOUNT);

    teardown(scenario, clock);
}

/// Regression: once both players have completed all 5 swipes, refund is
/// blocked even past the 1-hour window — `finalize` is permissionless and
/// any party can call it, so a loser cannot dodge by stalling.
#[test, expected_failure(abort_code = duel::ERefundDuelComplete)]
fun refund_rejected_when_both_completed_all_swipes() {
    let (mut scenario, mut clock) = setup_scenario();
    create_duel_with_alice(&mut scenario);

    let mut duel = take_duel(&mut scenario, BOB);
    duel.join_duel(mint_sui(STAKE_AMOUNT, &mut scenario), &clock, scenario.ctx());
    ts::return_shared(duel);
    reveal_atm_deck(&mut scenario);

    let mut t = clock.timestamp_ms();
    let deck_size = duel::test_default_deck_size();
    let mut i = 0;
    while (i < deck_size) {
        t = t + 2_000;
        clock.set_for_testing(t);

        let mut duel_a = take_duel(&mut scenario, ALICE);
        duel_a.record_swipe(i, true, 100, (100 + i) as u256, &clock, scenario.ctx());
        ts::return_shared(duel_a);

        let mut duel_b = take_duel(&mut scenario, BOB);
        duel_b.record_swipe(i, false, 100, (200 + i) as u256, &clock, scenario.ctx());
        ts::return_shared(duel_b);

        i = i + 1;
    };

    clock.set_for_testing(START_MS + 3_601_000);
    scenario.next_tx(BOB);
    let mut d = take_duel(&mut scenario, BOB);
    d.refund_duel(&clock, scenario.ctx());

    abort 999
}

// === Free tier ===

fun create_free_duel_with_alice(scenario: &mut Scenario): ID {
    scenario.next_tx(ALICE);
    let cards = atm_deck();
    let h = deck_hash_of(&cards);
    duel::create_duel_free<SUI>(h, 5, scenario.ctx())
}

#[test]
fun free_tier_full_duel_runs_with_no_stake_and_no_manager() {
    let (mut scenario, mut clock) = setup_scenario();
    let duel_id = create_free_duel_with_alice(&mut scenario);

    scenario.next_tx(BOB);
    let mut duel = scenario.take_shared_by_id<Duel<SUI>>(duel_id);
    assert_eq!(duel.tier(), duel::tier_free());
    duel.join_duel_free(&clock, scenario.ctx());
    assert_eq!(duel.status(), duel::status_active());
    ts::return_shared(duel);

    reveal_atm_deck(&mut scenario);

    let mut t = clock.timestamp_ms();
    let deck_size = duel::test_default_deck_size();
    let mut i = 0;
    while (i < deck_size) {
        t = t + 2_000;
        clock.set_for_testing(t);

        let mut duel_a = take_duel(&mut scenario, ALICE);
        duel_a.record_swipe_free(i, true, &clock, scenario.ctx());
        ts::return_shared(duel_a);

        let mut duel_b = take_duel(&mut scenario, BOB);
        duel_b.record_swipe_free(i, false, &clock, scenario.ctx());
        ts::return_shared(duel_b);

        i = i + 1;
    };

    settle_all_cards_free(
        &mut scenario, duel_id, duel::test_default_deck_size(),
        ATM_STRIKE + 1_000_000, 0, 0,
    );

    scenario.next_tx(ADMIN);
    let mut d = take_duel(&mut scenario, ADMIN);
    d.finalize_free(&clock, scenario.ctx());
    assert_eq!(d.status(), duel::status_complete());
    ts::return_shared(d);

    // Free tier escrows nothing → no payout coins for either player.
    let alice_payout = get_payout_amount(ALICE, &mut scenario);
    let bob_payout = get_payout_amount(BOB, &mut scenario);
    assert_eq!(alice_payout, 0);
    assert_eq!(bob_payout, 0);

    teardown(scenario, clock);
}

#[test, expected_failure(abort_code = duel::EWrongTier)]
fun free_tier_rejects_staked_swipe() {
    let (mut scenario, clock) = setup_scenario();
    let duel_id = create_free_duel_with_alice(&mut scenario);

    scenario.next_tx(BOB);
    let mut duel = scenario.take_shared_by_id<Duel<SUI>>(duel_id);
    duel.join_duel_free(&clock, scenario.ctx());
    ts::return_shared(duel);
    reveal_atm_deck(&mut scenario);

    scenario.next_tx(ALICE);
    let mut duel = scenario.take_shared_by_id<Duel<SUI>>(duel_id);
    duel.record_swipe(0, true, 100, 42, &clock, scenario.ctx());

    abort 999
}

#[test, expected_failure(abort_code = duel::EWrongTier)]
fun staked_tier_rejects_free_swipe() {
    let (mut scenario, clock) = setup_scenario();
    create_duel_with_alice(&mut scenario);

    let mut duel = take_duel(&mut scenario, BOB);
    duel.join_duel(mint_sui(STAKE_AMOUNT, &mut scenario), &clock, scenario.ctx());
    ts::return_shared(duel);
    reveal_atm_deck(&mut scenario);

    let mut duel = take_duel(&mut scenario, ALICE);
    duel.record_swipe_free(0, true, &clock, scenario.ctx());

    abort 999
}
