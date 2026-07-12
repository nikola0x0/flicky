/**************************************************************
 * THIS FILE IS GENERATED AND SHOULD NOT BE MANUALLY MODIFIED *
 **************************************************************/


/**
 * Flicky duel: a two-player, N-card prediction match escrowing stakes in a shared
 * object, scoring swipes against DeepBook Predict (6-24) expiry-market outcomes.
 * Each card pins its OWN `ExpiryMarket` (via `expiry_market_id` + `strike`), so a
 * deck of 5 cards can span 5 different expiry markets / strikes.
 * 
 * Lifecycle: `PENDING` (creator staked, waiting for challenger) → `ACTIVE` (both
 * staked, swipes in progress, then per-card settle) → `COMPLETE` (finalized or
 * refunded).
 * 
 * Finalization is two-phase:
 * 
 * 1.  `settle_card(card_idx, settlement_price, p0_premium, p1_premium)` ×
 *     `deck_size` — once a card's expiry market has settled off-chain, a keeper
 *     feeds the settlement price and per-player premium (6-24 exposes no public
 *     on-chain read for either) and anyone calls this to score both players'
 *     swipes for that card and accumulate the per-card payout/premium onto the
 *     Duel. Each call emits a `CardSettled` event with the proof
 *     (expiry_market_id + settlement_price).
 * 2.  `finalize(duel)` — verifies all cards are settled (or the forfeit/refund
 *     branches apply), compares aggregate PnL, and pays the pot.
 * 
 * Why two-phase: each card pins a different expiry market that settles on its own
 * clock, and settlement data is keeper-fed one card at a time, so we settle one
 * card at a time and accumulate state on the Duel itself. Bonus: a slow settlement
 * doesn't block the others, and a failed settle for one card doesn't roll back the
 * rest.
 * 
 * Tiers: `STAKED` — players mint 6-24 `ExpiryMarket` positions off-chain via
 * `expiry_market::mint_exact_quantity`, chained into `record_swipe` in the same
 * player-signed PTB; only the resulting `order_id` is recorded on-chain.
 * Anti-replay is enforced at settle time (`predict_account::has_position`), not at
 * swipe time. `FREE` — same engine, no Predict mint, no dUSDC stake. Same Duel
 * object, same scoring math, just gated money flow.
 */

import { MoveStruct, normalizeMoveArguments, type RawTransactionArgument } from '../utils/index.js';
import { bcs } from '@mysten/sui/bcs';
import { type Transaction, type TransactionArgument } from '@mysten/sui/transactions';
import * as balance from './deps/sui/balance.js';
const $moduleName = 'flicky::duel';
export const Card = new MoveStruct({ name: `${$moduleName}::Card`, fields: {
        /**
           * The 6-24 `ExpiryMarket` this card is bet on. Passed in at reveal (committed via
           * the deck hash), used for settle-time anti-replay.
           */
        expiry_market_id: bcs.Address,
        /** Raw strike price (`tick * tick_size`). `actual_up = settlement_price > strike`. */
        strike: bcs.u64()
    } });
export const Swipe = new MoveStruct({ name: `${$moduleName}::Swipe`, fields: {
        is_up: bcs.bool(),
        quantity: bcs.u64(),
        /**
         * The `order_id` returned by `expiry_market::mint_exact_quantity`, chained from
         * the mint command in the same player-signed PTB. Used at settle time for
         * anti-replay via `predict_account::has_position`. `0` for free-tier swipes (no
         * mint).
         */
        order_id: bcs.u256()
    } });
export const Duel = new MoveStruct({ name: `${$moduleName}::Duel<phantom T>`, fields: {
        id: bcs.Address,
        status: bcs.u8(),
        tier: bcs.u8(),
        /**
         * Number of cards in this duel. Chosen at create-time, bounded by
         * [`MIN_DECK_SIZE`, `MAX_DECK_SIZE`]. Each card pins its OWN expiry market — see
         * `Card.expiry_market_id`. A 5-card duel can span 5 different expiry markets.
         */
        deck_size: bcs.u64(),
        deck_hash: bcs.vector(bcs.u8()),
        cards: bcs.vector(Card),
        creator: bcs.Address,
        challenger: bcs.Address,
        p0_stake: balance.Balance,
        p1_stake: balance.Balance,
        p0_swipes: bcs.vector(bcs.option(Swipe)),
        p1_swipes: bcs.vector(bcs.option(Swipe)),
        /**
         * Per-card settlement state. All three vectors / counter have length `deck_size`
         * after `create_duel_internal`. `cards_settled[i]` flips to true after
         * `settle_card(i)` lands; once all true (or the forfeit/refund branches apply),
         * `finalize` distributes the pot.
         */
        cards_settled: bcs.vector(bcs.bool()),
        /**
         * Per-card settlement-price snapshot — written by `settle_card` so off-chain
         * consumers can recompute scoring without re-reading the oracle. 0 = unsettled.
         */
        card_settlement_prices: bcs.vector(bcs.u64()),
        settled_count: bcs.u64(),
        /**
         * Aggregated PnL fields incremented per `settle_card` call. Sum across cards
         * already settled; read by `finalize` to pick the winner.
         */
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
        tier: bcs.u8(),
        deck_size: bcs.u64()
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
        order_id: bcs.u256()
    } });
export const CardSettled = new MoveStruct({ name: `${$moduleName}::CardSettled`, fields: {
        duel_id: bcs.Address,
        card_idx: bcs.u64(),
        expiry_market_id: bcs.Address,
        settlement_price: bcs.u64(),
        actual_up: bcs.bool(),
        p0_payout: bcs.u64(),
        p0_premium: bcs.u64(),
        p1_payout: bcs.u64(),
        p1_premium: bcs.u64()
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
        primary_expiry_market_id: bcs.Address,
        primary_settlement_price: bcs.u64()
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
    expiryMarketId: RawTransactionArgument<string>;
    strike: RawTransactionArgument<number | bigint>;
}
export interface NewCardOptions {
    package?: string;
    arguments: NewCardArguments | [
        expiryMarketId: RawTransactionArgument<string>,
        strike: RawTransactionArgument<number | bigint>
    ];
}
export function newCard(options: NewCardOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        '0x2::object::ID',
        'u64'
    ] satisfies (string | null)[];
    const parameterNames = ["expiryMarketId", "strike"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'duel',
        function: 'new_card',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
    });
}
export interface CardExpiryMarketIdArguments {
    card: TransactionArgument;
}
export interface CardExpiryMarketIdOptions {
    package?: string;
    arguments: CardExpiryMarketIdArguments | [
        card: TransactionArgument
    ];
}
export function cardExpiryMarketId(options: CardExpiryMarketIdOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["card"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'duel',
        function: 'card_expiry_market_id',
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
    deckSize: RawTransactionArgument<number | bigint>;
}
export interface CreateDuelOptions {
    package?: string;
    arguments: CreateDuelArguments | [
        stake: RawTransactionArgument<string>,
        deckHash: RawTransactionArgument<Array<number>>,
        deckSize: RawTransactionArgument<number | bigint>
    ];
    typeArguments: [
        string
    ];
}
export function createDuel(options: CreateDuelOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null,
        'vector<u8>',
        'u64'
    ] satisfies (string | null)[];
    const parameterNames = ["stake", "deckHash", "deckSize"];
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
    deckSize: RawTransactionArgument<number | bigint>;
}
export interface CreateDuelFreeOptions {
    package?: string;
    arguments: CreateDuelFreeArguments | [
        deckHash: RawTransactionArgument<Array<number>>,
        deckSize: RawTransactionArgument<number | bigint>
    ];
    typeArguments: [
        string
    ];
}
/** Free / Social tier: no Predict mint, no dUSDC escrow. Same engine. */
export function createDuelFree(options: CreateDuelFreeOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        'vector<u8>',
        'u64'
    ] satisfies (string | null)[];
    const parameterNames = ["deckHash", "deckSize"];
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
    cardIdx: RawTransactionArgument<number | bigint>;
    isUp: RawTransactionArgument<boolean>;
    quantity: RawTransactionArgument<number | bigint>;
    orderId: RawTransactionArgument<number | bigint>;
}
export interface RecordSwipeOptions {
    package?: string;
    arguments: RecordSwipeArguments | [
        duel: RawTransactionArgument<string>,
        cardIdx: RawTransactionArgument<number | bigint>,
        isUp: RawTransactionArgument<boolean>,
        quantity: RawTransactionArgument<number | bigint>,
        orderId: RawTransactionArgument<number | bigint>
    ];
    typeArguments: [
        string
    ];
}
/**
 * Record a player's swipe on `card_idx`. `order_id` is the id returned by
 * `expiry_market::mint_exact_quantity`, chained from the mint command in the SAME
 * player-signed PTB — so a genuine mint backs every staked swipe. Premium/p_swiped
 * are no longer snapshotted here (6-24 exposes no public on-chain quote); premium
 * is keeper-fed at settle time.
 */
export function recordSwipe(options: RecordSwipeOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null,
        'u64',
        'bool',
        'u64',
        'u256',
        '0x2::clock::Clock'
    ] satisfies (string | null)[];
    const parameterNames = ["duel", "cardIdx", "isUp", "quantity", "orderId"];
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
    cardIdx: RawTransactionArgument<number | bigint>;
    isUp: RawTransactionArgument<boolean>;
}
export interface RecordSwipeFreeOptions {
    package?: string;
    arguments: RecordSwipeFreeArguments | [
        duel: RawTransactionArgument<string>,
        cardIdx: RawTransactionArgument<number | bigint>,
        isUp: RawTransactionArgument<boolean>
    ];
    typeArguments: [
        string
    ];
}
/**
 * Free-tier swipe — no mint, no anti-replay. Normalized quantity = `PROB_SCALE`,
 * `order_id = 0`.
 */
export function recordSwipeFree(options: RecordSwipeFreeOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null,
        'u64',
        'bool',
        '0x2::clock::Clock'
    ] satisfies (string | null)[];
    const parameterNames = ["duel", "cardIdx", "isUp"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'duel',
        function: 'record_swipe_free',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
        typeArguments: options.typeArguments
    });
}
export interface SettleCardArguments {
    duel: RawTransactionArgument<string>;
    p0Wrapper: RawTransactionArgument<string>;
    p1Wrapper: RawTransactionArgument<string>;
    cardIdx: RawTransactionArgument<number | bigint>;
    settlementPrice: RawTransactionArgument<number | bigint>;
    p0Premium: RawTransactionArgument<number | bigint>;
    p1Premium: RawTransactionArgument<number | bigint>;
}
export interface SettleCardOptions {
    package?: string;
    arguments: SettleCardArguments | [
        duel: RawTransactionArgument<string>,
        p0Wrapper: RawTransactionArgument<string>,
        p1Wrapper: RawTransactionArgument<string>,
        cardIdx: RawTransactionArgument<number | bigint>,
        settlementPrice: RawTransactionArgument<number | bigint>,
        p0Premium: RawTransactionArgument<number | bigint>,
        p1Premium: RawTransactionArgument<number | bigint>
    ];
    typeArguments: [
        string
    ];
}
/**
 * Settle one card. `settlement_price` (keeper-fed from the `MarketSettled` event)
 * and per-player `premium` (keeper-fed from `OrderMinted`) are supplied as
 * arguments — 6-24 exposes no public on-chain read for either. Scores both
 * players' swipes (UP wins if `settlement_price > strike`) and accumulates
 * payout/premium onto the duel. Idempotent via `cards_settled[card_idx]`.
 * Anti-replay: `predict_account::has_position` on each player's `AccountWrapper` —
 * a player who redeemed their 6-24 position before settle has their payout zeroed
 * (premium still counts).
 */
export function settleCard(options: SettleCardOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null,
        null,
        null,
        'u64',
        'u64',
        'u64',
        'u64'
    ] satisfies (string | null)[];
    const parameterNames = ["duel", "p0Wrapper", "p1Wrapper", "cardIdx", "settlementPrice", "p0Premium", "p1Premium"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'duel',
        function: 'settle_card',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
        typeArguments: options.typeArguments
    });
}
export interface SettleCardFreeArguments {
    duel: RawTransactionArgument<string>;
    cardIdx: RawTransactionArgument<number | bigint>;
    settlementPrice: RawTransactionArgument<number | bigint>;
    p0Premium: RawTransactionArgument<number | bigint>;
    p1Premium: RawTransactionArgument<number | bigint>;
}
export interface SettleCardFreeOptions {
    package?: string;
    arguments: SettleCardFreeArguments | [
        duel: RawTransactionArgument<string>,
        cardIdx: RawTransactionArgument<number | bigint>,
        settlementPrice: RawTransactionArgument<number | bigint>,
        p0Premium: RawTransactionArgument<number | bigint>,
        p1Premium: RawTransactionArgument<number | bigint>
    ];
    typeArguments: [
        string
    ];
}
/**
 * Per-card settle for Free tier. No AccountWrapper / anti-replay (free swipes
 * never minted). `premium` values are keeper-computed notionals.
 */
export function settleCardFree(options: SettleCardFreeOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null,
        'u64',
        'u64',
        'u64',
        'u64'
    ] satisfies (string | null)[];
    const parameterNames = ["duel", "cardIdx", "settlementPrice", "p0Premium", "p1Premium"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'duel',
        function: 'settle_card_free',
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
 * Finalize the duel. Verifies every card has been settled (or that the
 * forfeit/refund branches apply via the swipe timeout), then distributes the pot
 * based on `duel.p0_payout` / `duel.p1_payout` etc. (filled incrementally by
 * `settle_card`). Permissionless.
 */
export function finalize(options: FinalizeOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null,
        '0x2::clock::Clock'
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
export interface FinalizeFreeArguments {
    duel: RawTransactionArgument<string>;
}
export interface FinalizeFreeOptions {
    package?: string;
    arguments: FinalizeFreeArguments | [
        duel: RawTransactionArgument<string>
    ];
    typeArguments: [
        string
    ];
}
/** Free-tier counterpart to `finalize`. */
export function finalizeFree(options: FinalizeFreeOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null,
        '0x2::clock::Clock'
    ] satisfies (string | null)[];
    const parameterNames = ["duel"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'duel',
        function: 'finalize_free',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
        typeArguments: options.typeArguments
    });
}
export interface FinalizeTestOnePriceArguments {
    duel: RawTransactionArgument<string>;
    price: RawTransactionArgument<number | bigint>;
}
export interface FinalizeTestOnePriceOptions {
    package?: string;
    arguments: FinalizeTestOnePriceArguments | [
        duel: RawTransactionArgument<string>,
        price: RawTransactionArgument<number | bigint>
    ];
    typeArguments: [
        string
    ];
}
/**
 * **TEST/DEV ONLY** — settle every still-unsettled card against ONE fed `price`
 * (free-style scoring: no anti-replay, premium 0), then finalize. PnL is
 * approximate — never use on mainnet.
 */
export function finalizeTestOnePrice(options: FinalizeTestOnePriceOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null,
        'u64',
        '0x2::clock::Clock'
    ] satisfies (string | null)[];
    const parameterNames = ["duel", "price"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'duel',
        function: 'finalize_test_one_price',
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
export interface DeckSizeArguments {
    duel: RawTransactionArgument<string>;
}
export interface DeckSizeOptions {
    package?: string;
    arguments: DeckSizeArguments | [
        duel: RawTransactionArgument<string>
    ];
    typeArguments: [
        string
    ];
}
export function deckSize(options: DeckSizeOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null
    ] satisfies (string | null)[];
    const parameterNames = ["duel"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'duel',
        function: 'deck_size',
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
export interface IsCardSettledArguments {
    duel: RawTransactionArgument<string>;
    cardIdx: RawTransactionArgument<number | bigint>;
}
export interface IsCardSettledOptions {
    package?: string;
    arguments: IsCardSettledArguments | [
        duel: RawTransactionArgument<string>,
        cardIdx: RawTransactionArgument<number | bigint>
    ];
    typeArguments: [
        string
    ];
}
export function isCardSettled(options: IsCardSettledOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null,
        'u64'
    ] satisfies (string | null)[];
    const parameterNames = ["duel", "cardIdx"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'duel',
        function: 'is_card_settled',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
        typeArguments: options.typeArguments
    });
}
export interface CardSettlementPriceArguments {
    duel: RawTransactionArgument<string>;
    cardIdx: RawTransactionArgument<number | bigint>;
}
export interface CardSettlementPriceOptions {
    package?: string;
    arguments: CardSettlementPriceArguments | [
        duel: RawTransactionArgument<string>,
        cardIdx: RawTransactionArgument<number | bigint>
    ];
    typeArguments: [
        string
    ];
}
export function cardSettlementPrice(options: CardSettlementPriceOptions) {
    const packageAddress = options.package ?? 'flicky';
    const argumentsTypes = [
        null,
        'u64'
    ] satisfies (string | null)[];
    const parameterNames = ["duel", "cardIdx"];
    return (tx: Transaction) => tx.moveCall({
        package: packageAddress,
        module: 'duel',
        function: 'card_settlement_price',
        arguments: normalizeMoveArguments(options.arguments, argumentsTypes, parameterNames),
        typeArguments: options.typeArguments
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