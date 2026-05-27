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
export interface GetTradeAmountsArguments {
    Predict: RawTransactionArgument<string>;
    oracle: RawTransactionArgument<string>;
    key: TransactionArgument;
    quantity: RawTransactionArgument<number | bigint>;
}
export interface GetTradeAmountsOptions {
    package?: string;
    arguments: GetTradeAmountsArguments | [
        Predict: RawTransactionArgument<string>,
        oracle: RawTransactionArgument<string>,
        key: TransactionArgument,
        quantity: RawTransactionArgument<number | bigint>
    ];
}
/**
 * On-chain pricing: returns (mint_cost, max_payout) for swiping `quantity` of the
 * position keyed by `key`. mint_cost is the premium the player pays to mint the
 * Predict position; max_payout is `quantity`.
 *
 * On testnet, dispatched to real `deepbook_predict::predict::get_trade_amounts`.
 * Locally (tests), computes from `oracle.compute_price` × direction so that
 * `set_test_price(oracle, p_up)` drives the stub's pricing deterministically.
 */
export function getTradeAmounts(options: GetTradeAmountsOptions) {
    const packageAddress = options.package ?? 'deepbook_predict';
    const argumentsTypes = [
        null,
        null,
        null,
        'u64',
        '0x2::clock::Clock'
    ] satisfies (string | null)[];
    const parameterNames = ["Predict", "oracle", "key", "quantity"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'predict',
        function: 'get_trade_amounts',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}