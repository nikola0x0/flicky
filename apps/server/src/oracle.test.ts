/**
 * ExpiryMarket object JSON → the shape `oracle_tick` / GET /oracle/:id
 * consume. 8-21 put `expiry` on the object itself; dropping it made every
 * tick go out as expiry "0", and the swipe UI hung on "Loading card 1…"
 * (`BigInt("0")` is falsy) while the countdown read as "time's up".
 */
import { describe, expect, test } from "bun:test"
import { parseExpiryMarketJson } from "./oracle"

describe("parseExpiryMarketJson", () => {
  test("forwards top-level expiry so oracle_tick is not 0", () => {
    const state = parseExpiryMarketJson({
      expiry: "1788161640000",
      settlement_price: null,
      strike_exposure: { settlement_price: "78142482324370" },
    })
    expect(state?.market?.expiry).toBe("1788161640000")
  })

  test("numeric expiry stringifies", () => {
    const state = parseExpiryMarketJson({ expiry: 1788161640000 })
    expect(state?.market?.expiry).toBe("1788161640000")
  })

  test("missing expiry is omitted, not coerced to 0", () => {
    const state = parseExpiryMarketJson({ settlement_price: null })
    expect(state?.market?.expiry).toBeUndefined()
  })

  test("null json is null", () => {
    expect(parseExpiryMarketJson(null)).toBeNull()
  })
})
