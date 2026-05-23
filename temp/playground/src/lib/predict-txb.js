import { CONFIG } from '../config';
// ========== Helper: Build Keys ==========
export const buildRangeKey = (tx, oracleId, expiry, lower, higher) => {
    return tx.moveCall({
        target: `${CONFIG.predictPackageId}::range_key::new`,
        arguments: [
            tx.pure.id(oracleId),
            tx.pure.u64(expiry),
            tx.pure.u64(lower),
            tx.pure.u64(higher),
        ],
    });
};
export const buildMarketKey = (tx, oracleId, expiry, strike, isUp) => {
    return tx.moveCall({
        target: `${CONFIG.predictPackageId}::market_key::new`,
        arguments: [
            tx.pure.id(oracleId),
            tx.pure.u64(expiry),
            tx.pure.u64(strike),
            tx.pure.bool(isUp),
        ],
    });
};
// ========== Manager: Create And Share Manager ==========
export const txCreateManager = (tx) => {
    return tx.moveCall({
        target: `${CONFIG.predictPackageId}::predict::create_manager`,
        arguments: [],
    });
};
// ========== Oracle: Create Oracle ==========
export const txCreateOracle = (tx, underlyingAsset, expiry, minStrike, tickSize) => {
    if (!CONFIG.registryId || !CONFIG.predictObjectId || !CONFIG.marketOracleId) {
        throw new Error('Missing required config: REGISTRY_ID, PREDICT_OBJECT_ID, MARKET_ORACLE_ID');
    }
    return tx.moveCall({
        target: `${CONFIG.predictPackageId}::registry::create_oracle`,
        arguments: [
            tx.object(CONFIG.registryId),
            tx.object(CONFIG.predictObjectId),
            tx.object(CONFIG.marketOracleId),
            tx.pure.string(underlyingAsset),
            tx.pure.u64(expiry),
            tx.pure.u64(minStrike),
            tx.pure.u64(tickSize),
            tx.object('0x6'), // Clock
        ],
    });
};
// ========== Keeper: Compact Settled Oracle ==========
export const txCompactSettledOracle = (tx, oracleId, sviCapId) => {
    if (!CONFIG.predictObjectId) {
        throw new Error('PREDICT_OBJECT_ID not configured');
    }
    return tx.moveCall({
        target: `${CONFIG.predictPackageId}::predict::compact_settled_oracle`,
        arguments: [
            tx.object(CONFIG.predictObjectId),
            tx.object(oracleId),
            tx.object(sviCapId),
        ],
    });
};
// ========== Read-Only: Oracle Status ==========
export const readOracleStatus = (tx, oracleId) => {
    return tx.moveCall({
        target: `${CONFIG.predictPackageId}::oracle::status`,
        arguments: [
            tx.object(oracleId),
            tx.object('0x6'),
        ],
    });
};
// ========== Read-Only: Oracle Is Settled ==========
export const readOracleIsSettled = (tx, oracleId) => {
    return tx.moveCall({
        target: `${CONFIG.predictPackageId}::oracle::is_settled`,
        arguments: [tx.object(oracleId)],
    });
};
// ========== Read-Only: Oracle Settlement Price ==========
export const readOracleSettlementPrice = (tx, oracleId) => {
    return tx.moveCall({
        target: `${CONFIG.predictPackageId}::oracle::settlement_price`,
        arguments: [tx.object(oracleId)],
    });
};
// ========== Read-Only: Oracle Spot Price ==========
export const readOracleSpotPrice = (tx, oracleId) => {
    return tx.moveCall({
        target: `${CONFIG.predictPackageId}::oracle::spot_price`,
        arguments: [tx.object(oracleId)],
    });
};
// ========== Read-Only: Oracle Expiry ==========
export const readOracleExpiry = (tx, oracleId) => {
    return tx.moveCall({
        target: `${CONFIG.predictPackageId}::oracle::expiry`,
        arguments: [tx.object(oracleId)],
    });
};
// ========== Read-Only: Oracle ID ==========
export const readOracleId = (tx, oracleId) => {
    return tx.moveCall({
        target: `${CONFIG.predictPackageId}::oracle::id`,
        arguments: [tx.object(oracleId)],
    });
};
// ========== Read-Only: Pyth Source ID ==========
export const readPythSourceId = (tx, oracleId) => {
    return tx.moveCall({
        target: `${CONFIG.predictPackageId}::oracle::id`,
        arguments: [tx.object(oracleId)],
    });
};
// ========== Read-Only: Block Scholes Spot ==========
export const readBlockScholesSpot = (tx, oracleId) => {
    return tx.moveCall({
        target: `${CONFIG.predictPackageId}::oracle::spot_price`,
        arguments: [tx.object(oracleId)],
    });
};
// ========== Read-Only: Block Scholes Forward ==========
export const readBlockScholesForward = (tx, oracleId) => {
    return tx.moveCall({
        target: `${CONFIG.predictPackageId}::oracle::forward_price`,
        arguments: [tx.object(oracleId)],
    });
};
// ========== Read-Only: Block Scholes Price Source Timestamp ==========
export const readBlockScholesPriceSourceTimestamp = (tx, oracleId) => {
    return tx.moveCall({
        target: `${CONFIG.predictPackageId}::oracle::timestamp`,
        arguments: [tx.object(oracleId)],
    });
};
// ========== Read-Only: Block Scholes Price Update Timestamp ==========
export const readBlockScholesPriceUpdateTimestamp = (tx, oracleId) => {
    return tx.moveCall({
        target: `${CONFIG.predictPackageId}::oracle::timestamp`,
        arguments: [tx.object(oracleId)],
    });
};
// ========== Read-Only: Block Scholes SVI ==========
export const readBlockScholesSVI = (tx, oracleId) => {
    return tx.moveCall({
        target: `${CONFIG.predictPackageId}::oracle::svi`,
        arguments: [tx.object(oracleId)],
    });
};
// ========== Read-Only: Block Scholes SVI Source Timestamp ==========
export const readBlockScholesSVISourceTimestamp = (tx, oracleId) => {
    return tx.moveCall({
        target: `${CONFIG.predictPackageId}::oracle::timestamp`,
        arguments: [tx.object(oracleId)],
    });
};
// ========== Read-Only: Block Scholes SVI Update Timestamp ==========
export const readBlockScholesSVIUpdateTimestamp = (tx, oracleId) => {
    return tx.moveCall({
        target: `${CONFIG.predictPackageId}::oracle::timestamp`,
        arguments: [tx.object(oracleId)],
    });
};
// ========== Read-Only: Predict Trading Paused ==========
export const readTradingPaused = (tx) => {
    if (!CONFIG.predictObjectId) {
        throw new Error('PREDICT_OBJECT_ID not configured');
    }
    return tx.moveCall({
        target: `${CONFIG.predictPackageId}::predict::trading_paused`,
        arguments: [tx.object(CONFIG.predictObjectId)],
    });
};
// ========== Configuration: Set Trading Paused ==========
export const txSetTradingPaused = (tx, paused) => {
    if (!CONFIG.predictObjectId) {
        throw new Error('PREDICT_OBJECT_ID not configured');
    }
    return tx.moveCall({
        target: `${CONFIG.predictPackageId}::predict::set_trading_paused`,
        arguments: [
            tx.object(CONFIG.predictObjectId),
            tx.pure.bool(paused),
        ],
    });
};
// ========== Configuration: Set Min/Max Ask Price ==========
export const txSetMinAskPrice = (tx, price) => {
    if (!CONFIG.predictObjectId) {
        throw new Error('PREDICT_OBJECT_ID not configured');
    }
    return tx.moveCall({
        target: `${CONFIG.predictPackageId}::predict::set_min_ask_price`,
        arguments: [
            tx.object(CONFIG.predictObjectId),
            tx.pure.u64(price),
        ],
    });
};
export const txSetMaxAskPrice = (tx, price) => {
    if (!CONFIG.predictObjectId) {
        throw new Error('PREDICT_OBJECT_ID not configured');
    }
    return tx.moveCall({
        target: `${CONFIG.predictPackageId}::predict::set_max_ask_price`,
        arguments: [
            tx.object(CONFIG.predictObjectId),
            tx.pure.u64(price),
        ],
    });
};
// ========== Manager Balance / Position Query ==========
export const readManagerBalance = (tx, managerId, quoteType) => {
    return tx.moveCall({
        target: `${CONFIG.predictPackageId}::predict_manager::balance`,
        typeArguments: [quoteType],
        arguments: [tx.object(managerId)],
    });
};
export const readManagerPosition = (tx, managerId, marketKey) => {
    return tx.moveCall({
        target: `${CONFIG.predictPackageId}::predict_manager::position`,
        arguments: [tx.object(managerId), marketKey],
    });
};
export const readManagerRangePosition = (tx, managerId, rangeKey) => {
    return tx.moveCall({
        target: `${CONFIG.predictPackageId}::predict_manager::range_position`,
        arguments: [tx.object(managerId), rangeKey],
    });
};
// ========== Manager Deposit / Withdraw ==========
export const txDepositToManager = (tx, managerId, coinObject, quoteType) => {
    return tx.moveCall({
        target: `${CONFIG.predictPackageId}::predict_manager::deposit`,
        typeArguments: [quoteType],
        arguments: [tx.object(managerId), coinObject],
    });
};
export const txWithdrawFromManager = (tx, managerId, amount, quoteType) => {
    return tx.moveCall({
        target: `${CONFIG.predictPackageId}::predict_manager::withdraw`,
        typeArguments: [quoteType],
        arguments: [tx.object(managerId), tx.pure.u64(amount)],
    });
};
// ========== Trading: Binary Position (Mint / Redeem) ==========
export const txMint = (tx, managerId, marketOracleId, marketKey, quantity, quoteType) => {
    if (!CONFIG.predictObjectId) {
        throw new Error('PREDICT_OBJECT_ID not configured');
    }
    return tx.moveCall({
        target: `${CONFIG.predictPackageId}::predict::mint`,
        typeArguments: [quoteType],
        arguments: [
            tx.object(CONFIG.predictObjectId),
            tx.object(managerId),
            tx.object(marketOracleId),
            marketKey,
            tx.pure.u64(quantity),
            tx.object(CONFIG.CLOCK_ID),
        ],
    });
};
export const txRedeem = (tx, managerId, marketOracleId, marketKey, quantity, quoteType) => {
    if (!CONFIG.predictObjectId) {
        throw new Error('PREDICT_OBJECT_ID not configured');
    }
    return tx.moveCall({
        target: `${CONFIG.predictPackageId}::predict::redeem`,
        typeArguments: [quoteType],
        arguments: [
            tx.object(CONFIG.predictObjectId),
            tx.object(managerId),
            tx.object(marketOracleId),
            marketKey,
            tx.pure.u64(quantity),
            tx.object(CONFIG.CLOCK_ID),
        ],
    });
};
// ========== Trading: Range Position (Mint Range / Redeem Range) ==========
export const txMintRange = (tx, managerId, marketOracleId, rangeKey, quantity, quoteType) => {
    if (!CONFIG.predictObjectId) {
        throw new Error('PREDICT_OBJECT_ID not configured');
    }
    return tx.moveCall({
        target: `${CONFIG.predictPackageId}::predict::mint_range`,
        typeArguments: [quoteType],
        arguments: [
            tx.object(CONFIG.predictObjectId),
            tx.object(managerId),
            tx.object(marketOracleId),
            rangeKey,
            tx.pure.u64(quantity),
            tx.object(CONFIG.CLOCK_ID),
        ],
    });
};
export const txRedeemRange = (tx, managerId, marketOracleId, rangeKey, quantity, quoteType) => {
    if (!CONFIG.predictObjectId) {
        throw new Error('PREDICT_OBJECT_ID not configured');
    }
    return tx.moveCall({
        target: `${CONFIG.predictPackageId}::predict::redeem_range`,
        typeArguments: [quoteType],
        arguments: [
            tx.object(CONFIG.predictObjectId),
            tx.object(managerId),
            tx.object(marketOracleId),
            rangeKey,
            tx.pure.u64(quantity),
            tx.object(CONFIG.CLOCK_ID),
        ],
    });
};
// ========== LP: Supply / Withdraw ==========
export const txSupply = (tx, coinObject, quoteType) => {
    if (!CONFIG.predictObjectId) {
        throw new Error('PREDICT_OBJECT_ID not configured');
    }
    return tx.moveCall({
        target: `${CONFIG.predictPackageId}::predict::supply`,
        typeArguments: [quoteType],
        arguments: [
            tx.object(CONFIG.predictObjectId),
            coinObject,
            tx.object(CONFIG.CLOCK_ID),
        ],
    });
};
export const txWithdraw = (tx, lpCoinObject, quoteType) => {
    if (!CONFIG.predictObjectId) {
        throw new Error('PREDICT_OBJECT_ID not configured');
    }
    return tx.moveCall({
        target: `${CONFIG.predictPackageId}::predict::withdraw`,
        typeArguments: [quoteType],
        arguments: [
            tx.object(CONFIG.predictObjectId),
            lpCoinObject,
            tx.object(CONFIG.CLOCK_ID),
        ],
    });
};
// ========== Keeper: Permissionless Redeems ==========
export const txRedeemPermissionless = (tx, managerId, marketOracleId, marketKey, quantity, quoteType) => {
    if (!CONFIG.predictObjectId) {
        throw new Error('PREDICT_OBJECT_ID not configured');
    }
    return tx.moveCall({
        target: `${CONFIG.predictPackageId}::predict::redeem_permissionless`,
        typeArguments: [quoteType],
        arguments: [
            tx.object(CONFIG.predictObjectId),
            tx.object(managerId),
            tx.object(marketOracleId),
            marketKey,
            tx.pure.u64(quantity),
            tx.object(CONFIG.CLOCK_ID),
        ],
    });
};
// ========== Pricing / Quote Previews ==========
export const readGetTradeAmounts = (tx, marketOracleId, marketKey, quantity) => {
    if (!CONFIG.predictObjectId) {
        throw new Error('PREDICT_OBJECT_ID not configured');
    }
    return tx.moveCall({
        target: `${CONFIG.predictPackageId}::predict::get_trade_amounts`,
        arguments: [
            tx.object(CONFIG.predictObjectId),
            tx.object(marketOracleId),
            marketKey,
            tx.pure.u64(quantity),
            tx.object(CONFIG.CLOCK_ID),
        ],
    });
};
export const readGetRangeTradeAmounts = (tx, marketOracleId, rangeKey, quantity) => {
    if (!CONFIG.predictObjectId) {
        throw new Error('PREDICT_OBJECT_ID not configured');
    }
    return tx.moveCall({
        target: `${CONFIG.predictPackageId}::predict::get_range_trade_amounts`,
        arguments: [
            tx.object(CONFIG.predictObjectId),
            tx.object(marketOracleId),
            rangeKey,
            tx.pure.u64(quantity),
            tx.object(CONFIG.CLOCK_ID),
        ],
    });
};
// ========== Protocol Configuration Reads ==========
export const readBaseSpread = (tx) => {
    if (!CONFIG.predictObjectId) {
        throw new Error('PREDICT_OBJECT_ID not configured');
    }
    return tx.moveCall({
        target: `${CONFIG.predictPackageId}::predict::base_spread`,
        arguments: [tx.object(CONFIG.predictObjectId)],
    });
};
export const readMinSpread = (tx) => {
    if (!CONFIG.predictObjectId) {
        throw new Error('PREDICT_OBJECT_ID not configured');
    }
    return tx.moveCall({
        target: `${CONFIG.predictPackageId}::predict::min_spread`,
        arguments: [tx.object(CONFIG.predictObjectId)],
    });
};
export const readUtilizationMultiplier = (tx) => {
    if (!CONFIG.predictObjectId) {
        throw new Error('PREDICT_OBJECT_ID not configured');
    }
    return tx.moveCall({
        target: `${CONFIG.predictPackageId}::predict::utilization_multiplier`,
        arguments: [tx.object(CONFIG.predictObjectId)],
    });
};
export const readMaxTotalExposurePct = (tx) => {
    if (!CONFIG.predictObjectId) {
        throw new Error('PREDICT_OBJECT_ID not configured');
    }
    return tx.moveCall({
        target: `${CONFIG.predictPackageId}::predict::max_total_exposure_pct`,
        arguments: [tx.object(CONFIG.predictObjectId)],
    });
};
export const readAcceptedQuotes = (tx) => {
    if (!CONFIG.predictObjectId) {
        throw new Error('PREDICT_OBJECT_ID not configured');
    }
    return tx.moveCall({
        target: `${CONFIG.predictPackageId}::predict::accepted_quotes`,
        arguments: [tx.object(CONFIG.predictObjectId)],
    });
};
export const readAvailableWithdrawal = (tx) => {
    if (!CONFIG.predictObjectId) {
        throw new Error('PREDICT_OBJECT_ID not configured');
    }
    return tx.moveCall({
        target: `${CONFIG.predictPackageId}::predict::available_withdrawal`,
        arguments: [tx.object(CONFIG.predictObjectId), tx.object(CONFIG.CLOCK_ID)],
    });
};
export const readAskBounds = (tx, oracleId) => {
    if (!CONFIG.predictObjectId) {
        throw new Error('PREDICT_OBJECT_ID not configured');
    }
    return tx.moveCall({
        target: `${CONFIG.predictPackageId}::predict::ask_bounds`,
        arguments: [tx.object(CONFIG.predictObjectId), tx.pure.id(oracleId)],
    });
};
//# sourceMappingURL=predict-txb.js.map