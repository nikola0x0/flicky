/**
 * Card-source seam.
 *
 * Deliberately tests the deck LAYOUT against a supplied spot rather than
 * stubbing the price feed: conflating the two is how you get a green test
 * over a broken price path (which is exactly what happened first time —
 * the stub hid that spot was being read from a dead host).
 */
import { describe, expect, test } from "bun:test"
import {
  PYTH_SETTLE_OFFSETS_MS,
  buildPythDeck,
  pythCardSource,
  NoCardsAvailableError,
} from "./card-source"
import { commitDeck } from "./deckmaster"
import { pythPriceTo1e9 } from "./pyth"
import { env } from "./env"

const seed = new Uint8Array(32).fill(7)
const SPOT = 64_618_866_809_340n // $64,618.87 in 1e9-fixed USD

describe("buildPythDeck", () => {
  const now = 1_700_000_000_000
  const built = buildPythDeck(SPOT, seed, now)

  test("emits a full deck with aligned settle times", () => {
    expect(built.source).toBe("pyth")
    expect(built.cards.length).toBeGreaterThan(0)
    expect(built.settleAtMs.length).toBe(built.cards.length)
  })

  test("settle times are ours, ascending, and in the future", () => {
    for (const t of built.settleAtMs) expect(t).toBeGreaterThan(now)
    expect(built.settleAtMs).toEqual(
      [...built.settleAtMs].sort((a, b) => a - b)
    )
  })

  test("every card carries the Pyth feed id, so CardSettled is self-describing", () => {
    for (const c of built.cards) expect(c.expiryMarketId).toBe(env.pythFeedId)
  })

  test("strikes are distinct — cards share one market id, so this is load-bearing", () => {
    // Two cards with the same (market, strike) would be an identical
    // commitment in the deck hash.
    const strikes = built.cards.map((c) => c.strike.toString())
    expect(new Set(strikes).size).toBe(strikes.length)
  })

  test("strikes sit near spot, not at absurd offsets", () => {
    for (const c of built.cards) {
      const bps = Number((c.strike - SPOT) * 10_000n) / Number(SPOT)
      expect(Math.abs(bps)).toBeLessThan(500) // < 5%
      expect(c.strike).toBeGreaterThan(0n)
    }
  })

  test("commits to a valid 32-byte deck hash", () => {
    expect(commitDeck(built.cards).hashHex).toMatch(/^0x[0-9a-f]{64}$/)
  })

  test("is deterministic for a given seed", () => {
    const again = buildPythDeck(SPOT, seed, now)
    expect(commitDeck(again.cards).hashHex).toBe(
      commitDeck(built.cards).hashHex
    )
  })

  test("rejects a non-positive spot instead of laying out garbage strikes", () => {
    expect(() => buildPythDeck(0n, seed, now)).toThrow(NoCardsAvailableError)
  })
})

describe("pythCardSource", () => {
  test("refuses the staked tier — nothing to mint against", async () => {
    await expect(
      pythCardSource.build({ seed, tier: "staked", nowMs: Date.now() })
    ).rejects.toThrow(NoCardsAvailableError)
  })
})

describe("PYTH_SETTLE_OFFSETS_MS", () => {
  test("ascending and inside the ~15-min duel envelope", () => {
    const offs = [...PYTH_SETTLE_OFFSETS_MS]
    expect(offs).toEqual([...offs].sort((a, b) => a - b))
    expect(offs[offs.length - 1]).toBeLessThanOrEqual(15 * 60_000)
    expect(offs[0]).toBeGreaterThan(60_000)
  })
})

describe("pythPriceTo1e9", () => {
  // The exponent handling is the highest-risk arithmetic here: a wrong scale
  // misprices every strike by orders of magnitude.
  test("negative exponent (the live feed shape)", () => {
    // 6461886680934 x 10^-8 = $64,618.86680934
    expect(pythPriceTo1e9(6_461_886_680_934n, 8, true)).toBe(
      64_618_866_809_340n
    )
  })

  test("zero exponent", () => {
    expect(pythPriceTo1e9(5n, 0, true)).toBe(5_000_000_000n)
  })

  test("positive exponent", () => {
    expect(pythPriceTo1e9(5n, 2, false)).toBe(500_000_000_000n)
  })

  test("rejects an implausible exponent rather than overflowing", () => {
    expect(() => pythPriceTo1e9(1n, 99, false)).toThrow(/implausible exponent/)
  })
})
