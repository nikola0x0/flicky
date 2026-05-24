/**************************************************************
 * THIS FILE IS GENERATED AND SHOULD NOT BE MANUALLY MODIFIED *
 **************************************************************/
import { MoveStruct, normalizeMoveArguments, type RawTransactionArgument } from '../utils/index.js';
import { bcs } from '@mysten/sui/bcs';
import { type Transaction } from '@mysten/sui/transactions';
import * as balance from './deps/sui/balance.js';
const $moduleName = 'swap::swap';
export const LP = new MoveStruct({ name: `${$moduleName}::LP<phantom COIN_X, phantom COIN_Y>`, fields: {
        dummy_field: bcs.bool()
    } });
export const Pool = new MoveStruct({ name: `${$moduleName}::Pool<phantom COIN_X, phantom COIN_Y>`, fields: {
        id: bcs.Address,
        balance_x: balance.Balance,
        balance_y: balance.Balance,
        lp_supply: balance.Supply,
        fee_pct: bcs.u64()
    } });
export interface PoolReservesArguments {
    pool: RawTransactionArgument<string>;
}
export interface PoolReservesOptions {
    package?: string;
    arguments: PoolReservesArguments | [
        pool: RawTransactionArgument<string>
    ];
    typeArguments: [
        string,
        string
    ];
}
export function poolReserves(options: PoolReservesOptions) {
    const packageAddress = options.package ?? 'swap';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["pool"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'swap',
        function: 'pool_reserves',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
        typeArguments: options.typeArguments
    });
}
export interface PoolFeePctArguments {
    pool: RawTransactionArgument<string>;
}
export interface PoolFeePctOptions {
    package?: string;
    arguments: PoolFeePctArguments | [
        pool: RawTransactionArgument<string>
    ];
    typeArguments: [
        string,
        string
    ];
}
export function poolFeePct(options: PoolFeePctOptions) {
    const packageAddress = options.package ?? 'swap';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["pool"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'swap',
        function: 'pool_fee_pct',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
        typeArguments: options.typeArguments
    });
}
export interface PoolLpSupplyArguments {
    pool: RawTransactionArgument<string>;
}
export interface PoolLpSupplyOptions {
    package?: string;
    arguments: PoolLpSupplyArguments | [
        pool: RawTransactionArgument<string>
    ];
    typeArguments: [
        string,
        string
    ];
}
export function poolLpSupply(options: PoolLpSupplyOptions) {
    const packageAddress = options.package ?? 'swap';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["pool"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'swap',
        function: 'pool_lp_supply',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
        typeArguments: options.typeArguments
    });
}
export interface CreatePoolArguments {
    feePct: RawTransactionArgument<number | bigint>;
}
export interface CreatePoolOptions {
    package?: string;
    arguments: CreatePoolArguments | [
        feePct: RawTransactionArgument<number | bigint>
    ];
    typeArguments: [
        string,
        string
    ];
}
/** Creates a new shared liquidity pool for COIN_X and COIN_Y */
export function createPool(options: CreatePoolOptions) {
    const packageAddress = options.package ?? 'swap';
    const argumentsTypes = [
        'u64'
    ] satisfies (string | null)[];
    const parameterNames = ["feePct"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'swap',
        function: 'create_pool',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
        typeArguments: options.typeArguments
    });
}
export interface AddLiquidityArguments {
    pool: RawTransactionArgument<string>;
    coinX: RawTransactionArgument<string>;
    coinY: RawTransactionArgument<string>;
}
export interface AddLiquidityOptions {
    package?: string;
    arguments: AddLiquidityArguments | [
        pool: RawTransactionArgument<string>,
        coinX: RawTransactionArgument<string>,
        coinY: RawTransactionArgument<string>
    ];
    typeArguments: [
        string,
        string
    ];
}
/** Adds liquidity to the pool, mints and returns LP coins */
export function addLiquidity(options: AddLiquidityOptions) {
    const packageAddress = options.package ?? 'swap';
    const argumentsTypes = [
        null,
        null,
        null
    ] satisfies (string | null)[];
    const parameterNames = ["pool", "coinX", "coinY"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'swap',
        function: 'add_liquidity',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
        typeArguments: options.typeArguments
    });
}
export interface RemoveLiquidityArguments {
    pool: RawTransactionArgument<string>;
    lpCoin: RawTransactionArgument<string>;
}
export interface RemoveLiquidityOptions {
    package?: string;
    arguments: RemoveLiquidityArguments | [
        pool: RawTransactionArgument<string>,
        lpCoin: RawTransactionArgument<string>
    ];
    typeArguments: [
        string,
        string
    ];
}
/** Burns LP tokens and returns the underlying Coin X and Coin Y reserves */
export function removeLiquidity(options: RemoveLiquidityOptions) {
    const packageAddress = options.package ?? 'swap';
    const argumentsTypes = [
        null,
        null
    ] satisfies (string | null)[];
    const parameterNames = ["pool", "lpCoin"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'swap',
        function: 'remove_liquidity',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
        typeArguments: options.typeArguments
    });
}
export interface SwapXForYArguments {
    pool: RawTransactionArgument<string>;
    coinX: RawTransactionArgument<string>;
    minAmountOut: RawTransactionArgument<number | bigint>;
}
export interface SwapXForYOptions {
    package?: string;
    arguments: SwapXForYArguments | [
        pool: RawTransactionArgument<string>,
        coinX: RawTransactionArgument<string>,
        minAmountOut: RawTransactionArgument<number | bigint>
    ];
    typeArguments: [
        string,
        string
    ];
}
/** Swaps Coin X for Coin Y */
export function swapXForY(options: SwapXForYOptions) {
    const packageAddress = options.package ?? 'swap';
    const argumentsTypes = [
        null,
        null,
        'u64'
    ] satisfies (string | null)[];
    const parameterNames = ["pool", "coinX", "minAmountOut"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'swap',
        function: 'swap_x_for_y',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
        typeArguments: options.typeArguments
    });
}
export interface SwapYForXArguments {
    pool: RawTransactionArgument<string>;
    coinY: RawTransactionArgument<string>;
    minAmountOut: RawTransactionArgument<number | bigint>;
}
export interface SwapYForXOptions {
    package?: string;
    arguments: SwapYForXArguments | [
        pool: RawTransactionArgument<string>,
        coinY: RawTransactionArgument<string>,
        minAmountOut: RawTransactionArgument<number | bigint>
    ];
    typeArguments: [
        string,
        string
    ];
}
/** Swaps Coin Y for Coin X */
export function swapYForX(options: SwapYForXOptions) {
    const packageAddress = options.package ?? 'swap';
    const argumentsTypes = [
        null,
        null,
        'u64'
    ] satisfies (string | null)[];
    const parameterNames = ["pool", "coinY", "minAmountOut"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'swap',
        function: 'swap_y_for_x',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
        typeArguments: options.typeArguments
    });
}
export interface EntryCreatePoolArguments {
    feePct: RawTransactionArgument<number | bigint>;
}
export interface EntryCreatePoolOptions {
    package?: string;
    arguments: EntryCreatePoolArguments | [
        feePct: RawTransactionArgument<number | bigint>
    ];
    typeArguments: [
        string,
        string
    ];
}
export function entryCreatePool(options: EntryCreatePoolOptions) {
    const packageAddress = options.package ?? 'swap';
    const argumentsTypes = [
        'u64'
    ] satisfies (string | null)[];
    const parameterNames = ["feePct"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'swap',
        function: 'entry_create_pool',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
        typeArguments: options.typeArguments
    });
}
export interface EntrySwapXForYArguments {
    pool: RawTransactionArgument<string>;
    coinX: RawTransactionArgument<string>;
    minAmountOut: RawTransactionArgument<number | bigint>;
}
export interface EntrySwapXForYOptions {
    package?: string;
    arguments: EntrySwapXForYArguments | [
        pool: RawTransactionArgument<string>,
        coinX: RawTransactionArgument<string>,
        minAmountOut: RawTransactionArgument<number | bigint>
    ];
    typeArguments: [
        string,
        string
    ];
}
export function entrySwapXForY(options: EntrySwapXForYOptions) {
    const packageAddress = options.package ?? 'swap';
    const argumentsTypes = [
        null,
        null,
        'u64'
    ] satisfies (string | null)[];
    const parameterNames = ["pool", "coinX", "minAmountOut"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'swap',
        function: 'entry_swap_x_for_y',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
        typeArguments: options.typeArguments
    });
}
export interface EntrySwapYForXArguments {
    pool: RawTransactionArgument<string>;
    coinY: RawTransactionArgument<string>;
    minAmountOut: RawTransactionArgument<number | bigint>;
}
export interface EntrySwapYForXOptions {
    package?: string;
    arguments: EntrySwapYForXArguments | [
        pool: RawTransactionArgument<string>,
        coinY: RawTransactionArgument<string>,
        minAmountOut: RawTransactionArgument<number | bigint>
    ];
    typeArguments: [
        string,
        string
    ];
}
export function entrySwapYForX(options: EntrySwapYForXOptions) {
    const packageAddress = options.package ?? 'swap';
    const argumentsTypes = [
        null,
        null,
        'u64'
    ] satisfies (string | null)[];
    const parameterNames = ["pool", "coinY", "minAmountOut"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'swap',
        function: 'entry_swap_y_for_x',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
        typeArguments: options.typeArguments
    });
}
export interface EntryAddLiquidityArguments {
    pool: RawTransactionArgument<string>;
    coinX: RawTransactionArgument<string>;
    coinY: RawTransactionArgument<string>;
}
export interface EntryAddLiquidityOptions {
    package?: string;
    arguments: EntryAddLiquidityArguments | [
        pool: RawTransactionArgument<string>,
        coinX: RawTransactionArgument<string>,
        coinY: RawTransactionArgument<string>
    ];
    typeArguments: [
        string,
        string
    ];
}
export function entryAddLiquidity(options: EntryAddLiquidityOptions) {
    const packageAddress = options.package ?? 'swap';
    const argumentsTypes = [
        null,
        null,
        null
    ] satisfies (string | null)[];
    const parameterNames = ["pool", "coinX", "coinY"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'swap',
        function: 'entry_add_liquidity',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
        typeArguments: options.typeArguments
    });
}
export interface EntryRemoveLiquidityArguments {
    pool: RawTransactionArgument<string>;
    lpCoin: RawTransactionArgument<string>;
}
export interface EntryRemoveLiquidityOptions {
    package?: string;
    arguments: EntryRemoveLiquidityArguments | [
        pool: RawTransactionArgument<string>,
        lpCoin: RawTransactionArgument<string>
    ];
    typeArguments: [
        string,
        string
    ];
}
export function entryRemoveLiquidity(options: EntryRemoveLiquidityOptions) {
    const packageAddress = options.package ?? 'swap';
    const argumentsTypes = [
        null,
        null
    ] satisfies (string | null)[];
    const parameterNames = ["pool", "lpCoin"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'swap',
        function: 'entry_remove_liquidity',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
        typeArguments: options.typeArguments
    });
}