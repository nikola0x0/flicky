// Copyright (c) Flicky Labs
// SPDX-License-Identifier: Apache-2.0

#[test_only]
module flicky::oracle_tests;
use flicky::oracle::{Self, FlickyOracle, OracleAdminCap};
use std::unit_test::{assert_eq, destroy};
use sui::{clock::{Self, Clock}, test_scenario::{Self as ts, Scenario}};

const ADMIN: address = @0xA;

// 9-decimal fixed point helpers
const ONE_E9: u64 = 1_000_000_000;

// Default test config: 60s expiry from `start_ms`, $50k-$150k strike grid,
// 60s settlement freshness, 20% max deviation per push.
const START_MS: u64 = 1_000_000;
const TTL_MS: u64 = 60_000;
const MIN_STRIKE: u64 = 50_000_000_000_000; // $50k
const TICK_SIZE: u64 = 1_000_000_000; // $1
const NUM_TICKS: u64 = 100_000; // up to $150k
const SETTLEMENT_FRESHNESS_MS: u64 = 60_000;
const MAX_SPOT_DEVIATION: u64 = 200_000_000; // 20%

fun setup(): (Scenario, Clock, OracleAdminCap) {
    let mut scenario = ts::begin(ADMIN);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(START_MS);
    let cap = oracle::init_for_testing(scenario.ctx());
    (scenario, clock, cap)
}

fun create_default_oracle(scenario: &mut Scenario, cap: &OracleAdminCap, clock: &Clock) {
    oracle::create_oracle(
        cap,
        b"BTC".to_string(),
        clock.timestamp_ms() + TTL_MS,
        MIN_STRIKE,
        TICK_SIZE,
        NUM_TICKS,
        SETTLEMENT_FRESHNESS_MS,
        MAX_SPOT_DEVIATION,
        clock,
        scenario.ctx(),
    );
}

fun take_oracle(scenario: &mut Scenario): FlickyOracle {
    scenario.next_tx(ADMIN);
    scenario.take_shared<FlickyOracle>()
}

fun teardown(scenario: Scenario, clock: Clock, cap: OracleAdminCap) {
    destroy(clock);
    destroy(cap);
    scenario.end();
}

#[test]
fun create_oracle_starts_active() {
    let (mut scenario, clock, cap) = setup();
    create_default_oracle(&mut scenario, &cap, &clock);
    let oracle = take_oracle(&mut scenario);

    assert_eq!(oracle.status(&clock), oracle::status_active());
    assert_eq!(oracle.is_settled(), false);
    assert_eq!(oracle.is_live(&clock), false); // no price seeded yet
    assert_eq!(oracle.asset(), b"BTC".to_string());
    assert_eq!(oracle.spot(), 0);
    assert_eq!(oracle.min_strike(), MIN_STRIKE);
    assert_eq!(oracle.tick_size(), TICK_SIZE);
    assert_eq!(oracle.num_ticks(), NUM_TICKS);
    assert_eq!(oracle.settlement_freshness_ms(), SETTLEMENT_FRESHNESS_MS);
    assert_eq!(oracle.max_spot_deviation(), MAX_SPOT_DEVIATION);

    ts::return_shared(oracle);
    teardown(scenario, clock, cap);
}

#[test]
fun update_price_seeds_snapshot() {
    let (mut scenario, clock, cap) = setup();
    create_default_oracle(&mut scenario, &cap, &clock);
    let mut oracle = take_oracle(&mut scenario);

    let spot = 80_000_000_000_000;
    let forward = 80_100_000_000_000;
    let vol = 600_000_000;
    oracle.update_price(&cap, spot, forward, vol, START_MS, &clock);

    assert_eq!(oracle.spot(), spot);
    assert_eq!(oracle.forward(), forward);
    assert_eq!(oracle.volatility(), vol);
    assert_eq!(oracle.price_source_timestamp_ms(), START_MS);
    assert_eq!(oracle.price_update_timestamp_ms(), START_MS);
    assert_eq!(oracle.is_live(&clock), true);

    ts::return_shared(oracle);
    teardown(scenario, clock, cap);
}

#[test, expected_failure(abort_code = oracle::EZeroSpot)]
fun update_price_rejects_zero_spot() {
    let (mut scenario, clock, cap) = setup();
    create_default_oracle(&mut scenario, &cap, &clock);
    let mut oracle = take_oracle(&mut scenario);

    oracle.update_price(&cap, 0, 80_000_000_000_000, 600_000_000, START_MS, &clock);
    abort 999
}

#[test, expected_failure(abort_code = oracle::EZeroForward)]
fun update_price_rejects_zero_forward() {
    let (mut scenario, clock, cap) = setup();
    create_default_oracle(&mut scenario, &cap, &clock);
    let mut oracle = take_oracle(&mut scenario);

    oracle.update_price(&cap, 80_000_000_000_000, 0, 600_000_000, START_MS, &clock);
    abort 999
}

#[test, expected_failure(abort_code = oracle::EFutureSourceUpdate)]
fun update_price_rejects_future_source() {
    let (mut scenario, clock, cap) = setup();
    create_default_oracle(&mut scenario, &cap, &clock);
    let mut oracle = take_oracle(&mut scenario);

    oracle.update_price(
        &cap,
        80_000_000_000_000,
        80_000_000_000_000,
        600_000_000,
        START_MS + 1,
        &clock,
    );
    abort 999
}

#[test, expected_failure(abort_code = oracle::EStaleSourceUpdate)]
fun update_price_rejects_stale_source() {
    let (mut scenario, mut clock, cap) = setup();
    create_default_oracle(&mut scenario, &cap, &clock);
    let mut oracle = take_oracle(&mut scenario);

    oracle.update_price(
        &cap,
        80_000_000_000_000,
        80_000_000_000_000,
        600_000_000,
        START_MS,
        &clock,
    );

    // Second push with non-increasing source timestamp must fail.
    clock.set_for_testing(START_MS + 10);
    oracle.update_price(
        &cap,
        80_500_000_000_000,
        80_500_000_000_000,
        600_000_000,
        START_MS,
        &clock,
    );
    abort 999
}

#[test, expected_failure(abort_code = oracle::ESpotDeviationTooLarge)]
fun update_price_rejects_excess_deviation() {
    let (mut scenario, mut clock, cap) = setup();
    create_default_oracle(&mut scenario, &cap, &clock);
    let mut oracle = take_oracle(&mut scenario);

    let spot = 80_000_000_000_000;
    oracle.update_price(&cap, spot, spot, 600_000_000, START_MS, &clock);

    // 30% jump exceeds the 20% bound.
    clock.set_for_testing(START_MS + 1);
    oracle.update_price(
        &cap,
        spot + (spot * 30 / 100),
        spot + (spot * 30 / 100),
        600_000_000,
        START_MS + 1,
        &clock,
    );
    abort 999
}

#[test, expected_failure(abort_code = oracle::EOracleNotActive)]
fun update_price_rejects_when_expired() {
    let (mut scenario, mut clock, cap) = setup();
    create_default_oracle(&mut scenario, &cap, &clock);
    let mut oracle = take_oracle(&mut scenario);

    clock.set_for_testing(START_MS + TTL_MS); // exactly at expiry → PENDING_SETTLEMENT
    oracle.update_price(
        &cap,
        80_000_000_000_000,
        80_000_000_000_000,
        600_000_000,
        START_MS + TTL_MS,
        &clock,
    );
    abort 999
}

#[test]
fun settle_works_after_expiry() {
    let (mut scenario, mut clock, cap) = setup();
    create_default_oracle(&mut scenario, &cap, &clock);
    let mut oracle = take_oracle(&mut scenario);

    oracle.update_price(
        &cap,
        80_000_000_000_000,
        80_000_000_000_000,
        600_000_000,
        START_MS,
        &clock,
    );

    let expiry = START_MS + TTL_MS;
    clock.set_for_testing(expiry + 5_000); // 5s past expiry
    assert_eq!(oracle.status(&clock), oracle::status_pending_settlement());

    oracle.settle(&cap, 80_500_000_000_000, expiry + 1_000, &clock);

    assert_eq!(oracle.is_settled(), true);
    assert_eq!(oracle.status(&clock), oracle::status_settled());
    assert_eq!(oracle.settlement_price(), 80_500_000_000_000);
    assert_eq!(oracle.settlement_source_timestamp_ms(), expiry + 1_000);

    ts::return_shared(oracle);
    teardown(scenario, clock, cap);
}

#[test, expected_failure(abort_code = oracle::EOracleNotPendingSettlement)]
fun settle_rejects_before_expiry() {
    let (mut scenario, clock, cap) = setup();
    create_default_oracle(&mut scenario, &cap, &clock);
    let mut oracle = take_oracle(&mut scenario);

    oracle.settle(&cap, 80_500_000_000_000, START_MS, &clock);
    abort 999
}

#[test, expected_failure(abort_code = oracle::EStaleSourceUpdate)]
fun settle_rejects_source_at_or_before_expiry() {
    let (mut scenario, mut clock, cap) = setup();
    create_default_oracle(&mut scenario, &cap, &clock);
    let mut oracle = take_oracle(&mut scenario);

    let expiry = START_MS + TTL_MS;
    clock.set_for_testing(expiry + 5_000);

    // source timestamp == expiry is not strictly greater → stale.
    oracle.settle(&cap, 80_500_000_000_000, expiry, &clock);
    abort 999
}

#[test, expected_failure(abort_code = oracle::ESettlementSourceTooOld)]
fun settle_rejects_source_outside_freshness_window() {
    let (mut scenario, mut clock, cap) = setup();
    create_default_oracle(&mut scenario, &cap, &clock);
    let mut oracle = take_oracle(&mut scenario);

    let expiry = START_MS + TTL_MS;
    // Source 1ms after expiry, but now is 70s after that source.
    clock.set_for_testing(expiry + SETTLEMENT_FRESHNESS_MS + 10_000);
    oracle.settle(&cap, 80_500_000_000_000, expiry + 1, &clock);
    abort 999
}

#[test, expected_failure(abort_code = oracle::EOracleNotPendingSettlement)]
fun settle_rejects_when_already_settled() {
    let (mut scenario, mut clock, cap) = setup();
    create_default_oracle(&mut scenario, &cap, &clock);
    let mut oracle = take_oracle(&mut scenario);

    let expiry = START_MS + TTL_MS;
    clock.set_for_testing(expiry + 5_000);
    oracle.settle(&cap, 80_500_000_000_000, expiry + 1_000, &clock);

    // Second settle on a settled oracle must fail.
    oracle.settle(&cap, 81_000_000_000_000, expiry + 2_000, &clock);
    abort 999
}

#[test]
fun implied_probability_at_the_money_is_50pct() {
    let (mut scenario, clock, cap) = setup();
    create_default_oracle(&mut scenario, &cap, &clock);
    let mut oracle = take_oracle(&mut scenario);

    let forward = 80_000_000_000_000;
    oracle.update_price(&cap, forward, forward, 600_000_000, START_MS, &clock);

    // Black-Scholes ATM is slightly below 50% (the σ²T/2 drift term).
    // For short TTL (60s here) the drift is tiny — assert within 1% band.
    let p_up = oracle.implied_probability_up(forward, &clock);
    let half = ONE_E9 / 2;
    assert!(p_up <= half && half - p_up <= 10_000_000);
    let p_down = oracle.implied_probability_down(forward, &clock);
    assert!(p_down >= half && p_down - half <= 10_000_000);

    ts::return_shared(oracle);
    teardown(scenario, clock, cap);
}

#[test]
fun implied_probability_deep_itm_clamps_to_max() {
    let (mut scenario, clock, cap) = setup();
    create_default_oracle(&mut scenario, &cap, &clock);
    let mut oracle = take_oracle(&mut scenario);

    let forward = 100_000_000_000_000;
    oracle.update_price(&cap, forward, forward, 600_000_000, START_MS, &clock);

    // Strike far below forward → UP almost certain → clamps to 95%.
    let p_up = oracle.implied_probability_up(MIN_STRIKE, &clock);
    assert_eq!(p_up, 950_000_000);

    ts::return_shared(oracle);
    teardown(scenario, clock, cap);
}

#[test]
fun implied_probability_deep_otm_clamps_to_min() {
    let (mut scenario, clock, cap) = setup();
    create_default_oracle(&mut scenario, &cap, &clock);
    let mut oracle = take_oracle(&mut scenario);

    let forward = 80_000_000_000_000;
    oracle.update_price(&cap, forward, forward, 600_000_000, START_MS, &clock);

    // Strike far above forward → UP unlikely → clamps to 5%.
    let p_up = oracle.implied_probability_up(oracle.max_strike(), &clock);
    assert_eq!(p_up, 50_000_000);

    ts::return_shared(oracle);
    teardown(scenario, clock, cap);
}

#[test]
fun implied_probability_after_settlement() {
    let (mut scenario, mut clock, cap) = setup();
    create_default_oracle(&mut scenario, &cap, &clock);
    let mut oracle = take_oracle(&mut scenario);

    oracle.update_price(
        &cap,
        80_000_000_000_000,
        80_000_000_000_000,
        600_000_000,
        START_MS,
        &clock,
    );

    let expiry = START_MS + TTL_MS;
    clock.set_for_testing(expiry + 1_000);
    let settlement = 80_500_000_000_000;
    oracle.settle(&cap, settlement, expiry + 500, &clock);

    // Strike below settlement → UP wins certainly.
    assert_eq!(oracle.implied_probability_up(MIN_STRIKE, &clock), ONE_E9);
    // Strike above settlement → UP loses certainly.
    assert_eq!(oracle.implied_probability_up(oracle.max_strike(), &clock), 0);

    ts::return_shared(oracle);
    teardown(scenario, clock, cap);
}

#[test]
fun is_valid_strike_grid_check() {
    let (mut scenario, clock, cap) = setup();
    create_default_oracle(&mut scenario, &cap, &clock);
    let oracle = take_oracle(&mut scenario);

    assert_eq!(oracle.is_valid_strike(MIN_STRIKE), true);
    assert_eq!(oracle.is_valid_strike(MIN_STRIKE + TICK_SIZE), true);
    assert_eq!(oracle.is_valid_strike(oracle.max_strike()), true);
    // Below grid.
    assert_eq!(oracle.is_valid_strike(MIN_STRIKE - 1), false);
    // Above grid.
    assert_eq!(oracle.is_valid_strike(oracle.max_strike() + 1), false);
    // Off-tick.
    assert_eq!(oracle.is_valid_strike(MIN_STRIKE + TICK_SIZE / 2), false);

    ts::return_shared(oracle);
    teardown(scenario, clock, cap);
}
