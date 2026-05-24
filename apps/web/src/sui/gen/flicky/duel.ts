/**************************************************************
 * THIS FILE IS GENERATED AND SHOULD NOT BE MANUALLY MODIFIED *
 **************************************************************/


/**
 * Flicky duel: a two-player, five-card prediction match escrowing stakes in a
 * shared object, consuming DeepBook Predict positions for correctness and
 * computing payout.
 * 
 * Lifecycle: `PENDING` (creator staked, waiting for challenger) → `ACTIVE` (both
 * staked, swipes in progress) → `COMPLETE` (all cards settled and stakes paid
 * out).
 */

import { MoveStruct, normalizeMoveArguments, type RawTransactionArgument } from '../utils/index.js';
import { bcs } from '@mysten/sui/bcs';
import { type Transaction, type TransactionArgument } from '@mysten/sui/transactions';
import * as balance from './deps/sui/balance.js';
const $moduleName = 'flicky::duel';
export const Card = new MoveStruct({ name: `${$moduleName}::Card`, fields: {
        oracle_id: bcs.Address,
        strike: bcs.u64()
    } });
export const Swipe = new MoveStruct({ name: `${$moduleName}::Swipe`, fields: {
        is_up: bcs.bool(),
        quantity: bcs.u64(),
        premium: bcs.u64()
    } });
export const Duel = new MoveStruct({ name: `${$moduleName}::Duel<phantom T>`, fields: {
        id: bcs.Address,
        status: bcs.u8(),
        deck_hash: bcs.vector(bcs.u8()),
        cards: bcs.vector(Card),
        creator: bcs.Address,
        challenger: bcs.Address,
        p0_stake: balance.Balance,
        p1_stake: balance.Balance,
        p0_swipes: bcs.vector(bcs.option(Swipe)),
        p1_swipes: bcs.vector(bcs.option(Swipe)),
        p0_payout: bcs.u64(),
        p0_premium: bcs.u64(),
        p1_payout: bcs.u64(),
        p1_premium: bcs.u64(),
        p0_next_card_idx: bcs.u64(),
        p1_next_card_idx: bcs.u64(),
        card_settlements: bcs.vector(bcs.option(bcs.u64())),
        settled_count: bcs.u64(),
        started_at_ms: bcs.u64()
    } });
export const DuelCreated = new MoveStruct({ name: `${$moduleName}::DuelCreated`, fields: {
        duel_id: bcs.Address,
        creator: bcs.Address,
        stake_amount: bcs.u64(),
        deck_hash: bcs.vector(bcs.u8())
    } });
export const DeckRevealed = new MoveStruct({ name: `${$moduleName}::DeckRevealed`, fields: {
        duel_id: bcs.Address
    } });
export const DuelJoined = new MoveStruct({ name: `${$moduleName}::DuelJoined`, fields: {
        duel_id: bcs.Address,
        challenger: bcs.Address,
        stake_amount: bcs.u64(),
        started_at_ms: bcs.u64()
    } });
export const SwipeRecorded = new MoveStruct({ name: `${$moduleName}::SwipeRecorded`, fields: {
        duel_id: bcs.Address,
        player: bcs.Address,
        card_idx: bcs.u64(),
        is_up: bcs.bool(),
        quantity: bcs.u64(),
        premium: bcs.u64()
    } });
export const CardSettled = new MoveStruct({ name: `${$moduleName}::CardSettled`, fields: {
        duel_id: bcs.Address,
        card_idx: bcs.u64(),
        settlement_price: bcs.u64()
    } });
export const DuelFinalized = new MoveStruct({ name: `${$moduleName}::DuelFinalized`, fields: {
        duel_id: bcs.Address,
        winner: bcs.Address,
        payout_to_p0: bcs.u64(),
        payout_to_p1: bcs.u64()
    } });
export interface NewCardArguments {
    oracle: RawTransactionArgument<string>;
    strike: RawTransactionArgument<number | bigint>;
}
export interface NewCardOptions {
    package?: string;
    arguments: NewCardArguments | [
        oracle: RawTransactionArgument<string>,
        strike: RawTransactionArgument<number | bigint>
    ];
}
export function newCard(options: NewCardOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null,
        'u64'
    ] satisfies (string | null)[];
    const parameterNames = ["oracle", "strike"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'duel',
        function: 'new_card',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface CardOracleIdArguments {
    card: TransactionArgument;
}
export interface CardOracleIdOptions {
    package?: string;
    arguments: CardOracleIdArguments | [
        card: TransactionArgument
    ];
}
export function cardOracleId(options: CardOracleIdOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["card"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'duel',
        function: 'card_oracle_id',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface CardStrikeArguments {
    card: TransactionArgument;
}
export interface CardStrikeOptions {
    package?: string;
    arguments: CardStrikeArguments | [
        card: TransactionArgument
    ];
}
export function cardStrike(options: CardStrikeOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["card"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'duel',
        function: 'card_strike',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface CreateDuelArguments {
    stake: RawTransactionArgument<string>;
    deckHash: RawTransactionArgument<Array<number>>;
}
export interface CreateDuelOptions {
    package?: string;
    arguments: CreateDuelArguments | [
        stake: RawTransactionArgument<string>,
        deckHash: RawTransactionArgument<Array<number>>
    ];
    typeArguments: [
        string
    ];
}
export function createDuel(options: CreateDuelOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null,
        'vector<u8>'
    ] satisfies (string | null)[];
    const parameterNames = ["stake", "deckHash"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'duel',
        function: 'create_duel',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
        typeArguments: options.typeArguments
    });
}
export interface RevealDeckArguments {
    duel: RawTransactionArgument<string>;
    cards: TransactionArgument;
}
export interface RevealDeckOptions {
    package?: string;
    arguments: RevealDeckArguments | [
        duel: RawTransactionArgument<string>,
        cards: TransactionArgument
    ];
    typeArguments: [
        string
    ];
}
export function revealDeck(options: RevealDeckOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null,
        'vector<null>'
    ] satisfies (string | null)[];
    const parameterNames = ["duel", "cards"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'duel',
        function: 'reveal_deck',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
        typeArguments: options.typeArguments
    });
}
export interface JoinDuelArguments {
    duel: RawTransactionArgument<string>;
    stake: RawTransactionArgument<string>;
}
export interface JoinDuelOptions {
    package?: string;
    arguments: JoinDuelArguments | [
        duel: RawTransactionArgument<string>,
        stake: RawTransactionArgument<string>
    ];
    typeArguments: [
        string
    ];
}
export function joinDuel(options: JoinDuelOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null,
        null,
        '0x2::clock::Clock'
    ] satisfies (string | null)[];
    const parameterNames = ["duel", "stake"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'duel',
        function: 'join_duel',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
        typeArguments: options.typeArguments
    });
}
export interface RecordSwipeArguments {
    duel: RawTransactionArgument<string>;
    manager: RawTransactionArgument<string>;
    oracle: RawTransactionArgument<string>;
    cardIdx: RawTransactionArgument<number | bigint>;
    isUp: RawTransactionArgument<boolean>;
    quantity: RawTransactionArgument<number | bigint>;
    premium: RawTransactionArgument<number | bigint>;
}
export interface RecordSwipeOptions {
    package?: string;
    arguments: RecordSwipeArguments | [
        duel: RawTransactionArgument<string>,
        manager: RawTransactionArgument<string>,
        oracle: RawTransactionArgument<string>,
        cardIdx: RawTransactionArgument<number | bigint>,
        isUp: RawTransactionArgument<boolean>,
        quantity: RawTransactionArgument<number | bigint>,
        premium: RawTransactionArgument<number | bigint>
    ];
    typeArguments: [
        string
    ];
}
export function recordSwipe(options: RecordSwipeOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null,
        null,
        null,
        'u64',
        'bool',
        'u64',
        'u64',
        '0x2::clock::Clock'
    ] satisfies (string | null)[];
    const parameterNames = ["duel", "manager", "oracle", "cardIdx", "isUp", "quantity", "premium"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'duel',
        function: 'record_swipe',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
        typeArguments: options.typeArguments
    });
}
export interface SettleCardArguments {
    duel: RawTransactionArgument<string>;
    oracle: RawTransactionArgument<string>;
    cardIdx: RawTransactionArgument<number | bigint>;
}
export interface SettleCardOptions {
    package?: string;
    arguments: SettleCardArguments | [
        duel: RawTransactionArgument<string>,
        oracle: RawTransactionArgument<string>,
        cardIdx: RawTransactionArgument<number | bigint>
    ];
    typeArguments: [
        string
    ];
}
export function settleCard(options: SettleCardOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null,
        null,
        'u64'
    ] satisfies (string | null)[];
    const parameterNames = ["duel", "oracle", "cardIdx"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'duel',
        function: 'settle_card',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
        typeArguments: options.typeArguments
    });
}
export interface FinalizeArguments {
    duel: RawTransactionArgument<string>;
}
export interface FinalizeOptions {
    package?: string;
    arguments: FinalizeArguments | [
        duel: RawTransactionArgument<string>
    ];
    typeArguments: [
        string
    ];
}
export function finalize(options: FinalizeOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["duel"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'duel',
        function: 'finalize',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
        typeArguments: options.typeArguments
    });
}
export interface StatusArguments {
    duel: RawTransactionArgument<string>;
}
export interface StatusOptions {
    package?: string;
    arguments: StatusArguments | [
        duel: RawTransactionArgument<string>
    ];
    typeArguments: [
        string
    ];
}
export function status(options: StatusOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["duel"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'duel',
        function: 'status',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
        typeArguments: options.typeArguments
    });
}
export interface IsCompleteArguments {
    duel: RawTransactionArgument<string>;
}
export interface IsCompleteOptions {
    package?: string;
    arguments: IsCompleteArguments | [
        duel: RawTransactionArgument<string>
    ];
    typeArguments: [
        string
    ];
}
export function isComplete(options: IsCompleteOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["duel"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'duel',
        function: 'is_complete',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
        typeArguments: options.typeArguments
    });
}
export interface CreatorArguments {
    duel: RawTransactionArgument<string>;
}
export interface CreatorOptions {
    package?: string;
    arguments: CreatorArguments | [
        duel: RawTransactionArgument<string>
    ];
    typeArguments: [
        string
    ];
}
export function creator(options: CreatorOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["duel"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'duel',
        function: 'creator',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
        typeArguments: options.typeArguments
    });
}
export interface ChallengerArguments {
    duel: RawTransactionArgument<string>;
}
export interface ChallengerOptions {
    package?: string;
    arguments: ChallengerArguments | [
        duel: RawTransactionArgument<string>
    ];
    typeArguments: [
        string
    ];
}
export function challenger(options: ChallengerOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["duel"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'duel',
        function: 'challenger',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
        typeArguments: options.typeArguments
    });
}
export interface StartedAtMsArguments {
    duel: RawTransactionArgument<string>;
}
export interface StartedAtMsOptions {
    package?: string;
    arguments: StartedAtMsArguments | [
        duel: RawTransactionArgument<string>
    ];
    typeArguments: [
        string
    ];
}
export function startedAtMs(options: StartedAtMsOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["duel"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'duel',
        function: 'started_at_ms',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
        typeArguments: options.typeArguments
    });
}
export interface DeckArguments {
    duel: RawTransactionArgument<string>;
}
export interface DeckOptions {
    package?: string;
    arguments: DeckArguments | [
        duel: RawTransactionArgument<string>
    ];
    typeArguments: [
        string
    ];
}
export function deck(options: DeckOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["duel"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'duel',
        function: 'deck',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
        typeArguments: options.typeArguments
    });
}
export interface DeckHashArguments {
    duel: RawTransactionArgument<string>;
}
export interface DeckHashOptions {
    package?: string;
    arguments: DeckHashArguments | [
        duel: RawTransactionArgument<string>
    ];
    typeArguments: [
        string
    ];
}
export function deckHash(options: DeckHashOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["duel"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'duel',
        function: 'deck_hash',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
        typeArguments: options.typeArguments
    });
}
export interface P0PayoutArguments {
    duel: RawTransactionArgument<string>;
}
export interface P0PayoutOptions {
    package?: string;
    arguments: P0PayoutArguments | [
        duel: RawTransactionArgument<string>
    ];
    typeArguments: [
        string
    ];
}
export function p0Payout(options: P0PayoutOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["duel"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'duel',
        function: 'p0_payout',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
        typeArguments: options.typeArguments
    });
}
export interface P0PremiumArguments {
    duel: RawTransactionArgument<string>;
}
export interface P0PremiumOptions {
    package?: string;
    arguments: P0PremiumArguments | [
        duel: RawTransactionArgument<string>
    ];
    typeArguments: [
        string
    ];
}
export function p0Premium(options: P0PremiumOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["duel"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'duel',
        function: 'p0_premium',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
        typeArguments: options.typeArguments
    });
}
export interface P1PayoutArguments {
    duel: RawTransactionArgument<string>;
}
export interface P1PayoutOptions {
    package?: string;
    arguments: P1PayoutArguments | [
        duel: RawTransactionArgument<string>
    ];
    typeArguments: [
        string
    ];
}
export function p1Payout(options: P1PayoutOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["duel"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'duel',
        function: 'p1_payout',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
        typeArguments: options.typeArguments
    });
}
export interface P1PremiumArguments {
    duel: RawTransactionArgument<string>;
}
export interface P1PremiumOptions {
    package?: string;
    arguments: P1PremiumArguments | [
        duel: RawTransactionArgument<string>
    ];
    typeArguments: [
        string
    ];
}
export function p1Premium(options: P1PremiumOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["duel"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'duel',
        function: 'p1_premium',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
        typeArguments: options.typeArguments
    });
}
export interface P0StakeValueArguments {
    duel: RawTransactionArgument<string>;
}
export interface P0StakeValueOptions {
    package?: string;
    arguments: P0StakeValueArguments | [
        duel: RawTransactionArgument<string>
    ];
    typeArguments: [
        string
    ];
}
export function p0StakeValue(options: P0StakeValueOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["duel"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'duel',
        function: 'p0_stake_value',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
        typeArguments: options.typeArguments
    });
}
export interface P1StakeValueArguments {
    duel: RawTransactionArgument<string>;
}
export interface P1StakeValueOptions {
    package?: string;
    arguments: P1StakeValueArguments | [
        duel: RawTransactionArgument<string>
    ];
    typeArguments: [
        string
    ];
}
export function p1StakeValue(options: P1StakeValueOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["duel"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'duel',
        function: 'p1_stake_value',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
        typeArguments: options.typeArguments
    });
}
export interface SettledCountArguments {
    duel: RawTransactionArgument<string>;
}
export interface SettledCountOptions {
    package?: string;
    arguments: SettledCountArguments | [
        duel: RawTransactionArgument<string>
    ];
    typeArguments: [
        string
    ];
}
export function settledCount(options: SettledCountOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["duel"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'duel',
        function: 'settled_count',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
        typeArguments: options.typeArguments
    });
}
export interface P0NextCardIdxArguments {
    duel: RawTransactionArgument<string>;
}
export interface P0NextCardIdxOptions {
    package?: string;
    arguments: P0NextCardIdxArguments | [
        duel: RawTransactionArgument<string>
    ];
    typeArguments: [
        string
    ];
}
export function p0NextCardIdx(options: P0NextCardIdxOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["duel"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'duel',
        function: 'p0_next_card_idx',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
        typeArguments: options.typeArguments
    });
}
export interface P1NextCardIdxArguments {
    duel: RawTransactionArgument<string>;
}
export interface P1NextCardIdxOptions {
    package?: string;
    arguments: P1NextCardIdxArguments | [
        duel: RawTransactionArgument<string>
    ];
    typeArguments: [
        string
    ];
}
export function p1NextCardIdx(options: P1NextCardIdxOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["duel"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'duel',
        function: 'p1_next_card_idx',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
        typeArguments: options.typeArguments
    });
}
export interface StatusPendingOptions {
    package?: string;
    arguments?: [
    ];
}
export function statusPending(options: StatusPendingOptions = {}) {
    const packageAddress = options.package ?? 'flicky';
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'duel',
        function: 'status_pending',
    });
}
export interface StatusActiveOptions {
    package?: string;
    arguments?: [
    ];
}
export function statusActive(options: StatusActiveOptions = {}) {
    const packageAddress = options.package ?? 'flicky';
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'duel',
        function: 'status_active',
    });
}
export interface StatusCompleteOptions {
    package?: string;
    arguments?: [
    ];
}
export function statusComplete(options: StatusCompleteOptions = {}) {
    const packageAddress = options.package ?? 'flicky';
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'duel',
        function: 'status_complete',
    });
}
export interface DeckSizeOptions {
    package?: string;
    arguments?: [
    ];
}
export function deckSize(options: DeckSizeOptions = {}) {
    const packageAddress = options.package ?? 'flicky';
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'duel',
        function: 'deck_size',
    });
}
export interface DummyDepsArguments {
    Deep: TransactionArgument;
}
export interface DummyDepsOptions {
    package?: string;
    arguments: DummyDepsArguments | [
        Deep: TransactionArgument
    ];
}
export function dummyDeps(options: DummyDepsOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["Deep"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'duel',
        function: 'dummy_deps',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}