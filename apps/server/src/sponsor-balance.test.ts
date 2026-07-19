import { describe, expect, test } from "bun:test"
import { evaluateBalance, parseAddressBalance } from "./sponsor-balance"

describe("parseAddressBalance", () => {
  test("pulls the nested addressBalance (not the flat balance)", () => {
    const res = {
      balance: {
        balance: "2272953924",
        coinBalance: "1",
        addressBalance: "2272953923",
      },
    }
    // Must read addressBalance (the gas source), NOT the total balance.
    expect(parseAddressBalance(res)).toBe(2272953923n)
  })

  test("accepts numeric and bigint shapes", () => {
    expect(parseAddressBalance({ balance: { addressBalance: 500 } })).toBe(500n)
    expect(parseAddressBalance({ balance: { addressBalance: 7n } })).toBe(7n)
  })

  test("throws when the field is absent (never a silent zero)", () => {
    // A missing field must NOT read as a low balance and page a false alarm,
    // nor as a healthy zero — it's an error the caller logs and retries.
    expect(() => parseAddressBalance({ balance: {} })).toThrow()
    expect(() => parseAddressBalance({})).toThrow()
    expect(() =>
      parseAddressBalance({ balance: { addressBalance: null } })
    ).toThrow()
  })
})

describe("evaluateBalance", () => {
  const ADDR = "0x9c08"
  const WARN = 500_000_000n // 0.5 SUI

  test("flags low strictly below the threshold", () => {
    const s = evaluateBalance(ADDR, 2_078_868n, WARN, 1000)
    expect(s.low).toBe(true)
    expect(s.address).toBe(ADDR)
    expect(s.addressBalanceMist).toBe("2078868")
    expect(s.warnBelowMist).toBe("500000000")
    expect(s.checkedAtMs).toBe(1000)
  })

  test("healthy at or above the threshold", () => {
    expect(evaluateBalance(ADDR, 2_272_953_923n, WARN, 0).low).toBe(false)
    // Exactly at the floor is NOT low (strict less-than).
    expect(evaluateBalance(ADDR, WARN, WARN, 0).low).toBe(false)
    // One MIST under is low.
    expect(evaluateBalance(ADDR, WARN - 1n, WARN, 0).low).toBe(true)
  })
})
