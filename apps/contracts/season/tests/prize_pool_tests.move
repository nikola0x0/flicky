// Copyright (c) Flicky Labs
// SPDX-License-Identifier: Apache-2.0

#[test_only]
module season::prize_pool_tests;

use season::prize_pool::{Self, AdminCap, PrizePool};
use sui::coin::{Self, Coin};
use sui::sui::SUI;
use sui::test_scenario as ts;

const ADMIN: address = @0xAD;
const W1: address = @0x1;
const W2: address = @0x2;

fun setup_pool(sc: &mut ts::Scenario) {
    prize_pool::init_for_testing(sc.ctx());
    sc.next_tx(ADMIN);
    let cap = sc.take_from_sender<AdminCap>();
    prize_pool::create_pool<SUI>(&cap, b"season-0", 1000, sc.ctx());
    sc.return_to_sender(cap);
}

#[test]
fun distribute_pays_winners_and_locks() {
    let mut sc = ts::begin(ADMIN);
    setup_pool(&mut sc);

    sc.next_tx(ADMIN);
    {
        let mut pool = sc.take_shared<PrizePool<SUI>>();
        prize_pool::deposit(&mut pool, coin::mint_for_testing<SUI>(500, sc.ctx()));
        assert!(prize_pool::pool_balance(&pool) == 500, 0);

        let cap = sc.take_from_sender<AdminCap>();
        prize_pool::distribute(&cap, &mut pool, vector[W1, W2], vector[300, 200], sc.ctx());
        assert!(prize_pool::pool_balance(&pool) == 0, 1);
        assert!(prize_pool::is_distributed(&pool), 2);
        sc.return_to_sender(cap);
        ts::return_shared(pool);
    };

    // Each winner received exactly their amount.
    sc.next_tx(W1);
    {
        let c = sc.take_from_sender<Coin<SUI>>();
        assert!(c.value() == 300, 3);
        sc.return_to_sender(c);
    };
    sc.next_tx(W2);
    {
        let c = sc.take_from_sender<Coin<SUI>>();
        assert!(c.value() == 200, 4);
        sc.return_to_sender(c);
    };
    sc.end();
}

#[test]
#[expected_failure(abort_code = season::prize_pool::EInsufficientPool)]
fun distribute_over_balance_aborts() {
    let mut sc = ts::begin(ADMIN);
    setup_pool(&mut sc);
    sc.next_tx(ADMIN);
    let mut pool = sc.take_shared<PrizePool<SUI>>();
    prize_pool::deposit(&mut pool, coin::mint_for_testing<SUI>(100, sc.ctx()));
    let cap = sc.take_from_sender<AdminCap>();
    // Asks for 150 out of 100 → abort.
    prize_pool::distribute(&cap, &mut pool, vector[W1], vector[150], sc.ctx());
    abort 42 // unreachable
}

#[test]
#[expected_failure(abort_code = season::prize_pool::EMismatchedLengths)]
fun distribute_mismatched_lengths_aborts() {
    let mut sc = ts::begin(ADMIN);
    setup_pool(&mut sc);
    sc.next_tx(ADMIN);
    let mut pool = sc.take_shared<PrizePool<SUI>>();
    prize_pool::deposit(&mut pool, coin::mint_for_testing<SUI>(100, sc.ctx()));
    let cap = sc.take_from_sender<AdminCap>();
    prize_pool::distribute(&cap, &mut pool, vector[W1, W2], vector[100], sc.ctx());
    abort 42
}

#[test]
fun withdraw_remainder_recovers_leftover() {
    let mut sc = ts::begin(ADMIN);
    setup_pool(&mut sc);
    sc.next_tx(ADMIN);
    {
        let mut pool = sc.take_shared<PrizePool<SUI>>();
        prize_pool::deposit(&mut pool, coin::mint_for_testing<SUI>(500, sc.ctx()));
        let cap = sc.take_from_sender<AdminCap>();
        // Pay 200, leaving 300.
        prize_pool::distribute(&cap, &mut pool, vector[W1], vector[200], sc.ctx());
        assert!(prize_pool::pool_balance(&pool) == 300, 0);
        // Sweep the remainder back to admin.
        let leftover = prize_pool::withdraw_remainder(&cap, &mut pool, sc.ctx());
        assert!(leftover.value() == 300, 1);
        assert!(prize_pool::pool_balance(&pool) == 0, 2);
        transfer::public_transfer(leftover, ADMIN);
        sc.return_to_sender(cap);
        ts::return_shared(pool);
    };
    sc.end();
}
