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

  // Construct each Card struct using flicky::duel::new_card
  const cardObjects = cards.map(card => {
    return tx.moveCall({
      target: `${CONFIG.flickyPackageId}::duel::new_card`,
      arguments: [
        tx.object(card.oracleId),
        tx.pure.u64(card.strike)
      ]
    })
  })

  // Bundle card objects into a vector<Card>
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
export const txRecordSwipe = (
  tx: Transaction,
  duelId: string,
  managerId: string,
  oracleId: string,
  cardIdx: number,
  isUp: boolean,
  quantity: bigint,
  premium: bigint,
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
      tx.object(oracleId),
      tx.pure.u64(BigInt(cardIdx)),
      tx.pure.bool(isUp),
      tx.pure.u64(quantity),
      tx.pure.u64(premium),
      tx.object(CONFIG.CLOCK_ID)
    ]
  })
}

// ========== Duel: Settle Card ==========
export const txSettleCard = (
  tx: Transaction,
  duelId: string,
  oracleId: string,
  cardIdx: number,
  coinType: string = '0x2::sui::SUI'
) => {
  if (!CONFIG.flickyPackageId) {
    throw new Error('FLICKY_PACKAGE_ID not configured')
  }

  return tx.moveCall({
    target: `${CONFIG.flickyPackageId}::duel::settle_card`,
    typeArguments: [coinType],
    arguments: [
      tx.object(duelId),
      tx.object(oracleId),
      tx.pure.u64(BigInt(cardIdx))
    ]
  })
}

// ========== Duel: Finalize ==========
export const txFinalizeDuel = (
  tx: Transaction,
  duelId: string,
  coinType: string = '0x2::sui::SUI'
) => {
  if (!CONFIG.flickyPackageId) {
    throw new Error('FLICKY_PACKAGE_ID not configured')
  }

  return tx.moveCall({
    target: `${CONFIG.flickyPackageId}::duel::finalize`,
    typeArguments: [coinType],
    arguments: [
      tx.object(duelId)
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
