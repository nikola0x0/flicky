/**
 * Unit tests for the web-side PnL projection helpers. Pure functions —
 * no network or React. Mirror the math in apps/playground's E2EFlowPanel
 * `liveCardPnl` / `markCardPnl` and the contract's finalize scoring.
 *
 * 6-24: the swipe wire dropped per-swipe `premium` (only `orderId`
 * remains), so these helpers project BINARY pnl from spot-vs-strike +
 * direction: a correct call is worth `+quantity`, an incorrect one
 * `-quantity` — no cost basis is netted in (see pnl.ts docstring).
 */
import { describe, expect, test } from "bun:test"
import { liveCardPnl } from "./pnl"

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
