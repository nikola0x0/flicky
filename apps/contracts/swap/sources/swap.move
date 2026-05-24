// Copyright (c) Flicky Labs
// SPDX-License-Identifier: Apache-2.0

module swap::swap;

use sui::coin::{Self, Coin};
use sui::balance::{Self, Balance, Supply};

// ========== Errors ==========

const EZeroAmount: u64 = 0;
const EInsufficientOutput: u64 = 1;
const EEmptyPool: u64 = 2;
const EInvalidFee: u64 = 3;

// ========== Structs ==========

/// LP token witness for the pool
public struct LP<phantom COIN_X, phantom COIN_Y> has drop {}

/// Constant product AMM Pool managing reserves of Coin X and Coin Y
public struct Pool<phantom COIN_X, phantom COIN_Y> has key {
    id: UID,
    balance_x: Balance<COIN_X>,
    balance_y: Balance<COIN_Y>,
    lp_supply: Supply<LP<COIN_X, COIN_Y>>,
    fee_pct: u64, // Fee in basis points (e.g. 30 = 0.3%)
}

// ========== Getters ==========

public fun pool_reserves<COIN_X, COIN_Y>(pool: &Pool<COIN_X, COIN_Y>): (u64, u64) {
    (
        balance::value(&pool.balance_x),
        balance::value(&pool.balance_y)
    )
}

public fun pool_fee_pct<COIN_X, COIN_Y>(pool: &Pool<COIN_X, COIN_Y>): u64 {
    pool.fee_pct
}

public fun pool_lp_supply<COIN_X, COIN_Y>(pool: &Pool<COIN_X, COIN_Y>): u64 {
    balance::supply_value(&pool.lp_supply)
}

// ========== Core Functions ==========

/// Creates a new shared liquidity pool for COIN_X and COIN_Y
public fun create_pool<COIN_X, COIN_Y>(
    fee_pct: u64,
    ctx: &mut TxContext
) {
    assert!(fee_pct < 10000, EInvalidFee);
    let pool = Pool<COIN_X, COIN_Y> {
        id: object::new(ctx),
        balance_x: balance::zero(),
        balance_y: balance::zero(),
        lp_supply: balance::create_supply(LP<COIN_X, COIN_Y> {}),
        fee_pct,
    };
    transfer::share_object(pool);
}

/// Adds liquidity to the pool, mints and returns LP coins
public fun add_liquidity<COIN_X, COIN_Y>(
    pool: &mut Pool<COIN_X, COIN_Y>,
    coin_x: Coin<COIN_X>,
    coin_y: Coin<COIN_Y>,
    ctx: &mut TxContext
): Coin<LP<COIN_X, COIN_Y>> {
    let x_amt = coin::value(&coin_x);
    let y_amt = coin::value(&coin_y);
    assert!(x_amt > 0 && y_amt > 0, EZeroAmount);

    let reserve_x = (balance::value(&pool.balance_x) as u128);
    let reserve_y = (balance::value(&pool.balance_y) as u128);
    let lp_total = balance::supply_value(&pool.lp_supply);

    let lp_to_mint = if (lp_total == 0) {
        // Initial deposit: lp = sqrt(x * y)
        sqrt((x_amt as u128) * (y_amt as u128))
    } else {
        // Subsequent deposits: lp = min(x_amt * lp_total / reserve_x, y_amt * lp_total / reserve_y)
        let x_lp = (((x_amt as u128) * (lp_total as u128) / reserve_x) as u64);
        let y_lp = (((y_amt as u128) * (lp_total as u128) / reserve_y) as u64);
        if (x_lp < y_lp) { x_lp } else { y_lp }
    };

    assert!(lp_to_mint > 0, EZeroAmount);

    // Join pool balances
    balance::join(&mut pool.balance_x, coin::into_balance(coin_x));
    balance::join(&mut pool.balance_y, coin::into_balance(coin_y));

    // Increase LP supply and return LP coins
    let lp_balance = balance::increase_supply(&mut pool.lp_supply, lp_to_mint);
    coin::from_balance(lp_balance, ctx)
}

/// Burns LP tokens and returns the underlying Coin X and Coin Y reserves
public fun remove_liquidity<COIN_X, COIN_Y>(
    pool: &mut Pool<COIN_X, COIN_Y>,
    lp_coin: Coin<LP<COIN_X, COIN_Y>>,
    ctx: &mut TxContext
): (Coin<COIN_X>, Coin<COIN_Y>) {
    let lp_amt = coin::value(&lp_coin);
    assert!(lp_amt > 0, EZeroAmount);

    let reserve_x = (balance::value(&pool.balance_x) as u128);
    let reserve_y = (balance::value(&pool.balance_y) as u128);
    let lp_total = (balance::supply_value(&pool.lp_supply) as u128);

    // Calculate proportions of reserves to return
    let x_out = (((lp_amt as u128) * reserve_x / lp_total) as u64);
    let y_out = (((lp_amt as u128) * reserve_y / lp_total) as u64);

    assert!(x_out > 0 && y_out > 0, EZeroAmount);

    // Burn LP tokens
    balance::decrease_supply(&mut pool.lp_supply, coin::into_balance(lp_coin));

    // Split balances and convert back to coins
    let coin_x = coin::from_balance(balance::split(&mut pool.balance_x, x_out), ctx);
    let coin_y = coin::from_balance(balance::split(&mut pool.balance_y, y_out), ctx);

    (coin_x, coin_y)
}

/// Swaps Coin X for Coin Y
public fun swap_x_for_y<COIN_X, COIN_Y>(
    pool: &mut Pool<COIN_X, COIN_Y>,
    coin_x: Coin<COIN_X>,
    min_amount_out: u64,
    ctx: &mut TxContext
): Coin<COIN_Y> {
    let dx = (coin::value(&coin_x) as u128);
    assert!(dx > 0, EZeroAmount);

    let reserve_x = (balance::value(&pool.balance_x) as u128);
    let reserve_y = (balance::value(&pool.balance_y) as u128);
    assert!(reserve_x > 0 && reserve_y > 0, EEmptyPool);

    // Constant product formula with fee:
    // dy = (reserve_y * dx * (10000 - fee_pct)) / (reserve_x * 10000 + dx * (10000 - fee_pct))
    let multiplier: u128 = 10000;
    let fee_factor = multiplier - (pool.fee_pct as u128);
    let numerator = reserve_y * dx * fee_factor;
    let denominator = reserve_x * multiplier + dx * fee_factor;
    let dy = ((numerator / denominator) as u64);

    assert!(dy >= min_amount_out, EInsufficientOutput);

    // Update balances
    balance::join(&mut pool.balance_x, coin::into_balance(coin_x));
    let coin_y_balance = balance::split(&mut pool.balance_y, dy);
    coin::from_balance(coin_y_balance, ctx)
}

/// Swaps Coin Y for Coin X
public fun swap_y_for_x<COIN_X, COIN_Y>(
    pool: &mut Pool<COIN_X, COIN_Y>,
    coin_y: Coin<COIN_Y>,
    min_amount_out: u64,
    ctx: &mut TxContext
): Coin<COIN_X> {
    let dy = (coin::value(&coin_y) as u128);
    assert!(dy > 0, EZeroAmount);

    let reserve_x = (balance::value(&pool.balance_x) as u128);
    let reserve_y = (balance::value(&pool.balance_y) as u128);
    assert!(reserve_x > 0 && reserve_y > 0, EEmptyPool);

    let multiplier: u128 = 10000;
    let fee_factor = multiplier - (pool.fee_pct as u128);
    let numerator = reserve_x * dy * fee_factor;
    let denominator = reserve_y * multiplier + dy * fee_factor;
    let dx = ((numerator / denominator) as u64);

    assert!(dx >= min_amount_out, EInsufficientOutput);

    // Update balances
    balance::join(&mut pool.balance_y, coin::into_balance(coin_y));
    let coin_x_balance = balance::split(&mut pool.balance_x, dx);
    coin::from_balance(coin_x_balance, ctx)
}

// ========== Entry Functions ==========

entry fun entry_create_pool<COIN_X, COIN_Y>(
    fee_pct: u64,
    ctx: &mut TxContext
) {
    create_pool<COIN_X, COIN_Y>(fee_pct, ctx);
}

entry fun entry_swap_x_for_y<COIN_X, COIN_Y>(
    pool: &mut Pool<COIN_X, COIN_Y>,
    coin_x: Coin<COIN_X>,
    min_amount_out: u64,
    ctx: &mut TxContext
) {
    let coin_y = swap_x_for_y(pool, coin_x, min_amount_out, ctx);
    transfer::public_transfer(coin_y, tx_context::sender(ctx));
}

entry fun entry_swap_y_for_x<COIN_X, COIN_Y>(
    pool: &mut Pool<COIN_X, COIN_Y>,
    coin_y: Coin<COIN_Y>,
    min_amount_out: u64,
    ctx: &mut TxContext
) {
    let coin_x = swap_y_for_x(pool, coin_y, min_amount_out, ctx);
    transfer::public_transfer(coin_x, tx_context::sender(ctx));
}

entry fun entry_add_liquidity<COIN_X, COIN_Y>(
    pool: &mut Pool<COIN_X, COIN_Y>,
    coin_x: Coin<COIN_X>,
    coin_y: Coin<COIN_Y>,
    ctx: &mut TxContext
) {
    let lp_coin = add_liquidity(pool, coin_x, coin_y, ctx);
    transfer::public_transfer(lp_coin, tx_context::sender(ctx));
}

entry fun entry_remove_liquidity<COIN_X, COIN_Y>(
    pool: &mut Pool<COIN_X, COIN_Y>,
    lp_coin: Coin<LP<COIN_X, COIN_Y>>,
    ctx: &mut TxContext
) {
    let (coin_x, coin_y) = remove_liquidity(pool, lp_coin, ctx);
    let sender = tx_context::sender(ctx);
    transfer::public_transfer(coin_x, sender);
    transfer::public_transfer(coin_y, sender);
}

// ========== Helpers ==========

/// Integer square root (Babylonian / Newton's method)
fun sqrt(y: u128): u64 {
    if (y > 3) {
        let mut z = y;
        let mut x = y / 2 + 1;
        while (x < z) {
            z = x;
            x = (y / x + x) / 2;
        };
        (z as u64)
    } else if (y != 0) {
        1
    } else {
        0
    }
}
