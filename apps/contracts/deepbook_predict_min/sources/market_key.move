// Vendored minimal stub of `deepbook_predict::market_key` matching on-chain ABI.
module deepbook_predict::market_key;

public struct MarketKey has copy, drop, store {
    oracle_id: ID,
    expiry: u64,
    strike: u64,
    direction: u8
}

public fun up(oracle_id: ID, expiry: u64, strike: u64): MarketKey {
    MarketKey {
        oracle_id,
        expiry,
        strike,
        direction: 0
    }
}

public fun down(oracle_id: ID, expiry: u64, strike: u64): MarketKey {
    MarketKey {
        oracle_id,
        expiry,
        strike,
        direction: 1
    }
}

public fun new(oracle_id: ID, expiry: u64, strike: u64, direction: bool): MarketKey {
    MarketKey {
        oracle_id,
        expiry,
        strike,
        direction: if (direction) 0 else 1
    }
}

public fun oracle_id(self: &MarketKey): ID {
    self.oracle_id
}

public fun expiry(self: &MarketKey): u64 {
    self.expiry
}

public fun strike(self: &MarketKey): u64 {
    self.strike
}

public fun is_up(self: &MarketKey): bool {
    self.direction == 0
}

public fun is_down(self: &MarketKey): bool {
    self.direction == 1
}

