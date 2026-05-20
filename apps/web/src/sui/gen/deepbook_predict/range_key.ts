/**************************************************************
 * THIS FILE IS GENERATED AND SHOULD NOT BE MANUALLY MODIFIED *
 **************************************************************/
import { MoveStruct, normalizeMoveArguments, type RawTransactionArgument } from '../utils/index.js';
import { bcs } from '@mysten/sui/bcs';
import { type Transaction, type TransactionArgument } from '@mysten/sui/transactions';
const $moduleName = 'deepbook_predict::range_key';
export const RangeKey = new MoveStruct({ name: `${$moduleName}::RangeKey`, fields: {
        oracle_id: bcs.Address,
        expiry: bcs.u64(),
        lower_strike: bcs.u64(),
        higher_strike: bcs.u64()
    } });
export interface NewArguments {
    oracleId: RawTransactionArgument<string>;
    expiry: RawTransactionArgument<number | bigint>;
    lowerStrike: RawTransactionArgument<number | bigint>;
    higherStrike: RawTransactionArgument<number | bigint>;
}
export interface NewOptions {
    package?: string;
    arguments: NewArguments | [
        oracleId: RawTransactionArgument<string>,
        expiry: RawTransactionArgument<number | bigint>,
        lowerStrike: RawTransactionArgument<number | bigint>,
        higherStrike: RawTransactionArgument<number | bigint>
    ];
}
export function _new(options: NewOptions) {
    const packageAddress = options.package ?? 'deepbook_predict';
    const argumentsTypes = [
        '0x2::object::ID',
        'u64',
        'u64',
        'u64'
    ] satisfies (string | null)[];
    const parameterNames = ["oracleId", "expiry", "lowerStrike", "higherStrike"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'range_key',
        function: 'new',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface OracleIdArguments {
    key: TransactionArgument;
}
export interface OracleIdOptions {
    package?: string;
    arguments: OracleIdArguments | [
        key: TransactionArgument
    ];
}
export function oracleId(options: OracleIdOptions) {
    const packageAddress = options.package ?? 'deepbook_predict';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["key"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'range_key',
        function: 'oracle_id',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface ExpiryArguments {
    key: TransactionArgument;
}
export interface ExpiryOptions {
    package?: string;
    arguments: ExpiryArguments | [
        key: TransactionArgument
    ];
}
export function expiry(options: ExpiryOptions) {
    const packageAddress = options.package ?? 'deepbook_predict';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["key"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'range_key',
        function: 'expiry',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface LowerStrikeArguments {
    key: TransactionArgument;
}
export interface LowerStrikeOptions {
    package?: string;
    arguments: LowerStrikeArguments | [
        key: TransactionArgument
    ];
}
export function lowerStrike(options: LowerStrikeOptions) {
    const packageAddress = options.package ?? 'deepbook_predict';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["key"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'range_key',
        function: 'lower_strike',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface HigherStrikeArguments {
    key: TransactionArgument;
}
export interface HigherStrikeOptions {
    package?: string;
    arguments: HigherStrikeArguments | [
        key: TransactionArgument
    ];
}
export function higherStrike(options: HigherStrikeOptions) {
    const packageAddress = options.package ?? 'deepbook_predict';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["key"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'range_key',
        function: 'higher_strike',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}