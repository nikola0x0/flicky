/**
 * MMR ELO math + window-expanding pair selection. Runs against a throwaway
 * Postgres via TEST_DATABASE_URL (see test-preload.ts); skips when none is
 * configured.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import * as db from "./db"
import * as mmr from "./mmr"
import { HAS_TEST_DB, resetTables } from "./test-db"

describe.skipIf(!HAS_TEST_DB)("mmr", () => {
  beforeEach(async () => {
    await resetTables()
  })

  afterAll(async () => {
    await db.closeDb()
  })

  describe("applyDuelOutcome (ELO)", () => {
    test("equal-rated win moves the winner up by ~K/2 (default K=32 → 16)", async () => {
      const r = await mmr.applyDuelOutcome("0xa", "0xb", "p0_win")
      expect(r.p0Before).toBe(1000)
      expect(r.p1Before).toBe(1000)
      expect(r.p0After - r.p0Before).toBe(16)
      expect(r.p1After - r.p1Before).toBe(-16)
    })

    test("equal-rated tie produces no rating change", async () => {
      const r = await mmr.applyDuelOutcome("0xa", "0xb", "tie")
      expect(r.p0After).toBe(r.p0Before)
      expect(r.p1After).toBe(r.p1Before)
    })

    test("favourite winning gains less than an upset victory", async () => {
      // P0 starts much higher (1400), so beating P1 (1000) is "expected".
      await db.upsertPlayerRating({
        address: "0xa", rating: 1400, gamesPlayed: 0, wins: 0, losses: 0, ties: 0, lastUpdatedMs: 0,
      })
      const fav = await mmr.applyDuelOutcome("0xa", "0xb", "p0_win")
      const favGain = fav.p0After - fav.p0Before

      // Reset, then have low-rated P1 win an upset.
      await db.getSql()`DELETE FROM player_rating`
      await db.upsertPlayerRating({
        address: "0xa", rating: 1400, gamesPlayed: 0, wins: 0, losses: 0, ties: 0, lastUpdatedMs: 0,
      })
      const upset = await mmr.applyDuelOutcome("0xa", "0xb", "p1_win")
      const upsetGain = upset.p1After - upset.p1Before

      expect(upsetGain).toBeGreaterThan(favGain)
    })

    test("win/loss/tie counters increment correctly", async () => {
      await mmr.applyDuelOutcome("0xa", "0xb", "p0_win")
      await mmr.applyDuelOutcome("0xa", "0xb", "tie")
      await mmr.applyDuelOutcome("0xa", "0xb", "p1_win")
      const a = await db.getPlayerRating("0xa")
      const b = await db.getPlayerRating("0xb")
      expect(a.gamesPlayed).toBe(3)
      expect(a.wins).toBe(1)
      expect(a.losses).toBe(1)
      expect(a.ties).toBe(1)
      expect(b.wins).toBe(1) // 0xb won the upset, lost the first, tied the second
      expect(b.losses).toBe(1)
      expect(b.ties).toBe(1)
    })
  })

  describe("findClosestOpponent (window-expanding)", () => {
    test("returns null when pool is empty", async () => {
      expect(await mmr.findClosestOpponent(1000, Date.now(), [])).toBeNull()
    })

    test("matches inside the window, ignores outside", async () => {
      await db.upsertPlayerRating({
        address: "0xclose", rating: 1100, gamesPlayed: 1, wins: 0, losses: 0, ties: 0, lastUpdatedMs: 0,
      })
      await db.upsertPlayerRating({
        address: "0xfar", rating: 1600, gamesPlayed: 1, wins: 0, losses: 0, ties: 0, lastUpdatedMs: 0,
      })
      const now = Date.now()
      const pick = await mmr.findClosestOpponent(1000, now, [
        { address: "0xfar", queuedAtMs: now },
        { address: "0xclose", queuedAtMs: now },
      ])
      expect(pick?.address).toBe("0xclose")
    })

    test("expanding window eventually catches a far opponent", async () => {
      await db.upsertPlayerRating({
        address: "0xfar", rating: 1600, gamesPlayed: 1, wins: 0, losses: 0, ties: 0, lastUpdatedMs: 0,
      })
      const now = Date.now()
      // Both queued 60s ago → window = 200 + 60*20 = 1400 (covers ±600 gap)
      const queuedAt = now - 60_000
      const pick = await mmr.findClosestOpponent(1000, queuedAt, [
        { address: "0xfar", queuedAtMs: queuedAt },
      ])
      expect(pick?.address).toBe("0xfar")
    })
  })
})
