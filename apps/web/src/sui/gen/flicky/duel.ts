/**************************************************************
 * THIS FILE IS GENERATED AND SHOULD NOT BE MANUALLY MODIFIED *
 **************************************************************/


/**
 * Flicky duel: a two-player, five-card prediction match escrowing stakes in a
 * shared object, consuming DeepBook Predict positions for correctness and
 * computing payout.
 * 
 * Lifecycle: `PENDING` (creator staked, waiting for challenger) → `ACTIVE` (both
 * staked, swipes in progress) → `COMPLETE` (finalized or refunded).
 * 
 * Finalization is one-shot: after both players complete their swipes and the
 * oracle settles, anyone (typically the server admin) calls `finalize`, which
 * reads the supplied oracle's settlement_price, scores all 5 cards inline,
 * compares PnL, and distributes the stake. The `DuelFinalized` event carries the
 * oracle id + settlement_price as on-chain proof of the computation.
 * 
 * Tiers: `STAKED` — players mint Predict positions; `record_swipe` enforces
 * `manager.owner() == sender` and anti-replay vs PredictManager. `FREE` — same
 * engine, no Predict mint, no dUSDC stake. Same Duel object, same scoring math,
 * just gated money flow.
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
        premium: bcs.u64(),
        /**
         * Probability of the swiped direction, snapshotted from the oracle SVI surface
         * inside the swipe PTB. Scaled by `PROB_SCALE` (1e9).
         */
        p_swiped: bcs.u64()
    } });
export const Duel = new MoveStruct({ name: `${$moduleName}::Duel<phantom T>`, fields: {
        id: bcs.Address,
        status: bcs.u8(),
        tier: bcs.u8(),
        deck_hash: bcs.vector(bcs.u8()),
        cards: bcs.vector(Card),
        creator: bcs.Address,
        challenger: bcs.Address,
        p0_stake: balance.Balance,
        p1_stake: balance.Balance,
        p0_swipes: bcs.vector(bcs.option(Swipe)),
        p1_swipes: bcs.vector(bcs.option(Swipe)),
        /** Aggregated PnL fields written by `finalize`. Zero until then. */
        p0_payout: bcs.u64(),
        p0_premium: bcs.u64(),
        p1_payout: bcs.u64(),
        p1_premium: bcs.u64(),
        p0_next_card_idx: bcs.u64(),
        p1_next_card_idx: bcs.u64(),
        started_at_ms: bcs.u64()
    } });
export const DuelCreated = new MoveStruct({ name: `${$moduleName}::DuelCreated`, fields: {
        duel_id: bcs.Address,
        creator: bcs.Address,
        stake_amount: bcs.u64(),
        deck_hash: bcs.vector(bcs.u8()),
        tier: bcs.u8()
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
        premium: bcs.u64(),
        p_swiped: bcs.u64()
    } });
export const DuelFinalized = new MoveStruct({ name: `${$moduleName}::DuelFinalized`, fields: {
        duel_id: bcs.Address,
        winner: bcs.Address,
        payout_to_p0: bcs.u64(),
        payout_to_p1: bcs.u64(),
        p0_payout_total: bcs.u64(),
        p0_premium_total: bcs.u64(),
        p1_payout_total: bcs.u64(),
        p1_premium_total: bcs.u64(),
        oracle_id: bcs.Address,
        settlement_price: bcs.u64()
    } });
export const DuelRefunded = new MoveStruct({ name: `${$moduleName}::DuelRefunded`, fields: {
        duel_id: bcs.Address,
        refunded_to_p0: bcs.u64(),
        refunded_to_p1: bcs.u64()
    } });
export const DuelForfeited = new MoveStruct({ name: `${$moduleName}::DuelForfeited`, fields: {
        duel_id: bcs.Address,
        winner: bcs.Address,
        payout: bcs.u64(),
        /** 1 = reveal timeout (host did not reveal deck in time). */
        reason: bcs.u8()
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
export interface CreateDuelFreeArguments {
    deckHash: RawTransactionArgument<Array<number>>;
}
export interface CreateDuelFreeOptions {
    package?: string;
    arguments: CreateDuelFreeArguments | [
        deckHash: RawTransactionArgument<Array<number>>
    ];
    typeArguments: [
        string
    ];
}
/** Free / Social tier: no Predict mint, no dUSDC escrow. Same engine. */
export function createDuelFree(options: CreateDuelFreeOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        'vector<u8>'
    ] satisfies (string | null)[];
    const parameterNames = ["deckHash"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'duel',
        function: 'create_duel_free',
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
export interface JoinDuelFreeArguments {
    duel: RawTransactionArgument<string>;
}
export interface JoinDuelFreeOptions {
    package?: string;
    arguments: JoinDuelFreeArguments | [
        duel: RawTransactionArgument<string>
    ];
    typeArguments: [
        string
    ];
}
export function joinDuelFree(options: JoinDuelFreeOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null,
        '0x2::clock::Clock'
    ] satisfies (string | null)[];
    const parameterNames = ["duel"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'duel',
        function: 'join_duel_free',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
        typeArguments: options.typeArguments
    });
}
export interface RecordSwipeArguments {
    duel: RawTransactionArgument<string>;
    manager: RawTransactionArgument<string>;
    predict: RawTransactionArgument<string>;
    oracle: RawTransactionArgument<string>;
    cardIdx: RawTransactionArgument<number | bigint>;
    isUp: RawTransactionArgument<boolean>;
    quantity: RawTransactionArgument<number | bigint>;
}
export interface RecordSwipeOptions {
    package?: string;
    arguments: RecordSwipeArguments | [
        duel: RawTransactionArgument<string>,
        manager: RawTransactionArgument<string>,
        predict: RawTransactionArgument<string>,
        oracle: RawTransactionArgument<string>,
        cardIdx: RawTransactionArgument<number | bigint>,
        isUp: RawTransactionArgument<boolean>,
        quantity: RawTransactionArgument<number | bigint>
    ];
    typeArguments: [
        string
    ];
}
/**
 * Record a player's swipe on `card_idx`. Snapshots `premium` and `p_swiped` from
 * `predict::get_trade_amounts` inside the PTB — caller cannot supply these.
 * Premium is the dUSDC cost the player would pay to mint the `quantity` Predict
 * position at the current SVI price.
 */
export function recordSwipe(options: RecordSwipeOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null,
        null,
        null,
        null,
        'u64',
        'bool',
        'u64',
        '0x2::clock::Clock'
    ] satisfies (string | null)[];
    const parameterNames = ["duel", "manager", "predict", "oracle", "cardIdx", "isUp", "quantity"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'duel',
        function: 'record_swipe',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
        typeArguments: options.typeArguments
    });
}
export interface RecordSwipeFreeArguments {
    duel: RawTransactionArgument<string>;
    predict: RawTransactionArgument<string>;
    oracle: RawTransactionArgument<string>;
    cardIdx: RawTransactionArgument<number | bigint>;
    isUp: RawTransactionArgument<boolean>;
}
export interface RecordSwipeFreeOptions {
    package?: string;
    arguments: RecordSwipeFreeArguments | [
        duel: RawTransactionArgument<string>,
        predict: RawTransactionArgument<string>,
        oracle: RawTransactionArgument<string>,
        cardIdx: RawTransactionArgument<number | bigint>,
        isUp: RawTransactionArgument<boolean>
    ];
    typeArguments: [
        string
    ];
}
/**
 * Free-tier swipe — no PredictManager, no anti-replay. Premium and `p_swiped`
 * still come from real Predict pricing via `predict::get_trade_amounts` so scoring
 * stays consistent with Staked tier. Uses normalized quantity = `PROB_SCALE`.
 */
export function recordSwipeFree(options: RecordSwipeFreeOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null,
        null,
        null,
        'u64',
        'bool',
        '0x2::clock::Clock'
    ] satisfies (string | null)[];
    const parameterNames = ["duel", "predict", "oracle", "cardIdx", "isUp"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'duel',
        function: 'record_swipe_free',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
        typeArguments: options.typeArguments
    });
}
export interface FinalizeArguments {
    duel: RawTransactionArgument<string>;
    p0Manager: RawTransactionArgument<string>;
    p1Manager: RawTransactionArgument<string>;
    oracle: RawTransactionArgument<string>;
}
export interface FinalizeOptions {
    package?: string;
    arguments: FinalizeArguments | [
        duel: RawTransactionArgument<string>,
        p0Manager: RawTransactionArgument<string>,
        p1Manager: RawTransactionArgument<string>,
        oracle: RawTransactionArgument<string>
    ];
    typeArguments: [
        string
    ];
}
/**
 * One-shot finalize for Staked tier. Reads the supplied oracle's settlement_price,
 * scores all 5 cards inline, compares PnL, and distributes the stake. All 5 cards
 * in the deck must reference `oracle.id`. Permissionless — the oracle read makes
 * the result deterministic, so the caller (typically the server admin) cannot
 * influence the outcome.
 */
export function finalize(options: FinalizeOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null,
        null,
        null,
        null,
        '0x2::clock::Clock'
    ] satisfies (string | null)[];
    const parameterNames = ["duel", "p0Manager", "p1Manager", "oracle"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'duel',
        function: 'finalize',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
        typeArguments: options.typeArguments
    });
}
export interface FinalizeMultiArguments {
    duel: RawTransactionArgument<string>;
    p0Manager: RawTransactionArgument<string>;
    p1Manager: RawTransactionArgument<string>;
    oracle_0: RawTransactionArgument<string>;
    oracle_1: RawTransactionArgument<string>;
    oracle_2: RawTransactionArgument<string>;
    oracle_3: RawTransactionArgument<string>;
    oracle_4: RawTransactionArgument<string>;
}
export interface FinalizeMultiOptions {
    package?: string;
    arguments: FinalizeMultiArguments | [
        duel: RawTransactionArgument<string>,
        p0Manager: RawTransactionArgument<string>,
        p1Manager: RawTransactionArgument<string>,
        oracle_0: RawTransactionArgument<string>,
        oracle_1: RawTransactionArgument<string>,
        oracle_2: RawTransactionArgument<string>,
        oracle_3: RawTransactionArgument<string>,
        oracle_4: RawTransactionArgument<string>
    ];
    typeArguments: [
        string
    ];
}
/**
 * Production multi-oracle finalize: each card uses its own oracle. Validates
 * `card[i].oracle_id == oracle_i.id`, reads each oracle's `settlement_price`, and
 * computes anti-replay using each card's expiry. Use this when the deck has 5
 * different oracles. All 5 must be settled.
 */
export function finalizeMulti(options: FinalizeMultiOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        '0x2::clock::Clock'
    ] satisfies (string | null)[];
    const parameterNames = ["duel", "p0Manager", "p1Manager", "oracle_0", "oracle_1", "oracle_2", "oracle_3", "oracle_4"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'duel',
        function: 'finalize_multi',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
        typeArguments: options.typeArguments
    });
}
export interface FinalizeTestOneOracleArguments {
    duel: RawTransactionArgument<string>;
    oracle: RawTransactionArgument<string>;
}
export interface FinalizeTestOneOracleOptions {
    package?: string;
    arguments: FinalizeTestOneOracleArguments | [
        duel: RawTransactionArgument<string>,
        oracle: RawTransactionArgument<string>
    ];
    typeArguments: [
        string
    ];
}
/**
 * **TEST/DEV ONLY** — finalize using a single oracle's price applied to ALL 5
 * cards regardless of each card's actual `oracle_id`. Uses `settlement_price` if
 * the oracle has settled; otherwise falls back to `spot_price` (current SVI
 * underlying) so devs can finalize without waiting for any oracle to settle. Skips
 * anti-replay (no `PredictManager` check). PnL is approximate — never use this on
 * mainnet.
 */
export function finalizeTestOneOracle(options: FinalizeTestOneOracleOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null,
        null,
        '0x2::clock::Clock'
    ] satisfies (string | null)[];
    const parameterNames = ["duel", "oracle"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'duel',
        function: 'finalize_test_one_oracle',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
        typeArguments: options.typeArguments
    });
}
export interface FinalizeFreeArguments {
    duel: RawTransactionArgument<string>;
    oracle: RawTransactionArgument<string>;
}
export interface FinalizeFreeOptions {
    package?: string;
    arguments: FinalizeFreeArguments | [
        duel: RawTransactionArgument<string>,
        oracle: RawTransactionArgument<string>
    ];
    typeArguments: [
        string
    ];
}
/** Free-tier counterpart to `finalize`. No managers, no anti-replay. */
export function finalizeFree(options: FinalizeFreeOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null,
        null,
        '0x2::clock::Clock'
    ] satisfies (string | null)[];
    const parameterNames = ["duel", "oracle"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'duel',
        function: 'finalize_free',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
        typeArguments: options.typeArguments
    });
}
export interface RefundDuelArguments {
    duel: RawTransactionArgument<string>;
}
export interface RefundDuelOptions {
    package?: string;
    arguments: RefundDuelArguments | [
        duel: RawTransactionArgument<string>
    ];
    typeArguments: [
        string
    ];
}
/**
 * Refund stakes when a duel is stuck. Two paths:
 *
 * - `STATUS_PENDING` — creator can cancel before anyone joins.
 * - `STATUS_ACTIVE` — either player after 1h, only if at least one player has not
 *   completed all 5 swipes. Once both complete, `finalize` is the only path
 *   (anyone can call it, so a losing player cannot dodge).
 */
export function refundDuel(options: RefundDuelOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null,
        '0x2::clock::Clock'
    ] satisfies (string | null)[];
    const parameterNames = ["duel"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'duel',
        function: 'refund_duel',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
        typeArguments: options.typeArguments
    });
}
export interface ClaimRevealTimeoutArguments {
    duel: RawTransactionArgument<string>;
}
export interface ClaimRevealTimeoutOptions {
    package?: string;
    arguments: ClaimRevealTimeoutArguments | [
        duel: RawTransactionArgument<string>
    ];
    typeArguments: [
        string
    ];
}
/**
 * Challenger-only forfeit when the host never reveals the deck. After the
 * challenger has joined and 5 minutes pass without `reveal_deck` being called, the
 * challenger can sweep the entire pot. Discourages a host from griefing by
 * withholding the deck. Works for both tiers (Free tier has zero stake so the
 * "win" is symbolic).
 */
export function claimRevealTimeout(options: ClaimRevealTimeoutOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null,
        '0x2::clock::Clock'
    ] satisfies (string | null)[];
    const parameterNames = ["duel"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'duel',
        function: 'claim_reveal_timeout',
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
export interface TierArguments {
    duel: RawTransactionArgument<string>;
}
export interface TierOptions {
    package?: string;
    arguments: TierArguments | [
        duel: RawTransactionArgument<string>
    ];
    typeArguments: [
        string
    ];
}
export function tier(options: TierOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["duel"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'duel',
        function: 'tier',
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
export interface TierStakedOptions {
    package?: string;
    arguments?: [
    ];
}
export function tierStaked(options: TierStakedOptions = {}) {
    const packageAddress = options.package ?? 'flicky';
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'duel',
        function: 'tier_staked',
    });
}
export interface TierFreeOptions {
    package?: string;
    arguments?: [
    ];
}
export function tierFree(options: TierFreeOptions = {}) {
    const packageAddress = options.package ?? 'flicky';
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'duel',
        function: 'tier_free',
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
export interface ProbScaleOptions {
    package?: string;
    arguments?: [
    ];
}
export function probScale(options: ProbScaleOptions = {}) {
    const packageAddress = options.package ?? 'flicky';
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'duel',
        function: 'prob_scale',
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