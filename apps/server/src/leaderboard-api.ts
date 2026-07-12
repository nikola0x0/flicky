/**
 * GET /leaderboard?limit=N — top players by MMR rating.
 *
 * Read-only over the `player_rating` table written by
 * `mmr.applyDuelOutcome` (called from the indexer on `DuelFinalized`).
 *
 * Each player is annotated with `stakedDuels` (completed staked-duel count)
 * and `eligible` (≥ `SEASON_MIN_STAKED_DUELS`) for the Season 0 prize display.
 * Ranking itself is unchanged — all-tier rating; eligibility only gates prizes.
 */
import { topLeaderboard } from "./mmr"
import { stakedDuelCounts } from "./db"
import { env } from "./env"
import { json } from "./lib/http"

export async function handleLeaderboardRequest(
  req: Request,
  url: URL
): Promise<Response | null> {
  if (url.pathname !== "/leaderboard" || req.method !== "GET") return null
  const limitRaw = url.searchParams.get("limit")
  const limit = Math.min(100, Math.max(1, Number(limitRaw ?? 20)))
  try {
    const [players, staked] = await Promise.all([
      topLeaderboard(limit),
      stakedDuelCounts(),
    ])
    const minStaked = env.seasonMinStakedDuels
    return json({
      players: players.map((p) => {
        const stakedDuels = staked.get(p.address) ?? 0
        return {
          address: p.address,
          rating: p.rating,
          gamesPlayed: p.gamesPlayed,
          wins: p.wins,
          losses: p.losses,
          ties: p.ties,
          stakedDuels,
          eligible: stakedDuels >= minStaked,
        }
      }),
    })
  } catch (e) {
    return json(
      {
        error: "leaderboard read failed",
        detail: e instanceof Error ? e.message : String(e),
      },
      500
    )
  }
}
