/**
 * SQLite cursor round-trip tests. We point FLICKY_DB_PATH at a temp file
 * BEFORE importing the db module so its module-level singleton picks up
 * the override. Each test resets via `closeDb()` so a fresh `getDb()`
 * call re-opens against the same temp file.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

let dbModule: typeof import("./db")
let tmpDir: string
let dbPath: string

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "flicky-db-test-"))
  dbPath = resolve(tmpDir, "test.db")
  process.env.FLICKY_DB_PATH = dbPath
  // Dynamic import — env.ts reads dbPath at module-load time, so this
  // must run AFTER the env override.
  dbModule = await import("./db")
})

afterAll(() => {
  dbModule?.closeDb()
  rmSync(tmpDir, { recursive: true, force: true })
})

beforeEach(() => {
  // Force a fresh DB connection per test for isolation. Each test
  // creates / clears its own rows.
  dbModule.closeDb()
  // Wipe known tables. We get a fresh DB handle on the next getDb().
  const fresh = dbModule.getDb()
  fresh.exec("DELETE FROM event_cursor")
})

describe("getDb (smoke test)", () => {
  test("opens the DB, writes + reads a sentinel, applies WAL mode", () => {
    const db = dbModule.getDb()
    const row = db
      .query<{ journal_mode: string }, []>("PRAGMA journal_mode")
      .get()
    expect(row?.journal_mode).toBe("wal")
  })

  test("creates the event_cursor table", () => {
    const db = dbModule.getDb()
    const row = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='event_cursor'",
      )
      .get()
    expect(row?.name).toBe("event_cursor")
  })
})

describe("loadCursor + saveCursor", () => {
  test("loadCursor returns null when no row exists", () => {
    expect(dbModule.loadCursor("tracker-x")).toBeNull()
  })

  test("saveCursor inserts a new row; loadCursor reads it back", () => {
    dbModule.saveCursor("tracker-x", { txDigest: "AAA", eventSeq: "0" })
    expect(dbModule.loadCursor("tracker-x")).toEqual({
      txDigest: "AAA",
      eventSeq: "0",
    })
  })

  test("saveCursor upserts — second save overwrites the first", () => {
    dbModule.saveCursor("tracker-x", { txDigest: "AAA", eventSeq: "0" })
    dbModule.saveCursor("tracker-x", { txDigest: "BBB", eventSeq: "5" })
    expect(dbModule.loadCursor("tracker-x")).toEqual({
      txDigest: "BBB",
      eventSeq: "5",
    })
  })

  test("different tracker ids have independent cursors", () => {
    dbModule.saveCursor("tracker-x", { txDigest: "AAA", eventSeq: "0" })
    dbModule.saveCursor("tracker-y", { txDigest: "BBB", eventSeq: "1" })
    expect(dbModule.loadCursor("tracker-x")?.txDigest).toBe("AAA")
    expect(dbModule.loadCursor("tracker-y")?.txDigest).toBe("BBB")
  })
})

describe("listCursors", () => {
  test("returns all rows with updatedAt", () => {
    dbModule.saveCursor("a", { txDigest: "tx-a", eventSeq: "0" })
    dbModule.saveCursor("b", { txDigest: "tx-b", eventSeq: "0" })
    const rows = dbModule.listCursors()
    expect(rows).toHaveLength(2)
    const map = new Map(rows.map((r) => [r.trackerId, r]))
    expect(map.get("a")?.txDigest).toBe("tx-a")
    expect(map.get("b")?.txDigest).toBe("tx-b")
    expect(map.get("a")?.updatedAt).toBeGreaterThan(0)
  })

  test("returns empty array when no cursors stored", () => {
    expect(dbModule.listCursors()).toEqual([])
  })
})

describe("close + reopen", () => {
  test("data persists across closeDb / getDb cycle", () => {
    dbModule.saveCursor("survivor", { txDigest: "live-thru-reopen", eventSeq: "42" })
    dbModule.closeDb()
    // Next getDb() reopens — data should be there.
    const second = dbModule.loadCursor("survivor")
    expect(second).toEqual({ txDigest: "live-thru-reopen", eventSeq: "42" })
  })
})
