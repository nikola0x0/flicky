import { describe, expect, test } from "bun:test"
import { duelUnsettleable, missingSides } from "./duel-state"

const cards = [
  { expiry_market_id: "m0" },
  { expiry_market_id: "m1" },
  { expiry_market_id: "m2" },
]
const swipe = { isUp: true, quantity: "1", orderId: "1" }
const row = (i: number, p0: boolean, p1: boolean) => ({
  cardIdx: i,
  p0Swipe: p0 ? swipe : null,
  p1Swipe: p1 ? swipe : null,
})

describe("duelUnsettleable", () => {
  test("settled market with a missing swipe → dead", () => {
    // The production case: p1 swiped card 0 only, p0 nothing, markets
    // m0/m1 already settled — keeper's bothDone gate never opens.
    const duel = {
      status: "ACTIVE",
      cards,
      swipes: [row(0, false, true)],
    }
    expect(duelUnsettleable(duel, new Set(["m0", "m1"]))).toBe(true)
  })

  test("all swipes in on settled markets → still settleable", () => {
    const duel = {
      status: "ACTIVE",
      cards,
      swipes: [row(0, true, true), row(1, true, true), row(2, true, true)],
    }
    expect(duelUnsettleable(duel, new Set(["m0", "m1"]))).toBe(false)
  })

  test("missing swipes only on still-live markets → not dead yet", () => {
    const duel = {
      status: "ACTIVE",
      cards,
      swipes: [row(0, true, true)],
    }
    expect(duelUnsettleable(duel, new Set(["m0"]))).toBe(false)
  })

  test("non-ACTIVE duels are never dead", () => {
    const duel = { status: "COMPLETE", cards, swipes: [] }
    expect(duelUnsettleable(duel, new Set(["m0", "m1", "m2"]))).toBe(false)
  })
})

describe("missingSides", () => {
  test("attributes the abandonment to the right side(s)", () => {
    const duel = { cards, swipes: [row(0, false, true)] }
    // m0 settled: p0 missing there; m2 settled with NO row: both missing.
    expect(missingSides(duel, new Set(["m0"]))).toEqual({ p0: true, p1: false })
    expect(missingSides(duel, new Set(["m0", "m2"]))).toEqual({
      p0: true,
      p1: true,
    })
  })
})
