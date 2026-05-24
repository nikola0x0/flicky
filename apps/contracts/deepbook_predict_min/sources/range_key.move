// Vendored minimal stub of `deepbook_predict::range_key` matching on-chain ABI.
module deepbook_predict::range_key;

public struct RangeKey has copy, drop, store {
    oracle_id: ID,
    expiry: u64,
    lower_strike: u64,
    higher_strike: u64,
}

public fun new(oracle_id: ID, expiry: u64, lower_strike: u64, higher_strike: u64): RangeKey {
    RangeKey { oracle_id, expiry, lower_strike, higher_strike }
}

public fun oracle_id(key: &RangeKey): ID {
    key.oracle_id
}

public fun expiry(key: &RangeKey): u64 {
    key.expiry
}

public fun lower_strike(key: &RangeKey): u64 {
    key.lower_strike
}

public fun higher_strike(key: &RangeKey): u64 {
    key.higher_strike
}
