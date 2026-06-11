/**
 * Clear the local duel mirror. Deletes rows from the `duel` table only —
 * `event_cursor` is left intact so the indexer resumes forward and does NOT
 * re-pull the deleted duels. New duels created after this runs are indexed
 * fresh.
 *
 * NOTE: the settled-redeem keeper discovers duels from on-chain DuelCreated
 * events, not this table, so clearing here does not stop keeper retries on a
 * stuck on-chain duel — it only cleans the UI/history mirror.
 *
 * Stop the server first (the DB is single-writer; a running indexer could
 * re-add duels mid-run).
 *
 *   bun run clear:duels          # clear ALL duels
 *   bun run clear:duels 0xabc…   # clear one duel by id
 */
import { Database } from "bun:sqlite"
import { env } from "../env"

const onlyId = process.argv[2]
// Open the existing DB read/write; fail loud if it's missing rather than
// silently creating an empty one (a path typo shouldn't look like success).
const db = new Database(env.dbPath, { readwrite: true, create: false })

const before = (
  db.query("SELECT COUNT(*) AS n FROM duel").get() as { n: number }
).n

if (onlyId) {
  const res = db.run("DELETE FROM duel WHERE id = ?", [onlyId])
  console.log(`deleted ${res.changes} duel(s) matching ${onlyId}`)
} else {
  const res = db.run("DELETE FROM duel")
  console.log(`deleted ${res.changes} duel(s) (was ${before} total)`)
}

// Reclaim the freed pages so the file shrinks.
db.run("VACUUM")

const after = (
  db.query("SELECT COUNT(*) AS n FROM duel").get() as { n: number }
).n
console.log(`duel rows remaining: ${after}`)
db.close()
