/**
 * Unit tests for the indexer's pure projection helper. Network-free —
 * exercises the (cards, swipes, settlements) → cardOutcomes math the
 * duel contract's `settle_card` uses internally per card.
 */
import { describe, expect, test } from "bun:test"
import { computeCardOutcomes } from "./indexer"

describe("computeCardOutcomes", () => {
  test("returns empty when no oracles settled", () => {
    const out = computeCardOutcomes({
      cards: [
        { oracle_id: "0xA", strike: "100" },
        { oracle_id: "0xB", strike: "200" },
      ],
      p0Swipes: [
        { isUp: true, quantity: "1000000", premium: "300000" },
        null,
      ],
      p1Swipes: [null, null],
      oracleSettlements: new Map(),
    })
    expect(out).toEqual([])
  })

  test("projects only cards whose oracle has settled", () => {
    const out = computeCardOutcomes({
      cards: [
        { oracle_id: "0xA", strike: "100" },
        { oracle_id: "0xB", strike: "200" },
      ],
      p0Swipes: [
        { isUp: true, quantity: "1000000", premium: "300000" },
        { isUp: false, quantity: "1000000", premium: "700000" },
      ],
      p1Swipes: [null, null],
      oracleSettlements: new Map([["0xA", "150"]]),
    })
    expect(out.length).toBe(1)
    expect(out[0].cardIdx).toBe(0)
    expect(out[0].upWon).toBe(true) // 150 > 100
    expect(out[0].p0Pnl).toBe("700000") // 1_000_000 - 300_000
    expect(out[0].p1Pnl).toBe(null)
  })

  test("uses each card's own oracle (multi-oracle deck)", () => {
    const out = computeCardOutcomes({
      cards: [
        { oracle_id: "0xA", strike: "100" },
        { oracle_id: "0xB", strike: "200" },
      ],
      p0Swipes: [
        { isUp: true, quantity: "1000000", premium: "300000" },
        { isUp: true, quantity: "1000000", premium: "500000" },
      ],
      p1Swipes: [null, null],
      // If we (incorrectly) used one shared price, p0Pnl would be wrong on one.
      oracleSettlements: new Map([
        ["0xA", "50"], // below 100 → UP loses
        ["0xB", "250"], // above 200 → UP wins
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
      cards: [{ oracle_id: "0xA", strike: "100" }],
      p0Swipes: [{ isUp: false, quantity: "1000000", premium: "400000" }],
      p1Swipes: [{ isUp: true, quantity: "1000000", premium: "600000" }],
      oracleSettlements: new Map([["0xA", "100"]]),
    })
    expect(out[0].upWon).toBe(false)
    expect(out[0].p0Pnl).toBe("600000") // DOWN won: 1_000_000 - 400_000
    expect(out[0].p1Pnl).toBe("-600000") // UP lost: 0 - 600_000
  })
})
