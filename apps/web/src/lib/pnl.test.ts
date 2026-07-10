/**
 * Unit tests for the web-side PnL projection helpers. Pure functions —
 * no network or React. Mirror the math in apps/playground's E2EFlowPanel
 * `liveCardPnl` / `runningPnl` and the contract's finalize scoring.
 *
 * 6-24: the swipe wire dropped per-swipe `premium` (only `orderId`
 * remains), so these helpers project BINARY pnl from spot-vs-strike +
 * direction: a correct call is worth `+quantity`, an incorrect one
 * `-quantity` — no cost basis is netted in (see pnl.ts docstring).
 */
import { describe, expect, test } from "bun:test"
import { liveCardPnl, runningPnl } from "./pnl"

describe("liveCardPnl", () => {
  test("returns null when swipe missing", () => {
    expect(liveCardPnl(null, "100", "120")).toBeNull()
  })

  test("returns null when strike or spot missing", () => {
    const sw = { isUp: true, quantity: "1000000" }
    expect(liveCardPnl(sw, undefined, "120")).toBeNull()
    expect(liveCardPnl(sw, "100", undefined)).toBeNull()
  })

  test("UP swipe wins full quantity when spot > strike", () => {
    const sw = { isUp: true, quantity: "1000000" }
    expect(liveCardPnl(sw, "100", "120")).toBe(1000000n)
  })

  test("UP swipe loses full quantity when spot <= strike", () => {
    const sw = { isUp: true, quantity: "1000000" }
    expect(liveCardPnl(sw, "100", "80")).toBe(-1000000n)
    expect(liveCardPnl(sw, "100", "100")).toBe(-1000000n)
  })

  test("DOWN swipe inverts the in-money condition", () => {
    const sw = { isUp: false, quantity: "1000000" }
    expect(liveCardPnl(sw, "100", "120")).toBe(-1000000n)
    expect(liveCardPnl(sw, "100", "80")).toBe(1000000n)
    expect(liveCardPnl(sw, "100", "100")).toBe(1000000n)
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
    "0xA": { spot: "110" },
    "0xB": { spot: "190" },
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
          p0Swipe: { isUp: true, quantity: "1000000" },
          p1Swipe: null,
        },
        {
          cardIdx: 1,
          p0Swipe: { isUp: false, quantity: "1000000" },
          p1Swipe: null,
        },
      ],
    }
    // settled = 700_000 - 300_000 = 400_000
    // live (card 1, DOWN, spot 190 <= strike 200 → in money) = +1_000_000
    // total = 1_400_000
    expect(runningPnl(rs, "p0", deck, ticks)).toBe(1400000n)
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
          p0Swipe: { isUp: true, quantity: "1000000" },
          p1Swipe: null,
        },
      ],
    }
    // Tick for oracle A is present (spot 110 > strike 100 → in money for
    // UP) so PnL = +1_000_000.
    expect(runningPnl(rs, "p0", deck, ticks)).toBe(1000000n)
    // Same call, but with empty ticks → no live contribution.
    expect(runningPnl(rs, "p0", deck, {})).toBe(0n)
  })
})
