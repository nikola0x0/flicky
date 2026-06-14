/**
 * Bun test preload. Tests must NEVER touch a real DATABASE_URL (e.g. one
 * in .env pointing at the Railway Postgres) — they run only against an
 * explicit, throwaway TEST_DATABASE_URL. We rewrite the env here, before
 * env.ts captures DATABASE_URL at module-load time:
 *
 *   - TEST_DATABASE_URL set   → use it as DATABASE_URL (DB suites run)
 *   - TEST_DATABASE_URL unset → clear DATABASE_URL (DB suites skip)
 *
 * Spin up a throwaway Postgres and point the suite at it, e.g.:
 *   docker run -d --name flicky-test-pg -e POSTGRES_PASSWORD=test \
 *     -e POSTGRES_DB=flicky_test -p 55432:5432 postgres:16-alpine
 *   TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/flicky_test bun test
 */
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
} else {
  delete process.env.DATABASE_URL
}
