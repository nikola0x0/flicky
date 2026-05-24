# Standalone Constant Product AMM Swap Contract

This directory contains the standalone constant product AMM swap pool contract for the Flicky DeFi ecosystem, deployed on **Sui Testnet**.

## Deployed Contract Addresses (Sui Testnet)

* **Package ID**: `0x51ea0f29321f3c25f8b2f530ecd3ed3dec569d954c8832d318de7e203653a936`
* **Upgrade Capability ID**: `0x676dcb5f4a83791aed86c7a2f0488a75caa93aa49f90b22b98b30a17ebe8c178`

---

## Core Mechanics

The contract implements a standard Uniswap V2 style constant product market maker ($x \cdot y = k$) for any generic pair of Sui coins `COIN_X` and `COIN_Y`.

### 1. Key Data Structures

* **`Pool<COIN_X, COIN_Y>`** (Shared Object):
  * Manages the balances of `COIN_X` and `COIN_Y` in the pool.
  * Tracks total `LP` coin supply.
  * Stores fee percentage configured in basis points (e.g. `30` bps = `0.3%`).
* **`LP<COIN_X, COIN_Y>`** (Witness/Coin):
  * Represents a user's share of the pool.
  * Mints LP tokens when liquidity is supplied, and burns them on liquidity withdrawal.

---

## Smart Contract Functions

### Initialization

```move
public entry fun entry_create_pool<COIN_X, COIN_Y>(
    fee_pct: u64,
    ctx: &mut TxContext
)
```
Deploys a new shared pool for a specific token pair with a set fee basis points.

### Liquidity Management

```move
public entry fun entry_add_liquidity<COIN_X, COIN_Y>(
    pool: &mut Pool<COIN_X, COIN_Y>,
    coin_x: Coin<COIN_X>,
    coin_y: Coin<COIN_Y>,
    ctx: &mut TxContext
)
```
Supplies tokens to the pool and mints matching LP shares directly to the sender.

```move
public entry fun entry_remove_liquidity<COIN_X, COIN_Y>(
    pool: &mut Pool<COIN_X, COIN_Y>,
    lp_coin: Coin<LP<COIN_X, COIN_Y>>,
    ctx: &mut TxContext
)
```
Burns LP tokens and withdraws proportional SUI and dUSDC reserves back to the sender.

### Swapping

```move
public entry fun entry_swap_x_for_y<COIN_X, COIN_Y>(
    pool: &mut Pool<COIN_X, COIN_Y>,
    coin_x: Coin<COIN_X>,
    min_amount_out: u64,
    ctx: &mut TxContext
)
```
Swaps `COIN_X` (e.g., SUI) for `COIN_Y` (e.g., dUSDC) with minimum output safety threshold.

```move
public entry fun entry_swap_y_for_x<COIN_X, COIN_Y>(
    pool: &mut Pool<COIN_X, COIN_Y>,
    coin_y: Coin<COIN_Y>,
    min_amount_out: u64,
    ctx: &mut TxContext
)
```
Swaps `COIN_Y` (e.g., dUSDC) for `COIN_X` (e.g., SUI) with minimum output safety threshold.

---

## Build & Test Commands

Run the following commands inside `apps/contracts/swap/` to compile or test:

```bash
# Compile Move package
sui move build

# Run unit tests
sui move test
```
