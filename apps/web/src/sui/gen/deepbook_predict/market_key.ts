/**************************************************************
 * THIS FILE IS GENERATED AND SHOULD NOT BE MANUALLY MODIFIED *
 **************************************************************/
import { MoveStruct, normalizeMoveArguments, type RawTransactionArgument } from '../utils/index.js';
import { bcs } from '@mysten/sui/bcs';
import { type Transaction, type TransactionArgument } from '@mysten/sui/transactions';
const $moduleName = 'deepbook_predict::market_key';
export const MarketKey = new MoveStruct({ name: `${$moduleName}::MarketKey`, fields: {
        oracle_id: bcs.Address,
        expiry: bcs.u64(),
        strike: bcs.u64(),
        direction: bcs.u8()
    } });
export interface UpArguments {
    oracleId: RawTransactionArgument<string>;
    expiry: RawTransactionArgument<number | bigint>;
    strike: RawTransactionArgument<number | bigint>;
}
export interface UpOptions {
    package?: string;
    arguments: UpArguments | [
        oracleId: RawTransactionArgument<string>,
        expiry: RawTransactionArgument<number | bigint>,
        strike: RawTransactionArgument<number | bigint>
    ];
}
export function up(options: UpOptions) {
    const packageAddress = options.package ?? 'deepbook_predict';
    const argumentsTypes = [
        '0x2::object::ID',
        'u64',
        'u64'
    ] satisfies (string | null)[];
    const parameterNames = ["oracleId", "expiry", "strike"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'market_key',
        function: 'up',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface DownArguments {
    oracleId: RawTransactionArgument<string>;
    expiry: RawTransactionArgument<number | bigint>;
    strike: RawTransactionArgument<number | bigint>;
}
export interface DownOptions {
    package?: string;
    arguments: DownArguments | [
        oracleId: RawTransactionArgument<string>,
        expiry: RawTransactionArgument<number | bigint>,
        strike: RawTransactionArgument<number | bigint>
    ];
}
export function down(options: DownOptions) {
    const packageAddress = options.package ?? 'deepbook_predict';
    const argumentsTypes = [
        '0x2::object::ID',
        'u64',
        'u64'
    ] satisfies (string | null)[];
    const parameterNames = ["oracleId", "expiry", "strike"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'market_key',
        function: 'down',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface NewArguments {
    oracleId: RawTransactionArgument<string>;
    expiry: RawTransactionArgument<number | bigint>;
    strike: RawTransactionArgument<number | bigint>;
    direction: RawTransactionArgument<boolean>;
}
export interface NewOptions {
    package?: string;
    arguments: NewArguments | [
        oracleId: RawTransactionArgument<string>,
        expiry: RawTransactionArgument<number | bigint>,
        strike: RawTransactionArgument<number | bigint>,
        direction: RawTransactionArgument<boolean>
    ];
}
export function _new(options: NewOptions) {
    const packageAddress = options.package ?? 'deepbook_predict';
    const argumentsTypes = [
        '0x2::object::ID',
        'u64',
        'u64',
        'bool'
    ] satisfies (string | null)[];
    const parameterNames = ["oracleId", "expiry", "strike", "direction"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'market_key',
        function: 'new',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface OracleIdArguments {
    self: TransactionArgument;
}
export interface OracleIdOptions {
    package?: string;
    arguments: OracleIdArguments | [
        self: TransactionArgument
    ];
}
export function oracleId(options: OracleIdOptions) {
    const packageAddress = options.package ?? 'deepbook_predict';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["self"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'market_key',
        function: 'oracle_id',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface ExpiryArguments {
    self: TransactionArgument;
}
export interface ExpiryOptions {
    package?: string;
    arguments: ExpiryArguments | [
        self: TransactionArgument
    ];
}
export function expiry(options: ExpiryOptions) {
    const packageAddress = options.package ?? 'deepbook_predict';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["self"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'market_key',
        function: 'expiry',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface StrikeArguments {
    self: TransactionArgument;
}
export interface StrikeOptions {
    package?: string;
    arguments: StrikeArguments | [
        self: TransactionArgument
    ];
}
export function strike(options: StrikeOptions) {
    const packageAddress = options.package ?? 'deepbook_predict';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["self"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'market_key',
        function: 'strike',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface IsUpArguments {
    self: TransactionArgument;
}
export interface IsUpOptions {
    package?: string;
    arguments: IsUpArguments | [
        self: TransactionArgument
    ];
}
export function isUp(options: IsUpOptions) {
    const packageAddress = options.package ?? 'deepbook_predict';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["self"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'market_key',
        function: 'is_up',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface IsDownArguments {
    self: TransactionArgument;
}
export interface IsDownOptions {
    package?: string;
    arguments: IsDownArguments | [
        self: TransactionArgument
    ];
}
export function isDown(options: IsDownOptions) {
    const packageAddress = options.package ?? 'deepbook_predict';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["self"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'market_key',
        function: 'is_down',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}