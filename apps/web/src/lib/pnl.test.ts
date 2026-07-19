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
import { liveCardPnl, tickCardPnl, type SwipeLite } from "./pnl"

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

describe("tickCardPnl", () => {
  const NOW = 1_700_000_000_000
  const STRIKE = "64506000000000" // $64,506 at 1e9 scale
  const Q = "6000000" // 6 dUSDC at 1e6
  const down: SwipeLite = { isUp: false, quantity: Q }
  const up: SwipeLite = { isUp: true, quantity: Q }

  test("settled market locks to settlementPrice — live spot can't flip it", () => {
    // Settlement below strike: ↓ won. The live spot has since risen ABOVE
    // the strike — the production bug where a won card rendered as a loss
    // because the mark kept following the live spot after expiry.
    const tick = {
      spot: "64520000000000", // above strike now
      expiryMs: NOW - 60_000, // expired a minute ago
      settlementPrice: "64497165000000", // settled below strike
    }
    expect(tickCardPnl(down, STRIKE, tick, NOW)).toBe(6000000n)
    expect(tickCardPnl(up, STRIKE, tick, NOW)).toBe(-6000000n)
  })

  test("unsettled market keeps marking from the live spot", () => {
    const tick = { spot: "64520000000000", expiryMs: NOW + 60_000 }
    const pnl = tickCardPnl(up, STRIKE, tick, NOW)
    // In-the-money but not expired — a continuous mark strictly between
    // the binary extremes.
    expect(pnl).not.toBeNull()
    expect(pnl! > 0n).toBe(true)
    expect(pnl! < 6000000n).toBe(true)
  })

  test("no tick / no swipe → null", () => {
    expect(tickCardPnl(down, STRIKE, undefined, NOW)).toBeNull()
    expect(
      tickCardPnl(null, STRIKE, { spot: "64520000000000" }, NOW)
    ).toBeNull()
  })
})
