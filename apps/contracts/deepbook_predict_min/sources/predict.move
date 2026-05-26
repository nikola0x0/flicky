// Vendored minimal stub of `deepbook_predict::predict`.
module deepbook_predict::predict;

use deepbook_predict::oracle::{Self as db_oracle, OracleSVI};
use deepbook_predict::predict_manager::PredictManager;
use deepbook_predict::market_key::{Self as mk, MarketKey};
use deepbook_predict::range_key::RangeKey;
use sui::clock::Clock;

const PROB_SCALE_STUB: u64 = 1_000_000_000;

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

/// On-chain pricing: returns (mint_cost, max_payout) for swiping `quantity`
/// of the position keyed by `key`. mint_cost is the premium the player pays
/// to mint the Predict position; max_payout is `quantity`.
///
/// On testnet, dispatched to real `deepbook_predict::predict::get_trade_amounts`.
/// Locally (tests), computes from `oracle.compute_price` × direction so that
/// `set_test_price(oracle, p_up)` drives the stub's pricing deterministically.
public fun get_trade_amounts(
    _predict: &Predict,
    oracle: &OracleSVI,
    key: MarketKey,
    quantity: u64,
    _clock: &Clock,
): (u64, u64) {
    let p_up = db_oracle::compute_price(oracle, mk::strike(&key));
    let p_swiped = if (mk::is_up(&key)) p_up else (PROB_SCALE_STUB - p_up);
    let premium = (((quantity as u128) * (p_swiped as u128)) / (PROB_SCALE_STUB as u128)) as u64;
    (premium, quantity)
}

#[test_only]
public fun new_for_testing(ctx: &mut TxContext): Predict {
    Predict { id: object::new(ctx) }
}

#[test_only]
public fun share_for_testing(predict: Predict) {
    transfer::share_object(predict);
}


