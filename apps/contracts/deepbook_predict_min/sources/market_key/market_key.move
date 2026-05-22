// Vendored minimal stub of `deepbook_predict::market_key`. Mirrors the
// public surface of the on-chain package so codegen produces correct
// builders. Function bodies abort because this stub is never executed —
// flicky links against the real published package at runtime.
module deepbook_predict::market_key;

public struct MarketKey has copy, drop, store {
    oracle_id: ID,
    expiry: u64,
    strike: u64,
    is_up: bool,
}

public fun up(oracle_id: ID, expiry: u64, strike: u64): MarketKey {
    MarketKey { oracle_id, expiry, strike, is_up: true }
}

public fun down(oracle_id: ID, expiry: u64, strike: u64): MarketKey {
    MarketKey { oracle_id, expiry, strike, is_up: false }
}

public fun new(oracle_id: ID, expiry: u64, strike: u64, is_up: bool): MarketKey {
    MarketKey { oracle_id, expiry, strike, is_up }
}

public fun oracle_id(key: &MarketKey): ID { key.oracle_id }

public fun expiry(key: &MarketKey): u64 { key.expiry }

public fun strike(key: &MarketKey): u64 { key.strike }

public fun is_up(key: &MarketKey): bool { key.is_up }

public fun is_down(key: &MarketKey): bool { !key.is_up }
