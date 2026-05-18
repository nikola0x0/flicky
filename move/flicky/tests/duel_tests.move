// Copyright (c) Flicky Labs
// SPDX-License-Identifier: Apache-2.0

#[test_only]
module flicky::duel_tests;

use flicky::duel::{Self, Duel};
use flicky::oracle::{Self, FlickyOracle, OracleAdminCap};
use std::unit_test::{assert_eq, destroy};
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

const MIN_STRIKE: u64 = 50_000_000_000_000; // $50k
const TICK_SIZE: u64 = 1_000_000_000; // $1
const NUM_TICKS: u64 = 100_000;
const SETTLEMENT_FRESHNESS_MS: u64 = 600_000;
const MAX_SPOT_DEVIATION: u64 = 200_000_000; // 20%

// Default seeded spot (~$80k) and the strike we use throughout (ATM = $80k).
const SEED_SPOT: u64 = 80_000_000_000_000;
const ATM_STRIKE: u64 = 80_000_000_000_000;

fun setup_scenario(): (Scenario, Clock, OracleAdminCap) {
    let mut scenario = ts::begin(ADMIN);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(START_MS);
    let cap = oracle::init_for_testing(scenario.ctx());
    (scenario, clock, cap)
}

fun teardown(scenario: Scenario, clock: Clock, cap: OracleAdminCap) {
    destroy(clock);
    destroy(cap);
    scenario.end();
}

/// Create a single oracle, seed an ATM price, and return its ID.
fun create_seeded_oracle(
    scenario: &mut Scenario,
    cap: &OracleAdminCap,
    clock: &Clock,
): ID {
    oracle::create_oracle(
        cap,
        b"BTC".to_string(),
        clock.timestamp_ms() + ORACLE_TTL_MS,
        MIN_STRIKE,
        TICK_SIZE,
        NUM_TICKS,
        SETTLEMENT_FRESHNESS_MS,
        MAX_SPOT_DEVIATION,
        clock,
        scenario.ctx(),
    );
    scenario.next_tx(ADMIN);
    let mut o = scenario.take_shared<FlickyOracle>();
    let oid = object::id(&o);
    o.update_price(cap, SEED_SPOT, SEED_SPOT, 600_000_000, START_MS, clock);
    ts::return_shared(o);
    oid
}

/// Build a 5-card deck where every card is the same (oracle, ATM_STRIKE).
fun atm_deck(oracle: &FlickyOracle): vector<duel::Card> {
    let mut deck = vector<duel::Card>[];
    duel::test_deck_size().do!(|_| deck.push_back(duel::new_card(oracle, ATM_STRIKE)));
    deck
}

fun take_oracle(scenario: &mut Scenario, sender: address): FlickyOracle {
    scenario.next_tx(sender);
    scenario.take_shared<FlickyOracle>()
}

fun take_duel(scenario: &mut Scenario, sender: address): Duel<SUI> {
    scenario.next_tx(sender);
    scenario.take_shared<Duel<SUI>>()
}

fun mint_sui(amount: u64, scenario: &mut Scenario): coin::Coin<SUI> {
    coin::mint_for_testing<SUI>(amount, scenario.ctx())
}

/// Common setup: create oracle + duel created by ALICE.
/// Returns oracle borrowed from scenario; caller must return_shared.
fun create_duel_with_alice(
    scenario: &mut Scenario,
    cap: &OracleAdminCap,
    clock: &Clock,
): ID {
    create_seeded_oracle(scenario, cap, clock);
    scenario.next_tx(ALICE);
    let oracle_ref = scenario.take_shared<FlickyOracle>();
    let deck = atm_deck(&oracle_ref);
    ts::return_shared(oracle_ref);
    duel::create_duel<SUI>(mint_sui(STAKE_AMOUNT, scenario), deck, scenario.ctx())
}

// === create_duel ===

#[test]
fun create_duel_starts_pending() {
    let (mut scenario, clock, cap) = setup_scenario();
    create_duel_with_alice(&mut scenario, &cap, &clock);

    let duel = take_duel(&mut scenario, ALICE);
    assert_eq!(duel.status(), duel::status_pending());
    assert_eq!(duel.creator(), ALICE);
    assert_eq!(duel.challenger(), @0x0);
    assert_eq!(duel.p0_stake_value(), STAKE_AMOUNT);
    assert_eq!(duel.p1_stake_value(), 0);
    assert_eq!(duel.started_at_ms(), 0);
    assert_eq!(duel.deck().length(), duel::test_deck_size());

    ts::return_shared(duel);
    teardown(scenario, clock, cap);
}

#[test, expected_failure(abort_code = duel::EInvalidDeckSize)]
fun create_duel_rejects_wrong_deck_size() {
    let (mut scenario, clock, cap) = setup_scenario();
    create_seeded_oracle(&mut scenario, &cap, &clock);
    let oracle_ref = take_oracle(&mut scenario, ALICE);
    let short_deck = vector[duel::new_card(&oracle_ref, ATM_STRIKE)];
    duel::create_duel<SUI>(mint_sui(STAKE_AMOUNT, &mut scenario), short_deck, scenario.ctx());
    abort 999
}

#[test, expected_failure(abort_code = duel::EZeroStake)]
fun create_duel_rejects_zero_stake() {
    let (mut scenario, clock, cap) = setup_scenario();
    create_seeded_oracle(&mut scenario, &cap, &clock);
    let oracle_ref = take_oracle(&mut scenario, ALICE);
    let deck = atm_deck(&oracle_ref);
    ts::return_shared(oracle_ref);
    duel::create_duel<SUI>(mint_sui(0, &mut scenario), deck, scenario.ctx());
    abort 999
}

#[test, expected_failure(abort_code = duel::EInvalidStrike)]
fun new_card_rejects_off_grid_strike() {
    let (mut scenario, clock, cap) = setup_scenario();
    create_seeded_oracle(&mut scenario, &cap, &clock);
    let oracle_ref = take_oracle(&mut scenario, ALICE);
    let _ = duel::new_card(&oracle_ref, MIN_STRIKE - 1);
    abort 999
}

// === join_duel ===

#[test]
fun join_duel_starts_active() {
    let (mut scenario, mut clock, cap) = setup_scenario();
    create_duel_with_alice(&mut scenario, &cap, &clock);

    clock.set_for_testing(START_MS + 1_000);
    let mut duel = take_duel(&mut scenario, BOB);
    duel.join_duel(mint_sui(STAKE_AMOUNT, &mut scenario), &clock, scenario.ctx());

    assert_eq!(duel.status(), duel::status_active());
    assert_eq!(duel.challenger(), BOB);
    assert_eq!(duel.p1_stake_value(), STAKE_AMOUNT);
    assert_eq!(duel.started_at_ms(), START_MS + 1_000);

    ts::return_shared(duel);
    teardown(scenario, clock, cap);
}

#[test, expected_failure(abort_code = duel::ECreatorCannotJoin)]
fun join_duel_rejects_creator_self_join() {
    let (mut scenario, clock, cap) = setup_scenario();
    create_duel_with_alice(&mut scenario, &cap, &clock);

    let mut duel = take_duel(&mut scenario, ALICE);
    duel.join_duel(mint_sui(STAKE_AMOUNT, &mut scenario), &clock, scenario.ctx());
    abort 999
}

#[test, expected_failure(abort_code = duel::EStakeMismatch)]
fun join_duel_rejects_stake_mismatch() {
    let (mut scenario, clock, cap) = setup_scenario();
    create_duel_with_alice(&mut scenario, &cap, &clock);

    let mut duel = take_duel(&mut scenario, BOB);
    duel.join_duel(mint_sui(STAKE_AMOUNT - 1, &mut scenario), &clock, scenario.ctx());
    abort 999
}

#[test, expected_failure(abort_code = duel::EDuelNotPending)]
fun join_duel_rejects_second_join() {
    let (mut scenario, clock, cap) = setup_scenario();
    create_duel_with_alice(&mut scenario, &cap, &clock);

    let mut duel = take_duel(&mut scenario, BOB);
    duel.join_duel(mint_sui(STAKE_AMOUNT, &mut scenario), &clock, scenario.ctx());
    ts::return_shared(duel);

    let mut duel2 = take_duel(&mut scenario, EVE);
    duel2.join_duel(mint_sui(STAKE_AMOUNT, &mut scenario), &clock, scenario.ctx());
    abort 999
}

// === record_swipe ===

#[test]
fun record_swipe_works() {
    let (mut scenario, mut clock, cap) = setup_scenario();
    create_duel_with_alice(&mut scenario, &cap, &clock);

    {
        let mut duel = take_duel(&mut scenario, BOB);
        duel.join_duel(mint_sui(STAKE_AMOUNT, &mut scenario), &clock, scenario.ctx());
        ts::return_shared(duel);
    };

    // Alice swipes card 0 UP at +2s (fast multiplier).
    clock.set_for_testing(START_MS + 2_000);
    let oracle_ref = take_oracle(&mut scenario, ALICE);
    let mut duel = take_duel(&mut scenario, ALICE);
    duel.record_swipe(&oracle_ref, 0, true, &clock, scenario.ctx());
    assert_eq!(duel.p0_next_card_idx(), 1);

    ts::return_shared(duel);
    ts::return_shared(oracle_ref);
    teardown(scenario, clock, cap);
}

#[test, expected_failure(abort_code = duel::EOutOfTurn)]
fun record_swipe_rejects_out_of_order() {
    let (mut scenario, clock, cap) = setup_scenario();
    create_duel_with_alice(&mut scenario, &cap, &clock);

    {
        let mut duel = take_duel(&mut scenario, BOB);
        duel.join_duel(mint_sui(STAKE_AMOUNT, &mut scenario), &clock, scenario.ctx());
        ts::return_shared(duel);
    };

    let oracle_ref = take_oracle(&mut scenario, ALICE);
    let mut duel = take_duel(&mut scenario, ALICE);
    // Alice tries card 2 without swiping 0 and 1.
    duel.record_swipe(&oracle_ref, 2, true, &clock, scenario.ctx());
    abort 999
}

#[test, expected_failure(abort_code = duel::ENotPlayer)]
fun record_swipe_rejects_non_player() {
    let (mut scenario, clock, cap) = setup_scenario();
    create_duel_with_alice(&mut scenario, &cap, &clock);

    {
        let mut duel = take_duel(&mut scenario, BOB);
        duel.join_duel(mint_sui(STAKE_AMOUNT, &mut scenario), &clock, scenario.ctx());
        ts::return_shared(duel);
    };

    let oracle_ref = take_oracle(&mut scenario, EVE);
    let mut duel = take_duel(&mut scenario, EVE);
    duel.record_swipe(&oracle_ref, 0, true, &clock, scenario.ctx());
    abort 999
}

#[test, expected_failure(abort_code = duel::EDuelNotActive)]
fun record_swipe_rejects_when_pending() {
    let (mut scenario, clock, cap) = setup_scenario();
    create_duel_with_alice(&mut scenario, &cap, &clock);

    let oracle_ref = take_oracle(&mut scenario, ALICE);
    let mut duel = take_duel(&mut scenario, ALICE);
    duel.record_swipe(&oracle_ref, 0, true, &clock, scenario.ctx());
    abort 999
}

// === settle_card + finalize ===

/// Helper: run a full 5-card duel between Alice (always UP) and Bob (always DOWN),
/// then return the (alice_score, bob_score) once finalized.
fun run_full_duel(
    scenario: &mut Scenario,
    cap: &OracleAdminCap,
    clock: &mut Clock,
    swipe_delay_ms: u64,
    alice_is_up: bool,
    bob_is_up: bool,
    settlement_price: u64,
): (u64, u64) {
    create_duel_with_alice(scenario, cap, clock);

    // Bob joins.
    let mut duel = take_duel(scenario, BOB);
    duel.join_duel(mint_sui(STAKE_AMOUNT, scenario), clock, scenario.ctx());
    ts::return_shared(duel);

    // Both players swipe all 5 cards. Advance the clock by swipe_delay_ms
    // between swipes so each swipe's `decide_time_ms` lands in the fast tier.
    let mut t = clock.timestamp_ms();
    let deck_size = duel::test_deck_size();
    let mut i = 0;
    while (i < deck_size) {
        t = t + swipe_delay_ms;
        clock.set_for_testing(t);

        // Alice swipes card i.
        let oracle_a = take_oracle(scenario, ALICE);
        let mut duel_a = take_duel(scenario, ALICE);
        duel_a.record_swipe(&oracle_a, i, alice_is_up, clock, scenario.ctx());
        ts::return_shared(duel_a);
        ts::return_shared(oracle_a);

        // Bob swipes card i (his decide_time clock is independent, also fast).
        let oracle_b = take_oracle(scenario, BOB);
        let mut duel_b = take_duel(scenario, BOB);
        duel_b.record_swipe(&oracle_b, i, bob_is_up, clock, scenario.ctx());
        ts::return_shared(duel_b);
        ts::return_shared(oracle_b);

        i = i + 1;
    };

    // Advance past expiry, settle oracle, then settle each card.
    let expiry = START_MS + ORACLE_TTL_MS;
    clock.set_for_testing(expiry + 1_000);
    let mut oracle_s = take_oracle(scenario, ADMIN);
    oracle_s.settle(cap, settlement_price, expiry + 500, clock);
    let oracle_id = object::id(&oracle_s);
    ts::return_shared(oracle_s);

    // Settle all 5 cards.
    let mut j = 0;
    while (j < deck_size) {
        let o = take_oracle(scenario, ADMIN);
        assert_eq!(object::id(&o), oracle_id); // sanity
        let mut d = take_duel(scenario, ADMIN);
        d.settle_card(&o, j);
        ts::return_shared(d);
        ts::return_shared(o);
        j = j + 1;
    };

    // Finalize.
    let mut d = take_duel(scenario, ADMIN);
    d.finalize(scenario.ctx());
    let p0 = d.p0_score();
    let p1 = d.p1_score();
    assert_eq!(d.status(), duel::status_complete());
    ts::return_shared(d);
    (p0, p1)
}

#[test]
fun full_duel_alice_wins_when_settlement_above_strike() {
    let (mut scenario, mut clock, cap) = setup_scenario();
    // Alice UP, Bob DOWN, settlement > strike → Alice gets all 5 correct.
    let (a, b) = run_full_duel(
        &mut scenario,
        &cap,
        &mut clock,
        2_000, // fast swipes
        true,
        false,
        ATM_STRIKE + 1_000_000_000,
    );
    assert!(a > 0);
    assert_eq!(b, 0);

    // Verify Alice received the full pot at finalize. Bob's stake went to Alice.
    scenario.next_tx(ALICE);
    let payout = scenario.take_from_address<coin::Coin<SUI>>(ALICE);
    assert_eq!(payout.value(), STAKE_AMOUNT * 2);
    destroy(payout);
    teardown(scenario, clock, cap);
}

#[test]
fun full_duel_bob_wins_when_settlement_below_strike() {
    let (mut scenario, mut clock, cap) = setup_scenario();
    let (a, b) = run_full_duel(
        &mut scenario,
        &cap,
        &mut clock,
        2_000,
        true, // Alice UP (wrong)
        false, // Bob DOWN (right)
        ATM_STRIKE - 1_000_000_000,
    );
    assert_eq!(a, 0);
    assert!(b > 0);

    scenario.next_tx(BOB);
    let payout = scenario.take_from_address<coin::Coin<SUI>>(BOB);
    assert_eq!(payout.value(), STAKE_AMOUNT * 2);
    destroy(payout);
    teardown(scenario, clock, cap);
}

#[test]
fun full_duel_tie_refunds_stakes() {
    let (mut scenario, mut clock, cap) = setup_scenario();
    // Both pick UP, settlement > strike → both correct, identical pace.
    let (a, b) = run_full_duel(
        &mut scenario,
        &cap,
        &mut clock,
        2_000,
        true,
        true,
        ATM_STRIKE + 1_000_000_000,
    );
    assert_eq!(a, b);
    assert!(a > 0);

    // Both refunded their original stake.
    scenario.next_tx(ALICE);
    let alice_payout = scenario.take_from_address<coin::Coin<SUI>>(ALICE);
    assert_eq!(alice_payout.value(), STAKE_AMOUNT);
    destroy(alice_payout);

    scenario.next_tx(BOB);
    let bob_payout = scenario.take_from_address<coin::Coin<SUI>>(BOB);
    assert_eq!(bob_payout.value(), STAKE_AMOUNT);
    destroy(bob_payout);

    teardown(scenario, clock, cap);
}

#[test, expected_failure(abort_code = duel::EOracleNotSettled)]
fun settle_card_rejects_unsettled_oracle() {
    let (mut scenario, clock, cap) = setup_scenario();
    create_duel_with_alice(&mut scenario, &cap, &clock);
    // Bob joins.
    let mut duel = take_duel(&mut scenario, BOB);
    duel.join_duel(mint_sui(STAKE_AMOUNT, &mut scenario), &clock, scenario.ctx());
    ts::return_shared(duel);

    let oracle_ref = take_oracle(&mut scenario, ADMIN);
    let mut d = take_duel(&mut scenario, ADMIN);
    d.settle_card(&oracle_ref, 0);
    abort 999
}

#[test, expected_failure(abort_code = duel::EAllCardsNotSettled)]
fun finalize_rejects_partial_settlement() {
    let (mut scenario, mut clock, cap) = setup_scenario();
    create_duel_with_alice(&mut scenario, &cap, &clock);
    let mut duel = take_duel(&mut scenario, BOB);
    duel.join_duel(mint_sui(STAKE_AMOUNT, &mut scenario), &clock, scenario.ctx());
    ts::return_shared(duel);

    // Skip swipes, just settle oracle and try to finalize without any cards settled.
    let expiry = START_MS + ORACLE_TTL_MS;
    clock.set_for_testing(expiry + 1_000);
    let mut o = take_oracle(&mut scenario, ADMIN);
    o.settle(&cap, ATM_STRIKE, expiry + 500, &clock);
    ts::return_shared(o);

    let mut d = take_duel(&mut scenario, ADMIN);
    d.finalize(scenario.ctx());
    abort 999
}

// === Scoring math ===

#[test]
fun atm_correct_fast_swipe_scores_three_x() {
    let (mut scenario, mut clock, cap) = setup_scenario();
    // Single-card audit: Alice UP, Bob no-op, settlement > strike.
    // At-the-money ~50% probability (Black-Scholes; slight σ²T/2 drift),
    // fast multiplier (1.5x), correct → card_score ≈ (1/0.5) * 1.5 = 3.0.
    let (a, b) = run_full_duel(
        &mut scenario,
        &cap,
        &mut clock,
        2_000,
        true,
        true, // both UP so both correct
        ATM_STRIKE + 1_000_000_000,
    );
    // 5 cards * ~3.0 = ~15.0. Allow 1% tolerance for BS drift vs flat 50%.
    let expected: u64 = 15_000_000_000;
    let tol: u64 = 150_000_000; // 1%
    assert!(a >= expected - tol && a <= expected + tol);
    assert!(b >= expected - tol && b <= expected + tol);
    teardown(scenario, clock, cap);
}

#[test]
fun slow_tier_multiplier_applies() {
    let (mut scenario, mut clock, cap) = setup_scenario();
    // 25s per swipe → slow tier (0.75x). 5 cards × ~1.5 ≈ 7.5.
    let (a, _) = run_full_duel(
        &mut scenario,
        &cap,
        &mut clock,
        25_000,
        true,
        true,
        ATM_STRIKE + 1_000_000_000,
    );
    let expected: u64 = 7_500_000_000;
    let tol: u64 = 75_000_000;
    assert!(a >= expected - tol && a <= expected + tol);
    teardown(scenario, clock, cap);
}

#[test]
fun timeout_scores_zero() {
    let (mut scenario, mut clock, cap) = setup_scenario();
    // 65s per swipe → past timeout, multiplier 0.
    let (a, b) = run_full_duel(
        &mut scenario,
        &cap,
        &mut clock,
        65_000,
        true,
        true,
        ATM_STRIKE + 1_000_000_000,
    );
    assert_eq!(a, 0);
    assert_eq!(b, 0);
    // Tie → both get their stake back.
    teardown(scenario, clock, cap);
}

#[test, expected_failure(abort_code = duel::EOracleNotLive)]
fun record_swipe_rejects_after_expiry() {
    let (mut scenario, mut clock, cap) = setup_scenario();
    create_duel_with_alice(&mut scenario, &cap, &clock);

    // Bob joins.
    let mut duel = take_duel(&mut scenario, BOB);
    duel.join_duel(mint_sui(STAKE_AMOUNT, &mut scenario), &clock, scenario.ctx());
    ts::return_shared(duel);

    // Advance past oracle expiry → status moves to PENDING_SETTLEMENT and the
    // fairness guard must reject any further swipes.
    clock.set_for_testing(START_MS + ORACLE_TTL_MS + 1);
    let oracle_ref = take_oracle(&mut scenario, ALICE);
    let mut duel = take_duel(&mut scenario, ALICE);
    duel.record_swipe(&oracle_ref, 0, true, &clock, scenario.ctx());
    abort 999
}
