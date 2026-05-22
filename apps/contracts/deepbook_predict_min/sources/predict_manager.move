// Vendored minimal stub of `deepbook_predict::predict_manager`. Public
// surface mirrors the deployed package; function bodies abort because this
// stub is never executed — flicky links against the real published package
// at runtime. Internal tables (`positions`, `ranges`, etc.) are omitted —
// codegen only needs the type to exist + the function signatures.
module deepbook_predict::predict_manager;

use deepbook_predict::market_key::MarketKey;
use deepbook_predict::range_key::RangeKey;
use sui::coin::Coin;

const ENotImplementedInStub: u64 = 0;

public struct PredictManager has key {
    id: UID,
    owner: address,
}

public fun owner(self: &PredictManager): address { self.owner }

public fun position(_self: &PredictManager, _key: MarketKey): u64 {
    abort ENotImplementedInStub
}

public fun range_position(_self: &PredictManager, _key: RangeKey): u64 {
    abort ENotImplementedInStub
}

public fun balance<T>(_self: &PredictManager): u64 {
    abort ENotImplementedInStub
}

public fun deposit<T>(_self: &mut PredictManager, coin: Coin<T>, _ctx: &TxContext) {
    sui::transfer::public_transfer(coin, @0x0);
    abort ENotImplementedInStub
}

public fun withdraw<T>(_self: &mut PredictManager, _amount: u64, _ctx: &mut TxContext): Coin<T> {
    abort ENotImplementedInStub
}
