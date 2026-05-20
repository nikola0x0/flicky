// Copyright (c) Flicky Labs
// SPDX-License-Identifier: Apache-2.0

#[test_only]
module flicky::duel_tests;

use deepbook_predict::i64 as db_i64;
use deepbook_predict::oracle::{Self as db_oracle, OracleSVI};
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

// Default seeded spot ($80k) and the strike we use throughout (ATM = $80k).
// 1e9 fixed point: $80_000.00 → 80_000 × 1e9 = 80_000_000_000_000.
const SEED_SPOT: u64 = 80_000_000_000_000;
const ATM_STRIKE: u64 = 80_000_000_000_000;

// SVI params chosen so an ATM digital prices to N(d2) ≈ 0.5:
//   a = 1e-6 (1e9 scale → 1_000)
//   b = rho = m = sigma = 0
// → total_var = a, sqrt_var ≈ 3.16e-5, d2 ≈ -1.58e-5, N(d2) ≈ 0.49999...
const SVI_A: u64 = 1_000;

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

/// Create a single OracleSVI, activate it, seed prices + SVI, share, return ID.
fun create_seeded_oracle(scenario: &mut Scenario, clock: &Clock): ID {
    let mut oracle = db_oracle::new_for_testing(
        b"BTC".to_string(),
        clock.timestamp_ms() + ORACLE_TTL_MS,
        scenario.ctx(),
    );
    let oid = object::id(&oracle);
    oracle.activate_for_testing();
    oracle.set_prices_for_testing(SEED_SPOT, SEED_SPOT, clock);
    oracle.set_svi_for_testing(SVI_A, 0, db_i64::zero(), db_i64::zero(), 0);
    oracle.share_for_testing();
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

#[test, expected_failure(abort_code = duel::EDuelNotActive)]
fun reveal_deck_rejects_when_pending() {
    let (mut scenario, clock) = setup_scenario();
    create_duel_with_alice(&mut scenario, &clock);
    // Skip Bob's join — reveal on PENDING duel must abort.
    let oracle_ref = take_oracle(&mut scenario, ADMIN);
    let cards = atm_deck(&oracle_ref);
    let mut duel = take_duel(&mut scenario, ADMIN);
    duel.reveal_deck(cards);
    abort 999
}

#[test, expected_failure(abort_code = duel::EDeckHashMismatch)]
fun reveal_deck_rejects_wrong_plaintext() {
    let (mut scenario, clock) = setup_scenario();
    create_duel_with_alice(&mut scenario, &clock);

    let mut duel = take_duel(&mut scenario, BOB);
    duel.join_duel(mint_sui(STAKE_AMOUNT, &mut scenario), &clock, scenario.ctx());
    ts::return_shared(duel);

    // Reveal with cards that don't match the committed hash (different strike).
    let oracle_ref = take_oracle(&mut scenario, ADMIN);
    let mut wrong = vector<duel::Card>[];
    duel::test_deck_size().do!(|_| {
        wrong.push_back(duel::new_card(&oracle_ref, ATM_STRIKE + 1_000_000_000));
    });
    let mut d = take_duel(&mut scenario, ADMIN);
    d.reveal_deck(wrong);
    abort 999
}

#[test, expected_failure(abort_code = duel::EDeckAlreadyRevealed)]
fun reveal_deck_rejects_second_reveal() {
    let (mut scenario, clock) = setup_scenario();
    create_duel_with_alice(&mut scenario, &clock);

    let mut duel = take_duel(&mut scenario, BOB);
    duel.join_duel(mint_sui(STAKE_AMOUNT, &mut scenario), &clock, scenario.ctx());
    ts::return_shared(duel);

    reveal_atm_deck(&mut scenario);
    // Second reveal must abort.
    reveal_atm_deck(&mut scenario);
    abort 999
}

// === record_swipe ===

#[test]
fun record_swipe_works() {
    let (mut scenario, mut clock) = setup_scenario();
    create_duel_with_alice(&mut scenario, &clock);

    {
        let mut duel = take_duel(&mut scenario, BOB);
        duel.join_duel(mint_sui(STAKE_AMOUNT, &mut scenario), &clock, scenario.ctx());
        ts::return_shared(duel);
    };
    reveal_atm_deck(&mut scenario);

    // Alice swipes card 0 UP at +2s (fast multiplier).
    clock.set_for_testing(START_MS + 2_000);
    let oracle_ref = take_oracle(&mut scenario, ALICE);
    let mut duel = take_duel(&mut scenario, ALICE);
    duel.record_swipe(&oracle_ref, 0, true, &clock, scenario.ctx());
    assert_eq!(duel.p0_next_card_idx(), 1);

    ts::return_shared(duel);
    ts::return_shared(oracle_ref);
    teardown(scenario, clock);
}

#[test, expected_failure(abort_code = duel::EDeckNotRevealed)]
fun record_swipe_rejects_before_reveal() {
    let (mut scenario, clock) = setup_scenario();
    create_duel_with_alice(&mut scenario, &clock);

    {
        let mut duel = take_duel(&mut scenario, BOB);
        duel.join_duel(mint_sui(STAKE_AMOUNT, &mut scenario), &clock, scenario.ctx());
        ts::return_shared(duel);
    };
    // Skip reveal — swipe must abort.
    let oracle_ref = take_oracle(&mut scenario, ALICE);
    let mut duel = take_duel(&mut scenario, ALICE);
    duel.record_swipe(&oracle_ref, 0, true, &clock, scenario.ctx());
    abort 999
}

#[test, expected_failure(abort_code = duel::EOutOfTurn)]
fun record_swipe_rejects_out_of_order() {
    let (mut scenario, clock) = setup_scenario();
    create_duel_with_alice(&mut scenario, &clock);

    {
        let mut duel = take_duel(&mut scenario, BOB);
        duel.join_duel(mint_sui(STAKE_AMOUNT, &mut scenario), &clock, scenario.ctx());
        ts::return_shared(duel);
    };
    reveal_atm_deck(&mut scenario);

    let oracle_ref = take_oracle(&mut scenario, ALICE);
    let mut duel = take_duel(&mut scenario, ALICE);
    // Alice tries card 2 without swiping 0 and 1.
    duel.record_swipe(&oracle_ref, 2, true, &clock, scenario.ctx());
    abort 999
}

#[test, expected_failure(abort_code = duel::ENotPlayer)]
fun record_swipe_rejects_non_player() {
    let (mut scenario, clock) = setup_scenario();
    create_duel_with_alice(&mut scenario, &clock);

    {
        let mut duel = take_duel(&mut scenario, BOB);
        duel.join_duel(mint_sui(STAKE_AMOUNT, &mut scenario), &clock, scenario.ctx());
        ts::return_shared(duel);
    };
    reveal_atm_deck(&mut scenario);

    let oracle_ref = take_oracle(&mut scenario, EVE);
    let mut duel = take_duel(&mut scenario, EVE);
    duel.record_swipe(&oracle_ref, 0, true, &clock, scenario.ctx());
    abort 999
}

#[test, expected_failure(abort_code = duel::EDuelNotActive)]
fun record_swipe_rejects_when_pending() {
    let (mut scenario, clock) = setup_scenario();
    create_duel_with_alice(&mut scenario, &clock);

    let oracle_ref = take_oracle(&mut scenario, ALICE);
    let mut duel = take_duel(&mut scenario, ALICE);
    duel.record_swipe(&oracle_ref, 0, true, &clock, scenario.ctx());
    abort 999
}

// === settle_card + finalize ===

/// Helper: run a full 5-card duel between Alice and Bob, then return
/// `(alice_score, bob_score)` once finalized.
fun run_full_duel(
    scenario: &mut Scenario,
    clock: &mut Clock,
    swipe_delay_ms: u64,
    alice_is_up: bool,
    bob_is_up: bool,
    settlement_price: u64,
): (u64, u64) {
    create_duel_with_alice(scenario, clock);

    // Bob joins.
    let mut duel = take_duel(scenario, BOB);
    duel.join_duel(mint_sui(STAKE_AMOUNT, scenario), clock, scenario.ctx());
    ts::return_shared(duel);
    reveal_atm_deck(scenario);

    // Both players swipe all 5 cards. Advance the clock by swipe_delay_ms
    // between swipes so each swipe's `decide_time_ms` lands in the chosen tier.
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
    oracle_s.settle_for_testing(settlement_price);
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
    let (mut scenario, mut clock) = setup_scenario();
    // Alice UP, Bob DOWN, settlement > strike → Alice gets all 5 correct.
    let (a, b) = run_full_duel(
        &mut scenario,
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
        false, // Bob DOWN (right)
        ATM_STRIKE - 1_000_000_000,
    );
    assert_eq!(a, 0);
    assert!(b > 0);

    scenario.next_tx(BOB);
    let payout = scenario.take_from_address<coin::Coin<SUI>>(BOB);
    assert_eq!(payout.value(), STAKE_AMOUNT * 2);
    destroy(payout);
    teardown(scenario, clock);
}

#[test]
fun full_duel_tie_refunds_stakes_when_decide_time_matches() {
    let (mut scenario, mut clock) = setup_scenario();
    // Both pick UP, settlement > strike → both correct, identical pace
    // ⇒ tied score AND tied total decide-time ⇒ each refunded.
    let (a, b) = run_full_duel(
        &mut scenario,
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

    teardown(scenario, clock);
}

#[test]
fun full_duel_score_tied_faster_player_wins_pot() {
    let (mut scenario, mut clock) = setup_scenario();
    create_duel_with_alice(&mut scenario, &clock);

    // Bob joins.
    {
        let mut d = take_duel(&mut scenario, BOB);
        d.join_duel(mint_sui(STAKE_AMOUNT, &mut scenario), &clock, scenario.ctx());
        ts::return_shared(d);
    };
    reveal_atm_deck(&mut scenario);

    // Both swipe DOWN on every card, settlement lands ABOVE strike → both
    // wrong → both score 0 ⇒ tied on score. Alice swipes faster (2 s) than
    // Bob (4 s extra advance per card), so Alice's total decide-time is
    // strictly smaller ⇒ tie-breaker picks Alice for the pot.
    let mut t = clock.timestamp_ms();
    let deck_size = duel::test_deck_size();
    let mut i = 0;
    while (i < deck_size) {
        // Alice swipes first.
        t = t + 2_000;
        clock.set_for_testing(t);
        let oa = take_oracle(&mut scenario, ALICE);
        let mut da = take_duel(&mut scenario, ALICE);
        da.record_swipe(&oa, i, false, &clock, scenario.ctx());
        ts::return_shared(da);
        ts::return_shared(oa);

        // Bob swipes next (clock advanced further).
        t = t + 4_000;
        clock.set_for_testing(t);
        let ob = take_oracle(&mut scenario, BOB);
        let mut db = take_duel(&mut scenario, BOB);
        db.record_swipe(&ob, i, false, &clock, scenario.ctx());
        ts::return_shared(db);
        ts::return_shared(ob);

        i = i + 1;
    };

    // Advance + settle oracle + settle cards. Settlement ABOVE strike →
    // every DOWN swipe is wrong → 0/0 scores.
    let expiry = START_MS + ORACLE_TTL_MS;
    clock.set_for_testing(expiry + 1_000);
    {
        let mut o = take_oracle(&mut scenario, ADMIN);
        o.settle_for_testing(ATM_STRIKE + 1_000_000_000);
        ts::return_shared(o);
    };
    let mut j = 0;
    while (j < deck_size) {
        let o = take_oracle(&mut scenario, ADMIN);
        let mut d = take_duel(&mut scenario, ADMIN);
        d.settle_card(&o, j);
        ts::return_shared(d);
        ts::return_shared(o);
        j = j + 1;
    };

    let mut d = take_duel(&mut scenario, ADMIN);
    d.finalize(scenario.ctx());
    assert_eq!(d.p0_score(), 0);
    assert_eq!(d.p1_score(), 0);
    ts::return_shared(d);

    scenario.next_tx(ALICE);
    let payout = scenario.take_from_address<coin::Coin<SUI>>(ALICE);
    assert_eq!(payout.value(), STAKE_AMOUNT * 2);
    destroy(payout);

    teardown(scenario, clock);
}

#[test, expected_failure(abort_code = duel::EOracleNotSettled)]
fun settle_card_rejects_unsettled_oracle() {
    let (mut scenario, clock) = setup_scenario();
    create_duel_with_alice(&mut scenario, &clock);
    // Bob joins so the duel is ACTIVE; settle_card guards ACTIVE before
    // checking the oracle.
    let mut duel = take_duel(&mut scenario, BOB);
    duel.join_duel(mint_sui(STAKE_AMOUNT, &mut scenario), &clock, scenario.ctx());
    ts::return_shared(duel);
    reveal_atm_deck(&mut scenario);

    let oracle_ref = take_oracle(&mut scenario, ADMIN);
    let mut d = take_duel(&mut scenario, ADMIN);
    d.settle_card(&oracle_ref, 0);
    abort 999
}

#[test, expected_failure(abort_code = duel::EAllCardsNotSettled)]
fun finalize_rejects_partial_settlement() {
    let (mut scenario, mut clock) = setup_scenario();
    create_duel_with_alice(&mut scenario, &clock);
    let mut duel = take_duel(&mut scenario, BOB);
    duel.join_duel(mint_sui(STAKE_AMOUNT, &mut scenario), &clock, scenario.ctx());
    ts::return_shared(duel);
    reveal_atm_deck(&mut scenario);

    // Skip swipes, just settle oracle and try to finalize without any cards
    // settled.
    let expiry = START_MS + ORACLE_TTL_MS;
    clock.set_for_testing(expiry + 1_000);
    let mut o = take_oracle(&mut scenario, ADMIN);
    o.settle_for_testing(ATM_STRIKE);
    ts::return_shared(o);

    let mut d = take_duel(&mut scenario, ADMIN);
    d.finalize(scenario.ctx());
    abort 999
}

// === Scoring math ===

#[test]
fun atm_correct_fast_swipe_scores_three_x() {
    let (mut scenario, mut clock) = setup_scenario();
    // Single-card audit: both UP so both correct, settlement > strike.
    // ATM under our flat SVI prices to ~0.5; fast multiplier (1.5x),
    // correct → card_score ≈ (1/0.5) * 1.5 = 3.0. 5 cards → ~15.0.
    let (a, b) = run_full_duel(
        &mut scenario,
        &mut clock,
        2_000,
        true,
        true,
        ATM_STRIKE + 1_000_000_000,
    );
    let expected: u64 = 15_000_000_000;
    let tol: u64 = 150_000_000; // 1%
    assert!(a >= expected - tol && a <= expected + tol);
    assert!(b >= expected - tol && b <= expected + tol);
    teardown(scenario, clock);
}

#[test]
fun slow_tier_multiplier_applies() {
    let (mut scenario, mut clock) = setup_scenario();
    // 25s per swipe → slow tier (0.75x). 5 cards × ~1.5 ≈ 7.5.
    let (a, _) = run_full_duel(
        &mut scenario,
        &mut clock,
        25_000,
        true,
        true,
        ATM_STRIKE + 1_000_000_000,
    );
    let expected: u64 = 7_500_000_000;
    let tol: u64 = 75_000_000;
    assert!(a >= expected - tol && a <= expected + tol);
    teardown(scenario, clock);
}

#[test]
fun timeout_scores_zero() {
    let (mut scenario, mut clock) = setup_scenario();
    // 65s per swipe → past timeout, multiplier 0.
    let (a, b) = run_full_duel(
        &mut scenario,
        &mut clock,
        65_000,
        true,
        true,
        ATM_STRIKE + 1_000_000_000,
    );
    assert_eq!(a, 0);
    assert_eq!(b, 0);
    teardown(scenario, clock);
}

#[test, expected_failure(abort_code = duel::EOracleNotLive)]
fun record_swipe_rejects_after_expiry() {
    let (mut scenario, mut clock) = setup_scenario();
    create_duel_with_alice(&mut scenario, &clock);

    // Bob joins.
    let mut duel = take_duel(&mut scenario, BOB);
    duel.join_duel(mint_sui(STAKE_AMOUNT, &mut scenario), &clock, scenario.ctx());
    ts::return_shared(duel);
    reveal_atm_deck(&mut scenario);

    // Advance past oracle expiry → status moves to PENDING_SETTLEMENT and the
    // fairness guard must reject any further swipes.
    clock.set_for_testing(START_MS + ORACLE_TTL_MS + 1);
    let oracle_ref = take_oracle(&mut scenario, ALICE);
    let mut duel = take_duel(&mut scenario, ALICE);
    duel.record_swipe(&oracle_ref, 0, true, &clock, scenario.ctx());
    abort 999
}
