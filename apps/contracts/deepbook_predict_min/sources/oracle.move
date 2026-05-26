// Vendored minimal stub of `deepbook_predict::oracle` matching on-chain ABI.
module deepbook_predict::oracle;

use sui::clock::Clock;
use sui::vec_set::{Self, VecSet};
use std::string::String;
use deepbook_predict::i64::I64;

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
    rho: I64,
    m: I64,
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

public fun id(market: &OracleSVI): ID {
    market.id.to_inner()
}

public fun expiry(market: &OracleSVI): u64 {
    market.expiry
}

public fun is_settled(market: &OracleSVI): bool {
    market.settlement_price.is_some()
}

public fun status(market: &OracleSVI, clock: &Clock): u8 {
    if (market.settlement_price.is_some()) {
        STATUS_SETTLED
    } else if (clock.timestamp_ms() >= market.expiry) {
        STATUS_PENDING_SETTLEMENT
    } else {
        STATUS_ACTIVE
    }
}

public fun status_active(): u8 {
    STATUS_ACTIVE
}

public fun status_pending_settlement(): u8 {
    STATUS_PENDING_SETTLEMENT
}

public fun status_settled(): u8 {
    STATUS_SETTLED
}

public fun settlement_price(market: &OracleSVI): Option<u64> {
    market.settlement_price
}

public fun spot_price(market: &OracleSVI): u64 {
    market.prices.spot
}

public fun compute_price(market: &OracleSVI, _strike: u64): u64 {
    if (sui::dynamic_field::exists_(&market.id, b"test_price")) {
        *sui::dynamic_field::borrow(&market.id, b"test_price")
    } else {
        500_000_000
    }
}

// === Testnet admin (vendored stub only — DO NOT vendor onto mainnet) ===

/// Create a new OracleSVI on testnet. The stub deliberately omits the real
/// Predict cap-bearing constructor; this entry exists so the Flicky playground
/// and dev scripts can mint usable oracles without owning a real admin cap.
public fun new_market_oracle(expiry: u64, ctx: &mut TxContext): OracleSVI {
    OracleSVI {
        id: object::new(ctx),
        authorized_caps: vec_set::empty(),
        underlying_asset: std::string::utf8(b"USDC"),
        expiry,
        active: true,
        prices: PriceData { spot: 0, forward: 0 },
        svi: SVIParams {
            a: 0,
            b: 0,
            rho: deepbook_predict::i64::zero(),
            m: deepbook_predict::i64::zero(),
            sigma: 0,
        },
        timestamp: 0,
        settlement_price: option::none(),
    }
}

public fun share(oracle: OracleSVI) {
    transfer::share_object(oracle);
}

/// Set the price returned by `compute_price`. Stored in a dynamic field so we
/// don't need to mutate the (private) `prices` struct directly.
public fun set_compute_price(market: &mut OracleSVI, price: u64) {
    if (sui::dynamic_field::exists_(&market.id, b"test_price")) {
        let val: &mut u64 = sui::dynamic_field::borrow_mut(&mut market.id, b"test_price");
        *val = price;
    } else {
        sui::dynamic_field::add(&mut market.id, b"test_price", price);
    };
}

public fun settle_with(market: &mut OracleSVI, price: u64) {
    market.settlement_price = option::some(price);
}

#[test_only]
public fun new_for_testing(
    expiry: u64,
    ctx: &mut TxContext,
): OracleSVI {
    OracleSVI {
        id: object::new(ctx),
        authorized_caps: vec_set::empty(),
        underlying_asset: std::string::utf8(b"USDC"),
        expiry,
        active: true,
        prices: PriceData { spot: 0, forward: 0 },
        svi: SVIParams {
            a: 0,
            b: 0,
            rho: deepbook_predict::i64::zero(),
            m: deepbook_predict::i64::zero(),
            sigma: 0,
        },
        timestamp: 0,
        settlement_price: option::none(),
    }
}

#[test_only]
public fun share_for_testing(market: OracleSVI) {
    transfer::share_object(market);
}

#[test_only]
public fun settle_for_testing(market: &mut OracleSVI, price: u64) {
    market.settlement_price = option::some(price);
}

#[test_only]
public fun set_test_price(market: &mut OracleSVI, price: u64) {
    if (sui::dynamic_field::exists_(&market.id, b"test_price")) {
        let val = sui::dynamic_field::borrow_mut(&mut market.id, b"test_price");
        *val = price;
    } else {
        sui::dynamic_field::add(&mut market.id, b"test_price", price);
    };
}

