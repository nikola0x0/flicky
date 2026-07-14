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
import { playerRank, stakedDuelCounts } from "./db"
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

/**
 * GET /leaderboard/me?address=0x… — one player's own rank card. Returns the
 * player's 1-based position + rating + prize eligibility even when they sit
 * outside the fetched top-N, so the rank screen can always show "YOUR RANK #N".
 * `ranked: false` when the address has no completed duel yet.
 */
export async function handleMyRankRequest(
  req: Request,
  url: URL
): Promise<Response | null> {
  if (url.pathname !== "/leaderboard/me" || req.method !== "GET") return null
  const address = url.searchParams.get("address")?.toLowerCase()
  if (!address || !/^0x[0-9a-f]+$/.test(address)) {
    return json({ error: "address query param required (0x…)" }, 400)
  }
  try {
    const [info, staked] = await Promise.all([
      playerRank(address),
      stakedDuelCounts(),
    ])
    if (!info) return json({ ranked: false })
    const stakedDuels = staked.get(address) ?? 0
    return json({
      ranked: true,
      rank: info.rank,
      address: info.address,
      rating: info.rating,
      gamesPlayed: info.gamesPlayed,
      wins: info.wins,
      losses: info.losses,
      ties: info.ties,
      stakedDuels,
      eligible: stakedDuels >= env.seasonMinStakedDuels,
    })
  } catch (e) {
    return json(
      {
        error: "rank read failed",
        detail: e instanceof Error ? e.message : String(e),
      },
      500
    )
  }
}
