/// Local link stub for the on-chain `account` package
/// (0xb9389eac...15da3b, predict-testnet-6-24). Only the surface flicky
/// calls on-chain is stubbed: `load_account` + a position set for
/// anti-replay reads. Bodies are local test math; on-chain dispatch hits
/// the real package via `published-at`.
module account::account;

use sui::vec_set::{Self, VecSet};

public struct PosId has copy, drop, store {
    expiry_market_id: ID,
    order_id: u256,
}

public struct Account has store {
    owner: address,
    positions: VecSet<PosId>,
}

public struct AccountWrapper has key {
    id: UID,
    account: Account,
}

public fun load_account(self: &AccountWrapper): &Account {
    &self.account
}

public fun owner(self: &Account): address {
    self.owner
}

/// Stub of the real package's position-membership read. In the real
/// package this walks the attached PredictApp data; here it reads the
/// locally-seeded set so tests can drive anti-replay.
public fun contains_position(self: &Account, expiry_market_id: ID, order_id: u256): bool {
    self.positions.contains(&PosId { expiry_market_id, order_id })
}

#[test_only]
public fun new_wrapper_for_testing(owner: address, ctx: &mut TxContext): AccountWrapper {
    AccountWrapper {
        id: object::new(ctx),
        account: Account { owner, positions: vec_set::empty() },
    }
}

#[test_only]
public fun share_for_testing(w: AccountWrapper) {
    transfer::share_object(w);
}

#[test_only]
public fun add_position_for_testing(
    w: &mut AccountWrapper,
    expiry_market_id: ID,
    order_id: u256,
) {
    w.account.positions.insert(PosId { expiry_market_id, order_id });
}
