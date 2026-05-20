// Copyright (c) Flicky Labs
// SPDX-License-Identifier: Apache-2.0

/// SVI binary-digital fair pricing on top of DeepBook Predict's `OracleSVI`.
///
/// DeepBook's `oracle::compute_price` is `public(package)` and not callable
/// from external packages, so this module reproduces the same `N(d2)` math
/// (`compute_nd2`) using the publicly exposed SVI params, spot, and forward.
///
/// `p_up` is what `duel::record_swipe` snapshots as `p_swiped` at the moment
/// of a swipe — directly mirrors the implied UP-probability the player would
/// see on the trading surface, minus spread/utilization. The PRD's scoring
/// formula (`1 / p_swiped × speed_multiplier`) consumes this number.
module flicky::pricing;

use deepbook_predict::i64 as db_i64;
use deepbook_predict::oracle::{Self as db_oracle, OracleSVI};
use flicky::{i64, math};

const EZeroForward: u64 = 0;
const ECannotBeNegative: u64 = 1;
const EZeroVariance: u64 = 2;

/// 9-decimal fixed point (1e9 == 1.0).
const ONE_E9: u64 = 1_000_000_000;

/// Probability clamp range for game playability. Scoring divides by
/// `p_swiped`; runaway long-tail prices would break the duel economics.
const MIN_PROB: u64 = 50_000_000; // 5%
const MAX_PROB: u64 = 950_000_000; // 95%

/// Implied probability of UP for `strike` on the given oracle, in 1e9.
/// Settled oracles collapse to `0` / `1e9` based on `settlement_price > strike`;
/// live oracles run the SVI Black-Scholes binary-digital kernel.
public fun p_up(oracle: &OracleSVI, strike: u64): u64 {
    let raw = if (oracle.is_settled()) {
        let sp = oracle.settlement_price().destroy_some();
        if (sp > strike) ONE_E9 else 0
    } else {
        compute_p_up_svi(oracle, strike)
    };

    if (raw == 0 || raw == ONE_E9) raw
    else if (raw < MIN_PROB) MIN_PROB
    else if (raw > MAX_PROB) MAX_PROB
    else raw
}

/// `p(DOWN) = 1 − p(UP)`.
public fun p_down(oracle: &OracleSVI, strike: u64): u64 {
    ONE_E9 - p_up(oracle, strike)
}

// === Internal ===

fun compute_p_up_svi(oracle: &OracleSVI, strike: u64): u64 {
    let forward = oracle.forward_price();
    assert!(forward > 0, EZeroForward);

    let svi = oracle.svi();
    let a = db_oracle::svi_a(&svi);
    let b = db_oracle::svi_b(&svi);
    let sigma = db_oracle::svi_sigma(&svi);
    let m = to_flicky_i64(&db_oracle::svi_m(&svi));
    let rho = to_flicky_i64(&db_oracle::svi_rho(&svi));

    // k = ln(strike / forward) in 1e9 fixed point.
    let k = math::ln(mul_div_1e9(strike, forward));

    // SVI total variance: w(k) = a + b * (rho*(k-m) + sqrt((k-m)^2 + sigma^2))
    let k_minus_m = i64::sub(&k, &m);
    let k_minus_m_squared = i64::square_scaled(&k_minus_m);
    let sigma_squared = mul_1e9(sigma, sigma);
    let sq = math::sqrt(k_minus_m_squared + sigma_squared, ONE_E9);
    let sq_i = i64::from_u64(sq);

    let rho_km = i64::mul_scaled(&rho, &k_minus_m);
    let inner = i64::add(&rho_km, &sq_i);
    assert!(!i64::is_negative(&inner), ECannotBeNegative);
    let total_var = a + mul_1e9(b, i64::magnitude(&inner));
    assert!(total_var > 0, EZeroVariance);

    // d2 = -((k + total_var/2) / sqrt(total_var))
    let sqrt_var = math::sqrt(total_var, ONE_E9);
    let sqrt_var_i = i64::from_u64(sqrt_var);
    let half_var_i = i64::from_u64(total_var / 2);
    let d2_num = i64::add(&k, &half_var_i);
    let d2 = i64::div_scaled(&d2_num, &sqrt_var_i);
    let d2 = i64::neg(&d2);

    math::normal_cdf(&d2)
}

fun to_flicky_i64(v: &db_i64::I64): i64::I64 {
    i64::from_parts(db_i64::magnitude(v), db_i64::is_negative(v))
}

fun mul_1e9(a: u64, b: u64): u64 {
    (((a as u128) * (b as u128)) / (ONE_E9 as u128)) as u64
}

fun mul_div_1e9(num: u64, den: u64): u64 {
    (((num as u128) * (ONE_E9 as u128)) / (den as u128)) as u64
}
