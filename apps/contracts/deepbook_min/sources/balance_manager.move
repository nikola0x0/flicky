// Vendored minimal stub of `deepbook::balance_manager` matching on-chain ABI.
module deepbook::balance_manager;

use sui::bag::Bag;
use sui::vec_set::VecSet;

public struct BalanceManager has key, store {
    id: UID,
    owner: address,
    balances: Bag,
    allow_listed: VecSet<ID>,
}

public struct DepositCap has key, store {
    id: UID,
    balance_manager_id: ID,
}

public struct WithdrawCap has key, store {
    id: UID,
    balance_manager_id: ID,
}

#[test_only]
public fun new_for_testing(owner: address, ctx: &mut TxContext): BalanceManager {
    BalanceManager {
        id: object::new(ctx),
        owner,
        balances: sui::bag::new(ctx),
        allow_listed: sui::vec_set::empty(),
    }
}

#[test_only]
public fun new_deposit_cap_for_testing(bm_id: ID, ctx: &mut TxContext): DepositCap {
    DepositCap {
        id: object::new(ctx),
        balance_manager_id: bm_id,
    }
}

#[test_only]
public fun new_withdraw_cap_for_testing(bm_id: ID, ctx: &mut TxContext): WithdrawCap {
    WithdrawCap {
        id: object::new(ctx),
        balance_manager_id: bm_id,
    }
}
