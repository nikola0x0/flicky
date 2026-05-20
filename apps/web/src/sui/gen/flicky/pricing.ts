/**************************************************************
 * THIS FILE IS GENERATED AND SHOULD NOT BE MANUALLY MODIFIED *
 **************************************************************/


/**
 * SVI binary-digital fair pricing on top of DeepBook Predict's `OracleSVI`.
 * 
 * DeepBook's `oracle::compute_price` is `public(package)` and not callable from
 * external packages, so this module reproduces the same `N(d2)` math
 * (`compute_nd2`) using the publicly exposed SVI params, spot, and forward.
 * 
 * `p_up` is what `duel::record_swipe` snapshots as `p_swiped` at the moment of a
 * swipe — directly mirrors the implied UP-probability the player would see on the
 * trading surface, minus spread/utilization. The PRD's scoring formula
 * (`1 / p_swiped × speed_multiplier`) consumes this number.
 */

import { type Transaction } from '@mysten/sui/transactions';
import { normalizeMoveArguments, type RawTransactionArgument } from '../utils/index.js';
export interface PUpArguments {
    oracle: RawTransactionArgument<string>;
    strike: RawTransactionArgument<number | bigint>;
}
export interface PUpOptions {
    package?: string;
    arguments: PUpArguments | [
        oracle: RawTransactionArgument<string>,
        strike: RawTransactionArgument<number | bigint>
    ];
}
/**
 * Implied probability of UP for `strike` on the given oracle, in 1e9. Settled
 * oracles collapse to `0` / `1e9` based on `settlement_price > strike`; live
 * oracles run the SVI Black-Scholes binary-digital kernel.
 */
export function pUp(options: PUpOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null,
        'u64'
    ] satisfies (string | null)[];
    const parameterNames = ["oracle", "strike"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'pricing',
        function: 'p_up',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface PDownArguments {
    oracle: RawTransactionArgument<string>;
    strike: RawTransactionArgument<number | bigint>;
}
export interface PDownOptions {
    package?: string;
    arguments: PDownArguments | [
        oracle: RawTransactionArgument<string>,
        strike: RawTransactionArgument<number | bigint>
    ];
}
/** `p(DOWN) = 1 − p(UP)`. */
export function pDown(options: PDownOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null,
        'u64'
    ] satisfies (string | null)[];
    const parameterNames = ["oracle", "strike"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'pricing',
        function: 'p_down',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}