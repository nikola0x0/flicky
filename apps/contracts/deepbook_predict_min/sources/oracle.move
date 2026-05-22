// Vendored minimal stub of `deepbook_predict::oracle`. Mirrors the on-chain
// struct layout + public read API of the deployed package
// (`0xf5ea2b37…`) so flicky can typecheck against `&OracleSVI` and link via
// dep-replacement at runtime.
//
// We only re-declare the types and the read functions our flicky code calls.
// Write paths (activate, update_prices, update_svi, settle) and the
// admin-cap-bearing constructors are intentionally omitted from the public
// surface. A small `#[test_only]` API is provided so flicky's unit tests can
// fabricate a usable `OracleSVI` without owning a real cap.
module deepbook_predict::oracle;

use deepbook_predict::i64;
use std::string::String;
use sui::clock::Clock;
use sui::vec_set::{Self, VecSet};

const STATUS_INACTIVE: u8 = 0;
const STATUS_ACTIVE: u8 = 1;
const STATUS_PENDING_SETTLEMENT: u8 = 2;
const STATUS_SETTLED: u8 = 3;

public struct PriceData has copy, drop, store {
    spot: u64,
    forward: u64,
}

public struct SVIParams has copy, drop, store {
    a: u64,
    b: u64,
    rho: i64::I64,
    m: i64::I64,
    sigma: u64,
}

public struct OracleSVI has key {
    id: UID,
    authorized_caps: VecSet<ID>,
    underlying_asset: String,
    expiry: u64,
    active: bool,
    prices: PriceData,
    svi: SVIParams,
    timestamp: u64,
    settlement_price: Option<u64>,
}

public struct OracleSVICap has key, store {
    id: UID,
}

// === Public read API ===

public fun id(oracle: &OracleSVI): ID { oracle.id.to_inner() }

public fun expiry(oracle: &OracleSVI): u64 { oracle.expiry }

public fun underlying_asset(oracle: &OracleSVI): String { oracle.underlying_asset }

public fun is_active(oracle: &OracleSVI): bool { oracle.active }

public fun is_settled(oracle: &OracleSVI): bool { oracle.settlement_price.is_some() }

public fun prices(oracle: &OracleSVI): PriceData { oracle.prices }

public fun spot_price(oracle: &OracleSVI): u64 { oracle.prices.spot }

public fun forward_price(oracle: &OracleSVI): u64 { oracle.prices.forward }

public fun svi(oracle: &OracleSVI): SVIParams { oracle.svi }

public fun settlement_price(oracle: &OracleSVI): Option<u64> { oracle.settlement_price }

public fun timestamp(oracle: &OracleSVI): u64 { oracle.timestamp }

public fun status(oracle: &OracleSVI, clock: &Clock): u8 {
    if (oracle.settlement_price.is_some()) {
        STATUS_SETTLED
    } else if (clock.timestamp_ms() >= oracle.expiry) {
        STATUS_PENDING_SETTLEMENT
    } else if (!oracle.active) {
        STATUS_INACTIVE
    } else {
        STATUS_ACTIVE
    }
}

public fun status_inactive(): u8 { STATUS_INACTIVE }

public fun status_active(): u8 { STATUS_ACTIVE }

public fun status_pending_settlement(): u8 { STATUS_PENDING_SETTLEMENT }

public fun status_settled(): u8 { STATUS_SETTLED }

public fun svi_a(p: &SVIParams): u64 { p.a }

public fun svi_b(p: &SVIParams): u64 { p.b }

public fun svi_rho(p: &SVIParams): i64::I64 { p.rho }

public fun svi_m(p: &SVIParams): i64::I64 { p.m }

public fun svi_sigma(p: &SVIParams): u64 { p.sigma }

// === Test-only constructors and mutators ===
//
// These exist so flicky's unit tests can drive the oracle lifecycle without
// the real `OracleSVICap`. They are absent from the published package; the
// linker will resolve them to the stub at test time and to the real package
// at deploy time via `dep-replacements`.

#[test_only]
public fun new_for_testing(
    underlying_asset: String,
    expiry: u64,
    ctx: &mut TxContext,
): OracleSVI {
    OracleSVI {
        id: object::new(ctx),
        authorized_caps: vec_set::empty(),
        underlying_asset,
        expiry,
        active: false,
        prices: PriceData { spot: 0, forward: 0 },
        svi: SVIParams {
            a: 0,
            b: 0,
            rho: i64::zero(),
            m: i64::zero(),
            sigma: 0,
        },
        timestamp: 0,
        settlement_price: option::none(),
    }
}

#[test_only]
public fun share_for_testing(oracle: OracleSVI) {
    transfer::share_object(oracle);
}

#[test_only]
public fun activate_for_testing(oracle: &mut OracleSVI) {
    oracle.active = true;
}

#[test_only]
public fun set_prices_for_testing(oracle: &mut OracleSVI, spot: u64, forward: u64, clock: &Clock) {
    oracle.prices = PriceData { spot, forward };
    oracle.timestamp = clock.timestamp_ms();
}

#[test_only]
public fun set_svi_for_testing(
    oracle: &mut OracleSVI,
    a: u64,
    b: u64,
    rho: i64::I64,
    m: i64::I64,
    sigma: u64,
) {
    oracle.svi = SVIParams { a, b, rho, m, sigma };
}

#[test_only]
public fun settle_for_testing(oracle: &mut OracleSVI, settlement_price: u64) {
    oracle.settlement_price = option::some(settlement_price);
    oracle.active = false;
}
