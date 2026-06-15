/**
 * MMR (player rating) — PRD §Matchmaking: "MMR + bucketed per-tier
 * matching".
 *
 * Two pieces:
 *
 *   1. **ELO update** — when the indexer sees `DuelFinalized`, we look up
 *      both players' current ratings, apply a standard ELO step with
 *      `MMR_K_FACTOR` (default 32), and persist back. Ties update both
 *      sides toward the midpoint.
 *
 *   2. **Window-expanding pair selection** — `queue_join` uses
 *      `findClosestOpponent` instead of FIFO. The match window starts at
 *      `MMR_MATCH_WINDOW_INITIAL` (rating points) and expands by
 *      `MMR_MATCH_WINDOW_EXPAND_PER_SEC` for each second the candidate
 *      has been waiting. New players (no rating row yet) get the default
 *      `MMR_INITIAL_RATING`.
 */
import {
  clearPlayerRatings,
  getPlayerRating,
  leaderboard,
  listRecentDuels,
  upsertPlayerRating,
  type DuelRow,
} from "./db"
import { env } from "./env"
import { makeLogger, shortId } from "./log"

const log = makeLogger("mmr")

// ─── ELO ────────────────────────────────────────────────────────────────────

function expectedScore(self: number, opp: number): number {
  return 1 / (1 + Math.pow(10, (opp - self) / 400))
}

export type DuelOutcome = "p0_win" | "p1_win" | "tie"

/** Update both players' ratings + record win/loss/tie counts. */
export function applyDuelOutcome(
  p0: string,
  p1: string,
  outcome: DuelOutcome,
): { p0Before: number; p0After: number; p1Before: number; p1After: number } {
  const a = getPlayerRating(p0)
  const b = getPlayerRating(p1)
  const ea = expectedScore(a.rating, b.rating)
  const eb = 1 - ea
  let sa: number
  let sb: number
  if (outcome === "p0_win") {
    sa = 1
    sb = 0
  } else if (outcome === "p1_win") {
    sa = 0
    sb = 1
  } else {
    sa = 0.5
    sb = 0.5
  }
  const newA = Math.round(a.rating + env.mmrKFactor * (sa - ea))
  const newB = Math.round(b.rating + env.mmrKFactor * (sb - eb))
  const now = Date.now()
  upsertPlayerRating({
    address: a.address,
    rating: newA,
    gamesPlayed: a.gamesPlayed + 1,
    wins: a.wins + (outcome === "p0_win" ? 1 : 0),
    losses: a.losses + (outcome === "p1_win" ? 1 : 0),
    ties: a.ties + (outcome === "tie" ? 1 : 0),
    lastUpdatedMs: now,
  })
  upsertPlayerRating({
    address: b.address,
    rating: newB,
    gamesPlayed: b.gamesPlayed + 1,
    wins: b.wins + (outcome === "p1_win" ? 1 : 0),
    losses: b.losses + (outcome === "p0_win" ? 1 : 0),
    ties: b.ties + (outcome === "tie" ? 1 : 0),
    lastUpdatedMs: now,
  })
  log.info(
    `${shortId(p0)} ${a.rating}→${newA} vs ${shortId(p1)} ${b.rating}→${newB} (${outcome})`,
  )
  return {
    p0Before: a.rating,
    p0After: newA,
    p1Before: b.rating,
    p1After: newB,
  }
}

/**
 * Outcome of a finished duel. Prefers the authoritative `winner` recorded
 * from the on-chain DuelFinalized event; for older rows that predate that
 * column it falls back to the contract's own rule — the head-to-head net
 * comparison, i.e. `p0_net` vs `p1_net` (see the duel-table schema note:
 * "winner determined by (p0_payout + p1_premium) vs (p1_payout +
 * p0_premium)", which is algebraically the same). NOT the sign of p0's net
 * alone, which mislabels close duels where both sides netted the same way.
 */
function outcomeFromDuel(d: DuelRow): DuelOutcome {
  if (d.winner === "p0") return "p0_win"
  if (d.winner === "p1") return "p1_win"
  if (d.winner === "tie") return "tie"
  const p0Net = BigInt(d.p0Payout) - BigInt(d.p0Premium)
  const p1Net = BigInt(d.p1Payout) - BigInt(d.p1Premium)
  if (p0Net > p1Net) return "p0_win"
  if (p1Net > p0Net) return "p1_win"
  return "tie"
}

/**
 * Rebuild the entire player_rating table from the duel mirror by replaying
 * every COMPLETE duel through the ELO step in finalization order.
 *
 * Why this exists: live rating updates (`applyDuelOutcome` from the
 * indexer's `DuelFinalized` handler) are stream-only and not
 * reconstructable — if the rating DB is reset or the event cursor advances
 * past a finalization, those ratings are lost even though the duel mirror
 * still has the COMPLETE rows. This recompute makes the leaderboard a pure
 * function of the mirror, so it's correct after any reset and safe to
 * re-run (it wipes first).
 *
 * ELO is order-dependent, so we replay oldest → newest by `lastUpdatedMs`
 * (the mirror's finalization-time proxy). Run with the indexer stopped —
 * the DB is single-writer and a live finalization mid-replay would be
 * double-counted.
 */
export function recomputeRatingsFromMirror(): {
  cleared: number
  applied: number
  skipped: number
} {
  const cleared = clearPlayerRatings()
  // listRecentDuels returns newest-first; reverse for chronological replay.
  const complete = listRecentDuels(1_000_000, "COMPLETE").reverse()
  let applied = 0
  let skipped = 0
  for (const d of complete) {
    if (!d.creator || !d.challenger) {
      skipped++
      continue
    }
    applyDuelOutcome(d.creator, d.challenger, outcomeFromDuel(d))
    applied++
  }
  log.info(
    `recompute: cleared ${cleared} row(s), applied ${applied} duel(s), skipped ${skipped}`,
  )
  return { cleared, applied, skipped }
}

// ─── Window-expanding pair selection ────────────────────────────────────────

/** What `queue_join` needs about a queued candidate. */
export interface Candidate {
  address: string
  queuedAtMs: number
}

/**
 * From `pool`, pick the candidate whose rating is closest to `myRating`
 * **and** within their personal match window (which expands with wait
 * time). Returns null if no eligible opponent.
 *
 * Both sides must accept the window: a candidate that's been waiting
 * 30s might have a window of 800 rating points; a fresh joiner has 200.
 * We use the wider of the two so neither party is "stuck waiting" for
 * a closer rating than they'd accept themselves.
 */
export function findClosestOpponent(
  myRating: number,
  myQueuedAtMs: number,
  pool: Candidate[],
): Candidate | null {
  if (pool.length === 0) return null
  const now = Date.now()
  let best: { c: Candidate; gap: number } | null = null
  for (const c of pool) {
    const candRating = getPlayerRating(c.address).rating
    const gap = Math.abs(candRating - myRating)
    const candWindow = matchWindow(now - c.queuedAtMs)
    const myWindow = matchWindow(now - myQueuedAtMs)
    const window = Math.max(candWindow, myWindow)
    if (gap > window) continue
    if (best === null || gap < best.gap) best = { c, gap }
  }
  return best?.c ?? null
}

function matchWindow(waitMs: number): number {
  const seconds = Math.max(0, waitMs / 1000)
  return env.mmrMatchWindowInitial + seconds * env.mmrMatchWindowExpandPerSec
}

// ─── Leaderboard read ───────────────────────────────────────────────────────

export function topLeaderboard(limit: number) {
  return leaderboard(limit)
}
