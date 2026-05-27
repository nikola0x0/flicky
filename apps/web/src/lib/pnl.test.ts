/**
 * Unit tests for the web-side PnL projection helpers. Pure functions —
 * no network or React. Mirror the math in apps/playground's E2EFlowPanel
 * `liveCardPnl` / `runningPnl` and the contract's finalize scoring.
 */
import { describe, expect, test } from "bun:test"
import { liveCardPnl, runningPnl } from "./pnl"

describe("liveCardPnl", () => {
  test("returns null when swipe missing", () => {
    expect(liveCardPnl(null, "100", "120")).toBeNull()
  })

  test("returns null when strike or forward missing", () => {
    const sw = { isUp: true, quantity: "1000000", premium: "300000" }
    expect(liveCardPnl(sw, undefined, "120")).toBeNull()
    expect(liveCardPnl(sw, "100", undefined)).toBeNull()
  })

  test("UP swipe favored when forward > strike", () => {
    // quantity = 1e9, FLOAT_SCALING = 1e9 → pnl == (forward - strike).
    const sw = { isUp: true, quantity: "1000000000", premium: "0" }
    expect(liveCardPnl(sw, "100", "120")).toBe(20n)
  })

  test("UP swipe penalized when forward < strike", () => {
    const sw = { isUp: true, quantity: "1000000000", premium: "0" }
    expect(liveCardPnl(sw, "100", "80")).toBe(-20n)
  })

  test("DOWN swipe inverts sign", () => {
    const sw = { isUp: false, quantity: "1000000000", premium: "0" }
    expect(liveCardPnl(sw, "100", "120")).toBe(-20n)
    expect(liveCardPnl(sw, "100", "80")).toBe(20n)
  })
})

describe("runningPnl", () => {
  const deck = {
    cards: [
      { oracle_id: "0xA", strike: "100" },
      { oracle_id: "0xB", strike: "200" },
    ],
  }
  const ticks = {
    "0xA": { spot: "100", forward: "110" },
    "0xB": { spot: "200", forward: "190" },
  }

  test("sums settled + live for the same side", () => {
    const rs = {
      p0Payout: "700000",
      p0Premium: "300000",
      p1Payout: "0",
      p1Premium: "0",
      cardOutcomes: [{ cardIdx: 0 }],
      swipes: [
        {
          cardIdx: 0,
          p0Swipe: { isUp: true, quantity: "1000000", premium: "300000" },
          p1Swipe: null,
        },
        {
          cardIdx: 1,
          p0Swipe: { isUp: false, quantity: "1000000000", premium: "0" },
          p1Swipe: null,
        },
      ],
    }
    // settled = 700_000 - 300_000 = 400_000
    // live (card 1, DOWN, forward 190 vs strike 200) = (200 - 190) * 1e9 / 1e9 = 10
    // total = 400_010
    expect(runningPnl(rs, "p0", deck, ticks)).toBe(400010n)
  })

  test("returns settled-only when no live ticks for unsettled cards", () => {
    const rs = {
      p0Payout: "500000",
      p0Premium: "200000",
      p1Payout: "0",
      p1Premium: "0",
      cardOutcomes: [{ cardIdx: 0 }, { cardIdx: 1 }],
      swipes: [],
    }
    expect(runningPnl(rs, "p0", deck, ticks)).toBe(300000n)
  })

  test("skips swipes without ticks (honest unknown)", () => {
    const rs = {
      p0Payout: "0",
      p0Premium: "0",
      p1Payout: "0",
      p1Premium: "0",
      cardOutcomes: [],
      swipes: [
        {
          cardIdx: 0,
          p0Swipe: { isUp: true, quantity: "1000000000", premium: "0" },
          p1Swipe: null,
        },
      ],
    }
    // Tick for oracle A is present (we'll use it) so PnL = 110 - 100 = 10.
    expect(runningPnl(rs, "p0", deck, ticks)).toBe(10n)
    // Same call, but with empty ticks → no live contribution.
    expect(runningPnl(rs, "p0", deck, {})).toBe(0n)
  })
})
