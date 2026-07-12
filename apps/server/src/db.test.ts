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
      await db.saveCursor("tracker-x", "eyJ0IjoxLCJlIjowfQ==")
      expect(await db.loadCursor("tracker-x")).toBe("eyJ0IjoxLCJlIjowfQ==")
    })

    test("saveCursor upserts — second save overwrites the first", async () => {
      await db.saveCursor("tracker-x", "eyJ0IjoxLCJlIjowfQ==")
      await db.saveCursor("tracker-x", "eyJ0IjoyLCJlIjowfQ==")
      expect(await db.loadCursor("tracker-x")).toBe("eyJ0IjoyLCJlIjowfQ==")
    })

    test("different tracker ids have independent cursors", async () => {
      await db.saveCursor("tracker-x", "cursor-x")
      await db.saveCursor("tracker-y", "cursor-y")
      expect(await db.loadCursor("tracker-x")).toBe("cursor-x")
      expect(await db.loadCursor("tracker-y")).toBe("cursor-y")
    })
  })

  describe("listCursors", () => {
    test("returns all rows with updatedAt", async () => {
      await db.saveCursor("a", "cursor-a")
      await db.saveCursor("b", "cursor-b")
      const rows = await db.listCursors()
      expect(rows).toHaveLength(2)
      const map = new Map(rows.map((r) => [r.trackerId, r]))
      expect(map.get("a")?.cursor).toBe("cursor-a")
      expect(map.get("b")?.cursor).toBe("cursor-b")
      expect(map.get("a")?.updatedAt).toBeGreaterThan(0)
    })

    test("returns empty array when no cursors stored", async () => {
      expect(await db.listCursors()).toEqual([])
    })
  })

  describe("persistence", () => {
    test("data survives across a closeDb / re-open cycle", async () => {
      await db.saveCursor("survivor", "live-thru-reopen")
      await db.closeDb()
      // Next call re-creates the pool against the same DB — data persists.
      expect(await db.loadCursor("survivor")).toBe("live-thru-reopen")
    })
  })
})

describe.skipIf(!HAS_TEST_DB)("predict_manager cache", () => {
  beforeEach(async () => {
    await resetTables()
  })

  afterAll(async () => {
    await db.closeDb()
  })

  test("getCachedManager returns null when no row exists", async () => {
    expect(await db.getCachedManager("0xowner")).toBeNull()
  })

  test("cacheManager inserts; getCachedManager reads it back", async () => {
    await db.cacheManager("0xowner", "0xmgr")
    expect(await db.getCachedManager("0xowner")).toBe("0xmgr")
  })

  test("cacheManager upserts — a re-bootstrapped manager overwrites the old id", async () => {
    await db.cacheManager("0xowner", "0xmgr-old")
    await db.cacheManager("0xowner", "0xmgr-new")
    expect(await db.getCachedManager("0xowner")).toBe("0xmgr-new")
  })

  test("different owners have independent manager ids", async () => {
    await db.cacheManager("0xalice", "0xmgr-a")
    await db.cacheManager("0xbob", "0xmgr-b")
    expect(await db.getCachedManager("0xalice")).toBe("0xmgr-a")
    expect(await db.getCachedManager("0xbob")).toBe("0xmgr-b")
  })

  test("cache survives a closeDb / re-open cycle", async () => {
    await db.cacheManager("0xpersist", "0xmgr-persist")
    await db.closeDb()
    // Next call re-creates the pool against the same DB — data persists.
    expect(await db.getCachedManager("0xpersist")).toBe("0xmgr-persist")
  })
})

describe.skipIf(!HAS_TEST_DB)("player_profile (avatar)", () => {
  beforeEach(async () => {
    await resetTables()
  })

  afterAll(async () => {
    await db.closeDb()
  })

  test("getAvatarIcon returns null when no row exists", async () => {
    expect(await db.getAvatarIcon("0xnobody")).toBeNull()
  })

  test("setAvatarIcon inserts; getAvatarIcon reads it back", async () => {
    await db.setAvatarIcon("0xalice", "apple")
    expect(await db.getAvatarIcon("0xalice")).toBe("apple")
  })

  test("setAvatarIcon upserts — a new pick overwrites the old", async () => {
    await db.setAvatarIcon("0xalice", "apple")
    await db.setAvatarIcon("0xalice", "crab")
    expect(await db.getAvatarIcon("0xalice")).toBe("crab")
  })

  test("setAvatarIcon(null) clears the selection", async () => {
    await db.setAvatarIcon("0xalice", "apple")
    await db.setAvatarIcon("0xalice", null)
    expect(await db.getAvatarIcon("0xalice")).toBeNull()
  })

  test("getAvatarIcons batch returns only addresses that have a row", async () => {
    await db.setAvatarIcon("0xalice", "apple")
    await db.setAvatarIcon("0xbob", "crab")
    const map = await db.getAvatarIcons(["0xalice", "0xbob", "0xcarol"])
    expect(map["0xalice"]).toBe("apple")
    expect(map["0xbob"]).toBe("crab")
    expect(map["0xcarol"]).toBeUndefined()
  })

  test("getAvatarIcons([]) returns an empty object", async () => {
    expect(await db.getAvatarIcons([])).toEqual({})
  })
})
