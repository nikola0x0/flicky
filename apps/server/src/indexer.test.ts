/**
 * Unit tests for the indexer's pure projection helper. Network-free —
 * exercises the (cards, swipes, settlements, order premiums) →
 * cardOutcomes math the duel contract's `settle_card` uses internally
 * per card.
 */
import { describe, expect, test } from "bun:test"
import { computeCardOutcomes } from "./indexer"

describe("computeCardOutcomes", () => {
  test("returns empty when no markets settled", () => {
    const out = computeCardOutcomes({
      cards: [
        { expiry_market_id: "0xA", strike: "100" },
        { expiry_market_id: "0xB", strike: "200" },
      ],
      p0Swipes: [{ isUp: true, quantity: "1000000", orderId: "1" }, null],
      p1Swipes: [null, null],
      expiryMarketSettlements: new Map(),
      orderPremiums: new Map([["0xA:1", "300000"]]),
    })
    expect(out).toEqual([])
  })

  test("projects only cards whose expiry market has settled", () => {
    const out = computeCardOutcomes({
      cards: [
        { expiry_market_id: "0xA", strike: "100" },
        { expiry_market_id: "0xB", strike: "200" },
      ],
      p0Swipes: [
        { isUp: true, quantity: "1000000", orderId: "1" },
        { isUp: false, quantity: "1000000", orderId: "2" },
      ],
      p1Swipes: [null, null],
      expiryMarketSettlements: new Map([["0xA", "150"]]),
      orderPremiums: new Map([
        ["0xA:1", "300000"],
        ["0xB:2", "700000"],
      ]),
    })
    expect(out.length).toBe(1)
    expect(out[0].cardIdx).toBe(0)
    expect(out[0].upWon).toBe(true) // 150 > 100
    expect(out[0].p0Pnl).toBe("700000") // 1_000_000 - 300_000
    expect(out[0].p1Pnl).toBe(null)
  })

  test("uses each card's own expiry market (multi-market deck)", () => {
    const out = computeCardOutcomes({
      cards: [
        { expiry_market_id: "0xA", strike: "100" },
        { expiry_market_id: "0xB", strike: "200" },
      ],
      p0Swipes: [
        { isUp: true, quantity: "1000000", orderId: "1" },
        { isUp: true, quantity: "1000000", orderId: "2" },
      ],
      p1Swipes: [null, null],
      // If we (incorrectly) used one shared price, p0Pnl would be wrong on one.
      expiryMarketSettlements: new Map([
        ["0xA", "50"], // below 100 → UP loses
        ["0xB", "250"], // above 200 → UP wins
      ]),
      orderPremiums: new Map([
        ["0xA:1", "300000"],
        ["0xB:2", "500000"],
      ]),
    })
    expect(out.length).toBe(2)
    expect(out[0].upWon).toBe(false)
    expect(out[0].p0Pnl).toBe("-300000")
    expect(out[1].upWon).toBe(true)
    expect(out[1].p0Pnl).toBe("500000")
  })

  test("equal settlement_price counts as DOWN (strict >)", () => {
    // Contract semantics: upWon = settlement_price > strike. Equality
    // means DOWN wins (no rounding-up favoritism for UP).
    const out = computeCardOutcomes({
      cards: [{ expiry_market_id: "0xA", strike: "100" }],
      p0Swipes: [{ isUp: false, quantity: "1000000", orderId: "1" }],
      p1Swipes: [{ isUp: true, quantity: "1000000", orderId: "2" }],
      expiryMarketSettlements: new Map([["0xA", "100"]]),
      orderPremiums: new Map([
        ["0xA:1", "400000"],
        ["0xA:2", "600000"],
      ]),
    })
    expect(out[0].upWon).toBe(false)
    expect(out[0].p0Pnl).toBe("600000") // DOWN won: 1_000_000 - 400_000
    expect(out[0].p1Pnl).toBe("-600000") // UP lost: 0 - 600_000
  })

  test("missing order premium defaults to 0 (best-effort preview)", () => {
    // The order_premiums mirror may lag the OrderMinted event — the
    // preview should degrade to premium=0 rather than throwing/NaN-ing.
    const out = computeCardOutcomes({
      cards: [{ expiry_market_id: "0xA", strike: "100" }],
      p0Swipes: [{ isUp: true, quantity: "1000000", orderId: "1" }],
      p1Swipes: [null],
      expiryMarketSettlements: new Map([["0xA", "150"]]),
      orderPremiums: new Map(), // no entry for 0xA:1
    })
    expect(out[0].p0Pnl).toBe("1000000") // 1_000_000 - 0
  })
})
