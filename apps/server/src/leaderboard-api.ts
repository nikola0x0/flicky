/**
 * GET /leaderboard?limit=N — top players by MMR rating.
 *
 * Read-only over the `player_rating` table written by
 * `mmr.applyDuelOutcome` (called from the indexer on `DuelFinalized`).
 */
import { topLeaderboard } from "./mmr"
import { json } from "./lib/http"

export async function handleLeaderboardRequest(
  req: Request,
  url: URL,
): Promise<Response | null> {
  if (url.pathname !== "/leaderboard" || req.method !== "GET") return null
  const limitRaw = url.searchParams.get("limit")
  const limit = Math.min(100, Math.max(1, Number(limitRaw ?? 20)))
  try {
    return json({
      players: (await topLeaderboard(limit)).map((p) => ({
        address: p.address,
        rating: p.rating,
        gamesPlayed: p.gamesPlayed,
        wins: p.wins,
        losses: p.losses,
        ties: p.ties,
      })),
    })
  } catch (e) {
    return json(
      { error: "leaderboard read failed", detail: e instanceof Error ? e.message : String(e) },
      500,
    )
  }
}
