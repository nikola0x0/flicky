/**************************************************************
 * THIS FILE IS GENERATED AND SHOULD NOT BE MANUALLY MODIFIED *
 **************************************************************/
import { MoveStruct, normalizeMoveArguments, type RawTransactionArgument } from '../utils/index.js';
import { bcs } from '@mysten/sui/bcs';
import { type Transaction } from '@mysten/sui/transactions';
import * as i64 from './i64.js';
import * as vec_set from './deps/sui/vec_set.js';
const $moduleName = 'deepbook_predict::oracle';
export const PriceData = new MoveStruct({ name: `${$moduleName}::PriceData`, fields: {
        spot: bcs.u64(),
        forward: bcs.u64()
    } });
export const SVIParams = new MoveStruct({ name: `${$moduleName}::SVIParams`, fields: {
        a: bcs.u64(),
        b: bcs.u64(),
        rho: i64.I64,
        m: i64.I64,
        sigma: bcs.u64()
    } });
export const OracleSVI = new MoveStruct({ name: `${$moduleName}::OracleSVI`, fields: {
        id: bcs.Address,
        authorized_caps: vec_set.VecSet(bcs.Address),
        underlying_asset: bcs.string(),
        expiry: bcs.u64(),
        active: bcs.bool(),
        prices: PriceData,
        svi: SVIParams,
        timestamp: bcs.u64(),
        settlement_price: bcs.option(bcs.u64())
    } });
export interface IdArguments {
    market: RawTransactionArgument<string>;
}
export interface IdOptions {
    package?: string;
    arguments: IdArguments | [
        market: RawTransactionArgument<string>
    ];
}
export function id(options: IdOptions) {
    const packageAddress = options.package ?? 'deepbook_predict';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["market"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'oracle',
        function: 'id',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface ExpiryArguments {
    market: RawTransactionArgument<string>;
}
export interface ExpiryOptions {
    package?: string;
    arguments: ExpiryArguments | [
        market: RawTransactionArgument<string>
    ];
}
export function expiry(options: ExpiryOptions) {
    const packageAddress = options.package ?? 'deepbook_predict';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["market"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'oracle',
        function: 'expiry',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface IsSettledArguments {
    market: RawTransactionArgument<string>;
}
export interface IsSettledOptions {
    package?: string;
    arguments: IsSettledArguments | [
        market: RawTransactionArgument<string>
    ];
}
export function isSettled(options: IsSettledOptions) {
    const packageAddress = options.package ?? 'deepbook_predict';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["market"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'oracle',
        function: 'is_settled',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface StatusArguments {
    market: RawTransactionArgument<string>;
}
export interface StatusOptions {
    package?: string;
    arguments: StatusArguments | [
        market: RawTransactionArgument<string>
    ];
}
export function status(options: StatusOptions) {
    const packageAddress = options.package ?? 'deepbook_predict';
    const argumentsTypes = [
        null,
        '0x2::clock::Clock'
    ] satisfies (string | null)[];
    const parameterNames = ["market"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'oracle',
        function: 'status',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface StatusActiveOptions {
    package?: string;
    arguments?: [
    ];
}
export function statusActive(options: StatusActiveOptions = {}) {
    const packageAddress = options.package ?? 'deepbook_predict';
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'oracle',
        function: 'status_active',
    });
}
export interface StatusPendingSettlementOptions {
    package?: string;
    arguments?: [
    ];
}
export function statusPendingSettlement(options: StatusPendingSettlementOptions = {}) {
    const packageAddress = options.package ?? 'deepbook_predict';
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'oracle',
        function: 'status_pending_settlement',
    });
}
export interface StatusSettledOptions {
    package?: string;
    arguments?: [
    ];
}
export function statusSettled(options: StatusSettledOptions = {}) {
    const packageAddress = options.package ?? 'deepbook_predict';
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'oracle',
        function: 'status_settled',
    });
}
export interface SettlementPriceArguments {
    market: RawTransactionArgument<string>;
}
export interface SettlementPriceOptions {
    package?: string;
    arguments: SettlementPriceArguments | [
        market: RawTransactionArgument<string>
    ];
}
export function settlementPrice(options: SettlementPriceOptions) {
    const packageAddress = options.package ?? 'deepbook_predict';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["market"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'oracle',
        function: 'settlement_price',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface ComputePriceArguments {
    market: RawTransactionArgument<string>;
    Strike: RawTransactionArgument<number | bigint>;
}
export interface ComputePriceOptions {
    package?: string;
    arguments: ComputePriceArguments | [
        market: RawTransactionArgument<string>,
        Strike: RawTransactionArgument<number | bigint>
    ];
}
export function computePrice(options: ComputePriceOptions) {
    const packageAddress = options.package ?? 'deepbook_predict';
    const argumentsTypes = [
        null,
        'u64'
    ] satisfies (string | null)[];
    const parameterNames = ["market", "Strike"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'oracle',
        function: 'compute_price',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}