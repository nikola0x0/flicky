/**
 * Postgres cursor + schema round-trip tests. Run against a throwaway
 * Postgres via TEST_DATABASE_URL (see test-preload.ts); the suite skips
 * itself when none is configured.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import * as db from "./db"
import { HAS_TEST_DB, resetTables } from "./test-db"

describe.skipIf(!HAS_TEST_DB)("db (Postgres)", () => {
  beforeEach(async () => {
    await resetTables()
  })

  afterAll(async () => {
    await db.closeDb()
  })

  describe("schema", () => {
    test("ready() creates tables — countDuels works on an empty DB", async () => {
      expect(await db.countDuels()).toBe(0)
    })
  })

  describe("loadCursor + saveCursor", () => {
    test("loadCursor returns null when no row exists", async () => {
      expect(await db.loadCursor("tracker-x")).toBeNull()
    })

    test("saveCursor inserts a new row; loadCursor reads it back", async () => {
      await db.saveCursor("tracker-x", { txDigest: "AAA", eventSeq: "0" })
      expect(await db.loadCursor("tracker-x")).toEqual({
        txDigest: "AAA",
        eventSeq: "0",
      })
    })

    test("saveCursor upserts — second save overwrites the first", async () => {
      await db.saveCursor("tracker-x", { txDigest: "AAA", eventSeq: "0" })
      await db.saveCursor("tracker-x", { txDigest: "BBB", eventSeq: "5" })
      expect(await db.loadCursor("tracker-x")).toEqual({
        txDigest: "BBB",
        eventSeq: "5",
      })
    })

    test("different tracker ids have independent cursors", async () => {
      await db.saveCursor("tracker-x", { txDigest: "AAA", eventSeq: "0" })
      await db.saveCursor("tracker-y", { txDigest: "BBB", eventSeq: "1" })
      expect((await db.loadCursor("tracker-x"))?.txDigest).toBe("AAA")
      expect((await db.loadCursor("tracker-y"))?.txDigest).toBe("BBB")
    })
  })

  describe("listCursors", () => {
    test("returns all rows with updatedAt", async () => {
      await db.saveCursor("a", { txDigest: "tx-a", eventSeq: "0" })
      await db.saveCursor("b", { txDigest: "tx-b", eventSeq: "0" })
      const rows = await db.listCursors()
      expect(rows).toHaveLength(2)
      const map = new Map(rows.map((r) => [r.trackerId, r]))
      expect(map.get("a")?.txDigest).toBe("tx-a")
      expect(map.get("b")?.txDigest).toBe("tx-b")
      expect(map.get("a")?.updatedAt).toBeGreaterThan(0)
    })

    test("returns empty array when no cursors stored", async () => {
      expect(await db.listCursors()).toEqual([])
    })
  })

  describe("persistence", () => {
    test("data survives across a closeDb / re-open cycle", async () => {
      await db.saveCursor("survivor", {
        txDigest: "live-thru-reopen",
        eventSeq: "42",
      })
      await db.closeDb()
      // Next call re-creates the pool against the same DB — data persists.
      expect(await db.loadCursor("survivor")).toEqual({
        txDigest: "live-thru-reopen",
        eventSeq: "42",
      })
    })
  })
})
