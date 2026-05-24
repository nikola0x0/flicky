// Vendored minimal stub of `deepbook_predict::predict`.
module deepbook_predict::predict;

use deepbook_predict::oracle::OracleSVI;
use deepbook_predict::predict_manager::PredictManager;
use deepbook_predict::market_key::MarketKey;
use deepbook_predict::range_key::RangeKey;
use sui::clock::Clock;

const ENotImplementedInStub: u64 = 0;

public struct Predict has key {
    id: UID,
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


