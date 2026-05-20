/**************************************************************
 * THIS FILE IS GENERATED AND SHOULD NOT BE MANUALLY MODIFIED *
 **************************************************************/


/**
 * Flicky duel: a two-player, five-card prediction match escrowing stakes in a
 * shared object, consuming DeepBook Predict's `OracleSVI` per card for `p_swiped`
 * snapshots and terminal correctness.
 * 
 * Lifecycle: `PENDING` (creator staked, waiting for challenger) → `ACTIVE` (both
 * staked, swipes in progress) → `COMPLETE` (all cards settled and stakes paid
 * out).
 * 
 * Per the README/PRD spec:
 * 
 * - Each card references one `OracleSVI` + one strike on its grid.
 * - Swipes are strictly sequential per player; each swipe snapshots the implied
 *   probability of the chosen direction (`p_swiped`) at the moment of the swipe —
 *   this is what scoring rewards.
 * - Card score = `correct ? (1 / p_swiped) * speed_multiplier : 0`, with per-card
 *   decide-time measured from the previous swipe (or duel start for card 0).
 * 
 * Out of POC scope (follow-ups):
 * 
 * - Commit-reveal deck hashing (cards currently visible at creation).
 * - DeepBook `predict::mint` calls in the same PTB as `record_swipe`.
 * - Forfeit-on-timeout for slow players.
 * - Strike-grid validation in `new_card`: DeepBook's tick metadata lives in
 *   `Predict<Quote>.oracle_config`, not on the oracle itself. Off-grid strikes are
 *   rejected at `predict::mint` time when the player's swipe PTB bundles the mint
 *   call.
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
        /** Implied probability of the chosen direction at the moment of swipe. */
        p_swiped: bcs.u64(),
        /**
         * Time spent on this card, in ms, since the previous swipe (or duel start for card
         * 0). Drives the speed multiplier.
         */
        decide_time_ms: bcs.u64()
    } });
export const Duel = new MoveStruct({ name: `${$moduleName}::Duel<phantom T>`, fields: {
        id: bcs.Address,
        status: bcs.u8(),
        /**
         * sha2-256 of `bcs::to_bytes(&cards)` committed at create time. Cards stay empty
         * until `reveal_deck` is called with the plaintext.
         */
        deck_hash: bcs.vector(bcs.u8()),
        cards: bcs.vector(Card),
        creator: bcs.Address,
        /** `@0x0` until a challenger joins. */
        challenger: bcs.Address,
        p0_stake: balance.Balance,
        p1_stake: balance.Balance,
        p0_swipes: bcs.vector(bcs.option(Swipe)),
        p1_swipes: bcs.vector(bcs.option(Swipe)),
        /** Accumulated scores in 9-decimal fixed point. */
        p0_score: bcs.u64(),
        p1_score: bcs.u64(),
        /**
         * Clock checkpoint per player: the start time for the next swipe's
         * `decide_time_ms`. Set to `started_at_ms` on join, advanced on each swipe.
         */
        p0_last_swipe_or_start_ms: bcs.u64(),
        p1_last_swipe_or_start_ms: bcs.u64(),
        /** Next card index each player must swipe (must be strictly sequential). */
        p0_next_card_idx: bcs.u64(),
        p1_next_card_idx: bcs.u64(),
        /**
         * Per-card terminal price, populated by `settle_card` when the oracle for that
         * card has settled.
         */
        card_settlements: bcs.vector(bcs.option(bcs.u64())),
        /** Count of cards whose `card_settlements[i]` is `Some`. */
        settled_count: bcs.u64(),
        /** On-chain timestamp when `join_duel` landed; `0` while PENDING. */
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
        p_swiped: bcs.u64(),
        decide_time_ms: bcs.u64()
    } });
export const CardSettled = new MoveStruct({ name: `${$moduleName}::CardSettled`, fields: {
        duel_id: bcs.Address,
        card_idx: bcs.u64(),
        settlement_price: bcs.u64(),
        p0_card_score: bcs.u64(),
        p1_card_score: bcs.u64()
    } });
export const DuelFinalized = new MoveStruct({ name: `${$moduleName}::DuelFinalized`, fields: {
        duel_id: bcs.Address,
        p0_score: bcs.u64(),
        p1_score: bcs.u64(),
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
/**
 * Build a `Card` referencing this oracle + strike. Strike-grid validation happens
 * at `predict::mint` time in the player's swipe PTB; we accept any strike here.
 */
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
/**
 * Creator stakes and commits the deck's hash. Cards are revealed later via
 * `reveal_deck`. Returns the new shared duel ID.
 *
 * The `deck_hash` is `sha2_256(bcs::to_bytes(&cards))` computed off-chain by the
 * Deckmaster. Committing the hash before the challenger joins prevents
 * front-running with parallel Predict positions.
 */
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
/**
 * Reveal the committed deck. Permissionless — anyone with the plaintext can call.
 * Verifies `sha2_256(bcs::to_bytes(&cards)) == duel.deck_hash` and populates
 * `duel.cards`. Must run after `join_duel` (duel.status == ACTIVE) and before any
 * `record_swipe`.
 */
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
/**
 * Challenger matches the creator's stake and starts the match. Both decks become
 * "revealed" at this moment — per-player decide-time clocks start.
 */
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
    oracle: RawTransactionArgument<string>;
    cardIdx: RawTransactionArgument<number | bigint>;
    isUp: RawTransactionArgument<boolean>;
}
export interface RecordSwipeOptions {
    package?: string;
    arguments: RecordSwipeArguments | [
        duel: RawTransactionArgument<string>,
        oracle: RawTransactionArgument<string>,
        cardIdx: RawTransactionArgument<number | bigint>,
        isUp: RawTransactionArgument<boolean>
    ];
    typeArguments: [
        string
    ];
}
/**
 * Player records a swipe on the next card in their sequence. Must be the creator
 * or challenger; the supplied `oracle` must match `cards[card_idx]`. Snapshots the
 * implied probability of the chosen direction (UP or DOWN) from DeepBook's SVI
 * surface.
 */
export function recordSwipe(options: RecordSwipeOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null,
        null,
        'u64',
        'bool',
        '0x2::clock::Clock'
    ] satisfies (string | null)[];
    const parameterNames = ["duel", "oracle", "cardIdx", "isUp"];
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
/**
 * Permissionless. Settles one card once its oracle has reached SETTLED, computing
 * both players' scores for that card.
 */
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
/**
 * Permissionless once all cards are settled.
 *
 * Payout rules (PRD §Payout):
 *
 * - Higher score wins the entire pot.
 * - Tie on score → lower total decide-time wins.
 * - Still tied → each player gets their own stake back.
 */
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
export interface P0ScoreArguments {
    duel: RawTransactionArgument<string>;
}
export interface P0ScoreOptions {
    package?: string;
    arguments: P0ScoreArguments | [
        duel: RawTransactionArgument<string>
    ];
    typeArguments: [
        string
    ];
}
export function p0Score(options: P0ScoreOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["duel"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'duel',
        function: 'p0_score',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
        typeArguments: options.typeArguments
    });
}
export interface P1ScoreArguments {
    duel: RawTransactionArgument<string>;
}
export interface P1ScoreOptions {
    package?: string;
    arguments: P1ScoreArguments | [
        duel: RawTransactionArgument<string>
    ];
    typeArguments: [
        string
    ];
}
export function p1Score(options: P1ScoreOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["duel"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'duel',
        function: 'p1_score',
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