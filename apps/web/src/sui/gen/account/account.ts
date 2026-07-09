/**************************************************************
 * THIS FILE IS GENERATED AND SHOULD NOT BE MANUALLY MODIFIED *
 **************************************************************/


/**
 * Local link stub for the on-chain `account` package (0xb9389eac...15da3b,
 * predict-testnet-6-24). Only the surface flicky calls on-chain is stubbed:
 * `load_account` + a position set for anti-replay reads. Bodies are local test
 * math; on-chain dispatch hits the real package via `published-at`.
 */

import { MoveStruct, normalizeMoveArguments, type RawTransactionArgument } from '../utils/index.js';
import { bcs } from '@mysten/sui/bcs';
import { type Transaction, type TransactionArgument } from '@mysten/sui/transactions';
import * as vec_set from './deps/sui/vec_set.js';
const $moduleName = 'account::account';
export const PosId = new MoveStruct({ name: `${$moduleName}::PosId`, fields: {
        expiry_market_id: bcs.Address,
        order_id: bcs.u256()
    } });
export const Account = new MoveStruct({ name: `${$moduleName}::Account`, fields: {
        owner: bcs.Address,
        positions: vec_set.VecSet(PosId)
    } });
export const AccountWrapper = new MoveStruct({ name: `${$moduleName}::AccountWrapper`, fields: {
        id: bcs.Address,
        account: Account
    } });
export interface LoadAccountArguments {
    self: RawTransactionArgument<string>;
}
export interface LoadAccountOptions {
    package?: string;
    arguments: LoadAccountArguments | [
        self: RawTransactionArgument<string>
    ];
}
export function loadAccount(options: LoadAccountOptions) {
    const packageAddress = options.package ?? 'account';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["self"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'account',
        function: 'load_account',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface OwnerArguments {
    self: TransactionArgument;
}
export interface OwnerOptions {
    package?: string;
    arguments: OwnerArguments | [
        self: TransactionArgument
    ];
}
export function owner(options: OwnerOptions) {
    const packageAddress = options.package ?? 'account';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["self"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'account',
        function: 'owner',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface ContainsPositionArguments {
    self: TransactionArgument;
    expiryMarketId: RawTransactionArgument<string>;
    orderId: RawTransactionArgument<number | bigint>;
}
export interface ContainsPositionOptions {
    package?: string;
    arguments: ContainsPositionArguments | [
        self: TransactionArgument,
        expiryMarketId: RawTransactionArgument<string>,
        orderId: RawTransactionArgument<number | bigint>
    ];
}
/**
 * Stub of the real package's position-membership read. In the real package this
 * walks the attached PredictApp data; here it reads the locally-seeded set so
 * tests can drive anti-replay.
 */
export function containsPosition(options: ContainsPositionOptions) {
    const packageAddress = options.package ?? 'account';
    const argumentsTypes = [
        null,
        '0x2::object::ID',
        'u256'
    ] satisfies (string | null)[];
    const parameterNames = ["self", "expiryMarketId", "orderId"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'account',
        function: 'contains_position',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}