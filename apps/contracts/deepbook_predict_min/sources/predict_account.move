/// Local link stub for `deepbook_predict::predict_account`
/// (0xdb3ef5a5...446e, predict-testnet-6-24). flicky's only on-chain call
/// into the predict package is `has_position` for settle-time anti-replay.
module deepbook_predict::predict_account;

use account::account::{Self, Account};

/// True iff the account still holds the open position `(expiry_market_id,
/// order_id)`. In the real package this reads the account's PredictApp
/// position table; here it delegates to the account stub's seeded set.
public fun has_position(account: &Account, expiry_market_id: ID, order_id: u256): bool {
    account::contains_position(account, expiry_market_id, order_id)
}
