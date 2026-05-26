import { Transaction } from '@mysten/sui/transactions'
import { CONFIG } from '../config'

// ========== Duel: Create Duel ==========
export const txCreateDuel = (
  tx: Transaction,
  stakeCoin: any,
  deckHash: number[],
  coinType: string
) => {
  if (!CONFIG.flickyPackageId) {
    throw new Error('FLICKY_PACKAGE_ID not configured')
  }

  return tx.moveCall({
    target: `${CONFIG.flickyPackageId}::duel::create_duel`,
    typeArguments: [coinType],
    arguments: [
      stakeCoin,
      tx.pure.vector('u8', deckHash),
    ],
  })
}

export const txCreateDuelFree = (
  tx: Transaction,
  deckHash: number[],
  coinType: string = '0x2::sui::SUI'
) => {
  if (!CONFIG.flickyPackageId) {
    throw new Error('FLICKY_PACKAGE_ID not configured')
  }
  return tx.moveCall({
    target: `${CONFIG.flickyPackageId}::duel::create_duel_free`,
    typeArguments: [coinType],
    arguments: [tx.pure.vector('u8', deckHash)],
  })
}

// ========== Duel: Join Duel ==========
export const txJoinDuel = (
  tx: Transaction,
  duelId: string,
  stakeCoin: any,
  coinType: string
) => {
  if (!CONFIG.flickyPackageId) {
    throw new Error('FLICKY_PACKAGE_ID not configured')
  }

  return tx.moveCall({
    target: `${CONFIG.flickyPackageId}::duel::join_duel`,
    typeArguments: [coinType],
    arguments: [
      tx.object(duelId),
      stakeCoin,
      tx.object(CONFIG.CLOCK_ID),
    ],
  })
}

export const txJoinDuelFree = (
  tx: Transaction,
  duelId: string,
  coinType: string = '0x2::sui::SUI'
) => {
  if (!CONFIG.flickyPackageId) {
    throw new Error('FLICKY_PACKAGE_ID not configured')
  }
  return tx.moveCall({
    target: `${CONFIG.flickyPackageId}::duel::join_duel_free`,
    typeArguments: [coinType],
    arguments: [tx.object(duelId), tx.object(CONFIG.CLOCK_ID)],
  })
}

// ========== Duel: Reveal Deck ==========
export interface DuelCard {
  oracleId: string
  strike: bigint
  expiry?: bigint
}

export const txRevealDeck = (
  tx: Transaction,
  duelId: string,
  cards: DuelCard[],
  coinType: string
) => {
  if (!CONFIG.flickyPackageId) {
    throw new Error('FLICKY_PACKAGE_ID not configured')
  }

  const cardObjects = cards.map(card => {
    return tx.moveCall({
      target: `${CONFIG.flickyPackageId}::duel::new_card`,
      arguments: [
        tx.object(card.oracleId),
        tx.pure.u64(card.strike)
      ]
    })
  })

  const cardsVec = tx.makeMoveVec({
    type: `${CONFIG.flickyPackageId}::duel::Card`,
    elements: cardObjects
  })

  return tx.moveCall({
    target: `${CONFIG.flickyPackageId}::duel::reveal_deck`,
    typeArguments: [coinType],
    arguments: [
      tx.object(duelId),
      cardsVec
    ],
  })
}

// ========== Duel: Record Swipe ==========
// Snapshots premium + p_swiped from `predict::get_trade_amounts` on-chain.
// Client supplies only `quantity`; premium is derived from the live SVI.
export const txRecordSwipe = (
  tx: Transaction,
  duelId: string,
  managerId: string,
  predictId: string,
  oracleId: string,
  cardIdx: number,
  isUp: boolean,
  quantity: bigint,
  coinType: string = '0x2::sui::SUI'
) => {
  if (!CONFIG.flickyPackageId) {
    throw new Error('FLICKY_PACKAGE_ID not configured')
  }

  return tx.moveCall({
    target: `${CONFIG.flickyPackageId}::duel::record_swipe`,
    typeArguments: [coinType],
    arguments: [
      tx.object(duelId),
      tx.object(managerId),
      tx.object(predictId),
      tx.object(oracleId),
      tx.pure.u64(BigInt(cardIdx)),
      tx.pure.bool(isUp),
      tx.pure.u64(quantity),
      tx.object(CONFIG.CLOCK_ID)
    ]
  })
}

export const txRecordSwipeFree = (
  tx: Transaction,
  duelId: string,
  predictId: string,
  oracleId: string,
  cardIdx: number,
  isUp: boolean,
  coinType: string = '0x2::sui::SUI'
) => {
  if (!CONFIG.flickyPackageId) {
    throw new Error('FLICKY_PACKAGE_ID not configured')
  }
  return tx.moveCall({
    target: `${CONFIG.flickyPackageId}::duel::record_swipe_free`,
    typeArguments: [coinType],
    arguments: [
      tx.object(duelId),
      tx.object(predictId),
      tx.object(oracleId),
      tx.pure.u64(BigInt(cardIdx)),
      tx.pure.bool(isUp),
      tx.object(CONFIG.CLOCK_ID)
    ]
  })
}

// ========== Duel: Finalize ==========
// One-shot: reads oracle.settlement_price, scores all 5 cards inline,
// computes PnL, distributes the stake. No per-card settle step.
export const txFinalizeDuel = (
  tx: Transaction,
  duelId: string,
  p0Manager: string,
  p1Manager: string,
  oracleId: string,
  coinType: string = '0x2::sui::SUI'
) => {
  if (!CONFIG.flickyPackageId) {
    throw new Error('FLICKY_PACKAGE_ID not configured')
  }
  return tx.moveCall({
    target: `${CONFIG.flickyPackageId}::duel::finalize`,
    typeArguments: [coinType],
    arguments: [
      tx.object(duelId),
      tx.object(p0Manager),
      tx.object(p1Manager),
      tx.object(oracleId),
      tx.object(CONFIG.CLOCK_ID)
    ]
  })
}

// Production multi-oracle finalize: takes 5 oracle ids (one per card in
// `Duel.cards`). All 5 must be Settled on-chain. Validates per-card
// `card[i].oracle_id == oracle_i.id` and uses each oracle's
// settlement_price + expiry for anti-replay.
export const txFinalizeDuelMulti = (
  tx: Transaction,
  duelId: string,
  p0Manager: string,
  p1Manager: string,
  oracleIds: [string, string, string, string, string],
  coinType: string = '0x2::sui::SUI'
) => {
  if (!CONFIG.flickyPackageId) {
    throw new Error('FLICKY_PACKAGE_ID not configured')
  }
  return tx.moveCall({
    target: `${CONFIG.flickyPackageId}::duel::finalize_multi`,
    typeArguments: [coinType],
    arguments: [
      tx.object(duelId),
      tx.object(p0Manager),
      tx.object(p1Manager),
      tx.object(oracleIds[0]),
      tx.object(oracleIds[1]),
      tx.object(oracleIds[2]),
      tx.object(oracleIds[3]),
      tx.object(oracleIds[4]),
      tx.object(CONFIG.CLOCK_ID)
    ]
  })
}

// TEST/DEV ONLY: finalize using a single settled oracle, applied to all 5
// cards regardless of each card's actual oracle_id. Skips anti-replay.
// Useful when waiting for all 5 oracles to settle is impractical.
export const txFinalizeDuelTestOneOracle = (
  tx: Transaction,
  duelId: string,
  oracleId: string,
  coinType: string = '0x2::sui::SUI'
) => {
  if (!CONFIG.flickyPackageId) {
    throw new Error('FLICKY_PACKAGE_ID not configured')
  }
  return tx.moveCall({
    target: `${CONFIG.flickyPackageId}::duel::finalize_test_one_oracle`,
    typeArguments: [coinType],
    arguments: [
      tx.object(duelId),
      tx.object(oracleId),
      tx.object(CONFIG.CLOCK_ID)
    ]
  })
}

export const txFinalizeDuelFree = (
  tx: Transaction,
  duelId: string,
  oracleId: string,
  coinType: string = '0x2::sui::SUI'
) => {
  if (!CONFIG.flickyPackageId) {
    throw new Error('FLICKY_PACKAGE_ID not configured')
  }
  return tx.moveCall({
    target: `${CONFIG.flickyPackageId}::duel::finalize_free`,
    typeArguments: [coinType],
    arguments: [
      tx.object(duelId),
      tx.object(oracleId),
      tx.object(CONFIG.CLOCK_ID)
    ]
  })
}

// ========== Duel: Refund ==========
export const txRefundDuel = (
  tx: Transaction,
  duelId: string,
  coinType: string = '0x2::sui::SUI'
) => {
  if (!CONFIG.flickyPackageId) {
    throw new Error('FLICKY_PACKAGE_ID not configured')
  }
  return tx.moveCall({
    target: `${CONFIG.flickyPackageId}::duel::refund_duel`,
    typeArguments: [coinType],
    arguments: [
      tx.object(duelId),
      tx.object(CONFIG.CLOCK_ID)
    ]
  })
}

// ========== Duel: Claim reveal timeout (challenger forfeit win) ==========
// Callable only by the challenger, 5 minutes after join if the host has not
// revealed the deck. Challenger sweeps both stakes.
export const txClaimRevealTimeout = (
  tx: Transaction,
  duelId: string,
  coinType: string = '0x2::sui::SUI'
) => {
  if (!CONFIG.flickyPackageId) {
    throw new Error('FLICKY_PACKAGE_ID not configured')
  }
  return tx.moveCall({
    target: `${CONFIG.flickyPackageId}::duel::claim_reveal_timeout`,
    typeArguments: [coinType],
    arguments: [
      tx.object(duelId),
      tx.object(CONFIG.CLOCK_ID)
    ]
  })
}

// ========== Duel: Read Status/Fields ==========
export const readDuelStatus = (tx: Transaction, duelId: string, coinType: string = '0x2::sui::SUI') => {
  return tx.moveCall({
    target: `${CONFIG.flickyPackageId}::duel::status`,
    typeArguments: [coinType],
    arguments: [tx.object(duelId)]
  })
}
