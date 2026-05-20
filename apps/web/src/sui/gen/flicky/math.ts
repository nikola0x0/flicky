/**************************************************************
 * THIS FILE IS GENERATED AND SHOULD NOT BE MANUALLY MODIFIED *
 **************************************************************/


/**
 * Fixed-point math (1e9 scaling) used by the SVI/Black-Scholes fair-price
 * computation in `flicky::oracle`. Direct port of DeepBook Predict's
 * `deepbook_predict::math` module — same Cody (1969) normal-CDF approximation,
 * same Taylor exp series, same Newton sqrt. Brought into our package so we don't
 * depend on DeepBook's runtime presence (testnet rotation is unreliable for game
 * timing).
 */

import { type Transaction, type TransactionArgument } from '@mysten/sui/transactions';
import { normalizeMoveArguments, type RawTransactionArgument } from '../utils/index.js';
export interface LnArguments {
    x: RawTransactionArgument<number | bigint>;
}
export interface LnOptions {
    package?: string;
    arguments: LnArguments | [
        x: RawTransactionArgument<number | bigint>
    ];
}
/** Natural logarithm in fixed point. `x > 0`. */
export function ln(options: LnOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        'u64'
    ] satisfies (string | null)[];
    const parameterNames = ["x"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'math',
        function: 'ln',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface ExpArguments {
    x: TransactionArgument;
}
export interface ExpOptions {
    package?: string;
    arguments: ExpArguments | [
        x: TransactionArgument
    ];
}
/** `e^x` in fixed point. Aborts on overflow for very large positive x. */
export function exp(options: ExpOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["x"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'math',
        function: 'exp',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface NormalCdfArguments {
    x: TransactionArgument;
}
export interface NormalCdfOptions {
    package?: string;
    arguments: NormalCdfArguments | [
        x: TransactionArgument
    ];
}
/** Standard normal CDF Φ(x). Returns probability in 1e9 fixed point. */
export function normalCdf(options: NormalCdfOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["x"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'math',
        function: 'normal_cdf',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface SqrtArguments {
    x: RawTransactionArgument<number | bigint>;
    precision: RawTransactionArgument<number | bigint>;
}
export interface SqrtOptions {
    package?: string;
    arguments: SqrtArguments | [
        x: RawTransactionArgument<number | bigint>,
        precision: RawTransactionArgument<number | bigint>
    ];
}
/** Fixed-point square root. `precision` must divide FLOAT_SCALING. */
export function sqrt(options: SqrtOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        'u64',
        'u64'
    ] satisfies (string | null)[];
    const parameterNames = ["x", "precision"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'math',
        function: 'sqrt',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}