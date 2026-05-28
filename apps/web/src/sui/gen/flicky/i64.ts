/**************************************************************
 * THIS FILE IS GENERATED AND SHOULD NOT BE MANUALLY MODIFIED *
 **************************************************************/


/**
 * Signed u64 magnitude with normalized zero. Used by the SVI/Black-Scholes
 * fair-price computation in `flicky::oracle`. Mirrors DeepBook's
 * `deepbook_predict::i64` but lives in our package (separate type identity).
 */

import { MoveStruct, normalizeMoveArguments, type RawTransactionArgument } from '../utils/index.js';
import { bcs } from '@mysten/sui/bcs';
import { type Transaction, type TransactionArgument } from '@mysten/sui/transactions';
const $moduleName = 'flicky::i64';
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
    const packageAddress = options.package ?? 'flicky';
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
    const packageAddress = options.package ?? 'flicky';
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
    const packageAddress = options.package ?? 'flicky';
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
    const packageAddress = options.package ?? 'flicky';
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
    const packageAddress = options.package ?? 'flicky';
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
    const packageAddress = options.package ?? 'flicky';
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
export interface NegArguments {
    value: TransactionArgument;
}
export interface NegOptions {
    package?: string;
    arguments: NegArguments | [
        value: TransactionArgument
    ];
}
export function neg(options: NegOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["value"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'i64',
        function: 'neg',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface AddArguments {
    a: TransactionArgument;
    b: TransactionArgument;
}
export interface AddOptions {
    package?: string;
    arguments: AddArguments | [
        a: TransactionArgument,
        b: TransactionArgument
    ];
}
export function add(options: AddOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null,
        null
    ] satisfies (string | null)[];
    const parameterNames = ["a", "b"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'i64',
        function: 'add',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface SubArguments {
    a: TransactionArgument;
    b: TransactionArgument;
}
export interface SubOptions {
    package?: string;
    arguments: SubArguments | [
        a: TransactionArgument,
        b: TransactionArgument
    ];
}
export function sub(options: SubOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null,
        null
    ] satisfies (string | null)[];
    const parameterNames = ["a", "b"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'i64',
        function: 'sub',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface MulScaledArguments {
    a: TransactionArgument;
    b: TransactionArgument;
}
export interface MulScaledOptions {
    package?: string;
    arguments: MulScaledArguments | [
        a: TransactionArgument,
        b: TransactionArgument
    ];
}
/** `(a * b) / FLOAT_SCALING`, signs XOR. */
export function mulScaled(options: MulScaledOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null,
        null
    ] satisfies (string | null)[];
    const parameterNames = ["a", "b"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'i64',
        function: 'mul_scaled',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface DivScaledArguments {
    a: TransactionArgument;
    b: TransactionArgument;
}
export interface DivScaledOptions {
    package?: string;
    arguments: DivScaledArguments | [
        a: TransactionArgument,
        b: TransactionArgument
    ];
}
/** `(a * FLOAT_SCALING) / b`, signs XOR. */
export function divScaled(options: DivScaledOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null,
        null
    ] satisfies (string | null)[];
    const parameterNames = ["a", "b"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'i64',
        function: 'div_scaled',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface SquareScaledArguments {
    value: TransactionArgument;
}
export interface SquareScaledOptions {
    package?: string;
    arguments: SquareScaledArguments | [
        value: TransactionArgument
    ];
}
/** Square in fixed point; result is always nonnegative. */
export function squareScaled(options: SquareScaledOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["value"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'i64',
        function: 'square_scaled',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}