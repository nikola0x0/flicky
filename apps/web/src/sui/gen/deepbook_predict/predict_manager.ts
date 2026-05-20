/**************************************************************
 * THIS FILE IS GENERATED AND SHOULD NOT BE MANUALLY MODIFIED *
 **************************************************************/
import { MoveStruct, normalizeMoveArguments, type RawTransactionArgument } from '../utils/index.js';
import { bcs } from '@mysten/sui/bcs';
import { type Transaction, type TransactionArgument } from '@mysten/sui/transactions';
const $moduleName = 'deepbook_predict::predict_manager';
export const PredictManager = new MoveStruct({ name: `${$moduleName}::PredictManager`, fields: {
        id: bcs.Address,
        owner: bcs.Address
    } });
export interface OwnerArguments {
    self: RawTransactionArgument<string>;
}
export interface OwnerOptions {
    package?: string;
    arguments: OwnerArguments | [
        self: RawTransactionArgument<string>
    ];
}
export function owner(options: OwnerOptions) {
    const packageAddress = options.package ?? 'deepbook_predict';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["self"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'predict_manager',
        function: 'owner',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface PositionArguments {
    Self: RawTransactionArgument<string>;
    Key: TransactionArgument;
}
export interface PositionOptions {
    package?: string;
    arguments: PositionArguments | [
        Self: RawTransactionArgument<string>,
        Key: TransactionArgument
    ];
}
export function position(options: PositionOptions) {
    const packageAddress = options.package ?? 'deepbook_predict';
    const argumentsTypes = [
        null,
        null
    ] satisfies (string | null)[];
    const parameterNames = ["Self", "Key"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'predict_manager',
        function: 'position',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface RangePositionArguments {
    Self: RawTransactionArgument<string>;
    Key: TransactionArgument;
}
export interface RangePositionOptions {
    package?: string;
    arguments: RangePositionArguments | [
        Self: RawTransactionArgument<string>,
        Key: TransactionArgument
    ];
}
export function rangePosition(options: RangePositionOptions) {
    const packageAddress = options.package ?? 'deepbook_predict';
    const argumentsTypes = [
        null,
        null
    ] satisfies (string | null)[];
    const parameterNames = ["Self", "Key"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'predict_manager',
        function: 'range_position',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface BalanceArguments {
    Self: RawTransactionArgument<string>;
}
export interface BalanceOptions {
    package?: string;
    arguments: BalanceArguments | [
        Self: RawTransactionArgument<string>
    ];
    typeArguments: [
        string
    ];
}
export function balance(options: BalanceOptions) {
    const packageAddress = options.package ?? 'deepbook_predict';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["Self"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'predict_manager',
        function: 'balance',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
        typeArguments: options.typeArguments
    });
}
export interface DepositArguments {
    Self: RawTransactionArgument<string>;
    coin: RawTransactionArgument<string>;
}
export interface DepositOptions {
    package?: string;
    arguments: DepositArguments | [
        Self: RawTransactionArgument<string>,
        coin: RawTransactionArgument<string>
    ];
    typeArguments: [
        string
    ];
}
export function deposit(options: DepositOptions) {
    const packageAddress = options.package ?? 'deepbook_predict';
    const argumentsTypes = [
        null,
        null
    ] satisfies (string | null)[];
    const parameterNames = ["Self", "coin"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'predict_manager',
        function: 'deposit',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
        typeArguments: options.typeArguments
    });
}
export interface WithdrawArguments {
    Self: RawTransactionArgument<string>;
    Amount: RawTransactionArgument<number | bigint>;
}
export interface WithdrawOptions {
    package?: string;
    arguments: WithdrawArguments | [
        Self: RawTransactionArgument<string>,
        Amount: RawTransactionArgument<number | bigint>
    ];
    typeArguments: [
        string
    ];
}
export function withdraw(options: WithdrawOptions) {
    const packageAddress = options.package ?? 'deepbook_predict';
    const argumentsTypes = [
        null,
        'u64'
    ] satisfies (string | null)[];
    const parameterNames = ["Self", "Amount"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'predict_manager',
        function: 'withdraw',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
        typeArguments: options.typeArguments
    });
}