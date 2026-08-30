/// Local link stub for `deepbook_predict::predict_account`
/// (0x42104175...3597b, predict-testnet-8-21). flicky's only on-chain call
/// into the predict package is `has_position` for settle-time anti-replay.
module deepbook_predict::predict_account;

use account::account::{Self, Account};

/// True iff the account still holds the open position `(expiry_market_id,
/// order_id)`. In the real package this reads the account's PredictApp
/// position table; here it delegates to the account stub's seeded set.
public fun has_position(account: &Account, expiry_market_id: ID, order_id: u256): bool {
    account::contains_position(account, expiry_market_id, order_id)
}
