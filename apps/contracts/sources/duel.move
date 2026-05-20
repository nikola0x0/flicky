// Copyright (c) Flicky Labs
// SPDX-License-Identifier: Apache-2.0

/// Flicky duel: a two-player, five-card prediction match escrowing stakes
/// in a shared object, consuming DeepBook Predict's `OracleSVI` per card for
/// `p_swiped` snapshots and terminal correctness.
///
/// Lifecycle:
///   `PENDING` (creator staked, waiting for challenger) →
///   `ACTIVE`  (both staked, swipes in progress) →
///   `COMPLETE` (all cards settled and stakes paid out).
///
/// Per the README/PRD spec:
/// - Each card references one `OracleSVI` + one strike on its grid.
/// - Swipes are strictly sequential per player; each swipe snapshots the
///   implied probability of the chosen direction (`p_swiped`) at the moment
///   of the swipe — this is what scoring rewards.
/// - Card score = `correct ? (1 / p_swiped) * speed_multiplier : 0`, with
///   per-card decide-time measured from the previous swipe (or duel start
///   for card 0).
///
/// Out of POC scope (follow-ups):
/// - Commit-reveal deck hashing (cards currently visible at creation).
/// - DeepBook `predict::mint` calls in the same PTB as `record_swipe`.
/// - Forfeit-on-timeout for slow players.
/// - Strike-grid validation in `new_card`: DeepBook's tick metadata lives in
///   `Predict<Quote>.oracle_config`, not on the oracle itself. Off-grid
///   strikes are rejected at `predict::mint` time when the player's swipe
///   PTB bundles the mint call.
module flicky::duel;

use deepbook_predict::oracle::{Self as db_oracle, OracleSVI};
use flicky::pricing;
use std::hash;
use sui::balance::{Self, Balance};
use sui::bcs;
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::event;

// === Errors ===
const ENotPlayer: u64 = 0;
const EDuelNotPending: u64 = 1;
const EDuelNotActive: u64 = 2;
const EAlreadyJoined: u64 = 3;
const ECreatorCannotJoin: u64 = 4;
const EStakeMismatch: u64 = 5;
const EInvalidDeckSize: u64 = 6;
const ECardIndexOOB: u64 = 7;
const EOracleMismatch: u64 = 8;
const EOutOfTurn: u64 = 9;
const ECardAlreadySettled: u64 = 10;
const EAllCardsNotSettled: u64 = 11;
const EOracleNotSettled: u64 = 12;
const EZeroStake: u64 = 13;
/// Raised by `record_swipe` when the oracle backing the card is no longer
/// ACTIVE (inactive, already expired, or settled). Prevents trivially-known
/// outcomes from being scored.
const EOracleNotLive: u64 = 14;
/// `deck_hash` must be exactly 32 bytes (sha2-256 length).
const EInvalidDeckHash: u64 = 15;
/// `reveal_deck` called twice on the same Duel.
const EDeckAlreadyRevealed: u64 = 16;
/// Plaintext deck passed to `reveal_deck` does not hash to the committed
/// `deck_hash`. Anti-front-run guarantee.
const EDeckHashMismatch: u64 = 17;
/// `record_swipe` requires the deck to have been revealed first.
const EDeckNotRevealed: u64 = 18;

// === Status ===
const STATUS_PENDING: u8 = 1;
const STATUS_ACTIVE: u8 = 2;
const STATUS_COMPLETE: u8 = 3;

// === Constants ===
/// Cards per duel. Tinder-style 5-card swipe deck.
const DECK_SIZE: u64 = 5;
/// 9-decimal fixed point (1e9 == 1.0 or 100%).
const ONE_E9: u64 = 1_000_000_000;

// Speed thresholds (ms) and 9-decimal multipliers.
const SPEED_FAST_MAX_MS: u64 = 5_000;
const SPEED_NORMAL_MAX_MS: u64 = 20_000;
const SPEED_SLOW_MAX_MS: u64 = 60_000;
const SPEED_FAST_MULT: u64 = 1_500_000_000; // 1.5x
const SPEED_NORMAL_MULT: u64 = 1_000_000_000; // 1.0x
const SPEED_SLOW_MULT: u64 = 750_000_000; // 0.75x

// === Structs ===

/// One prediction card. References a DeepBook `OracleSVI` + a strike.
public struct Card has copy, drop, store {
    oracle_id: ID,
    strike: u64,
}

/// One player's response to one card. Snapshot taken at swipe time.
public struct Swipe has copy, drop, store {
    is_up: bool,
    /// Implied probability of the chosen direction at the moment of swipe.
    p_swiped: u64,
    /// Time spent on this card, in ms, since the previous swipe (or duel
    /// start for card 0). Drives the speed multiplier.
    decide_time_ms: u64,
}

/// Two-player prediction duel. Generic over the stake coin type `T`
/// (dUSDC in production; mock coins in tests).
public struct Duel<phantom T> has key {
    id: UID,
    status: u8,
    /// sha2-256 of `bcs::to_bytes(&cards)` committed at create time. Cards
    /// stay empty until `reveal_deck` is called with the plaintext.
    deck_hash: vector<u8>,
    cards: vector<Card>,
    creator: address,
    /// `@0x0` until a challenger joins.
    challenger: address,
    p0_stake: Balance<T>,
    p1_stake: Balance<T>,
    p0_swipes: vector<Option<Swipe>>,
    p1_swipes: vector<Option<Swipe>>,
    /// Accumulated scores in 9-decimal fixed point.
    p0_score: u64,
    p1_score: u64,
    /// Clock checkpoint per player: the start time for the next swipe's
    /// `decide_time_ms`. Set to `started_at_ms` on join, advanced on each swipe.
    p0_last_swipe_or_start_ms: u64,
    p1_last_swipe_or_start_ms: u64,
    /// Next card index each player must swipe (must be strictly sequential).
    p0_next_card_idx: u64,
    p1_next_card_idx: u64,
    /// Per-card terminal price, populated by `settle_card` when the oracle
    /// for that card has settled.
    card_settlements: vector<Option<u64>>,
    /// Count of cards whose `card_settlements[i]` is `Some`.
    settled_count: u64,
    /// On-chain timestamp when `join_duel` landed; `0` while PENDING.
    started_at_ms: u64,
}

// === Events ===

public struct DuelCreated has copy, drop {
    duel_id: ID,
    creator: address,
    stake_amount: u64,
    deck_hash: vector<u8>,
}

public struct DeckRevealed has copy, drop {
    duel_id: ID,
}

public struct DuelJoined has copy, drop {
    duel_id: ID,
    challenger: address,
    stake_amount: u64,
    started_at_ms: u64,
}

public struct SwipeRecorded has copy, drop {
    duel_id: ID,
    player: address,
    card_idx: u64,
    is_up: bool,
    p_swiped: u64,
    decide_time_ms: u64,
}

public struct CardSettled has copy, drop {
    duel_id: ID,
    card_idx: u64,
    settlement_price: u64,
    p0_card_score: u64,
    p1_card_score: u64,
}

public struct DuelFinalized has copy, drop {
    duel_id: ID,
    p0_score: u64,
    p1_score: u64,
    winner: address, // @0x0 == tie
    payout_to_p0: u64,
    payout_to_p1: u64,
}

// === Public: card construction ===

/// Build a `Card` referencing this oracle + strike. Strike-grid validation
/// happens at `predict::mint` time in the player's swipe PTB; we accept any
/// strike here.
public fun new_card(oracle: &OracleSVI, strike: u64): Card {
    Card { oracle_id: object::id(oracle), strike }
}

public fun card_oracle_id(card: &Card): ID { card.oracle_id }

public fun card_strike(card: &Card): u64 { card.strike }

// === Public: lifecycle ===

/// Creator stakes and commits the deck's hash. Cards are revealed later
/// via `reveal_deck`. Returns the new shared duel ID.
///
/// The `deck_hash` is `sha2_256(bcs::to_bytes(&cards))` computed off-chain
/// by the Deckmaster. Committing the hash before the challenger joins
/// prevents front-running with parallel Predict positions.
public fun create_duel<T>(
    stake: Coin<T>,
    deck_hash: vector<u8>,
    ctx: &mut TxContext,
): ID {
    assert!(deck_hash.length() == 32, EInvalidDeckHash);
    let stake_amount = stake.value();
    assert!(stake_amount > 0, EZeroStake);

    let mut card_settlements = vector<Option<u64>>[];
    let mut p0_swipes = vector<Option<Swipe>>[];
    let mut p1_swipes = vector<Option<Swipe>>[];
    DECK_SIZE.do!(|_| {
        card_settlements.push_back(option::none());
        p0_swipes.push_back(option::none());
        p1_swipes.push_back(option::none());
    });

    let creator = ctx.sender();
    let duel = Duel<T> {
        id: object::new(ctx),
        status: STATUS_PENDING,
        deck_hash,
        cards: vector<Card>[],
        creator,
        challenger: @0x0,
        p0_stake: stake.into_balance(),
        p1_stake: balance::zero<T>(),
        p0_swipes,
        p1_swipes,
        p0_score: 0,
        p1_score: 0,
        p0_last_swipe_or_start_ms: 0,
        p1_last_swipe_or_start_ms: 0,
        p0_next_card_idx: 0,
        p1_next_card_idx: 0,
        card_settlements,
        settled_count: 0,
        started_at_ms: 0,
    };

    let duel_id = object::id(&duel);

    event::emit(DuelCreated {
        duel_id,
        creator,
        stake_amount,
        deck_hash: duel.deck_hash,
    });

    transfer::share_object(duel);
    duel_id
}

/// Reveal the committed deck. Permissionless — anyone with the plaintext
/// can call. Verifies `sha2_256(bcs::to_bytes(&cards)) == duel.deck_hash`
/// and populates `duel.cards`. Must run after `join_duel` (duel.status ==
/// ACTIVE) and before any `record_swipe`.
public fun reveal_deck<T>(duel: &mut Duel<T>, cards: vector<Card>) {
    assert!(duel.status == STATUS_ACTIVE, EDuelNotActive);
    assert!(duel.cards.is_empty(), EDeckAlreadyRevealed);
    assert!(cards.length() == DECK_SIZE, EInvalidDeckSize);
    let serialized = bcs::to_bytes(&cards);
    let computed = hash::sha2_256(serialized);
    assert!(computed == duel.deck_hash, EDeckHashMismatch);
    duel.cards = cards;
    event::emit(DeckRevealed { duel_id: object::id(duel) });
}

/// Challenger matches the creator's stake and starts the match. Both decks
/// become "revealed" at this moment — per-player decide-time clocks start.
public fun join_duel<T>(
    duel: &mut Duel<T>,
    stake: Coin<T>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(duel.status == STATUS_PENDING, EDuelNotPending);
    let challenger = ctx.sender();
    assert!(challenger != duel.creator, ECreatorCannotJoin);
    assert!(duel.challenger == @0x0, EAlreadyJoined);

    let stake_amount = stake.value();
    assert!(stake_amount == duel.p0_stake.value(), EStakeMismatch);

    duel.p1_stake.join(stake.into_balance());
    duel.challenger = challenger;
    duel.status = STATUS_ACTIVE;
    let now_ms = clock.timestamp_ms();
    duel.started_at_ms = now_ms;
    duel.p0_last_swipe_or_start_ms = now_ms;
    duel.p1_last_swipe_or_start_ms = now_ms;

    event::emit(DuelJoined {
        duel_id: object::id(duel),
        challenger,
        stake_amount,
        started_at_ms: now_ms,
    });
}

/// Player records a swipe on the next card in their sequence. Must be the
/// creator or challenger; the supplied `oracle` must match `cards[card_idx]`.
/// Snapshots the implied probability of the chosen direction (UP or DOWN)
/// from DeepBook's SVI surface.
public fun record_swipe<T>(
    duel: &mut Duel<T>,
    oracle: &OracleSVI,
    card_idx: u64,
    is_up: bool,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(duel.status == STATUS_ACTIVE, EDuelNotActive);
    assert!(!duel.cards.is_empty(), EDeckNotRevealed);
    assert!(card_idx < DECK_SIZE, ECardIndexOOB);

    let sender = ctx.sender();
    let is_p0 = sender == duel.creator;
    let is_p1 = sender == duel.challenger;
    assert!(is_p0 || is_p1, ENotPlayer);

    let card = &duel.cards[card_idx];
    assert!(card.oracle_id == object::id(oracle), EOracleMismatch);
    // Swipes are only fair while the oracle is ACTIVE — past expiry or settled,
    // the outcome is observable and `p_swiped` collapses to a trivial value.
    assert!(oracle.status(clock) == db_oracle::status_active(), EOracleNotLive);

    let next_idx = if (is_p0) duel.p0_next_card_idx else duel.p1_next_card_idx;
    assert!(card_idx == next_idx, EOutOfTurn);

    let now_ms = clock.timestamp_ms();
    let baseline = if (is_p0) duel.p0_last_swipe_or_start_ms
        else duel.p1_last_swipe_or_start_ms;
    let decide_time_ms = if (now_ms > baseline) now_ms - baseline else 0;

    let p_up = pricing::p_up(oracle, card.strike);
    let p_swiped = if (is_up) p_up else ONE_E9 - p_up;

    let swipe = Swipe { is_up, p_swiped, decide_time_ms };
    if (is_p0) {
        *vector::borrow_mut(&mut duel.p0_swipes, card_idx) = option::some(swipe);
        duel.p0_last_swipe_or_start_ms = now_ms;
        duel.p0_next_card_idx = card_idx + 1;
    } else {
        *vector::borrow_mut(&mut duel.p1_swipes, card_idx) = option::some(swipe);
        duel.p1_last_swipe_or_start_ms = now_ms;
        duel.p1_next_card_idx = card_idx + 1;
    };

    event::emit(SwipeRecorded {
        duel_id: object::id(duel),
        player: sender,
        card_idx,
        is_up,
        p_swiped,
        decide_time_ms,
    });
}

/// Permissionless. Settles one card once its oracle has reached SETTLED,
/// computing both players' scores for that card.
public fun settle_card<T>(duel: &mut Duel<T>, oracle: &OracleSVI, card_idx: u64) {
    assert!(duel.status == STATUS_ACTIVE, EDuelNotActive);
    assert!(card_idx < DECK_SIZE, ECardIndexOOB);
    let card = &duel.cards[card_idx];
    assert!(card.oracle_id == object::id(oracle), EOracleMismatch);
    assert!(duel.card_settlements[card_idx].is_none(), ECardAlreadySettled);

    let settle_opt = oracle.settlement_price();
    assert!(settle_opt.is_some(), EOracleNotSettled);
    let settlement_price = settle_opt.destroy_some();
    let strike = card.strike;

    let p0_card_score = compute_card_score(&duel.p0_swipes[card_idx], settlement_price, strike);
    let p1_card_score = compute_card_score(&duel.p1_swipes[card_idx], settlement_price, strike);

    duel.p0_score = duel.p0_score + p0_card_score;
    duel.p1_score = duel.p1_score + p1_card_score;
    *vector::borrow_mut(&mut duel.card_settlements, card_idx) = option::some(settlement_price);
    duel.settled_count = duel.settled_count + 1;

    event::emit(CardSettled {
        duel_id: object::id(duel),
        card_idx,
        settlement_price,
        p0_card_score,
        p1_card_score,
    });
}

/// Permissionless once all cards are settled.
///
/// Payout rules (PRD §Payout):
///   - Higher score wins the entire pot.
///   - Tie on score → lower total decide-time wins.
///   - Still tied → each player gets their own stake back.
public fun finalize<T>(duel: &mut Duel<T>, ctx: &mut TxContext) {
    assert!(duel.status == STATUS_ACTIVE, EDuelNotActive);
    assert!(duel.settled_count == DECK_SIZE, EAllCardsNotSettled);

    let p0 = duel.creator;
    let p1 = duel.challenger;
    let total_p0 = duel.p0_stake.value();
    let total_p1 = duel.p1_stake.value();
    let total = total_p0 + total_p1;

    let (payout_to_p0, payout_to_p1, winner) = if (duel.p0_score > duel.p1_score) {
        (total, 0, p0)
    } else if (duel.p1_score > duel.p0_score) {
        (0, total, p1)
    } else {
        // Score-tied → faster total decide-time wins.
        let p0_time = total_decide_time(&duel.p0_swipes);
        let p1_time = total_decide_time(&duel.p1_swipes);
        if (p0_time < p1_time) {
            (total, 0, p0)
        } else if (p1_time < p0_time) {
            (0, total, p1)
        } else {
            // Still tied — refund each player's own stake.
            (total_p0, total_p1, @0x0)
        }
    };

    pay_player(&mut duel.p0_stake, &mut duel.p1_stake, p0, payout_to_p0, ctx);
    pay_player(&mut duel.p0_stake, &mut duel.p1_stake, p1, payout_to_p1, ctx);

    duel.status = STATUS_COMPLETE;

    event::emit(DuelFinalized {
        duel_id: object::id(duel),
        p0_score: duel.p0_score,
        p1_score: duel.p1_score,
        winner,
        payout_to_p0,
        payout_to_p1,
    });
}

/// Sum of `decide_time_ms` across all recorded swipes (None entries
/// contribute 0). Used as the score-tie breaker in `finalize`.
fun total_decide_time(swipes: &vector<Option<Swipe>>): u64 {
    let mut total: u64 = 0;
    let mut i = 0;
    while (i < swipes.length()) {
        let s = &swipes[i];
        if (s.is_some()) {
            total = total + s.borrow().decide_time_ms;
        };
        i = i + 1;
    };
    total
}

// === Read API ===

public fun status<T>(duel: &Duel<T>): u8 { duel.status }

public fun is_complete<T>(duel: &Duel<T>): bool { duel.status == STATUS_COMPLETE }

public fun creator<T>(duel: &Duel<T>): address { duel.creator }

public fun challenger<T>(duel: &Duel<T>): address { duel.challenger }

public fun started_at_ms<T>(duel: &Duel<T>): u64 { duel.started_at_ms }

public fun deck<T>(duel: &Duel<T>): &vector<Card> { &duel.cards }

public fun deck_hash<T>(duel: &Duel<T>): vector<u8> { duel.deck_hash }

public fun p0_score<T>(duel: &Duel<T>): u64 { duel.p0_score }

public fun p1_score<T>(duel: &Duel<T>): u64 { duel.p1_score }

public fun p0_stake_value<T>(duel: &Duel<T>): u64 { duel.p0_stake.value() }

public fun p1_stake_value<T>(duel: &Duel<T>): u64 { duel.p1_stake.value() }

public fun settled_count<T>(duel: &Duel<T>): u64 { duel.settled_count }

public fun p0_next_card_idx<T>(duel: &Duel<T>): u64 { duel.p0_next_card_idx }

public fun p1_next_card_idx<T>(duel: &Duel<T>): u64 { duel.p1_next_card_idx }

public fun status_pending(): u8 { STATUS_PENDING }

public fun status_active(): u8 { STATUS_ACTIVE }

public fun status_complete(): u8 { STATUS_COMPLETE }

public fun deck_size(): u64 { DECK_SIZE }

// === Internal helpers ===

fun compute_card_score(swipe: &Option<Swipe>, settlement_price: u64, strike: u64): u64 {
    if (swipe.is_none()) return 0;
    let s = *swipe.borrow();
    let actual_up = settlement_price > strike;
    if (actual_up != s.is_up) return 0;
    card_score_from_swipe(s.p_swiped, s.decide_time_ms)
}

/// `card_score = (1 / p_swiped) * speed_multiplier`, all in 9-decimal.
/// Computed in u128 to avoid intermediate overflow.
fun card_score_from_swipe(p_swiped: u64, decide_time_ms: u64): u64 {
    if (p_swiped == 0) return 0;
    let mult = speed_multiplier(decide_time_ms);
    if (mult == 0) return 0;
    let score =
        (ONE_E9 as u128) * (ONE_E9 as u128) * (mult as u128)
        / ((p_swiped as u128) * (ONE_E9 as u128));
    score as u64
}

fun speed_multiplier(decide_time_ms: u64): u64 {
    if (decide_time_ms <= SPEED_FAST_MAX_MS) {
        SPEED_FAST_MULT
    } else if (decide_time_ms <= SPEED_NORMAL_MAX_MS) {
        SPEED_NORMAL_MULT
    } else if (decide_time_ms <= SPEED_SLOW_MAX_MS) {
        SPEED_SLOW_MULT
    } else {
        0
    }
}

/// Withdraw `amount` from the duel's two stake balances (p0 first, then p1)
/// and transfer the resulting coin to `recipient`. No-op when `amount == 0`.
fun pay_player<T>(
    p0_stake: &mut Balance<T>,
    p1_stake: &mut Balance<T>,
    recipient: address,
    amount: u64,
    ctx: &mut TxContext,
) {
    if (amount == 0) return;
    let from_p0 = if (p0_stake.value() >= amount) amount else p0_stake.value();
    let remaining = amount - from_p0;
    let mut payout = balance::zero<T>();
    if (from_p0 > 0) {
        payout.join(p0_stake.split(from_p0));
    };
    if (remaining > 0) {
        payout.join(p1_stake.split(remaining));
    };
    transfer::public_transfer(coin::from_balance(payout, ctx), recipient);
}

// === Test-only constants surfaced for assertions ===

#[test_only]
public fun test_deck_size(): u64 { DECK_SIZE }

#[test_only]
public fun test_one_e9(): u64 { ONE_E9 }

#[test_only]
public fun test_speed_fast_mult(): u64 { SPEED_FAST_MULT }

#[test_only]
public fun test_speed_normal_mult(): u64 { SPEED_NORMAL_MULT }

#[test_only]
public fun test_speed_slow_mult(): u64 { SPEED_SLOW_MULT }
