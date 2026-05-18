// Copyright (c) Flicky Labs
// SPDX-License-Identifier: Apache-2.0

/// Multi-asset oracle system for Flicky prediction protocol.
///
/// Extends DeepBook Predict by supporting any asset (ETH, SUI, SOL, ...) via
/// an admin-operated price feed. Each oracle tracks a single asset/expiry pair
/// and follows DeepBook's three-state lifecycle:
///   `ACTIVE` (accepting price pushes) →
///   `PENDING_SETTLEMENT` (past expiry, awaiting a fresh settlement price) →
///   `SETTLED` (terminal).
///
/// In production, price updates would come from Pyth/Supra on-chain feeds. For
/// the hackathon POC, an admin keypair pushes prices and a Bun keeper drives
/// the `update_price` cadence + `settle` at expiry.
module flicky::oracle;
use flicky::{i64, math};
use std::string::String;
use sui::{clock::Clock, event};

// === Errors ===
const EOracleNotActive: u64 = 0;
const EOracleNotPendingSettlement: u64 = 1;
const EZeroSpot: u64 = 2;
const EZeroForward: u64 = 3;
const EStaleSourceUpdate: u64 = 4;
const EFutureSourceUpdate: u64 = 5;
const ESettlementSourceTooOld: u64 = 6;
const ESpotDeviationTooLarge: u64 = 7;
const EInvalidBounds: u64 = 8;
const EInvalidStrikeConfig: u64 = 9;
const EInvalidExpiry: u64 = 10;

// === Status constants ===
const STATUS_ACTIVE: u8 = 1;
const STATUS_PENDING_SETTLEMENT: u8 = 2;
const STATUS_SETTLED: u8 = 3;

// === Numeric constants ===
/// 9-decimal fixed-point unit (1.0 == 1e9)
const ONE_E9: u64 = 1_000_000_000;
/// Default annualized volatility used when none is supplied (60% in 9-decimal)
const DEFAULT_VOLATILITY: u64 = 600_000_000;
/// Probability clamp range for `implied_probability_up`
const MIN_PROB: u64 = 50_000_000; // 5%
const MAX_PROB: u64 = 950_000_000; // 95%

// === Events ===

public struct OracleCreated has copy, drop {
    oracle_id: ID,
    asset: String,
    expiry: u64,
    min_strike: u64,
    tick_size: u64,
    num_ticks: u64,
}

public struct PriceUpdated has copy, drop {
    oracle_id: ID,
    asset: String,
    spot: u64,
    forward: u64,
    volatility: u64,
    source_timestamp_ms: u64,
    update_timestamp_ms: u64,
}

public struct OracleSettled has copy, drop {
    oracle_id: ID,
    asset: String,
    settlement_price: u64,
    expiry: u64,
    source_timestamp_ms: u64,
    update_timestamp_ms: u64,
}

// === Structs ===

/// Admin capability — holder can create oracles, push prices, and settle.
/// Minted once on publish via `init` and transferred to the deployer.
public struct OracleAdminCap has key, store {
    id: UID,
}

/// Runtime bounds applied to every price push and settlement.
public struct OracleBounds has copy, drop, store {
    /// Max age of the settlement source timestamp at the moment `settle` lands.
    settlement_freshness_ms: u64,
    /// Max relative spot deviation between consecutive pushes (9-decimal fixed
    /// point: 50_000_000 == 5%). `0` disables the check.
    max_spot_deviation: u64,
}

/// Latest price snapshot from the oracle publisher.
public struct PriceState has copy, drop, store {
    spot: u64,
    forward: u64,
    volatility: u64,
    /// Timestamp the publisher claims the data was observed at.
    source_timestamp_ms: u64,
    /// On-chain `clock.timestamp_ms()` when the push landed.
    update_timestamp_ms: u64,
}

/// Terminal settlement state — set exactly once.
public struct SettlementState has copy, drop, store {
    price: u64,
    source_timestamp_ms: u64,
    update_timestamp_ms: u64,
}

/// Per-asset, per-expiry oracle instance. Shared so any duel can read it.
public struct FlickyOracle has key, store {
    id: UID,
    /// Human-readable asset name: "BTC", "ETH", "SUI", "SOL", ...
    asset: String,
    /// Expiry timestamp in milliseconds.
    expiry: u64,
    /// Latest publisher-supplied price snapshot.
    price: PriceState,
    /// Terminal settlement state; populated on `settle`.
    settlement: Option<SettlementState>,
    /// Minimum strike on the grid (9-decimal).
    min_strike: u64,
    /// Strike grid tick size (9-decimal).
    tick_size: u64,
    /// Number of strikes on the grid.
    num_ticks: u64,
    /// On-chain timestamp when the oracle was created.
    created_at_ms: u64,
    /// Tuning bounds for safety checks.
    bounds: OracleBounds,
}

// === Init ===

/// Mint the admin cap on publish and transfer it to the deployer.
fun init(ctx: &mut TxContext) {
    let cap = OracleAdminCap { id: object::new(ctx) };
    transfer::transfer(cap, ctx.sender());
}

// === Public Functions ===

/// Create a new oracle for any asset. Starts in `ACTIVE` with zero-valued
/// price data; the first `update_price` call seeds the snapshot.
public fun create_oracle(
    _cap: &OracleAdminCap,
    asset: String,
    expiry: u64,
    min_strike: u64,
    tick_size: u64,
    num_ticks: u64,
    settlement_freshness_ms: u64,
    max_spot_deviation: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): ID {
    assert!(tick_size > 0, EInvalidStrikeConfig);
    assert!(num_ticks > 0, EInvalidStrikeConfig);
    assert!(settlement_freshness_ms > 0, EInvalidBounds);
    assert!(max_spot_deviation < ONE_E9, EInvalidBounds);
    assert!(expiry > clock.timestamp_ms(), EInvalidExpiry);

    let oracle = FlickyOracle {
        id: object::new(ctx),
        asset,
        expiry,
        price: PriceState {
            spot: 0,
            forward: 0,
            volatility: DEFAULT_VOLATILITY,
            source_timestamp_ms: 0,
            update_timestamp_ms: 0,
        },
        settlement: option::none(),
        min_strike,
        tick_size,
        num_ticks,
        created_at_ms: clock.timestamp_ms(),
        bounds: OracleBounds {
            settlement_freshness_ms,
            max_spot_deviation,
        },
    };

    let oracle_id = object::id(&oracle);

    event::emit(OracleCreated {
        oracle_id,
        asset: oracle.asset,
        expiry,
        min_strike,
        tick_size,
        num_ticks,
    });

    transfer::share_object(oracle);
    oracle_id
}

/// Push a price snapshot. Only valid while the oracle is `ACTIVE`. The
/// `source_timestamp_ms` is the publisher's observation time (e.g. Pyth
/// aggregator timestamp); pushes that are stale, future-dated, or violate
/// the spot deviation circuit breaker are rejected.
public fun update_price(
    oracle: &mut FlickyOracle,
    _cap: &OracleAdminCap,
    spot: u64,
    forward: u64,
    volatility: u64,
    source_timestamp_ms: u64,
    clock: &Clock,
) {
    assert!(oracle.status(clock) == STATUS_ACTIVE, EOracleNotActive);
    assert!(spot > 0, EZeroSpot);
    assert!(forward > 0, EZeroForward);

    let now_ms = clock.timestamp_ms();
    assert!(source_timestamp_ms <= now_ms, EFutureSourceUpdate);
    assert!(source_timestamp_ms > oracle.price.source_timestamp_ms, EStaleSourceUpdate);
    oracle.assert_spot_deviation(spot);

    oracle.price =
        PriceState {
            spot,
            forward,
            volatility,
            source_timestamp_ms,
            update_timestamp_ms: now_ms,
        };

    event::emit(PriceUpdated {
        oracle_id: object::id(oracle),
        asset: oracle.asset,
        spot,
        forward,
        volatility,
        source_timestamp_ms,
        update_timestamp_ms: now_ms,
    });
}

/// Finalize the oracle once expired. Caller supplies a fresh settlement
/// price observed at or after `expiry`. The source must land within the
/// configured `settlement_freshness_ms` window.
public fun settle(
    oracle: &mut FlickyOracle,
    _cap: &OracleAdminCap,
    settlement_price: u64,
    source_timestamp_ms: u64,
    clock: &Clock,
) {
    assert!(oracle.status(clock) == STATUS_PENDING_SETTLEMENT, EOracleNotPendingSettlement);
    assert!(settlement_price > 0, EZeroSpot);

    let now_ms = clock.timestamp_ms();
    assert!(source_timestamp_ms <= now_ms, EFutureSourceUpdate);
    assert!(source_timestamp_ms > oracle.expiry, EStaleSourceUpdate);
    assert!(
        now_ms - source_timestamp_ms <= oracle.bounds.settlement_freshness_ms,
        ESettlementSourceTooOld,
    );

    oracle.settlement =
        option::some(SettlementState {
            price: settlement_price,
            source_timestamp_ms,
            update_timestamp_ms: now_ms,
        });

    event::emit(OracleSettled {
        oracle_id: object::id(oracle),
        asset: oracle.asset,
        settlement_price,
        expiry: oracle.expiry,
        source_timestamp_ms,
        update_timestamp_ms: now_ms,
    });
}

// === Read API ===

/// Current lifecycle status.
public fun status(oracle: &FlickyOracle, clock: &Clock): u8 {
    if (oracle.settlement.is_some()) {
        STATUS_SETTLED
    } else if (clock.timestamp_ms() >= oracle.expiry) {
        STATUS_PENDING_SETTLEMENT
    } else {
        STATUS_ACTIVE
    }
}

public fun is_live(oracle: &FlickyOracle, clock: &Clock): bool {
    oracle.status(clock) == STATUS_ACTIVE && oracle.price.spot > 0
}

public fun is_settled(oracle: &FlickyOracle): bool {
    oracle.settlement.is_some()
}

public fun asset(oracle: &FlickyOracle): String { oracle.asset }

public fun expiry(oracle: &FlickyOracle): u64 { oracle.expiry }

public fun spot(oracle: &FlickyOracle): u64 { oracle.price.spot }

public fun forward(oracle: &FlickyOracle): u64 { oracle.price.forward }

public fun volatility(oracle: &FlickyOracle): u64 { oracle.price.volatility }

public fun price_source_timestamp_ms(oracle: &FlickyOracle): u64 {
    oracle.price.source_timestamp_ms
}

public fun price_update_timestamp_ms(oracle: &FlickyOracle): u64 {
    oracle.price.update_timestamp_ms
}

public fun settlement_price(oracle: &FlickyOracle): u64 {
    oracle.settlement.borrow().price
}

public fun settlement_source_timestamp_ms(oracle: &FlickyOracle): u64 {
    oracle.settlement.borrow().source_timestamp_ms
}

public fun settlement_update_timestamp_ms(oracle: &FlickyOracle): u64 {
    oracle.settlement.borrow().update_timestamp_ms
}

public fun min_strike(oracle: &FlickyOracle): u64 { oracle.min_strike }

public fun tick_size(oracle: &FlickyOracle): u64 { oracle.tick_size }

public fun num_ticks(oracle: &FlickyOracle): u64 { oracle.num_ticks }

public fun max_strike(oracle: &FlickyOracle): u64 {
    oracle.min_strike + oracle.tick_size * oracle.num_ticks
}

public fun settlement_freshness_ms(oracle: &FlickyOracle): u64 {
    oracle.bounds.settlement_freshness_ms
}

public fun max_spot_deviation(oracle: &FlickyOracle): u64 {
    oracle.bounds.max_spot_deviation
}

public fun created_at_ms(oracle: &FlickyOracle): u64 { oracle.created_at_ms }

public fun status_active(): u8 { STATUS_ACTIVE }

public fun status_pending_settlement(): u8 { STATUS_PENDING_SETTLEMENT }

public fun status_settled(): u8 { STATUS_SETTLED }

/// Validate that a strike lies on the configured grid.
public fun is_valid_strike(oracle: &FlickyOracle, strike: u64): bool {
    strike >= oracle.min_strike
    && strike <= oracle.max_strike()
    && (strike - oracle.min_strike) % oracle.tick_size == 0
}

/// Implied probability for a binary UP position at `strike`, in 1e9 fixed
/// point (1e9 == 100%).
///
/// Uses a Black-Scholes binary digital model — the same formula DeepBook's
/// `pricing::compute_nd2` uses (minus the SVI surface, which we don't store):
///
///   k       = ln(strike / forward)
///   w       = σ² · T  (total variance for time to expiry T in years)
///   d2      = -(k + w/2) / √w
///   p(UP)   = Φ(d2)         (standard normal CDF)
///
/// Clamped to [5%, 95%] for game playability — scoring divides by p_swiped
/// and runaway long-tail prices break the duel economics.
public fun implied_probability_up(oracle: &FlickyOracle, strike: u64, clock: &Clock): u64 {
    let forward = oracle.price.forward;
    if (forward == 0) return ONE_E9 / 2;

    let now_ms = clock.timestamp_ms();
    let ttl_ms = if (oracle.expiry > now_ms) {
        oracle.expiry - now_ms
    } else {
        0
    };

    if (ttl_ms == 0) {
        if (oracle.settlement.is_some()) {
            let sp = oracle.settlement.borrow().price;
            return if (sp > strike) { ONE_E9 } else { 0 }
        };
        return ONE_E9 / 2
    };

    let prob = compute_p_up_bs(forward, strike, oracle.price.volatility, ttl_ms);
    if (prob < MIN_PROB) { MIN_PROB } else if (prob > MAX_PROB) { MAX_PROB } else { prob }
}

/// `p(DOWN) = 1 − p(UP)`.
public fun implied_probability_down(oracle: &FlickyOracle, strike: u64, clock: &Clock): u64 {
    ONE_E9 - oracle.implied_probability_up(strike, clock)
}

// === Internal helpers ===

fun assert_spot_deviation(oracle: &FlickyOracle, new_spot: u64) {
    let prev = oracle.price.spot;
    if (prev == 0 || oracle.bounds.max_spot_deviation == 0) return;

    let diff = if (new_spot >= prev) { new_spot - prev } else { prev - new_spot };
    // max_allowed = prev * max_spot_deviation / ONE_E9
    let max_allowed = (
        ((prev as u128) * (oracle.bounds.max_spot_deviation as u128) / (ONE_E9 as u128)) as u64,
    );
    assert!(diff <= max_allowed, ESpotDeviationTooLarge);
}

/// Black-Scholes binary digital `p(UP)` in 1e9 fixed point.
/// `volatility` is annualized σ in 1e9 (e.g. 600_000_000 == 60% vol).
/// Returns 1e9-scaled `Φ(d2)` directly (no clamping — caller applies game bounds).
fun compute_p_up_bs(forward: u64, strike: u64, volatility: u64, ttl_ms: u64): u64 {
    // Total variance: σ² × T_years, all in 1e9 fixed point.
    let ms_per_year: u128 = 31_557_600_000;
    let sigma_sq_128 = ((volatility as u128) * (volatility as u128)) / (ONE_E9 as u128);
    let total_var_128 = sigma_sq_128 * (ttl_ms as u128) / ms_per_year;
    if (total_var_128 == 0) return ONE_E9 / 2;
    let total_var = total_var_128 as u64;

    // k = ln(strike / forward) in 1e9 fixed point (signed).
    let k_ratio = (((strike as u128) * (ONE_E9 as u128) / (forward as u128)) as u64);
    let k = math::ln(k_ratio);

    // d2 = -(k + total_var/2) / sqrt(total_var)
    let sqrt_var = math::sqrt(total_var, ONE_E9);
    if (sqrt_var == 0) return ONE_E9 / 2;
    let sqrt_var_i = i64::from_u64(sqrt_var);
    let half_var_i = i64::from_u64(total_var / 2);
    let inner = k.add(&half_var_i);
    let d2_pos = inner.div_scaled(&sqrt_var_i);
    let d2 = d2_pos.neg();
    math::normal_cdf(&d2)
}

// === Test-only ===

#[test_only]
public fun init_for_testing(ctx: &mut TxContext): OracleAdminCap {
    OracleAdminCap { id: object::new(ctx) }
}
