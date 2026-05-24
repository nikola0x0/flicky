import { Transaction } from '@mysten/sui/transactions'
import { CONFIG } from '../config'

// ========== Helper: Build Keys ==========

export const buildRangeKey = (
  tx: Transaction,
  oracleId: string,
  expiry: bigint,
  lower: bigint,
  higher: bigint
) => {
  return tx.moveCall({
    target: `${CONFIG.predictPackageId}::range_key::new`,
    arguments: [
      tx.pure.id(oracleId),
      tx.pure.u64(expiry),
      tx.pure.u64(lower),
      tx.pure.u64(higher),
    ],
  })
}

export const buildMarketKey = (
  tx: Transaction,
  oracleId: string,
  expiry: bigint,
  strike: bigint,
  isUp: boolean
) => {
  return tx.moveCall({
    target: `${CONFIG.predictPackageId}::market_key::new`,
    arguments: [
      tx.pure.id(oracleId),
      tx.pure.u64(expiry),
      tx.pure.u64(strike),
      tx.pure.bool(isUp),
    ],
  })
}

// ========== Manager: Create And Share Manager ==========

export const txCreateManager = (tx: Transaction) => {
  return tx.moveCall({
    target: `${CONFIG.predictPackageId}::predict::create_manager`,
    arguments: [],
  })
}


// ========== Oracle: Create Oracle ==========

export const txCreateOracle = (
  tx: Transaction,
  underlyingAsset: string,
  expiry: bigint,
  minStrike: bigint,
  tickSize: bigint
) => {
  if (!CONFIG.registryId || !CONFIG.predictObjectId || !CONFIG.marketOracleId) {
    throw new Error('Missing required config: REGISTRY_ID, PREDICT_OBJECT_ID, MARKET_ORACLE_ID')
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
  })
}

// ========== Keeper: Compact Settled Oracle ==========

export const txCompactSettledOracle = (
  tx: Transaction,
  oracleId: string,
  sviCapId: string
) => {
  if (!CONFIG.predictObjectId) {
    throw new Error('PREDICT_OBJECT_ID not configured')
  }

  return tx.moveCall({
    target: `${CONFIG.predictPackageId}::predict::compact_settled_oracle`,
    arguments: [
      tx.object(CONFIG.predictObjectId),
      tx.object(oracleId),
      tx.object(sviCapId),
    ],
  })
}

// ========== Read-Only: Oracle Status ==========

export const readOracleStatus = (tx: Transaction, oracleId: string) => {
  return tx.moveCall({
    target: `${CONFIG.predictPackageId}::oracle::status`,
    arguments: [
      tx.object(oracleId),
      tx.object('0x6'),
    ],
  })
}

// ========== Read-Only: Oracle Is Settled ==========

export const readOracleIsSettled = (tx: Transaction, oracleId: string) => {
  return tx.moveCall({
    target: `${CONFIG.predictPackageId}::oracle::is_settled`,
    arguments: [tx.object(oracleId)],
  })
}

// ========== Read-Only: Oracle Settlement Price ==========

export const readOracleSettlementPrice = (tx: Transaction, oracleId: string) => {
  return tx.moveCall({
    target: `${CONFIG.predictPackageId}::oracle::settlement_price`,
    arguments: [tx.object(oracleId)],
  })
}

// ========== Read-Only: Oracle Spot Price ==========

export const readOracleSpotPrice = (tx: Transaction, oracleId: string) => {
  return tx.moveCall({
    target: `${CONFIG.predictPackageId}::oracle::spot_price`,
    arguments: [tx.object(oracleId)],
  })
}

// ========== Read-Only: Oracle Expiry ==========

export const readOracleExpiry = (tx: Transaction, oracleId: string) => {
  return tx.moveCall({
    target: `${CONFIG.predictPackageId}::oracle::expiry`,
    arguments: [tx.object(oracleId)],
  })
}

// ========== Read-Only: Oracle ID ==========

export const readOracleId = (tx: Transaction, oracleId: string) => {
  return tx.moveCall({
    target: `${CONFIG.predictPackageId}::oracle::id`,
    arguments: [tx.object(oracleId)],
  })
}

// ========== Read-Only: Pyth Source ID ==========

export const readPythSourceId = (tx: Transaction, oracleId: string) => {
  return tx.moveCall({
    target: `${CONFIG.predictPackageId}::oracle::id`,
    arguments: [tx.object(oracleId)],
  })
}

// ========== Read-Only: Block Scholes Spot ==========

export const readBlockScholesSpot = (tx: Transaction, oracleId: string) => {
  return tx.moveCall({
    target: `${CONFIG.predictPackageId}::oracle::spot_price`,
    arguments: [tx.object(oracleId)],
  })
}

// ========== Read-Only: Block Scholes Forward ==========

export const readBlockScholesForward = (tx: Transaction, oracleId: string) => {
  return tx.moveCall({
    target: `${CONFIG.predictPackageId}::oracle::forward_price`,
    arguments: [tx.object(oracleId)],
  })
}

// ========== Read-Only: Block Scholes Price Source Timestamp ==========

export const readBlockScholesPriceSourceTimestamp = (tx: Transaction, oracleId: string) => {
  return tx.moveCall({
    target: `${CONFIG.predictPackageId}::oracle::timestamp`,
    arguments: [tx.object(oracleId)],
  })
}

// ========== Read-Only: Block Scholes Price Update Timestamp ==========

export const readBlockScholesPriceUpdateTimestamp = (tx: Transaction, oracleId: string) => {
  return tx.moveCall({
    target: `${CONFIG.predictPackageId}::oracle::timestamp`,
    arguments: [tx.object(oracleId)],
  })
}

// ========== Read-Only: Block Scholes SVI ==========

export const readBlockScholesSVI = (tx: Transaction, oracleId: string) => {
  return tx.moveCall({
    target: `${CONFIG.predictPackageId}::oracle::svi`,
    arguments: [tx.object(oracleId)],
  })
}

// ========== Read-Only: Block Scholes SVI Source Timestamp ==========

export const readBlockScholesSVISourceTimestamp = (tx: Transaction, oracleId: string) => {
  return tx.moveCall({
    target: `${CONFIG.predictPackageId}::oracle::timestamp`,
    arguments: [tx.object(oracleId)],
  })
}

// ========== Read-Only: Block Scholes SVI Update Timestamp ==========

export const readBlockScholesSVIUpdateTimestamp = (tx: Transaction, oracleId: string) => {
  return tx.moveCall({
    target: `${CONFIG.predictPackageId}::oracle::timestamp`,
    arguments: [tx.object(oracleId)],
  })
}

// ========== Read-Only: Predict Trading Paused ==========

export const readTradingPaused = (tx: Transaction) => {
  if (!CONFIG.predictObjectId) {
    throw new Error('PREDICT_OBJECT_ID not configured')
  }

  return tx.moveCall({
    target: `${CONFIG.predictPackageId}::predict::trading_paused`,
    arguments: [tx.object(CONFIG.predictObjectId)],
  })
}

// ========== Configuration: Set Trading Paused ==========

export const txSetTradingPaused = (
  tx: Transaction,
  paused: boolean
) => {
  if (!CONFIG.predictObjectId) {
    throw new Error('PREDICT_OBJECT_ID not configured')
  }

  return tx.moveCall({
    target: `${CONFIG.predictPackageId}::predict::set_trading_paused`,
    arguments: [
      tx.object(CONFIG.predictObjectId),
      tx.pure.bool(paused),
    ],
  })
}

// ========== Configuration: Set Min/Max Ask Price ==========

export const txSetMinAskPrice = (
  tx: Transaction,
  price: bigint
) => {
  if (!CONFIG.predictObjectId) {
    throw new Error('PREDICT_OBJECT_ID not configured')
  }

  return tx.moveCall({
    target: `${CONFIG.predictPackageId}::predict::set_min_ask_price`,
    arguments: [
      tx.object(CONFIG.predictObjectId),
      tx.pure.u64(price),
    ],
  })
}

export const txSetMaxAskPrice = (
  tx: Transaction,
  price: bigint
) => {
  if (!CONFIG.predictObjectId) {
    throw new Error('PREDICT_OBJECT_ID not configured')
  }

  return tx.moveCall({
    target: `${CONFIG.predictPackageId}::predict::set_max_ask_price`,
    arguments: [
      tx.object(CONFIG.predictObjectId),
      tx.pure.u64(price),
    ],
  })
}

// ========== Manager Balance / Position Query ==========

export const readManagerBalance = (
  tx: Transaction,
  managerId: string,
  quoteType: string
) => {
  return tx.moveCall({
    target: `${CONFIG.predictPackageId}::predict_manager::balance`,
    typeArguments: [quoteType],
    arguments: [tx.object(managerId)],
  })
}

export const readManagerPosition = (
  tx: Transaction,
  managerId: string,
  marketKey: any
) => {
  return tx.moveCall({
    target: `${CONFIG.predictPackageId}::predict_manager::position`,
    arguments: [tx.object(managerId), marketKey],
  })
}

export const readManagerRangePosition = (
  tx: Transaction,
  managerId: string,
  rangeKey: any
) => {
  return tx.moveCall({
    target: `${CONFIG.predictPackageId}::predict_manager::range_position`,
    arguments: [tx.object(managerId), rangeKey],
  })
}

// ========== Manager Deposit / Withdraw ==========

export const txDepositToManager = (
  tx: Transaction,
  managerId: string,
  coinObject: any,
  quoteType: string
) => {
  return tx.moveCall({
    target: `${CONFIG.predictPackageId}::predict_manager::deposit`,
    typeArguments: [quoteType],
    arguments: [tx.object(managerId), coinObject],
  })
}

export const txWithdrawFromManager = (
  tx: Transaction,
  managerId: string,
  amount: bigint,
  quoteType: string
) => {
  return tx.moveCall({
    target: `${CONFIG.predictPackageId}::predict_manager::withdraw`,
    typeArguments: [quoteType],
    arguments: [tx.object(managerId), tx.pure.u64(amount)],
  })
}

// ========== Trading: Binary Position (Mint / Redeem) ==========

export const txMint = (
  tx: Transaction,
  managerId: string,
  marketOracleId: string,
  marketKey: any,
  quantity: bigint,
  quoteType: string
) => {
  if (!CONFIG.predictObjectId) {
    throw new Error('PREDICT_OBJECT_ID not configured')
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
  })
}

export const txRedeem = (
  tx: Transaction,
  managerId: string,
  marketOracleId: string,
  marketKey: any,
  quantity: bigint,
  quoteType: string
) => {
  if (!CONFIG.predictObjectId) {
    throw new Error('PREDICT_OBJECT_ID not configured')
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
  })
}

// ========== Trading: Range Position (Mint Range / Redeem Range) ==========

export const txMintRange = (
  tx: Transaction,
  managerId: string,
  marketOracleId: string,
  rangeKey: any,
  quantity: bigint,
  quoteType: string
) => {
  if (!CONFIG.predictObjectId) {
    throw new Error('PREDICT_OBJECT_ID not configured')
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
  })
}

export const txRedeemRange = (
  tx: Transaction,
  managerId: string,
  marketOracleId: string,
  rangeKey: any,
  quantity: bigint,
  quoteType: string
) => {
  if (!CONFIG.predictObjectId) {
    throw new Error('PREDICT_OBJECT_ID not configured')
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
  })
}

// ========== LP: Supply / Withdraw ==========

export const txSupply = (
  tx: Transaction,
  coinObject: any,
  quoteType: string
) => {
  if (!CONFIG.predictObjectId) {
    throw new Error('PREDICT_OBJECT_ID not configured')
  }

  return tx.moveCall({
    target: `${CONFIG.predictPackageId}::predict::supply`,
    typeArguments: [quoteType],
    arguments: [
      tx.object(CONFIG.predictObjectId),
      coinObject,
      tx.object(CONFIG.CLOCK_ID),
    ],
  })
}

export const txWithdraw = (
  tx: Transaction,
  lpCoinObject: any,
  quoteType: string
) => {
  if (!CONFIG.predictObjectId) {
    throw new Error('PREDICT_OBJECT_ID not configured')
  }

  return tx.moveCall({
    target: `${CONFIG.predictPackageId}::predict::withdraw`,
    typeArguments: [quoteType],
    arguments: [
      tx.object(CONFIG.predictObjectId),
      lpCoinObject,
      tx.object(CONFIG.CLOCK_ID),
    ],
  })
}

// ========== Keeper: Permissionless Redeems ==========

export const txRedeemPermissionless = (
  tx: Transaction,
  managerId: string,
  marketOracleId: string,
  marketKey: any,
  quantity: bigint,
  quoteType: string
) => {
  if (!CONFIG.predictObjectId) {
    throw new Error('PREDICT_OBJECT_ID not configured')
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
  })
}

// ========== Pricing / Quote Previews ==========

export const readGetTradeAmounts = (
  tx: Transaction,
  marketOracleId: string,
  marketKey: any,
  quantity: bigint
) => {
  if (!CONFIG.predictObjectId) {
    throw new Error('PREDICT_OBJECT_ID not configured')
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
  })
}

export const readGetRangeTradeAmounts = (
  tx: Transaction,
  marketOracleId: string,
  rangeKey: any,
  quantity: bigint
) => {
  if (!CONFIG.predictObjectId) {
    throw new Error('PREDICT_OBJECT_ID not configured')
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
  })
}

// ========== Protocol Configuration Reads ==========

export const readBaseSpread = (tx: Transaction) => {
  if (!CONFIG.predictObjectId) {
    throw new Error('PREDICT_OBJECT_ID not configured')
  }
  return tx.moveCall({
    target: `${CONFIG.predictPackageId}::predict::base_spread`,
    arguments: [tx.object(CONFIG.predictObjectId)],
  })
}

export const readMinSpread = (tx: Transaction) => {
  if (!CONFIG.predictObjectId) {
    throw new Error('PREDICT_OBJECT_ID not configured')
  }
  return tx.moveCall({
    target: `${CONFIG.predictPackageId}::predict::min_spread`,
    arguments: [tx.object(CONFIG.predictObjectId)],
  })
}

export const readUtilizationMultiplier = (tx: Transaction) => {
  if (!CONFIG.predictObjectId) {
    throw new Error('PREDICT_OBJECT_ID not configured')
  }
  return tx.moveCall({
    target: `${CONFIG.predictPackageId}::predict::utilization_multiplier`,
    arguments: [tx.object(CONFIG.predictObjectId)],
  })
}

export const readMaxTotalExposurePct = (tx: Transaction) => {
  if (!CONFIG.predictObjectId) {
    throw new Error('PREDICT_OBJECT_ID not configured')
  }
  return tx.moveCall({
    target: `${CONFIG.predictPackageId}::predict::max_total_exposure_pct`,
    arguments: [tx.object(CONFIG.predictObjectId)],
  })
}

export const readAcceptedQuotes = (tx: Transaction) => {
  if (!CONFIG.predictObjectId) {
    throw new Error('PREDICT_OBJECT_ID not configured')
  }
  return tx.moveCall({
    target: `${CONFIG.predictPackageId}::predict::accepted_quotes`,
    arguments: [tx.object(CONFIG.predictObjectId)],
  })
}

export const readAvailableWithdrawal = (tx: Transaction) => {
  if (!CONFIG.predictObjectId) {
    throw new Error('PREDICT_OBJECT_ID not configured')
  }
  return tx.moveCall({
    target: `${CONFIG.predictPackageId}::predict::available_withdrawal`,
    arguments: [tx.object(CONFIG.predictObjectId), tx.object(CONFIG.CLOCK_ID)],
  })
}

export const readAskBounds = (tx: Transaction, oracleId: string) => {
  if (!CONFIG.predictObjectId) {
    throw new Error('PREDICT_OBJECT_ID not configured')
  }
  return tx.moveCall({
    target: `${CONFIG.predictPackageId}::predict::ask_bounds`,
    arguments: [tx.object(CONFIG.predictObjectId), tx.pure.id(oracleId)],
  })
}

