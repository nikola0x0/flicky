/**************************************************************
 * THIS FILE IS GENERATED AND SHOULD NOT BE MANUALLY MODIFIED *
 **************************************************************/
import { MoveStruct, normalizeMoveArguments, type RawTransactionArgument } from '../utils/index.js';
import { bcs } from '@mysten/sui/bcs';
import { type Transaction, type TransactionArgument } from '@mysten/sui/transactions';
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
export const OracleSVICap = new MoveStruct({ name: `${$moduleName}::OracleSVICap`, fields: {
        id: bcs.Address
    } });
export interface IdArguments {
    oracle: RawTransactionArgument<string>;
}
export interface IdOptions {
    package?: string;
    arguments: IdArguments | [
        oracle: RawTransactionArgument<string>
    ];
}
export function id(options: IdOptions) {
    const packageAddress = options.package ?? 'deepbook_predict';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["oracle"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'oracle',
        function: 'id',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface ExpiryArguments {
    oracle: RawTransactionArgument<string>;
}
export interface ExpiryOptions {
    package?: string;
    arguments: ExpiryArguments | [
        oracle: RawTransactionArgument<string>
    ];
}
export function expiry(options: ExpiryOptions) {
    const packageAddress = options.package ?? 'deepbook_predict';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["oracle"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'oracle',
        function: 'expiry',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface UnderlyingAssetArguments {
    oracle: RawTransactionArgument<string>;
}
export interface UnderlyingAssetOptions {
    package?: string;
    arguments: UnderlyingAssetArguments | [
        oracle: RawTransactionArgument<string>
    ];
}
export function underlyingAsset(options: UnderlyingAssetOptions) {
    const packageAddress = options.package ?? 'deepbook_predict';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["oracle"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'oracle',
        function: 'underlying_asset',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface IsActiveArguments {
    oracle: RawTransactionArgument<string>;
}
export interface IsActiveOptions {
    package?: string;
    arguments: IsActiveArguments | [
        oracle: RawTransactionArgument<string>
    ];
}
export function isActive(options: IsActiveOptions) {
    const packageAddress = options.package ?? 'deepbook_predict';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["oracle"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'oracle',
        function: 'is_active',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface IsSettledArguments {
    oracle: RawTransactionArgument<string>;
}
export interface IsSettledOptions {
    package?: string;
    arguments: IsSettledArguments | [
        oracle: RawTransactionArgument<string>
    ];
}
export function isSettled(options: IsSettledOptions) {
    const packageAddress = options.package ?? 'deepbook_predict';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["oracle"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'oracle',
        function: 'is_settled',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface PricesArguments {
    oracle: RawTransactionArgument<string>;
}
export interface PricesOptions {
    package?: string;
    arguments: PricesArguments | [
        oracle: RawTransactionArgument<string>
    ];
}
export function prices(options: PricesOptions) {
    const packageAddress = options.package ?? 'deepbook_predict';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["oracle"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'oracle',
        function: 'prices',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface SpotPriceArguments {
    oracle: RawTransactionArgument<string>;
}
export interface SpotPriceOptions {
    package?: string;
    arguments: SpotPriceArguments | [
        oracle: RawTransactionArgument<string>
    ];
}
export function spotPrice(options: SpotPriceOptions) {
    const packageAddress = options.package ?? 'deepbook_predict';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["oracle"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'oracle',
        function: 'spot_price',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface ForwardPriceArguments {
    oracle: RawTransactionArgument<string>;
}
export interface ForwardPriceOptions {
    package?: string;
    arguments: ForwardPriceArguments | [
        oracle: RawTransactionArgument<string>
    ];
}
export function forwardPrice(options: ForwardPriceOptions) {
    const packageAddress = options.package ?? 'deepbook_predict';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["oracle"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'oracle',
        function: 'forward_price',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface SviArguments {
    oracle: RawTransactionArgument<string>;
}
export interface SviOptions {
    package?: string;
    arguments: SviArguments | [
        oracle: RawTransactionArgument<string>
    ];
}
export function svi(options: SviOptions) {
    const packageAddress = options.package ?? 'deepbook_predict';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["oracle"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'oracle',
        function: 'svi',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface SettlementPriceArguments {
    oracle: RawTransactionArgument<string>;
}
export interface SettlementPriceOptions {
    package?: string;
    arguments: SettlementPriceArguments | [
        oracle: RawTransactionArgument<string>
    ];
}
export function settlementPrice(options: SettlementPriceOptions) {
    const packageAddress = options.package ?? 'deepbook_predict';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["oracle"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'oracle',
        function: 'settlement_price',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface TimestampArguments {
    oracle: RawTransactionArgument<string>;
}
export interface TimestampOptions {
    package?: string;
    arguments: TimestampArguments | [
        oracle: RawTransactionArgument<string>
    ];
}
export function timestamp(options: TimestampOptions) {
    const packageAddress = options.package ?? 'deepbook_predict';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["oracle"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'oracle',
        function: 'timestamp',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface StatusArguments {
    oracle: RawTransactionArgument<string>;
}
export interface StatusOptions {
    package?: string;
    arguments: StatusArguments | [
        oracle: RawTransactionArgument<string>
    ];
}
export function status(options: StatusOptions) {
    const packageAddress = options.package ?? 'deepbook_predict';
    const argumentsTypes = [
        null,
        '0x2::clock::Clock'
    ] satisfies (string | null)[];
    const parameterNames = ["oracle"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'oracle',
        function: 'status',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface StatusInactiveOptions {
    package?: string;
    arguments?: [
    ];
}
export function statusInactive(options: StatusInactiveOptions = {}) {
    const packageAddress = options.package ?? 'deepbook_predict';
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'oracle',
        function: 'status_inactive',
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
export interface SviAArguments {
    p: TransactionArgument;
}
export interface SviAOptions {
    package?: string;
    arguments: SviAArguments | [
        p: TransactionArgument
    ];
}
export function sviA(options: SviAOptions) {
    const packageAddress = options.package ?? 'deepbook_predict';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["p"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'oracle',
        function: 'svi_a',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface SviBArguments {
    p: TransactionArgument;
}
export interface SviBOptions {
    package?: string;
    arguments: SviBArguments | [
        p: TransactionArgument
    ];
}
export function sviB(options: SviBOptions) {
    const packageAddress = options.package ?? 'deepbook_predict';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["p"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'oracle',
        function: 'svi_b',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface SviRhoArguments {
    p: TransactionArgument;
}
export interface SviRhoOptions {
    package?: string;
    arguments: SviRhoArguments | [
        p: TransactionArgument
    ];
}
export function sviRho(options: SviRhoOptions) {
    const packageAddress = options.package ?? 'deepbook_predict';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["p"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'oracle',
        function: 'svi_rho',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface SviMArguments {
    p: TransactionArgument;
}
export interface SviMOptions {
    package?: string;
    arguments: SviMArguments | [
        p: TransactionArgument
    ];
}
export function sviM(options: SviMOptions) {
    const packageAddress = options.package ?? 'deepbook_predict';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["p"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'oracle',
        function: 'svi_m',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface SviSigmaArguments {
    p: TransactionArgument;
}
export interface SviSigmaOptions {
    package?: string;
    arguments: SviSigmaArguments | [
        p: TransactionArgument
    ];
}
export function sviSigma(options: SviSigmaOptions) {
    const packageAddress = options.package ?? 'deepbook_predict';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["p"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'oracle',
        function: 'svi_sigma',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}