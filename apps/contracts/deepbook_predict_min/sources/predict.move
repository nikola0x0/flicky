// Vendored minimal stub of `deepbook_predict::predict`. Public function
// signatures match the deployed package; bodies abort because this stub is
// never executed — flicky links against the real published package at
// runtime. Internal fields (vault, configs, etc.) are omitted.
module deepbook_predict::predict;

use deepbook_predict::market_key::MarketKey;
use deepbook_predict::oracle::{OracleSVI, OracleSVICap};
use deepbook_predict::predict_manager::PredictManager;
use deepbook_predict::range_key::RangeKey;
use sui::clock::Clock;

const ENotImplementedInStub: u64 = 0;

public struct Predict has key {
    id: UID,
}

public fun create_manager(_ctx: &mut TxContext): ID {
    abort ENotImplementedInStub
}

public fun get_trade_amounts(
    _predict: &Predict,
    _oracle: &OracleSVI,
    _key: MarketKey,
    _quantity: u64,
    _clock: &Clock,
): (u64, u64) {
    abort ENotImplementedInStub
}

public fun ask_bounds(_predict: &Predict, _oracle_id: ID): (u64, u64) {
    abort ENotImplementedInStub
}

public fun mint<Quote>(
    _predict: &mut Predict,
    _manager: &mut PredictManager,
    _oracle: &OracleSVI,
    _key: MarketKey,
    _quantity: u64,
    _clock: &Clock,
    _ctx: &mut TxContext,
) {
    abort ENotImplementedInStub
}

public fun compact_settled_oracle(
    _predict: &mut Predict,
    _oracle: &OracleSVI,
    _oracle_cap: &OracleSVICap,
) {
    abort ENotImplementedInStub
}

public fun redeem<Quote>(
    _predict: &mut Predict,
    _manager: &mut PredictManager,
    _oracle: &OracleSVI,
    _key: MarketKey,
    _quantity: u64,
    _clock: &Clock,
    _ctx: &mut TxContext,
) {
    abort ENotImplementedInStub
}

public fun redeem_permissionless<Quote>(
    _predict: &mut Predict,
    _manager: &mut PredictManager,
    _oracle: &OracleSVI,
    _key: MarketKey,
    _quantity: u64,
    _clock: &Clock,
    _ctx: &mut TxContext,
) {
    abort ENotImplementedInStub
}

public fun get_range_trade_amounts(
    _predict: &Predict,
    _oracle: &OracleSVI,
    _key: RangeKey,
    _quantity: u64,
    _clock: &Clock,
): (u64, u64) {
    abort ENotImplementedInStub
}

public fun mint_range<Quote>(
    _predict: &mut Predict,
    _manager: &mut PredictManager,
    _oracle: &OracleSVI,
    _key: RangeKey,
    _quantity: u64,
    _clock: &Clock,
    _ctx: &mut TxContext,
) {
    abort ENotImplementedInStub
}

public fun redeem_range<Quote>(
    _predict: &mut Predict,
    _manager: &mut PredictManager,
    _oracle: &OracleSVI,
    _key: RangeKey,
    _quantity: u64,
    _clock: &Clock,
    _ctx: &mut TxContext,
) {
    abort ENotImplementedInStub
}
