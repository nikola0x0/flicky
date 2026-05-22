/**************************************************************
 * THIS FILE IS GENERATED AND SHOULD NOT BE MANUALLY MODIFIED *
 **************************************************************/
import { MoveStruct, normalizeMoveArguments, type RawTransactionArgument } from '../utils/index.js';
import { bcs } from '@mysten/sui/bcs';
import { type Transaction, type TransactionArgument } from '@mysten/sui/transactions';
const $moduleName = 'deepbook_predict::i64';
export const I64 = new MoveStruct({ name: `${$moduleName}::I64`, fields: {
        magnitude: bcs.u64(),
        is_negative: bcs.bool()
    } });
export interface MagnitudeArguments {
    value: TransactionArgument;
}
export interface MagnitudeOptions {
    package?: string;
    arguments: MagnitudeArguments | [
        value: TransactionArgument
    ];
}
export function magnitude(options: MagnitudeOptions) {
    const packageAddress = options.package ?? 'deepbook_predict';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["value"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'i64',
        function: 'magnitude',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface IsNegativeArguments {
    value: TransactionArgument;
}
export interface IsNegativeOptions {
    package?: string;
    arguments: IsNegativeArguments | [
        value: TransactionArgument
    ];
}
export function isNegative(options: IsNegativeOptions) {
    const packageAddress = options.package ?? 'deepbook_predict';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["value"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'i64',
        function: 'is_negative',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface IsZeroArguments {
    value: TransactionArgument;
}
export interface IsZeroOptions {
    package?: string;
    arguments: IsZeroArguments | [
        value: TransactionArgument
    ];
}
export function isZero(options: IsZeroOptions) {
    const packageAddress = options.package ?? 'deepbook_predict';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["value"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'i64',
        function: 'is_zero',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface ZeroOptions {
    package?: string;
    arguments?: [
    ];
}
export function zero(options: ZeroOptions = {}) {
    const packageAddress = options.package ?? 'deepbook_predict';
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'i64',
        function: 'zero',
    });
}
export interface FromU64Arguments {
    value: RawTransactionArgument<number | bigint>;
}
export interface FromU64Options {
    package?: string;
    arguments: FromU64Arguments | [
        value: RawTransactionArgument<number | bigint>
    ];
}
export function fromU64(options: FromU64Options) {
    const packageAddress = options.package ?? 'deepbook_predict';
    const argumentsTypes = [
        'u64'
    ] satisfies (string | null)[];
    const parameterNames = ["value"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'i64',
        function: 'from_u64',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface FromPartsArguments {
    magnitude: RawTransactionArgument<number | bigint>;
    isNegative: RawTransactionArgument<boolean>;
}
export interface FromPartsOptions {
    package?: string;
    arguments: FromPartsArguments | [
        magnitude: RawTransactionArgument<number | bigint>,
        isNegative: RawTransactionArgument<boolean>
    ];
}
export function fromParts(options: FromPartsOptions) {
    const packageAddress = options.package ?? 'deepbook_predict';
    const argumentsTypes = [
        'u64',
        'bool'
    ] satisfies (string | null)[];
    const parameterNames = ["magnitude", "isNegative"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'i64',
        function: 'from_parts',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}