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
  | { type: "oracle_subscribe"; oracleIds: string[] }
  | { type: "oracle_unsubscribe"; oracleIds: string[] }
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
        p0Swipe: { isUp: boolean; quantity: string; premium: string } | null
        p1Swipe: { isUp: boolean; quantity: string; premium: string } | null
      }>
      /**
       * Per-card swipes captured from chain — both settled and pending.
       * The UI uses this to render running PnL (premium paid so far)
       * and to rehydrate `swipeResults` after F5 without losing the
       * "what have I swiped" memory.
       */
      swipes: Array<{
        cardIdx: number
        p0Swipe: { isUp: boolean; quantity: string; premium: string } | null
        p1Swipe: { isUp: boolean; quantity: string; premium: string } | null
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
      type: "practice_session"
      cards: Array<{ oracle_id: string; strike: string; expiry: string }>
      botSwipes: boolean[]
    }
  | {
      type: "chat_history"
      messages: Array<{ id: number; from: string; text: string; timestampMs: number }>
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
      type: "oracle_tick"
      oracleId: string
      spot: string
      forward: string
      expiry: string
      settled: boolean
      /**
       * SVI parameters used by the on-chain `pricing::p_up` quoter.
       * Optional — older OracleSVI snapshots may not surface them.
       * Five-tuple in 1e9 fixed point: (a, b, rho, m, sigma).
       */
      svi?: { a: string; b: string; rho: string; m: string; sigma: string }
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
