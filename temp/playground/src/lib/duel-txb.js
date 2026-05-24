import { CONFIG } from '../config';
// ========== Duel: Create Duel ==========
export const txCreateDuel = (tx, stakeCoin, deckHash, coinType) => {
    if (!CONFIG.flickyPackageId) {
        throw new Error('FLICKY_PACKAGE_ID not configured');
    }
    return tx.moveCall({
        target: `${CONFIG.flickyPackageId}::duel::create_duel`,
        typeArguments: [coinType],
        arguments: [
            stakeCoin,
            tx.pure.vector('u8', deckHash),
        ],
    });
};
// ========== Duel: Join Duel ==========
export const txJoinDuel = (tx, duelId, stakeCoin, coinType) => {
    if (!CONFIG.flickyPackageId) {
        throw new Error('FLICKY_PACKAGE_ID not configured');
    }
    return tx.moveCall({
        target: `${CONFIG.flickyPackageId}::duel::join_duel`,
        typeArguments: [coinType],
        arguments: [
            tx.object(duelId),
            stakeCoin,
            tx.object(CONFIG.CLOCK_ID),
        ],
    });
};
export const txRevealDeck = (tx, duelId, cards, coinType) => {
    if (!CONFIG.flickyPackageId) {
        throw new Error('FLICKY_PACKAGE_ID not configured');
    }
    // Construct each Card struct using flicky::duel::new_card
    const cardObjects = cards.map(card => {
        return tx.moveCall({
            target: `${CONFIG.flickyPackageId}::duel::new_card`,
            arguments: [
                tx.object(card.oracleId),
                tx.pure.u64(card.strike)
            ]
        });
    });
    // Bundle card objects into a vector<Card>
    const cardsVec = tx.makeMoveVec({
        type: `${CONFIG.flickyPackageId}::duel::Card`,
        elements: cardObjects
    });
    return tx.moveCall({
        target: `${CONFIG.flickyPackageId}::duel::reveal_deck`,
        typeArguments: [coinType],
        arguments: [
            tx.object(duelId),
            cardsVec
        ],
    });
};
// ========== Duel: Record Swipe ==========
export const txRecordSwipe = (tx, duelId, managerId, oracleId, cardIdx, isUp, quantity, premium, coinType = '0x2::sui::SUI') => {
    if (!CONFIG.flickyPackageId) {
        throw new Error('FLICKY_PACKAGE_ID not configured');
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
    });
};
// ========== Duel: Settle Card ==========
export const txSettleCard = (tx, duelId, oracleId, cardIdx, coinType = '0x2::sui::SUI') => {
    if (!CONFIG.flickyPackageId) {
        throw new Error('FLICKY_PACKAGE_ID not configured');
    }
    return tx.moveCall({
        target: `${CONFIG.flickyPackageId}::duel::settle_card`,
        typeArguments: [coinType],
        arguments: [
            tx.object(duelId),
            tx.object(oracleId),
            tx.pure.u64(BigInt(cardIdx))
        ]
    });
};
// ========== Duel: Finalize ==========
export const txFinalizeDuel = (tx, duelId, coinType = '0x2::sui::SUI') => {
    if (!CONFIG.flickyPackageId) {
        throw new Error('FLICKY_PACKAGE_ID not configured');
    }
    return tx.moveCall({
        target: `${CONFIG.flickyPackageId}::duel::finalize`,
        typeArguments: [coinType],
        arguments: [
            tx.object(duelId)
        ]
    });
};
// ========== Duel: Read Status/Fields ==========
export const readDuelStatus = (tx, duelId, coinType = '0x2::sui::SUI') => {
    return tx.moveCall({
        target: `${CONFIG.flickyPackageId}::duel::status`,
        typeArguments: [coinType],
        arguments: [tx.object(duelId)]
    });
};
//# sourceMappingURL=duel-txb.js.map