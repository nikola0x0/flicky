/**
 * Wire protocol for the `/ws` endpoint. Every message is a JSON object
 * with a `type` discriminator. The server is authoritative for clocks,
 * matchmaking state, and duel state — clients send intents and receive
 * deltas, never the other way around.
 */

// ─── Stake tiers ────────────────────────────────────────────────────────────
//
// dUSDC, 6-decimal. PRD §Stake tiers — 1 / 3 / 5 / 10 dUSDC, all gated
// by PredictManager balance ≥ 5 dUSDC. Practice has no on-chain stake;
// it shares the swipe engine but skips the queue and the chain.

export const STAKE_TIERS = {
  practice: 0n,
  casual: 3_000_000n,
  standard: 5_000_000n,
  high_roller: 10_000_000n,
  starter: 1_000_000n,
} as const

export type Tier = keyof typeof STAKE_TIERS

export function isValidTier(s: unknown): s is Tier {
  return typeof s === "string" && Object.hasOwn(STAKE_TIERS, s)
}

// ─── Client → Server ────────────────────────────────────────────────────────

export type ClientMsg =
  | { type: "hello"; address: string }
  | { type: "queue_join"; tier: Tier }
  | { type: "queue_leave" }
  | { type: "practice_start" }
  | { type: "room_subscribe"; duelId: string }
  | { type: "room_unsubscribe"; duelId: string }
  | { type: "chat_send"; text: string }
  | { type: "chat_react"; duelId: string; emoji: string }
  | { type: "oracle_subscribe"; marketIds: string[] }
  | { type: "oracle_unsubscribe"; marketIds: string[] }
  | { type: "spot_subscribe" }
  | { type: "spot_unsubscribe" }
  | { type: "ping" }

// ─── Server → Client ────────────────────────────────────────────────────────

export type ServerMsg =
  | { type: "hello"; address: string }
  | { type: "queue_status"; tier: Tier; size: number; waitMs: number }
  | { type: "queue_left" }
  | {
      type: "match_found"
      tier: Tier
      role: "creator" | "challenger"
      opponent: string
      /**
       * sha2_256 hash of the 5-card deck the server pre-generated for
       * this match. The plaintext stays server-side until reveal_deck
       * lands on chain — the creator commits THIS hash in `create_duel`,
       * the keeper reveals later. "0x"-prefixed hex string. Empty only
       * if deck generation degraded gracefully (shouldn't happen in
       * practice).
       */
      deckHash: string
    }
  | {
      /**
       * Pushed to a matched challenger the moment the indexer sees
       * their creator's `DuelCreated` event on chain — saves a polling
       * roundtrip vs hitting `/duels/recent` every couple seconds.
       */
      type: "duel_assigned"
      duelId: string
      creator: string
    }
  | {
      type: "room_state"
      duelId: string
      status: "PENDING" | "ACTIVE" | "COMPLETE"
      cardsRevealed: boolean
      cardCount: number
      /**
       * Revealed cards — empty until `DeckRevealed` lands. Each entry
       * carries the 6-24 `ExpiryMarket` id and the u64 strike (decimal
       * string). UI uses these to render the swipe deck and look up
       * per-card market ticks.
       */
      cards: Array<{ expiry_market_id: string; strike: string }>
      settledCount: number
      /**
       * Real-PnL cumulative fields per the new contract. Winner is
       * `(p0Payout + p1Premium) vs (p1Payout + p0Premium)` — UI can
       * render running net or final result.
       */
      p0Payout: string
      p0Premium: string
      p1Payout: string
      p1Premium: string
      /** ms timestamp when the duel went ACTIVE (set on join_duel). 0 while PENDING. */
      startedAtMs: number
      creator: string
      challenger: string
      stakeCoinType: string
      /** Per-card outcomes for settled cards (one entry per settledCount). */
      cardOutcomes: Array<{
        cardIdx: number
        settlementPrice: string
        strike: string
        upWon: boolean
        /** Signed decimal real PnL = (won ? quantity : 0) - premium. Null if no swipe. */
        p0Pnl: string | null
        p1Pnl: string | null
        p0Swipe: { isUp: boolean; quantity: string; orderId: string } | null
        p1Swipe: { isUp: boolean; quantity: string; orderId: string } | null
      }>
      /**
       * Per-card swipes captured from chain — both settled and pending.
       * The UI uses this to render running PnL (premium paid so far,
       * looked up server-side by `orderId`) and to rehydrate
       * `swipeResults` after F5 without losing the "what have I swiped"
       * memory.
       */
      swipes: Array<{
        cardIdx: number
        p0Swipe: { isUp: boolean; quantity: string; orderId: string } | null
        p1Swipe: { isUp: boolean; quantity: string; orderId: string } | null
      }>
    }
  | { type: "room_settled"; duelId: string; winner: string; payoutTo: string }
  | {
      type: "peer_left"
      duelId: string
      address: string
      gracePeriodMs: number
    }
  | { type: "peer_rejoined"; duelId: string; address: string }
  | { type: "peer_forfeit"; duelId: string; address: string }
  | {
      /**
       * Practice deck — synthetic cards, no on-chain markets. `strike` is
       * 1e9-fixed (same scale as `oracle_tick.spot`); `expiryOffsetMs` is
       * relative to lockup start (the client anchors the clock when the
       * 5th swipe lands); `pUp` is the design win-probability of UP and
       * doubles as the scoring `p_swiped` (UP → pUp, DOWN → 1 − pUp).
       */
      type: "practice_session"
      cards: Array<{ strike: string; expiryOffsetMs: number; pUp: number }>
      botSwipes: boolean[]
    }
  | {
      type: "chat_history"
      messages: Array<{
        id: number
        from: string
        text: string
        timestampMs: number
      }>
    }
  | {
      type: "chat_message"
      id: number
      from: string
      text: string
      timestampMs: number
    }
  | {
      type: "chat_reaction"
      duelId: string
      from: string
      emoji: string
      timestampMs: number
    }
  | {
      /**
       * 6-24: streams `ExpiryMarket` state instead of the pre-6-24
       * `OracleSVI` object (which no longer exists). `settlementPrice` is
       * `null` until the predict indexer's `MarketSettled` mirror has a
       * row for this market.
       */
      type: "oracle_tick"
      expiryMarketId: string
      spot: string
      expiry: string
      settlementPrice: string | null
      timestampMs: number
    }
  | {
      /**
       * Market-less live Pyth BTC spot for practice mode — same source,
       * cadence, and 1e9 scale as `oracle_tick.spot`, but requires no
       * `ExpiryMarket` id. Sent only to sockets that `spot_subscribe`d.
       */
      type: "spot_tick"
      spot: string
      timestampMs: number
    }
  | {
      type: "match_tick"
      duelId: string
      serverNowMs: number
      status: "PENDING" | "ACTIVE" | "COMPLETE"
    }
  | { type: "pong" }
  | { type: "error"; code: string; message: string; detail?: unknown }

export function parseClientMsg(raw: string): ClientMsg | null {
  try {
    const o = JSON.parse(raw) as Partial<ClientMsg>
    if (!o || typeof o !== "object" || typeof o.type !== "string") return null
    return o as ClientMsg
  } catch {
    return null
  }
}
