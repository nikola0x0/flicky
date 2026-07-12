// Copyright (c) Flicky Labs
// SPDX-License-Identifier: Apache-2.0

/// Season prize escrow.
///
/// A `PrizePool<T>` shared object holds the season's prize funds (SUI, or any
/// coin `T`). Anyone may top it up (`deposit`); only the `AdminCap` holder may
/// create a pool, `distribute` to the ranked winners at season end, or recover
/// leftover funds. Display of standings + eligibility lives off-chain (the
/// server's `/leaderboard` + `/season`); this module is only the payout rail —
/// the team runs `season:results`, then submits that winner list to `distribute`.
///
/// Safety properties:
///   - Funds move out ONLY via `distribute` (admin) or `withdraw_remainder`
///     (admin) — never stuck (the recovery hatch always frees the balance).
///   - `distribute` is single-shot (`distributed` lock) and asserts matched
///     winner/amount lengths and `sum(amounts) <= balance`, so it can neither
///     be replayed nor over-spend the pool.
module season::prize_pool;

use sui::balance::{Self, Balance};
use sui::coin::{Self, Coin};
use sui::event;

// ========== Errors ==========

const EMismatchedLengths: u64 = 0;
const EZeroWinners: u64 = 1;
const EInsufficientPool: u64 = 2;
const EAlreadyDistributed: u64 = 3;

// ========== Capability ==========

/// Held by the publisher; authorizes create / distribute / recover.
public struct AdminCap has key, store {
    id: UID,
}

// ========== Pool ==========

/// A season's prize escrow. Shared so anyone can `deposit`; mutations that move
/// funds out are `AdminCap`-gated.
public struct PrizePool<phantom T> has key {
    id: UID,
    /// Human label for the season (e.g. b"season-0"). Informational.
    season_id: vector<u8>,
    /// The escrowed prize funds.
    balance: Balance<T>,
    /// When the season ends (ms). Informational — payout timing is admin
    /// discretion, not enforced on-chain.
    ends_at_ms: u64,
    /// Set once `distribute` runs; blocks a second distribution.
    distributed: bool,
}

// ========== Events ==========

public struct PoolCreated has copy, drop {
    pool_id: ID,
    season_id: vector<u8>,
    ends_at_ms: u64,
}

public struct Deposited has copy, drop {
    pool_id: ID,
    amount: u64,
    new_balance: u64,
}

public struct Distributed has copy, drop {
    pool_id: ID,
    season_id: vector<u8>,
    total: u64,
    winners: u64,
}

public struct RemainderWithdrawn has copy, drop {
    pool_id: ID,
    amount: u64,
}

// ========== Init ==========

/// Mint the single `AdminCap` to the publisher at publish time.
fun init(ctx: &mut TxContext) {
    transfer::public_transfer(AdminCap { id: object::new(ctx) }, ctx.sender());
}

// ========== Admin: create ==========

/// Create and share an empty prize pool for a season. Admin-only.
public fun create_pool<T>(
    _: &AdminCap,
    season_id: vector<u8>,
    ends_at_ms: u64,
    ctx: &mut TxContext,
) {
    let pool = PrizePool<T> {
        id: object::new(ctx),
        season_id,
        balance: balance::zero<T>(),
        ends_at_ms,
        distributed: false,
    };
    event::emit(PoolCreated {
        pool_id: object::id(&pool),
        season_id: pool.season_id,
        ends_at_ms,
    });
    transfer::share_object(pool);
}

// ========== Fund (permissionless) ==========

/// Top up the pool. Anyone can add funds — funding is always safe.
public fun deposit<T>(pool: &mut PrizePool<T>, funds: Coin<T>) {
    let amount = funds.value();
    pool.balance.join(funds.into_balance());
    event::emit(Deposited {
        pool_id: object::id(pool),
        amount,
        new_balance: pool.balance.value(),
    });
}

// ========== Admin: distribute ==========

/// Pay each winner their amount, then lock the pool. Admin-only, single-shot.
/// `winners[i]` receives `amounts[i]`. Aborts on mismatched lengths, an empty
/// list, an insufficient balance, or a second call. Any leftover stays in the
/// pool (recover it with `withdraw_remainder`).
public fun distribute<T>(
    _: &AdminCap,
    pool: &mut PrizePool<T>,
    winners: vector<address>,
    amounts: vector<u64>,
    ctx: &mut TxContext,
) {
    assert!(!pool.distributed, EAlreadyDistributed);
    let n = winners.length();
    assert!(n == amounts.length(), EMismatchedLengths);
    assert!(n > 0, EZeroWinners);

    let mut total = 0u64;
    let mut i = 0;
    while (i < n) {
        total = total + amounts[i];
        i = i + 1;
    };
    assert!(total <= pool.balance.value(), EInsufficientPool);

    i = 0;
    while (i < n) {
        let amount = amounts[i];
        if (amount > 0) {
            let payout = coin::from_balance(pool.balance.split(amount), ctx);
            transfer::public_transfer(payout, winners[i]);
        };
        i = i + 1;
    };

    pool.distributed = true;
    event::emit(Distributed {
        pool_id: object::id(pool),
        season_id: pool.season_id,
        total,
        winners: n,
    });
}

// ========== Admin: recover ==========

/// Recover the pool's remaining balance as a coin to the caller — the safety
/// hatch so funds are never stuck (season cancelled, over-funded, dust after a
/// distribution). Admin-only; callable before or after `distribute`.
public fun withdraw_remainder<T>(
    _: &AdminCap,
    pool: &mut PrizePool<T>,
    ctx: &mut TxContext,
): Coin<T> {
    let amount = pool.balance.value();
    let out = coin::from_balance(pool.balance.withdraw_all(), ctx);
    event::emit(RemainderWithdrawn { pool_id: object::id(pool), amount });
    out
}

// ========== Getters ==========

public fun pool_balance<T>(pool: &PrizePool<T>): u64 {
    pool.balance.value()
}

public fun is_distributed<T>(pool: &PrizePool<T>): bool {
    pool.distributed
}

public fun ends_at_ms<T>(pool: &PrizePool<T>): u64 {
    pool.ends_at_ms
}

// ========== Test helpers ==========

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) {
    init(ctx)
}
