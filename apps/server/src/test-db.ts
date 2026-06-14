/**
 * Shared Postgres test helpers. DB-backed suites run ONLY when an explicit
 * throwaway TEST_DATABASE_URL is provided (mapped to DATABASE_URL by
 * test-preload.ts); otherwise they skip via `describe.skipIf(!HAS_TEST_DB)`,
 * so `bun test` never mutates a real database.
 */
import { getSql, ready } from "./db"

export const HAS_TEST_DB = !!process.env.TEST_DATABASE_URL

/** Wipe every table to a clean slate. No-op when no test DB is configured. */
export async function resetTables(): Promise<void> {
  if (!HAS_TEST_DB) return
  await ready()
  await getSql()`
    TRUNCATE event_cursor, duel, chat_message, player_rating, deck
    RESTART IDENTITY
  `
}
