/**************************************************************
 * THIS FILE IS GENERATED AND SHOULD NOT BE MANUALLY MODIFIED *
 **************************************************************/


/**
 * Local link stub for `deepbook_predict::predict_account` (0xdb3ef5a5...446e,
 * predict-testnet-6-24). flicky's only on-chain call into the predict package is
 * `has_position` for settle-time anti-replay.
 */

import { type Transaction, type TransactionArgument } from '@mysten/sui/transactions';
import { normalizeMoveArguments, type RawTransactionArgument } from '../utils/index.js';
export interface HasPositionArguments {
    account: TransactionArgument;
    expiryMarketId: RawTransactionArgument<string>;
    orderId: RawTransactionArgument<number | bigint>;
}
export interface HasPositionOptions {
    package?: string;
    arguments: HasPositionArguments | [
        account: TransactionArgument,
        expiryMarketId: RawTransactionArgument<string>,
        orderId: RawTransactionArgument<number | bigint>
    ];
}
/**
 * True iff the account still holds the open position
 * `(expiry_market_id,  order_id)`. In the real package this reads the account's
 * PredictApp position table; here it delegates to the account stub's seeded set.
 */
export function hasPosition(options: HasPositionOptions) {
    const packageAddress = options.package ?? 'deepbook_predict';
    const argumentsTypes = [
        null,
        '0x2::object::ID',
        'u256'
    ] satisfies (string | null)[];
    const parameterNames = ["account", "expiryMarketId", "orderId"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'predict_account',
        function: 'has_position',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}