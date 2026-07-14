import { describe, expect, test } from "bun:test"
import { isValidTier, parseClientMsg, STAKE_TIERS } from "./protocol"

describe("STAKE_TIERS", () => {
  test("covers every PRD tier name + practice + starter", () => {
    // PRD §Stake tiers: 1 / 3 / 5 / 10 dUSDC. Practice is no-stake solo
    // vs. bot. We name them practice / starter / casual / standard /
    // high_roller server-side.
    expect(STAKE_TIERS.practice).toBe(0n)
    expect(STAKE_TIERS.starter).toBe(1_000_000n)
    expect(STAKE_TIERS.casual).toBe(3_000_000n)
    expect(STAKE_TIERS.standard).toBe(5_000_000n)
    expect(STAKE_TIERS.high_roller).toBe(10_000_000n)
  })
})

describe("isValidTier", () => {
  test("returns true for known tiers", () => {
    for (const t of Object.keys(STAKE_TIERS)) {
      expect(isValidTier(t)).toBe(true)
    }
  })

  test("returns false for unknown / mistyped strings", () => {
    expect(isValidTier("Casual")).toBe(false) // case-sensitive
    expect(isValidTier("vip")).toBe(false)
    expect(isValidTier("")).toBe(false)
  })

  test("returns false for non-strings", () => {
    expect(isValidTier(undefined)).toBe(false)
    expect(isValidTier(null)).toBe(false)
    expect(isValidTier(123)).toBe(false)
    expect(isValidTier({})).toBe(false)
  })
})

describe("parseClientMsg", () => {
  test("parses a valid hello message", () => {
    const msg = parseClientMsg(
      JSON.stringify({ type: "hello", address: "0xabc" })
    )
    expect(msg?.type).toBe("hello")
    if (msg?.type === "hello") expect(msg.address).toBe("0xabc")
  })

  test("parses queue_join with tier", () => {
    const msg = parseClientMsg(
      JSON.stringify({ type: "queue_join", tier: "casual" })
    )
    expect(msg?.type).toBe("queue_join")
  })

  test("parses practice_start (no args)", () => {
    const msg = parseClientMsg(JSON.stringify({ type: "practice_start" }))
    expect(msg?.type).toBe("practice_start")
  })

  test("returns null for invalid JSON", () => {
    expect(parseClientMsg("not json")).toBeNull()
    expect(parseClientMsg("")).toBeNull()
    expect(parseClientMsg("{")).toBeNull()
  })

  test("returns null when type field is missing or non-string", () => {
    expect(parseClientMsg(JSON.stringify({ foo: "bar" }))).toBeNull()
    expect(parseClientMsg(JSON.stringify({ type: 42 }))).toBeNull()
    expect(parseClientMsg(JSON.stringify(null))).toBeNull()
    expect(parseClientMsg(JSON.stringify("string-not-object"))).toBeNull()
  })

  test("parses spot_subscribe / spot_unsubscribe (no args)", () => {
    expect(
      parseClientMsg(JSON.stringify({ type: "spot_subscribe" }))?.type
    ).toBe("spot_subscribe")
    expect(
      parseClientMsg(JSON.stringify({ type: "spot_unsubscribe" }))?.type
    ).toBe("spot_unsubscribe")
  })
})
