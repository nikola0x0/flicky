// Vendored minimal stub of `deepbook_predict::predict_manager` matching on-chain ABI.
module deepbook_predict::predict_manager;

use deepbook_predict::range_key::RangeKey;
use deepbook_predict::market_key::MarketKey;
use deepbook::balance_manager::{Self, BalanceManager, DepositCap, WithdrawCap};
use sui::table::{Self, Table};
use sui::coin::Coin;
use sui::dynamic_field;

const ENotImplementedInStub: u64 = 0;
const TEST_QTY_KEY: vector<u8> = b"test_qty";

public struct PredictManager has key {
    id: UID,
    owner: address,
    balance_manager: BalanceManager,
    deposit_cap: DepositCap,
    withdraw_cap: WithdrawCap,
    positions: Table<MarketKey, u64>,
    range_positions: Table<RangeKey, u64>,
}

public fun owner(self: &PredictManager): address { self.owner }

public fun position(self: &PredictManager, key: MarketKey): u64 {
    if (dynamic_field::exists_(&self.id, TEST_QTY_KEY)) {
        *dynamic_field::borrow(&self.id, TEST_QTY_KEY)
    } else if (table::contains(&self.positions, key)) {
        *table::borrow(&self.positions, key)
    } else {
        0
    }
}

public fun range_position(self: &PredictManager, key: RangeKey): u64 {
    if (dynamic_field::exists_(&self.id, TEST_QTY_KEY)) {
        *dynamic_field::borrow(&self.id, TEST_QTY_KEY)
    } else if (table::contains(&self.range_positions, key)) {
        *table::borrow(&self.range_positions, key)
    } else {
        0
    }
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

public fun share(self: PredictManager) {
    sui::transfer::share_object(self);
}

#[test_only]
public fun new_manager_for_testing(owner: address, test_position_qty: u64, ctx: &mut TxContext): PredictManager {
    let bm = balance_manager::new_for_testing(owner, ctx);
    let bm_id = object::id(&bm);
    let mut pm = PredictManager {
        id: object::new(ctx),
        owner,
        balance_manager: bm,
        deposit_cap: balance_manager::new_deposit_cap_for_testing(bm_id, ctx),
        withdraw_cap: balance_manager::new_withdraw_cap_for_testing(bm_id, ctx),
        positions: table::new(ctx),
        range_positions: table::new(ctx),
    };
    if (test_position_qty > 0) {
        dynamic_field::add(&mut pm.id, TEST_QTY_KEY, test_position_qty);
    };
    pm
}

#[test_only]
public fun set_test_position_qty(self: &mut PredictManager, qty: u64) {
    if (dynamic_field::exists_(&self.id, TEST_QTY_KEY)) {
        let val = dynamic_field::borrow_mut(&mut self.id, TEST_QTY_KEY);
        *val = qty;
    } else {
        dynamic_field::add(&mut self.id, TEST_QTY_KEY, qty);
    };
}

#[test_only]
public fun transfer_for_testing(self: PredictManager, recipient: address) {
    sui::transfer::transfer(self, recipient);
}
