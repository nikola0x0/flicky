/**
 * Clear the duel mirror. Deletes rows from the `duel` table only —
 * `event_cursor` is left intact so the indexer resumes forward and does NOT
 * re-pull the deleted duels. New duels created after this runs are indexed
 * fresh.
 *
 * NOTE: the settled-redeem keeper discovers duels from on-chain DuelCreated
 * events, not this table, so clearing here does not stop keeper retries on a
 * stuck on-chain duel — it only cleans the UI/history mirror.
 *
 * Reads DATABASE_URL from the environment (apps/server/.env). Point it at the
 * public proxy URL when running locally against the Railway Postgres.
 *
 *   bun run clear:duels          # clear ALL duels
 *   bun run clear:duels 0xabc…   # clear one duel by id
 */
import { closeDb, getSql, ready } from "../db"

const onlyId = process.argv[2]

await ready()
const sql = getSql()

const [{ c: before }] = (await sql`SELECT COUNT(*)::int AS c FROM duel`) as Array<{
  c: number
}>

if (onlyId) {
  const deleted = (await sql`DELETE FROM duel WHERE id = ${onlyId} RETURNING id`) as Array<{
    id: string
  }>
  console.log(`deleted ${deleted.length} duel(s) matching ${onlyId}`)
} else {
  const deleted = (await sql`DELETE FROM duel RETURNING id`) as Array<{ id: string }>
  console.log(`deleted ${deleted.length} duel(s) (was ${before} total)`)
}

const [{ c: after }] = (await sql`SELECT COUNT(*)::int AS c FROM duel`) as Array<{
  c: number
}>
console.log(`duel rows remaining: ${after}`)
await closeDb()
