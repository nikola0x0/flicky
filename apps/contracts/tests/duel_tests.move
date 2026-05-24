// Copyright (c) Flicky Labs
// SPDX-License-Identifier: Apache-2.0

#[test_only]
module flicky::duel_tests;

use deepbook_predict::oracle::{Self as db_oracle, OracleSVI};
use deepbook_predict::predict_manager::{Self, PredictManager};
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
// Wide enough to cover slow-swipe and timeout test cases (5 swipes * up-to-65s each).
const ORACLE_TTL_MS: u64 = 600_000;
const STAKE_AMOUNT: u64 = 100_000_000; // 0.1 SUI in mist

// Default strike we use throughout (ATM = $80k).
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

/// Create a single MarketOracle, activate it, share, return ID.
fun create_seeded_oracle(scenario: &mut Scenario, clock: &Clock): ID {
    let oracle = db_oracle::new_for_testing(
        clock.timestamp_ms() + ORACLE_TTL_MS,
        scenario.ctx(),
    );
    let oid = db_oracle::id(&oracle);
    db_oracle::share_for_testing(oracle);
    oid
}

/// Build a 5-card deck where every card is the same (oracle, ATM_STRIKE).
fun atm_deck(oracle: &OracleSVI): vector<duel::Card> {
    let mut deck = vector<duel::Card>[];
    duel::test_deck_size().do!(|_| deck.push_back(duel::new_card(oracle, ATM_STRIKE)));
    deck
}

fun deck_hash_of(cards: &vector<duel::Card>): vector<u8> {
    hash::sha2_256(bcs::to_bytes(cards))
}

fun take_oracle(scenario: &mut Scenario, sender: address): OracleSVI {
    scenario.next_tx(sender);
    scenario.take_shared<OracleSVI>()
}

fun take_duel(scenario: &mut Scenario, sender: address): Duel<SUI> {
    scenario.next_tx(sender);
    scenario.take_shared<Duel<SUI>>()
}

fun mint_sui(amount: u64, scenario: &mut Scenario): coin::Coin<SUI> {
    coin::mint_for_testing<SUI>(amount, scenario.ctx())
}

/// Common setup: create oracle + duel created by ALICE with the standard
/// ATM deck hash. The deck stays unrevealed until `reveal_atm_deck` is
/// called (typically right after the challenger joins).
fun create_duel_with_alice(scenario: &mut Scenario, clock: &Clock): ID {
    create_seeded_oracle(scenario, clock);
    scenario.next_tx(ALICE);
    let oracle_ref = scenario.take_shared<OracleSVI>();
    let cards = atm_deck(&oracle_ref);
    let h = deck_hash_of(&cards);
    ts::return_shared(oracle_ref);
    duel::create_duel<SUI>(mint_sui(STAKE_AMOUNT, scenario), h, scenario.ctx())
}

/// Reveal the ATM deck. Permissionless on chain, but in tests we call as
/// ADMIN so the scenario's tx ordering stays simple.
fun reveal_atm_deck(scenario: &mut Scenario) {
    let oracle_ref = take_oracle(scenario, ADMIN);
    let cards = atm_deck(&oracle_ref);
    let mut duel = take_duel(scenario, ADMIN);
    duel.reveal_deck(cards);
    ts::return_shared(duel);
    ts::return_shared(oracle_ref);
}

fun create_manager_for(player: address, scenario: &mut Scenario) {
    scenario.next_tx(player);
    let manager = predict_manager::new_manager_for_testing(player, 0, scenario.ctx());
    predict_manager::transfer_for_testing(manager, player);
}

fun set_manager_qty(player: address, qty: u64, scenario: &mut Scenario) {
    scenario.next_tx(player);
    let mut manager = scenario.take_from_address<PredictManager>(player);
    predict_manager::set_test_position_qty(&mut manager, qty);
    ts::return_to_address(player, manager);
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

// === create_duel ===

#[test]
fun create_duel_starts_pending_with_empty_deck() {
    let (mut scenario, clock) = setup_scenario();
    create_duel_with_alice(&mut scenario, &clock);

    let duel = take_duel(&mut scenario, ALICE);
    assert_eq!(duel.status(), duel::status_pending());
    assert_eq!(duel.creator(), ALICE);
    assert_eq!(duel.challenger(), @0x0);
    assert_eq!(duel.p0_stake_value(), STAKE_AMOUNT);
    assert_eq!(duel.p1_stake_value(), 0);
    assert_eq!(duel.started_at_ms(), 0);
    // Deck is hidden until reveal_deck.
    assert_eq!(duel.deck().length(), 0);
    assert_eq!(duel.deck_hash().length(), 32);

    ts::return_shared(duel);
    teardown(scenario, clock);
}

#[test, expected_failure(abort_code = duel::EInvalidDeckHash)]
fun create_duel_rejects_wrong_hash_length() {
    let (mut scenario, clock) = setup_scenario();
    create_seeded_oracle(&mut scenario, &clock);
    scenario.next_tx(ALICE);
    // 16-byte hash (not 32) — should abort.
    let bad = vector[0u8, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
    duel::create_duel<SUI>(mint_sui(STAKE_AMOUNT, &mut scenario), bad, scenario.ctx());
    abort 999
}

#[test, expected_failure(abort_code = duel::EZeroStake)]
fun create_duel_rejects_zero_stake() {
    let (mut scenario, clock) = setup_scenario();
    create_seeded_oracle(&mut scenario, &clock);
    let oracle_ref = take_oracle(&mut scenario, ALICE);
    let h = deck_hash_of(&atm_deck(&oracle_ref));
    ts::return_shared(oracle_ref);
    duel::create_duel<SUI>(mint_sui(0, &mut scenario), h, scenario.ctx());
    abort 999
}

// === join_duel ===

#[test]
fun join_duel_starts_active() {
    let (mut scenario, mut clock) = setup_scenario();
    create_duel_with_alice(&mut scenario, &clock);

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
    create_duel_with_alice(&mut scenario, &clock);

    let mut duel = take_duel(&mut scenario, ALICE);
    duel.join_duel(mint_sui(STAKE_AMOUNT, &mut scenario), &clock, scenario.ctx());
    abort 999
}

#[test, expected_failure(abort_code = duel::EStakeMismatch)]
fun join_duel_rejects_stake_mismatch() {
    let (mut scenario, clock) = setup_scenario();
    create_duel_with_alice(&mut scenario, &clock);

    let mut duel = take_duel(&mut scenario, BOB);
    duel.join_duel(mint_sui(STAKE_AMOUNT - 1, &mut scenario), &clock, scenario.ctx());
    abort 999
}

#[test, expected_failure(abort_code = duel::EDuelNotPending)]
fun join_duel_rejects_second_join() {
    let (mut scenario, clock) = setup_scenario();
    create_duel_with_alice(&mut scenario, &clock);

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
    create_duel_with_alice(&mut scenario, &clock);

    // Bob joins.
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
fun record_swipe_works() {
    let (mut scenario, mut clock) = setup_scenario();
    create_manager_for(ALICE, &mut scenario);
    create_duel_with_alice(&mut scenario, &clock);

    {
        let mut duel = take_duel(&mut scenario, BOB);
        duel.join_duel(mint_sui(STAKE_AMOUNT, &mut scenario), &clock, scenario.ctx());
        ts::return_shared(duel);
    };
    reveal_atm_deck(&mut scenario);

    clock.set_for_testing(START_MS + 2_000);
    set_manager_qty(ALICE, 100, &mut scenario);

    scenario.next_tx(ALICE);
    let manager = scenario.take_from_address<PredictManager>(ALICE);
    let mut oracle_ref = take_oracle(&mut scenario, ALICE);
    db_oracle::set_test_price(&mut oracle_ref, 500_000_000);
    let mut duel = take_duel(&mut scenario, ALICE);
    duel.record_swipe(&manager, &oracle_ref, 0, true, 100, 50, &clock, scenario.ctx());
    assert_eq!(duel.p0_next_card_idx(), 1);

    ts::return_shared(duel);
    ts::return_shared(oracle_ref);
    ts::return_to_address(ALICE, manager);
    teardown(scenario, clock);
}

// === settle_card + finalize ===

fun run_full_duel(
    scenario: &mut Scenario,
    clock: &mut Clock,
    swipe_delay_ms: u64,
    alice_is_up: bool,
    alice_qty: u64,
    alice_p_swiped: u64,
    bob_is_up: bool,
    bob_qty: u64,
    bob_p_swiped: u64,
    settlement_price: u64,
): (u64, u64) {
    create_manager_for(ALICE, scenario);
    create_manager_for(BOB, scenario);
    create_duel_with_alice(scenario, clock);

    // Bob joins.
    let mut duel = take_duel(scenario, BOB);
    duel.join_duel(mint_sui(STAKE_AMOUNT, scenario), clock, scenario.ctx());
    ts::return_shared(duel);
    reveal_atm_deck(scenario);

    let mut t = clock.timestamp_ms();
    let deck_size = duel::test_deck_size();
    let mut i = 0;
    while (i < deck_size) {
        t = t + swipe_delay_ms;
        clock.set_for_testing(t);

        // Alice swipes card i.
        set_manager_qty(ALICE, alice_qty, scenario);
        scenario.next_tx(ALICE);
        let manager_a = scenario.take_from_address<PredictManager>(ALICE);
        let mut oracle_a = take_oracle(scenario, ALICE);
        let alice_fair = if (alice_is_up) alice_p_swiped else (1_000_000_000 - alice_p_swiped);
        db_oracle::set_test_price(&mut oracle_a, alice_fair);
        let mut duel_a = take_duel(scenario, ALICE);
        let alice_premium = (((alice_qty as u128) * (alice_p_swiped as u128)) / 1_000_000_000) as u64;
        duel_a.record_swipe(&manager_a, &oracle_a, i, alice_is_up, alice_qty, alice_premium, clock, scenario.ctx());
        ts::return_shared(duel_a);
        ts::return_shared(oracle_a);
        ts::return_to_address(ALICE, manager_a);

        // Bob swipes card i.
        set_manager_qty(BOB, bob_qty, scenario);
        scenario.next_tx(BOB);
        let manager_b = scenario.take_from_address<PredictManager>(BOB);
        let mut oracle_b = take_oracle(scenario, BOB);
        let bob_fair = if (bob_is_up) bob_p_swiped else (1_000_000_000 - bob_p_swiped);
        db_oracle::set_test_price(&mut oracle_b, bob_fair);
        let mut duel_b = take_duel(scenario, BOB);
        let bob_premium = (((bob_qty as u128) * (bob_p_swiped as u128)) / 1_000_000_000) as u64;
        duel_b.record_swipe(&manager_b, &oracle_b, i, bob_is_up, bob_qty, bob_premium, clock, scenario.ctx());
        ts::return_shared(duel_b);
        ts::return_shared(oracle_b);
        ts::return_to_address(BOB, manager_b);

        i = i + 1;
    };

    // Advance past expiry, settle oracle, then settle each card.
    let expiry = START_MS + ORACLE_TTL_MS;
    clock.set_for_testing(expiry + 1_000);
    let mut oracle_s = take_oracle(scenario, ADMIN);
    db_oracle::settle_for_testing(&mut oracle_s, settlement_price);
    let oracle_id = db_oracle::id(&oracle_s);
    ts::return_shared(oracle_s);

    // Settle all 5 cards.
    let mut j = 0;
    while (j < deck_size) {
        let o = take_oracle(scenario, ADMIN);
        assert_eq!(db_oracle::id(&o), oracle_id);
        let mut d = take_duel(scenario, ADMIN);
        d.settle_card(&o, j);
        ts::return_shared(d);
        ts::return_shared(o);
        j = j + 1;
    };

    // Finalize.
    let mut d = take_duel(scenario, ADMIN);
    d.finalize(scenario.ctx());
    assert_eq!(d.status(), duel::status_complete());
    ts::return_shared(d);

    let alice_payout = get_payout_amount(ALICE, scenario);
    let bob_payout = get_payout_amount(BOB, scenario);
    (alice_payout, bob_payout)
}

#[test]
fun full_duel_alice_wins_when_settlement_above_strike() {
    let (mut scenario, mut clock) = setup_scenario();
    // Alice UP, Bob DOWN.
    // Alice swiped at 0.4 implied prob, Bob swiped at 0.6.
    // Settlement is above strike, so Alice gets payouts.
    let (a, b) = run_full_duel(
        &mut scenario,
        &mut clock,
        2_000,
        true, // Alice UP (correct)
        100, // Alice qty
        400_000_000, // Alice p_swiped
        false, // Bob DOWN (wrong)
        100, // Bob qty
        600_000_000, // Bob p_swiped
        ATM_STRIKE + 1_000_000_000,
    );
    assert_eq!(a, STAKE_AMOUNT * 2);
    assert_eq!(b, 0);

    teardown(scenario, clock);
}

#[test]
fun full_duel_bob_wins_when_settlement_below_strike() {
    let (mut scenario, mut clock) = setup_scenario();
    let (a, b) = run_full_duel(
        &mut scenario,
        &mut clock,
        2_000,
        true, // Alice UP (wrong)
        100,
        400_000_000,
        false, // Bob DOWN (correct)
        100,
        600_000_000,
        ATM_STRIKE - 1_000_000_000,
    );
    assert_eq!(a, 0);
    assert_eq!(b, STAKE_AMOUNT * 2);

    teardown(scenario, clock);
}

#[test]
fun full_duel_tie_refunds_stakes() {
    let (mut scenario, mut clock) = setup_scenario();
    // Both UP, both correct, same parameters -> Tie.
    let (a, b) = run_full_duel(
        &mut scenario,
        &mut clock,
        2_000,
        true,
        100,
        500_000_000,
        true,
        100,
        500_000_000,
        ATM_STRIKE + 1_000_000_000,
    );
    assert_eq!(a, STAKE_AMOUNT);
    assert_eq!(b, STAKE_AMOUNT);

    teardown(scenario, clock);
}

#[test, expected_failure(abort_code = duel::ESwipeTimeout)]
fun record_swipe_rejects_after_10_minutes() {
    let (mut scenario, mut clock) = setup_scenario();
    create_manager_for(ALICE, &mut scenario);
    create_duel_with_alice(&mut scenario, &clock);

    // Bob joins.
    {
        let mut duel = take_duel(&mut scenario, BOB);
        duel.join_duel(mint_sui(STAKE_AMOUNT, &mut scenario), &clock, scenario.ctx());
        ts::return_shared(duel);
    };
    reveal_atm_deck(&mut scenario);

    // Advance clock by 11 minutes (660,000 ms) -> past the 10-minute swipe window
    clock.set_for_testing(START_MS + 660_000);
    set_manager_qty(ALICE, 100, &mut scenario);

    scenario.next_tx(ALICE);
    let manager = scenario.take_from_address<PredictManager>(ALICE);
    let mut oracle_ref = take_oracle(&mut scenario, ALICE);
    db_oracle::set_test_price(&mut oracle_ref, 500_000_000);
    let mut duel = take_duel(&mut scenario, ALICE);
    duel.record_swipe(&manager, &oracle_ref, 0, true, 100, 50, &clock, scenario.ctx());
    
    ts::return_shared(duel);
    ts::return_shared(oracle_ref);
    ts::return_to_address(ALICE, manager);
    teardown(scenario, clock);
}

#[test, expected_failure(abort_code = duel::EOracleNotLive)]
fun record_swipe_rejects_after_expiry() {
    let (mut scenario, mut clock) = setup_scenario();
    create_manager_for(ALICE, &mut scenario);
    
    // Create oracle with 2 minutes expiry
    let short_ttl = 120_000;
    scenario.next_tx(ALICE);
    let oracle = db_oracle::new_for_testing(START_MS + short_ttl, scenario.ctx());
    let oracle_id = db_oracle::id(&oracle);
    db_oracle::share_for_testing(oracle);
    
    // Create deck of 5 cards with this oracle
    scenario.next_tx(ALICE);
    let oracle_ref = scenario.take_shared<OracleSVI>();
    let mut cards = vector<duel::Card>[];
    duel::test_deck_size().do!(|_| cards.push_back(duel::new_card(&oracle_ref, ATM_STRIKE)));
    let h = deck_hash_of(&cards);
    ts::return_shared(oracle_ref);
    
    let duel_id = duel::create_duel<SUI>(mint_sui(STAKE_AMOUNT, &mut scenario), h, scenario.ctx());
    
    // Bob joins
    scenario.next_tx(BOB);
    let mut duel = scenario.take_shared_by_id<Duel<SUI>>(duel_id);
    duel.join_duel(mint_sui(STAKE_AMOUNT, &mut scenario), &clock, scenario.ctx());
    ts::return_shared(duel);
    
    // Reveal deck
    scenario.next_tx(ADMIN);
    let mut duel = scenario.take_shared_by_id<Duel<SUI>>(duel_id);
    duel.reveal_deck(cards);
    ts::return_shared(duel);

    // Advance clock past oracle expiry (e.g. 3 minutes = 180,000 ms) but inside 10-minute swipe window
    clock.set_for_testing(START_MS + 180_000);
    set_manager_qty(ALICE, 100, &mut scenario);

    scenario.next_tx(ALICE);
    let manager = scenario.take_from_address<PredictManager>(ALICE);
    let mut oracle_ref = scenario.take_shared_by_id<OracleSVI>(oracle_id);
    db_oracle::set_test_price(&mut oracle_ref, 500_000_000);
    let mut duel = scenario.take_shared_by_id<Duel<SUI>>(duel_id);
    
    // This should fail with EOracleNotLive
    duel.record_swipe(&manager, &oracle_ref, 0, true, 100, 50, &clock, scenario.ctx());
    
    ts::return_shared(duel);
    ts::return_shared(oracle_ref);
    ts::return_to_address(ALICE, manager);
    teardown(scenario, clock);
}
