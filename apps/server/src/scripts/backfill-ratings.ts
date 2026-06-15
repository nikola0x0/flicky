/**
 * Rebuild the leaderboard (player_rating) from the duel mirror.
 *
 * Live ELO updates are stream-only — written by the indexer's
 * `DuelFinalized` handler as events pass — and are NOT reconstructable. So
 * after a rating-DB reset (or if the event cursor advanced past a
 * finalization), the leaderboard can be empty even though the duel mirror
 * still holds the COMPLETE rows. This wipes player_rating and replays every
 * COMPLETE duel through the same ELO step, in finalization order, making the
 * leaderboard a pure function of the mirror.
 *
 * Idempotent — safe to re-run (it always wipes first).
 *
 * Stop the server first: the DB is single-writer, and a live finalization
 * landing mid-replay would be double-counted.
 *
 *   bun run backfill:ratings
 */
import { recomputeRatingsFromMirror, topLeaderboard } from "../mmr"
import { closeDb } from "../db"

const { cleared, applied, skipped } = await recomputeRatingsFromMirror()
console.log(
  `backfill: cleared ${cleared} rating row(s), replayed ${applied} duel(s)` +
    (skipped ? `, skipped ${skipped} (missing players)` : ""),
)

const top = await topLeaderboard(20)
if (top.length === 0) {
  console.log("leaderboard is empty — no COMPLETE duels in the mirror.")
} else {
  console.log(`\ntop ${top.length}:`)
  for (const [i, p] of top.entries()) {
    console.log(
      `  ${(i + 1).toString().padStart(2)} ${p.address.slice(0, 10)}…  ` +
        `${p.rating}  (${p.wins}W ${p.losses}L ${p.ties}T / ${p.gamesPlayed})`,
    )
  }
}

// Close the pool so the script exits instead of hanging on an open connection.
await closeDb()
