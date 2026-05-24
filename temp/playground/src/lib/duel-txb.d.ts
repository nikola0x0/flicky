import { Transaction } from '@mysten/sui/transactions';
export declare const txCreateDuel: (tx: Transaction, stakeCoin: any, deckHash: number[], coinType: string) => import("@mysten/sui/transactions").TransactionResult;
export declare const txJoinDuel: (tx: Transaction, duelId: string, stakeCoin: any, coinType: string) => import("@mysten/sui/transactions").TransactionResult;
export interface DuelCard {
    oracleId: string;
    strike: bigint;
    expiry?: bigint;
}
export declare const txRevealDeck: (tx: Transaction, duelId: string, cards: DuelCard[], coinType: string) => import("@mysten/sui/transactions").TransactionResult;
export declare const txRecordSwipe: (tx: Transaction, duelId: string, managerId: string, oracleId: string, cardIdx: number, isUp: boolean, quantity: bigint, premium: bigint, coinType?: string) => import("@mysten/sui/transactions").TransactionResult;
export declare const txSettleCard: (tx: Transaction, duelId: string, oracleId: string, cardIdx: number, coinType?: string) => import("@mysten/sui/transactions").TransactionResult;
export declare const txFinalizeDuel: (tx: Transaction, duelId: string, coinType?: string) => import("@mysten/sui/transactions").TransactionResult;
export declare const readDuelStatus: (tx: Transaction, duelId: string, coinType?: string) => import("@mysten/sui/transactions").TransactionResult;
