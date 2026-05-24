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
import { getPlayerRating, leaderboard, upsertPlayerRating } from "./db"
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
