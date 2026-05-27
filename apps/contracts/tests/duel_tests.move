// Copyright (c) Flicky Labs
// SPDX-License-Identifier: Apache-2.0

#[test_only]
module flicky::duel_tests;

use deepbook_predict::oracle::{Self as db_oracle, OracleSVI};
use deepbook_predict::predict::{Self as db_predict, Predict};
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
const ORACLE_TTL_MS: u64 = 600_000;
const STAKE_AMOUNT: u64 = 100_000_000;
const ATM_STRIKE: u64 = 80_000_000_000_000;

fun setup_scenario(): (Scenario, Clock) {
    let mut scenario = ts::begin(ADMIN);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(START_MS);
    // Share a Predict object up front so all swipes can borrow it.
    let predict = db_predict::new_for_testing(scenario.ctx());
    db_predict::share_for_testing(predict);
    (scenario, clock)
}

fun take_predict(scenario: &mut Scenario, sender: address): Predict {
    scenario.next_tx(sender);
    scenario.take_shared<Predict>()
}

fun teardown(scenario: Scenario, clock: Clock) {
    destroy(clock);
    scenario.end();
}

fun create_seeded_oracle(scenario: &mut Scenario, clock: &Clock): ID {
    let oracle = db_oracle::new_for_testing(
        clock.timestamp_ms() + ORACLE_TTL_MS,
        scenario.ctx(),
    );
    let oid = db_oracle::id(&oracle);
    db_oracle::share_for_testing(oracle);
    oid
}

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

fun create_duel_with_alice(scenario: &mut Scenario, clock: &Clock): ID {
    create_seeded_oracle(scenario, clock);
    scenario.next_tx(ALICE);
    let oracle_ref = scenario.take_shared<OracleSVI>();
    let cards = atm_deck(&oracle_ref);
    let h = deck_hash_of(&cards);
    ts::return_shared(oracle_ref);
    duel::create_duel<SUI>(mint_sui(STAKE_AMOUNT, scenario), h, scenario.ctx())
}

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

fun set_manager_qty(player: address, key: deepbook_predict::market_key::MarketKey, qty: u64, scenario: &mut Scenario) {
    scenario.next_tx(player);
    let mut manager = scenario.take_from_address<PredictManager>(player);
    predict_manager::set_test_position_qty(&mut manager, key, qty);
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

fun set_oracle_p_up(oracle: &mut OracleSVI, p_up: u64) {
    db_oracle::set_test_price(oracle, p_up);
}

// === create_duel ===

#[test]
fun create_duel_starts_pending_with_empty_deck() {
    let (mut scenario, clock) = setup_scenario();
    create_duel_with_alice(&mut scenario, &clock);

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
    let (mut scenario, clock) = setup_scenario();
    create_seeded_oracle(&mut scenario, &clock);
    scenario.next_tx(ALICE);
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
fun record_swipe_snapshots_p_swiped_from_oracle() {
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

    let expiry = START_MS + ORACLE_TTL_MS;
    let mut oracle_ref = take_oracle(&mut scenario, ALICE);
    set_oracle_p_up(&mut oracle_ref, 400_000_000);
    let oid = db_oracle::id(&oracle_ref);
    let key = deepbook_predict::market_key::new(oid, expiry, ATM_STRIKE, true);
    set_manager_qty(ALICE, key, 100, &mut scenario);

    scenario.next_tx(ALICE);
    let manager = scenario.take_from_address<PredictManager>(ALICE);
    let mut duel = take_duel(&mut scenario, ALICE);
    let predict = take_predict(&mut scenario, ALICE);
    duel.record_swipe(&manager, &predict, &oracle_ref, 0, true, 100, &clock, scenario.ctx());
    assert_eq!(duel.p0_next_card_idx(), 1);

    ts::return_shared(duel);
    ts::return_shared(predict);
    ts::return_shared(oracle_ref);
    ts::return_to_address(ALICE, manager);
    teardown(scenario, clock);
}

// === full duel (one-shot finalize) ===

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

    let mut duel = take_duel(scenario, BOB);
    duel.join_duel(mint_sui(STAKE_AMOUNT, scenario), clock, scenario.ctx());
    ts::return_shared(duel);
    reveal_atm_deck(scenario);

    let mut t = clock.timestamp_ms();
    let deck_size = duel::test_deck_size();
    let expiry = START_MS + ORACLE_TTL_MS;
    let mut i = 0;
    while (i < deck_size) {
        t = t + swipe_delay_ms;
        clock.set_for_testing(t);

        let duel_a = take_duel(scenario, ALICE);
        let card = *duel_a.deck().borrow(i);
        ts::return_shared(duel_a);

        let key_a = deepbook_predict::market_key::new(duel::card_oracle_id(&card), expiry, duel::card_strike(&card), alice_is_up);
        set_manager_qty(ALICE, key_a, alice_qty, scenario);

        scenario.next_tx(ALICE);
        let manager_a = scenario.take_from_address<PredictManager>(ALICE);
        let mut oracle_a = take_oracle(scenario, ALICE);
        let alice_p_up = if (alice_is_up) alice_p_swiped else (1_000_000_000 - alice_p_swiped);
        set_oracle_p_up(&mut oracle_a, alice_p_up);
        let mut duel_a2 = take_duel(scenario, ALICE);
        let predict = take_predict(scenario, ALICE);
        duel_a2.record_swipe(&manager_a, &predict, &oracle_a, i, alice_is_up, alice_qty, clock, scenario.ctx());
        ts::return_shared(duel_a2);
        ts::return_shared(predict);
        ts::return_shared(oracle_a);
        ts::return_to_address(ALICE, manager_a);

        let key_b = deepbook_predict::market_key::new(duel::card_oracle_id(&card), expiry, duel::card_strike(&card), bob_is_up);
        set_manager_qty(BOB, key_b, bob_qty, scenario);

        scenario.next_tx(BOB);
        let manager_b = scenario.take_from_address<PredictManager>(BOB);
        let mut oracle_b = take_oracle(scenario, BOB);
        let bob_p_up = if (bob_is_up) bob_p_swiped else (1_000_000_000 - bob_p_swiped);
        set_oracle_p_up(&mut oracle_b, bob_p_up);
        let mut duel_b2 = take_duel(scenario, BOB);
        let predict = take_predict(scenario, BOB);
        duel_b2.record_swipe(&manager_b, &predict, &oracle_b, i, bob_is_up, bob_qty, clock, scenario.ctx());
        ts::return_shared(duel_b2);
        ts::return_shared(predict);
        ts::return_shared(oracle_b);
        ts::return_to_address(BOB, manager_b);

        i = i + 1;
    };

    // Server admin sees both done, oracle settles, finalizes in one tx.
    clock.set_for_testing(expiry + 1_000);
    let mut oracle_s = take_oracle(scenario, ADMIN);
    db_oracle::settle_for_testing(&mut oracle_s, settlement_price);
    ts::return_shared(oracle_s);

    scenario.next_tx(ADMIN);
    let manager_a = scenario.take_from_address<PredictManager>(ALICE);
    let manager_b = scenario.take_from_address<PredictManager>(BOB);
    let oracle_f = take_oracle(scenario, ADMIN);
    let mut d = take_duel(scenario, ADMIN);
    d.finalize(&manager_a, &manager_b, &oracle_f, clock, scenario.ctx());
    assert_eq!(d.status(), duel::status_complete());
    ts::return_shared(d);
    ts::return_shared(oracle_f);
    ts::return_to_address(ALICE, manager_a);
    ts::return_to_address(BOB, manager_b);

    let alice_payout = get_payout_amount(ALICE, scenario);
    let bob_payout = get_payout_amount(BOB, scenario);
    (alice_payout, bob_payout)
}

#[test]
fun full_duel_alice_wins_when_settlement_above_strike() {
    let (mut scenario, mut clock) = setup_scenario();
    let (a, b) = run_full_duel(
        &mut scenario,
        &mut clock,
        2_000,
        true, 100, 400_000_000,
        false, 100, 600_000_000,
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
        true, 100, 400_000_000,
        false, 100, 600_000_000,
        ATM_STRIKE - 1_000_000_000,
    );
    assert_eq!(a, 0);
    assert_eq!(b, STAKE_AMOUNT * 2);

    teardown(scenario, clock);
}

#[test]
fun full_duel_tie_refunds_stakes() {
    let (mut scenario, mut clock) = setup_scenario();
    let (a, b) = run_full_duel(
        &mut scenario,
        &mut clock,
        2_000,
        true, 100, 500_000_000,
        true, 100, 500_000_000,
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

    {
        let mut duel = take_duel(&mut scenario, BOB);
        duel.join_duel(mint_sui(STAKE_AMOUNT, &mut scenario), &clock, scenario.ctx());
        ts::return_shared(duel);
    };
    reveal_atm_deck(&mut scenario);

    clock.set_for_testing(START_MS + 660_000);
    let key = deepbook_predict::market_key::new(sui::object::id_from_address(@0x0), START_MS + ORACLE_TTL_MS, ATM_STRIKE, true);
    set_manager_qty(ALICE, key, 100, &mut scenario);

    scenario.next_tx(ALICE);
    let manager = scenario.take_from_address<PredictManager>(ALICE);
    let mut oracle_ref = take_oracle(&mut scenario, ALICE);
    set_oracle_p_up(&mut oracle_ref, 500_000_000);
    let mut duel = take_duel(&mut scenario, ALICE);
    let predict = take_predict(&mut scenario, ALICE);
    duel.record_swipe(&manager, &predict, &oracle_ref, 0, true, 100, &clock, scenario.ctx());

    ts::return_shared(duel);
    ts::return_shared(predict);
    ts::return_shared(oracle_ref);
    ts::return_to_address(ALICE, manager);
    teardown(scenario, clock);
}

#[test, expected_failure(abort_code = duel::EOracleNotLive)]
fun record_swipe_rejects_after_expiry() {
    let (mut scenario, mut clock) = setup_scenario();
    create_manager_for(ALICE, &mut scenario);

    let short_ttl = 120_000;
    scenario.next_tx(ALICE);
    let oracle = db_oracle::new_for_testing(START_MS + short_ttl, scenario.ctx());
    let oracle_id = db_oracle::id(&oracle);
    db_oracle::share_for_testing(oracle);

    scenario.next_tx(ALICE);
    let oracle_ref = scenario.take_shared<OracleSVI>();
    let mut cards = vector<duel::Card>[];
    duel::test_deck_size().do!(|_| cards.push_back(duel::new_card(&oracle_ref, ATM_STRIKE)));
    let h = deck_hash_of(&cards);
    ts::return_shared(oracle_ref);

    let duel_id = duel::create_duel<SUI>(mint_sui(STAKE_AMOUNT, &mut scenario), h, scenario.ctx());

    scenario.next_tx(BOB);
    let mut duel = scenario.take_shared_by_id<Duel<SUI>>(duel_id);
    duel.join_duel(mint_sui(STAKE_AMOUNT, &mut scenario), &clock, scenario.ctx());
    ts::return_shared(duel);

    scenario.next_tx(ADMIN);
    let mut duel = scenario.take_shared_by_id<Duel<SUI>>(duel_id);
    duel.reveal_deck(cards);
    ts::return_shared(duel);

    clock.set_for_testing(START_MS + 180_000);
    let key = deepbook_predict::market_key::new(oracle_id, START_MS + 120_000, ATM_STRIKE, true);
    set_manager_qty(ALICE, key, 100, &mut scenario);

    scenario.next_tx(ALICE);
    let manager = scenario.take_from_address<PredictManager>(ALICE);
    let mut oracle_ref = scenario.take_shared_by_id<OracleSVI>(oracle_id);
    set_oracle_p_up(&mut oracle_ref, 500_000_000);
    let mut duel = scenario.take_shared_by_id<Duel<SUI>>(duel_id);

    let predict = take_predict(&mut scenario, ALICE);
    duel.record_swipe(&manager, &predict, &oracle_ref, 0, true, 100, &clock, scenario.ctx());

    ts::return_shared(duel);
    ts::return_shared(predict);
    ts::return_shared(oracle_ref);
    ts::return_to_address(ALICE, manager);
    teardown(scenario, clock);
}

#[test]
fun early_redemption_penalty() {
    let (mut scenario, mut clock) = setup_scenario();
    create_manager_for(ALICE, &mut scenario);
    create_manager_for(BOB, &mut scenario);
    create_duel_with_alice(&mut scenario, &clock);

    let mut duel = take_duel(&mut scenario, BOB);
    duel.join_duel(mint_sui(STAKE_AMOUNT, &mut scenario), &clock, scenario.ctx());
    ts::return_shared(duel);
    reveal_atm_deck(&mut scenario);

    let mut t = clock.timestamp_ms();
    let deck_size = duel::test_deck_size();
    let expiry = START_MS + ORACLE_TTL_MS;
    let mut i = 0;

    while (i < deck_size) {
        t = t + 2_000;
        clock.set_for_testing(t);

        let duel_a = take_duel(&mut scenario, ALICE);
        let card = *duel_a.deck().borrow(i);
        ts::return_shared(duel_a);

        let key_a = deepbook_predict::market_key::new(duel::card_oracle_id(&card), expiry, duel::card_strike(&card), true);
        set_manager_qty(ALICE, key_a, 100, &mut scenario);

        scenario.next_tx(ALICE);
        let manager_a = scenario.take_from_address<PredictManager>(ALICE);
        let mut oracle_a = take_oracle(&mut scenario, ALICE);
        set_oracle_p_up(&mut oracle_a, 400_000_000);
        let mut duel_a2 = take_duel(&mut scenario, ALICE);
        let predict = take_predict(&mut scenario, ALICE);
        duel_a2.record_swipe(&manager_a, &predict, &oracle_a, i, true, 100, &clock, scenario.ctx());
        ts::return_shared(duel_a2);
        ts::return_shared(predict);
        ts::return_shared(oracle_a);
        ts::return_to_address(ALICE, manager_a);

        let key_b = deepbook_predict::market_key::new(duel::card_oracle_id(&card), expiry, duel::card_strike(&card), true);
        set_manager_qty(BOB, key_b, 100, &mut scenario);

        scenario.next_tx(BOB);
        let manager_b = scenario.take_from_address<PredictManager>(BOB);
        let mut oracle_b = take_oracle(&mut scenario, BOB);
        set_oracle_p_up(&mut oracle_b, 400_000_000);
        let mut duel_b2 = take_duel(&mut scenario, BOB);
        let predict = take_predict(&mut scenario, BOB);
        duel_b2.record_swipe(&manager_b, &predict, &oracle_b, i, true, 100, &clock, scenario.ctx());
        ts::return_shared(duel_b2);
        ts::return_shared(predict);
        ts::return_shared(oracle_b);
        ts::return_to_address(BOB, manager_b);

        i = i + 1;
    };

    // Alice redeems position 0 early.
    let duel_a = take_duel(&mut scenario, ALICE);
    let card_0 = *duel_a.deck().borrow(0);
    ts::return_shared(duel_a);
    let key_0 = deepbook_predict::market_key::new(duel::card_oracle_id(&card_0), expiry, duel::card_strike(&card_0), true);
    set_manager_qty(ALICE, key_0, 0, &mut scenario);

    clock.set_for_testing(expiry + 1_000);
    let mut oracle_s = take_oracle(&mut scenario, ADMIN);
    db_oracle::settle_for_testing(&mut oracle_s, ATM_STRIKE + 1_000_000);
    ts::return_shared(oracle_s);

    scenario.next_tx(ADMIN);
    let manager_a = scenario.take_from_address<PredictManager>(ALICE);
    let manager_b = scenario.take_from_address<PredictManager>(BOB);
    let oracle_f = take_oracle(&mut scenario, ADMIN);
    let mut d = take_duel(&mut scenario, ADMIN);
    d.finalize(&manager_a, &manager_b, &oracle_f, &clock, scenario.ctx());
    assert_eq!(d.status(), duel::status_complete());
    ts::return_shared(d);
    ts::return_shared(oracle_f);
    ts::return_to_address(ALICE, manager_a);
    ts::return_to_address(BOB, manager_b);

    let alice_payout = get_payout_amount(ALICE, &mut scenario);
    let bob_payout = get_payout_amount(BOB, &mut scenario);
    assert_eq!(alice_payout, 0);
    assert_eq!(bob_payout, STAKE_AMOUNT * 2);

    teardown(scenario, clock);
}

#[test]
fun finalize_forfeit_wins() {
    let (mut scenario, mut clock) = setup_scenario();
    create_manager_for(ALICE, &mut scenario);
    create_manager_for(BOB, &mut scenario);
    create_duel_with_alice(&mut scenario, &clock);

    let mut duel = take_duel(&mut scenario, BOB);
    duel.join_duel(mint_sui(STAKE_AMOUNT, &mut scenario), &clock, scenario.ctx());
    ts::return_shared(duel);
    reveal_atm_deck(&mut scenario);

    let mut t = clock.timestamp_ms();
    let expiry = START_MS + ORACLE_TTL_MS;

    let mut i = 0;
    while (i < 2) {
        t = t + 2_000;
        clock.set_for_testing(t);

        let duel_a = take_duel(&mut scenario, ALICE);
        let card = *duel_a.deck().borrow(i);
        ts::return_shared(duel_a);

        let key_a = deepbook_predict::market_key::new(duel::card_oracle_id(&card), expiry, duel::card_strike(&card), true);
        set_manager_qty(ALICE, key_a, 100, &mut scenario);

        scenario.next_tx(ALICE);
        let manager_a = scenario.take_from_address<PredictManager>(ALICE);
        let mut oracle_a = take_oracle(&mut scenario, ALICE);
        set_oracle_p_up(&mut oracle_a, 400_000_000);
        let mut duel_a2 = take_duel(&mut scenario, ALICE);
        let predict = take_predict(&mut scenario, ALICE);
        duel_a2.record_swipe(&manager_a, &predict, &oracle_a, i, true, 100, &clock, scenario.ctx());
        ts::return_shared(duel_a2);
        ts::return_shared(predict);
        ts::return_shared(oracle_a);
        ts::return_to_address(ALICE, manager_a);
        i = i + 1;
    };

    // Bob only swipes card 0.
    t = t + 2_000;
    clock.set_for_testing(t);
    let duel_b = take_duel(&mut scenario, BOB);
    let card_0 = *duel_b.deck().borrow(0);
    ts::return_shared(duel_b);
    let key_b = deepbook_predict::market_key::new(duel::card_oracle_id(&card_0), expiry, duel::card_strike(&card_0), true);
    set_manager_qty(BOB, key_b, 100, &mut scenario);

    scenario.next_tx(BOB);
    let manager_b = scenario.take_from_address<PredictManager>(BOB);
    let mut oracle_b = take_oracle(&mut scenario, BOB);
    set_oracle_p_up(&mut oracle_b, 400_000_000);
    let mut duel_b2 = take_duel(&mut scenario, BOB);
    let predict = take_predict(&mut scenario, BOB);
    duel_b2.record_swipe(&manager_b, &predict, &oracle_b, 0, true, 100, &clock, scenario.ctx());
    ts::return_shared(duel_b2);
    ts::return_shared(predict);
    ts::return_shared(oracle_b);
    ts::return_to_address(BOB, manager_b);

    // Settle oracle, then finalize after the 10-minute window — forfeit wins.
    clock.set_for_testing(expiry + 1_000);
    let mut oracle_s = take_oracle(&mut scenario, ADMIN);
    db_oracle::settle_for_testing(&mut oracle_s, ATM_STRIKE + 1_000_000);
    ts::return_shared(oracle_s);

    scenario.next_tx(ADMIN);
    let manager_a = scenario.take_from_address<PredictManager>(ALICE);
    let manager_b = scenario.take_from_address<PredictManager>(BOB);
    let oracle_f = take_oracle(&mut scenario, ADMIN);
    let mut d = take_duel(&mut scenario, ADMIN);
    d.finalize(&manager_a, &manager_b, &oracle_f, &clock, scenario.ctx());
    assert_eq!(d.status(), duel::status_complete());
    ts::return_shared(d);
    ts::return_shared(oracle_f);
    ts::return_to_address(ALICE, manager_a);
    ts::return_to_address(BOB, manager_b);

    let alice_payout = get_payout_amount(ALICE, &mut scenario);
    let bob_payout = get_payout_amount(BOB, &mut scenario);
    assert_eq!(alice_payout, STAKE_AMOUNT * 2);
    assert_eq!(bob_payout, 0);

    teardown(scenario, clock);
}

// === refund_duel ===

// === finalize_multi (5 oracles, one per card) ===

#[test]
fun finalize_multi_with_same_oracle_passed_five_times_matches_finalize() {
    // Smoke test: passing the same oracle 5 times to `finalize_multi`
    // (since the test deck uses one oracle for all 5 cards) should produce
    // the same outcome as the single-oracle `finalize`.
    let (mut scenario, mut clock) = setup_scenario();
    create_manager_for(ALICE, &mut scenario);
    create_manager_for(BOB, &mut scenario);
    create_duel_with_alice(&mut scenario, &clock);

    let mut duel = take_duel(&mut scenario, BOB);
    duel.join_duel(mint_sui(STAKE_AMOUNT, &mut scenario), &clock, scenario.ctx());
    ts::return_shared(duel);
    reveal_atm_deck(&mut scenario);

    let mut t = clock.timestamp_ms();
    let expiry = START_MS + ORACLE_TTL_MS;
    let deck_size = duel::test_deck_size();
    let mut i = 0;
    while (i < deck_size) {
        t = t + 2_000;
        clock.set_for_testing(t);

        let duel_a = take_duel(&mut scenario, ALICE);
        let card = *duel_a.deck().borrow(i);
        ts::return_shared(duel_a);

        let key_a = deepbook_predict::market_key::new(duel::card_oracle_id(&card), expiry, duel::card_strike(&card), true);
        set_manager_qty(ALICE, key_a, 100, &mut scenario);
        scenario.next_tx(ALICE);
        let manager_a = scenario.take_from_address<PredictManager>(ALICE);
        let mut oracle_a = take_oracle(&mut scenario, ALICE);
        set_oracle_p_up(&mut oracle_a, 400_000_000);
        let predict_a = take_predict(&mut scenario, ALICE);
        let mut duel_a2 = take_duel(&mut scenario, ALICE);
        duel_a2.record_swipe(&manager_a, &predict_a, &oracle_a, i, true, 100, &clock, scenario.ctx());
        ts::return_shared(duel_a2);
        ts::return_shared(predict_a);
        ts::return_shared(oracle_a);
        ts::return_to_address(ALICE, manager_a);

        let key_b = deepbook_predict::market_key::new(duel::card_oracle_id(&card), expiry, duel::card_strike(&card), false);
        set_manager_qty(BOB, key_b, 100, &mut scenario);
        scenario.next_tx(BOB);
        let manager_b = scenario.take_from_address<PredictManager>(BOB);
        let mut oracle_b = take_oracle(&mut scenario, BOB);
        set_oracle_p_up(&mut oracle_b, 400_000_000);
        let predict_b = take_predict(&mut scenario, BOB);
        let mut duel_b2 = take_duel(&mut scenario, BOB);
        duel_b2.record_swipe(&manager_b, &predict_b, &oracle_b, i, false, 100, &clock, scenario.ctx());
        ts::return_shared(duel_b2);
        ts::return_shared(predict_b);
        ts::return_shared(oracle_b);
        ts::return_to_address(BOB, manager_b);

        i = i + 1;
    };

    clock.set_for_testing(expiry + 1_000);
    let mut oracle_s = take_oracle(&mut scenario, ADMIN);
    db_oracle::settle_for_testing(&mut oracle_s, ATM_STRIKE + 1_000_000);
    ts::return_shared(oracle_s);

    // Finalize via the multi-oracle path, passing the same oracle 5 times.
    scenario.next_tx(ADMIN);
    let manager_a = scenario.take_from_address<PredictManager>(ALICE);
    let manager_b = scenario.take_from_address<PredictManager>(BOB);
    let oracle_f = take_oracle(&mut scenario, ADMIN);
    let mut d = take_duel(&mut scenario, ADMIN);
    d.finalize_multi(
        &manager_a, &manager_b,
        &oracle_f, &oracle_f, &oracle_f, &oracle_f, &oracle_f,
        &clock, scenario.ctx(),
    );
    assert_eq!(d.status(), duel::status_complete());
    ts::return_shared(d);
    ts::return_shared(oracle_f);
    ts::return_to_address(ALICE, manager_a);
    ts::return_to_address(BOB, manager_b);

    let alice_payout = get_payout_amount(ALICE, &mut scenario);
    let bob_payout = get_payout_amount(BOB, &mut scenario);
    // Settled price (UP) means Alice (all UP) wins on every card.
    assert_eq!(alice_payout, STAKE_AMOUNT * 2);
    assert_eq!(bob_payout, 0);

    teardown(scenario, clock);
}

// === finalize_test_one_oracle (DEV ONLY) ===

#[test]
fun finalize_test_one_oracle_resolves_without_managers() {
    // Same duel setup as the staked happy-path, but instead of calling
    // `finalize` (which would need both managers + same-oracle deck), call
    // `finalize_test_one_oracle` with just the one settled oracle.
    let (mut scenario, mut clock) = setup_scenario();
    create_manager_for(ALICE, &mut scenario);
    create_manager_for(BOB, &mut scenario);
    create_duel_with_alice(&mut scenario, &clock);

    let mut duel = take_duel(&mut scenario, BOB);
    duel.join_duel(mint_sui(STAKE_AMOUNT, &mut scenario), &clock, scenario.ctx());
    ts::return_shared(duel);
    reveal_atm_deck(&mut scenario);

    let mut t = clock.timestamp_ms();
    let expiry = START_MS + ORACLE_TTL_MS;
    let deck_size = duel::test_deck_size();
    let mut i = 0;
    while (i < deck_size) {
        t = t + 2_000;
        clock.set_for_testing(t);

        let duel_a = take_duel(&mut scenario, ALICE);
        let card = *duel_a.deck().borrow(i);
        ts::return_shared(duel_a);

        let key_a = deepbook_predict::market_key::new(duel::card_oracle_id(&card), expiry, duel::card_strike(&card), true);
        set_manager_qty(ALICE, key_a, 100, &mut scenario);
        scenario.next_tx(ALICE);
        let manager_a = scenario.take_from_address<PredictManager>(ALICE);
        let mut oracle_a = take_oracle(&mut scenario, ALICE);
        set_oracle_p_up(&mut oracle_a, 400_000_000);
        let predict_a = take_predict(&mut scenario, ALICE);
        let mut duel_a2 = take_duel(&mut scenario, ALICE);
        duel_a2.record_swipe(&manager_a, &predict_a, &oracle_a, i, true, 100, &clock, scenario.ctx());
        ts::return_shared(duel_a2);
        ts::return_shared(predict_a);
        ts::return_shared(oracle_a);
        ts::return_to_address(ALICE, manager_a);

        let key_b = deepbook_predict::market_key::new(duel::card_oracle_id(&card), expiry, duel::card_strike(&card), false);
        set_manager_qty(BOB, key_b, 100, &mut scenario);
        scenario.next_tx(BOB);
        let manager_b = scenario.take_from_address<PredictManager>(BOB);
        let mut oracle_b = take_oracle(&mut scenario, BOB);
        set_oracle_p_up(&mut oracle_b, 400_000_000);
        let predict_b = take_predict(&mut scenario, BOB);
        let mut duel_b2 = take_duel(&mut scenario, BOB);
        duel_b2.record_swipe(&manager_b, &predict_b, &oracle_b, i, false, 100, &clock, scenario.ctx());
        ts::return_shared(duel_b2);
        ts::return_shared(predict_b);
        ts::return_shared(oracle_b);
        ts::return_to_address(BOB, manager_b);

        i = i + 1;
    };

    // Settle oracle UP — ALICE (UP) is correct, BOB (DOWN) is wrong.
    clock.set_for_testing(expiry + 1_000);
    let mut oracle_s = take_oracle(&mut scenario, ADMIN);
    db_oracle::settle_for_testing(&mut oracle_s, ATM_STRIKE + 1_000_000);
    ts::return_shared(oracle_s);

    scenario.next_tx(ADMIN);
    let oracle_f = take_oracle(&mut scenario, ADMIN);
    let mut d = take_duel(&mut scenario, ADMIN);
    d.finalize_test_one_oracle(&oracle_f, &clock, scenario.ctx());
    assert_eq!(d.status(), duel::status_complete());
    ts::return_shared(d);
    ts::return_shared(oracle_f);

    let alice_payout = get_payout_amount(ALICE, &mut scenario);
    let bob_payout = get_payout_amount(BOB, &mut scenario);
    // Alice swept ALL 5 cards correct (UP) using this oracle's price.
    assert_eq!(alice_payout, STAKE_AMOUNT * 2);
    assert_eq!(bob_payout, 0);

    teardown(scenario, clock);
}

// === claim_reveal_timeout ===

#[test]
fun reveal_timeout_lets_challenger_claim_forfeit() {
    let (mut scenario, mut clock) = setup_scenario();
    let duel_id = create_duel_with_alice(&mut scenario, &clock);

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
    let duel_id = create_duel_with_alice(&mut scenario, &clock);

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
    let duel_id = create_duel_with_alice(&mut scenario, &clock);

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
    let duel_id = create_duel_with_alice(&mut scenario, &clock);

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
    let duel_id = create_duel_with_alice(&mut scenario, &clock);

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
    let duel_id = create_duel_with_alice(&mut scenario, &clock);

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
    create_manager_for(ALICE, &mut scenario);
    create_manager_for(BOB, &mut scenario);
    create_duel_with_alice(&mut scenario, &clock);

    let mut duel = take_duel(&mut scenario, BOB);
    duel.join_duel(mint_sui(STAKE_AMOUNT, &mut scenario), &clock, scenario.ctx());
    ts::return_shared(duel);
    reveal_atm_deck(&mut scenario);

    let mut t = clock.timestamp_ms();
    let deck_size = duel::test_deck_size();
    let expiry = START_MS + ORACLE_TTL_MS;
    let mut i = 0;
    while (i < deck_size) {
        t = t + 2_000;
        clock.set_for_testing(t);

        let duel_a = take_duel(&mut scenario, ALICE);
        let card = *duel_a.deck().borrow(i);
        ts::return_shared(duel_a);

        let key_a = deepbook_predict::market_key::new(duel::card_oracle_id(&card), expiry, duel::card_strike(&card), true);
        set_manager_qty(ALICE, key_a, 100, &mut scenario);
        scenario.next_tx(ALICE);
        let manager_a = scenario.take_from_address<PredictManager>(ALICE);
        let mut oracle_a = take_oracle(&mut scenario, ALICE);
        set_oracle_p_up(&mut oracle_a, 400_000_000);
        let mut duel_a2 = take_duel(&mut scenario, ALICE);
        let predict = take_predict(&mut scenario, ALICE);
        duel_a2.record_swipe(&manager_a, &predict, &oracle_a, i, true, 100, &clock, scenario.ctx());
        ts::return_shared(duel_a2);
        ts::return_shared(predict);
        ts::return_shared(oracle_a);
        ts::return_to_address(ALICE, manager_a);

        let key_b = deepbook_predict::market_key::new(duel::card_oracle_id(&card), expiry, duel::card_strike(&card), false);
        set_manager_qty(BOB, key_b, 100, &mut scenario);
        scenario.next_tx(BOB);
        let manager_b = scenario.take_from_address<PredictManager>(BOB);
        let mut oracle_b = take_oracle(&mut scenario, BOB);
        set_oracle_p_up(&mut oracle_b, 400_000_000);
        let mut duel_b2 = take_duel(&mut scenario, BOB);
        let predict = take_predict(&mut scenario, BOB);
        duel_b2.record_swipe(&manager_b, &predict, &oracle_b, i, false, 100, &clock, scenario.ctx());
        ts::return_shared(duel_b2);
        ts::return_shared(predict);
        ts::return_shared(oracle_b);
        ts::return_to_address(BOB, manager_b);

        i = i + 1;
    };

    clock.set_for_testing(START_MS + 3_601_000);
    scenario.next_tx(BOB);
    let mut d = take_duel(&mut scenario, BOB);
    d.refund_duel(&clock, scenario.ctx());

    abort 999
}

// === Free tier ===

fun create_free_duel_with_alice(scenario: &mut Scenario, clock: &Clock): ID {
    create_seeded_oracle(scenario, clock);
    scenario.next_tx(ALICE);
    let oracle_ref = scenario.take_shared<OracleSVI>();
    let cards = atm_deck(&oracle_ref);
    let h = deck_hash_of(&cards);
    ts::return_shared(oracle_ref);
    duel::create_duel_free<SUI>(h, scenario.ctx())
}

#[test]
fun free_tier_full_duel_runs_with_no_stake_and_no_manager() {
    let (mut scenario, mut clock) = setup_scenario();
    let duel_id = create_free_duel_with_alice(&mut scenario, &clock);

    scenario.next_tx(BOB);
    let mut duel = scenario.take_shared_by_id<Duel<SUI>>(duel_id);
    assert_eq!(duel.tier(), duel::tier_free());
    duel.join_duel_free(&clock, scenario.ctx());
    assert_eq!(duel.status(), duel::status_active());
    ts::return_shared(duel);

    reveal_atm_deck(&mut scenario);

    let mut t = clock.timestamp_ms();
    let deck_size = duel::test_deck_size();
    let mut i = 0;
    while (i < deck_size) {
        t = t + 2_000;
        clock.set_for_testing(t);

        scenario.next_tx(ALICE);
        let mut oracle_a = take_oracle(&mut scenario, ALICE);
        set_oracle_p_up(&mut oracle_a, 400_000_000);
        let predict_a = take_predict(&mut scenario, ALICE);
        let mut duel_a = take_duel(&mut scenario, ALICE);
        duel_a.record_swipe_free(&predict_a, &oracle_a, i, true, &clock, scenario.ctx());
        ts::return_shared(duel_a);
        ts::return_shared(predict_a);
        ts::return_shared(oracle_a);

        scenario.next_tx(BOB);
        let mut oracle_b = take_oracle(&mut scenario, BOB);
        set_oracle_p_up(&mut oracle_b, 400_000_000);
        let predict_b = take_predict(&mut scenario, BOB);
        let mut duel_b = take_duel(&mut scenario, BOB);
        duel_b.record_swipe_free(&predict_b, &oracle_b, i, false, &clock, scenario.ctx());
        ts::return_shared(duel_b);
        ts::return_shared(predict_b);
        ts::return_shared(oracle_b);

        i = i + 1;
    };

    let expiry = START_MS + ORACLE_TTL_MS;
    clock.set_for_testing(expiry + 1_000);
    let mut oracle_s = take_oracle(&mut scenario, ADMIN);
    db_oracle::settle_for_testing(&mut oracle_s, ATM_STRIKE + 1_000_000);
    ts::return_shared(oracle_s);

    scenario.next_tx(ADMIN);
    let oracle_f = take_oracle(&mut scenario, ADMIN);
    let mut d = take_duel(&mut scenario, ADMIN);
    d.finalize_free(&oracle_f, &clock, scenario.ctx());
    assert_eq!(d.status(), duel::status_complete());
    ts::return_shared(d);
    ts::return_shared(oracle_f);

    let alice_payout = get_payout_amount(ALICE, &mut scenario);
    let bob_payout = get_payout_amount(BOB, &mut scenario);
    assert_eq!(alice_payout, 0);
    assert_eq!(bob_payout, 0);

    teardown(scenario, clock);
}

#[test, expected_failure(abort_code = duel::EWrongTier)]
fun free_tier_rejects_staked_swipe() {
    let (mut scenario, clock) = setup_scenario();
    let duel_id = create_free_duel_with_alice(&mut scenario, &clock);
    create_manager_for(ALICE, &mut scenario);

    scenario.next_tx(BOB);
    let mut duel = scenario.take_shared_by_id<Duel<SUI>>(duel_id);
    duel.join_duel_free(&clock, scenario.ctx());
    ts::return_shared(duel);
    reveal_atm_deck(&mut scenario);

    scenario.next_tx(ALICE);
    let manager = scenario.take_from_address<PredictManager>(ALICE);
    let mut oracle_ref = take_oracle(&mut scenario, ALICE);
    set_oracle_p_up(&mut oracle_ref, 500_000_000);
    let mut duel = take_duel(&mut scenario, ALICE);

    let predict = take_predict(&mut scenario, ALICE);
    duel.record_swipe(&manager, &predict, &oracle_ref, 0, true, 100, &clock, scenario.ctx());

    abort 999
}

#[test, expected_failure(abort_code = duel::EWrongTier)]
fun staked_tier_rejects_free_swipe() {
    let (mut scenario, clock) = setup_scenario();
    create_manager_for(ALICE, &mut scenario);
    create_duel_with_alice(&mut scenario, &clock);

    let mut duel = take_duel(&mut scenario, BOB);
    duel.join_duel(mint_sui(STAKE_AMOUNT, &mut scenario), &clock, scenario.ctx());
    ts::return_shared(duel);
    reveal_atm_deck(&mut scenario);

    scenario.next_tx(ALICE);
    let mut oracle_ref = take_oracle(&mut scenario, ALICE);
    set_oracle_p_up(&mut oracle_ref, 500_000_000);
    let predict = take_predict(&mut scenario, ALICE);
    let mut duel = take_duel(&mut scenario, ALICE);
    duel.record_swipe_free(&predict, &oracle_ref, 0, true, &clock, scenario.ctx());

    abort 999
}
