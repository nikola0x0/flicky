/**************************************************************
 * THIS FILE IS GENERATED AND SHOULD NOT BE MANUALLY MODIFIED *
 **************************************************************/
import { MoveStruct, normalizeMoveArguments, type RawTransactionArgument } from '../utils/index.js';
import { bcs } from '@mysten/sui/bcs';
import { type Transaction, type TransactionArgument } from '@mysten/sui/transactions';
const $moduleName = 'deepbook_predict::predict';
export const Predict = new MoveStruct({ name: `${$moduleName}::Predict`, fields: {
        id: bcs.Address
    } });
export interface CreateManagerOptions {
    package?: string;
    arguments?: [
    ];
}
export function createManager(options: CreateManagerOptions = {}) {
    const packageAddress = options.package ?? 'deepbook_predict';
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'predict',
        function: 'create_manager',
    });
}
export interface GetTradeAmountsArguments {
    Predict: RawTransactionArgument<string>;
    Oracle: RawTransactionArgument<string>;
    Key: TransactionArgument;
    Quantity: RawTransactionArgument<number | bigint>;
}
export interface GetTradeAmountsOptions {
    package?: string;
    arguments: GetTradeAmountsArguments | [
        Predict: RawTransactionArgument<string>,
        Oracle: RawTransactionArgument<string>,
        Key: TransactionArgument,
        Quantity: RawTransactionArgument<number | bigint>
    ];
}
export function getTradeAmounts(options: GetTradeAmountsOptions) {
    const packageAddress = options.package ?? 'deepbook_predict';
    const argumentsTypes = [
        null,
        null,
        null,
        'u64',
        '0x2::clock::Clock'
    ] satisfies (string | null)[];
    const parameterNames = ["Predict", "Oracle", "Key", "Quantity"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'predict',
        function: 'get_trade_amounts',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface AskBoundsArguments {
    Predict: RawTransactionArgument<string>;
    OracleId: RawTransactionArgument<string>;
}
export interface AskBoundsOptions {
    package?: string;
    arguments: AskBoundsArguments | [
        Predict: RawTransactionArgument<string>,
        OracleId: RawTransactionArgument<string>
    ];
}
export function askBounds(options: AskBoundsOptions) {
    const packageAddress = options.package ?? 'deepbook_predict';
    const argumentsTypes = [
        null,
        '0x2::object::ID'
    ] satisfies (string | null)[];
    const parameterNames = ["Predict", "OracleId"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'predict',
        function: 'ask_bounds',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface MintArguments {
    Predict: RawTransactionArgument<string>;
    Manager: RawTransactionArgument<string>;
    Oracle: RawTransactionArgument<string>;
    Key: TransactionArgument;
    Quantity: RawTransactionArgument<number | bigint>;
}
export interface MintOptions {
    package?: string;
    arguments: MintArguments | [
        Predict: RawTransactionArgument<string>,
        Manager: RawTransactionArgument<string>,
        Oracle: RawTransactionArgument<string>,
        Key: TransactionArgument,
        Quantity: RawTransactionArgument<number | bigint>
    ];
    typeArguments: [
        string
    ];
}
export function mint(options: MintOptions) {
    const packageAddress = options.package ?? 'deepbook_predict';
    const argumentsTypes = [
        null,
        null,
        null,
        null,
        'u64',
        '0x2::clock::Clock'
    ] satisfies (string | null)[];
    const parameterNames = ["Predict", "Manager", "Oracle", "Key", "Quantity"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'predict',
        function: 'mint',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
        typeArguments: options.typeArguments
    });
}
export interface CompactSettledOracleArguments {
    Predict: RawTransactionArgument<string>;
    Oracle: RawTransactionArgument<string>;
    OracleCap: RawTransactionArgument<string>;
}
export interface CompactSettledOracleOptions {
    package?: string;
    arguments: CompactSettledOracleArguments | [
        Predict: RawTransactionArgument<string>,
        Oracle: RawTransactionArgument<string>,
        OracleCap: RawTransactionArgument<string>
    ];
}
export function compactSettledOracle(options: CompactSettledOracleOptions) {
    const packageAddress = options.package ?? 'deepbook_predict';
    const argumentsTypes = [
        null,
        null,
        null
    ] satisfies (string | null)[];
    const parameterNames = ["Predict", "Oracle", "OracleCap"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'predict',
        function: 'compact_settled_oracle',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface RedeemArguments {
    Predict: RawTransactionArgument<string>;
    Manager: RawTransactionArgument<string>;
    Oracle: RawTransactionArgument<string>;
    Key: TransactionArgument;
    Quantity: RawTransactionArgument<number | bigint>;
}
export interface RedeemOptions {
    package?: string;
    arguments: RedeemArguments | [
        Predict: RawTransactionArgument<string>,
        Manager: RawTransactionArgument<string>,
        Oracle: RawTransactionArgument<string>,
        Key: TransactionArgument,
        Quantity: RawTransactionArgument<number | bigint>
    ];
    typeArguments: [
        string
    ];
}
export function redeem(options: RedeemOptions) {
    const packageAddress = options.package ?? 'deepbook_predict';
    const argumentsTypes = [
        null,
        null,
        null,
        null,
        'u64',
        '0x2::clock::Clock'
    ] satisfies (string | null)[];
    const parameterNames = ["Predict", "Manager", "Oracle", "Key", "Quantity"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'predict',
        function: 'redeem',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
        typeArguments: options.typeArguments
    });
}
export interface RedeemPermissionlessArguments {
    Predict: RawTransactionArgument<string>;
    Manager: RawTransactionArgument<string>;
    Oracle: RawTransactionArgument<string>;
    Key: TransactionArgument;
    Quantity: RawTransactionArgument<number | bigint>;
}
export interface RedeemPermissionlessOptions {
    package?: string;
    arguments: RedeemPermissionlessArguments | [
        Predict: RawTransactionArgument<string>,
        Manager: RawTransactionArgument<string>,
        Oracle: RawTransactionArgument<string>,
        Key: TransactionArgument,
        Quantity: RawTransactionArgument<number | bigint>
    ];
    typeArguments: [
        string
    ];
}
export function redeemPermissionless(options: RedeemPermissionlessOptions) {
    const packageAddress = options.package ?? 'deepbook_predict';
    const argumentsTypes = [
        null,
        null,
        null,
        null,
        'u64',
        '0x2::clock::Clock'
    ] satisfies (string | null)[];
    const parameterNames = ["Predict", "Manager", "Oracle", "Key", "Quantity"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'predict',
        function: 'redeem_permissionless',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
        typeArguments: options.typeArguments
    });
}
export interface GetRangeTradeAmountsArguments {
    Predict: RawTransactionArgument<string>;
    Oracle: RawTransactionArgument<string>;
    Key: TransactionArgument;
    Quantity: RawTransactionArgument<number | bigint>;
}
export interface GetRangeTradeAmountsOptions {
    package?: string;
    arguments: GetRangeTradeAmountsArguments | [
        Predict: RawTransactionArgument<string>,
        Oracle: RawTransactionArgument<string>,
        Key: TransactionArgument,
        Quantity: RawTransactionArgument<number | bigint>
    ];
}
export function getRangeTradeAmounts(options: GetRangeTradeAmountsOptions) {
    const packageAddress = options.package ?? 'deepbook_predict';
    const argumentsTypes = [
        null,
        null,
        null,
        'u64',
        '0x2::clock::Clock'
    ] satisfies (string | null)[];
    const parameterNames = ["Predict", "Oracle", "Key", "Quantity"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'predict',
        function: 'get_range_trade_amounts',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface MintRangeArguments {
    Predict: RawTransactionArgument<string>;
    Manager: RawTransactionArgument<string>;
    Oracle: RawTransactionArgument<string>;
    Key: TransactionArgument;
    Quantity: RawTransactionArgument<number | bigint>;
}
export interface MintRangeOptions {
    package?: string;
    arguments: MintRangeArguments | [
        Predict: RawTransactionArgument<string>,
        Manager: RawTransactionArgument<string>,
        Oracle: RawTransactionArgument<string>,
        Key: TransactionArgument,
        Quantity: RawTransactionArgument<number | bigint>
    ];
    typeArguments: [
        string
    ];
}
export function mintRange(options: MintRangeOptions) {
    const packageAddress = options.package ?? 'deepbook_predict';
    const argumentsTypes = [
        null,
        null,
        null,
        null,
        'u64',
        '0x2::clock::Clock'
    ] satisfies (string | null)[];
    const parameterNames = ["Predict", "Manager", "Oracle", "Key", "Quantity"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'predict',
        function: 'mint_range',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
        typeArguments: options.typeArguments
    });
}
export interface RedeemRangeArguments {
    Predict: RawTransactionArgument<string>;
    Manager: RawTransactionArgument<string>;
    Oracle: RawTransactionArgument<string>;
    Key: TransactionArgument;
    Quantity: RawTransactionArgument<number | bigint>;
}
export interface RedeemRangeOptions {
    package?: string;
    arguments: RedeemRangeArguments | [
        Predict: RawTransactionArgument<string>,
        Manager: RawTransactionArgument<string>,
        Oracle: RawTransactionArgument<string>,
        Key: TransactionArgument,
        Quantity: RawTransactionArgument<number | bigint>
    ];
    typeArguments: [
        string
    ];
}
export function redeemRange(options: RedeemRangeOptions) {
    const packageAddress = options.package ?? 'deepbook_predict';
    const argumentsTypes = [
        null,
        null,
        null,
        null,
        'u64',
        '0x2::clock::Clock'
    ] satisfies (string | null)[];
    const parameterNames = ["Predict", "Manager", "Oracle", "Key", "Quantity"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'predict',
        function: 'redeem_range',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
        typeArguments: options.typeArguments
    });
}