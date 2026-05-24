/**
 * Keeper parsing tests — focus on the pure helpers that decode on-chain
 * shapes. The full settle PTB path involves RPC + signing and is
 * exercised by `src/scripts/e2e.test.ts` (opt-in live testnet).
 */
import { describe, expect, test } from "bun:test"
import { hexFromBytes, parseDuelFromObject, parseSwipe } from "./keeper"

describe("hexFromBytes", () => {
  test("string input passes through with 0x lowercase", () => {
    expect(hexFromBytes("0xABCDEF")).toBe("0xabcdef")
    expect(hexFromBytes("aaff")).toBe("0xaaff") // adds 0x if missing
  })

  test("byte array input is hex-encoded with leading zeros", () => {
    expect(hexFromBytes([0x01, 0x0a, 0xff])).toBe("0x010aff")
    expect(hexFromBytes(new Array(32).fill(0))).toBe("0x" + "00".repeat(32))
  })
})

describe("parseSwipe", () => {
  test("returns null for null input", () => {
    expect(parseSwipe(null)).toBeNull()
  })

  test("parses {is_up, quantity, premium} into SwipeLite", () => {
    const out = parseSwipe({
      fields: { is_up: true, quantity: "1000000", premium: "250000" },
    })
    expect(out).not.toBeNull()
    expect(out!.isUp).toBe(true)
    expect(out!.quantity).toBe(1_000_000n)
    expect(out!.premium).toBe(250_000n)
  })

  test("preserves false is_up (regression for the old shape that used p_swiped)", () => {
    const out = parseSwipe({
      fields: { is_up: false, quantity: "1", premium: "2" },
    })
    expect(out?.isUp).toBe(false)
  })
})

describe("parseDuelFromObject", () => {
  const FRESH_DUEL_FIELDS = {
    id: { id: "0x6aeaf9f99c0090f6f2e14be729e90f0473255479469971444d36e7f401f3faaa" },
    status: "2", // ACTIVE
    deck_hash: [0xab, 0xcd, 0xef] as number[],
    creator: "0x9c08a74cca711f45a176765e9db499f01def450fa90320a4c23934b2082aa882",
    challenger: "0x62dab70b5e879cd3a215fee9569587da86b362492dc41f2a2573f569755f4cc8",
    p0_stake: { fields: { value: "5000000" } },
    p1_stake: { fields: { value: "5000000" } },
    cards: [
      {
        fields: {
          oracle_id: "0x420f5040ea1dec75a15183b2bc39aee40e6f5f26643b6f186357224050614ece",
          strike: "74098253655589",
        },
      },
      {
        fields: {
          oracle_id: "0x2c2057537b36280fbaf4a7d7448a9b99aa17e4fa5f08fa1cedcdc81ef7cc159b",
          strike: "75123456789012",
        },
      },
    ],
    card_settlements: [null, "75000000000000"] as Array<string | null>,
    p0_swipes: [
      { fields: { is_up: true, quantity: "100000", premium: "30000" } },
      null,
    ],
    p1_swipes: [
      null,
      { fields: { is_up: false, quantity: "200000", premium: "80000" } },
    ],
  }

  test("returns null when fields missing or wrong shape", () => {
    expect(parseDuelFromObject(undefined, null)).toBeNull()
    expect(parseDuelFromObject(undefined, "string")).toBeNull()
    expect(parseDuelFromObject(undefined, {})).toBeNull()
  })

  test("extracts core fields + maps status", () => {
    const d = parseDuelFromObject(
      "0xPKG::duel::Duel<0xCT::dusdc::DUSDC>",
      FRESH_DUEL_FIELDS,
    )
    expect(d).not.toBeNull()
    expect(d!.status).toBe("ACTIVE")
    expect(d!.stakeCoinType).toBe("0xCT::dusdc::DUSDC")
    expect(d!.creator).toBe(FRESH_DUEL_FIELDS.creator)
    expect(d!.challenger).toBe(FRESH_DUEL_FIELDS.challenger)
    expect(d!.p0Stake).toBe(5_000_000n)
    expect(d!.p1Stake).toBe(5_000_000n)
  })

  test("parses cards with normalized oracle ids + bigint strike", () => {
    const d = parseDuelFromObject(undefined, FRESH_DUEL_FIELDS)!
    expect(d.cards).toHaveLength(2)
    expect(d.cards[0].strike).toBe(74_098_253_655_589n)
    expect(d.cards[0].oracleId).toBe(FRESH_DUEL_FIELDS.cards[0].fields.oracle_id)
  })

  test("card_settlements null/string handled", () => {
    const d = parseDuelFromObject(undefined, FRESH_DUEL_FIELDS)!
    expect(d.cardSettlements[0]).toBeNull()
    expect(d.cardSettlements[1]).toBe(75_000_000_000_000n)
  })

  test("p0_swipes / p1_swipes parsed with quantity + premium (new contract shape)", () => {
    const d = parseDuelFromObject(undefined, FRESH_DUEL_FIELDS)!
    // P0 swiped card 0 UP with quantity 100k, premium 30k
    expect(d.p0Swipes[0]).not.toBeNull()
    expect(d.p0Swipes[0]!.isUp).toBe(true)
    expect(d.p0Swipes[0]!.quantity).toBe(100_000n)
    expect(d.p0Swipes[0]!.premium).toBe(30_000n)
    expect(d.p0Swipes[1]).toBeNull()
    // P1 swiped card 1 DOWN with quantity 200k, premium 80k
    expect(d.p1Swipes[0]).toBeNull()
    expect(d.p1Swipes[1]).not.toBeNull()
    expect(d.p1Swipes[1]!.isUp).toBe(false)
    expect(d.p1Swipes[1]!.quantity).toBe(200_000n)
    expect(d.p1Swipes[1]!.premium).toBe(80_000n)
  })

  test("REGRESSION: rejects the legacy {is_up, p_swiped, decide_time_ms} shape", () => {
    // If the contract reverts to the old swipe shape, quantity will
    // come back as `undefined` → BigInt(undefined) throws. We want a
    // clear failure rather than silently wrong numbers.
    const legacyFields = {
      ...FRESH_DUEL_FIELDS,
      p0_swipes: [
        // Old shape — quantity + premium fields are missing.
        { fields: { is_up: true, p_swiped: "500000000", decide_time_ms: "2000" } },
        null,
      ],
    } as unknown as typeof FRESH_DUEL_FIELDS
    expect(() => parseDuelFromObject(undefined, legacyFields)).toThrow()
  })

  test("falls back to SUI stake coin type when type tag is malformed", () => {
    const d = parseDuelFromObject("not-a-Duel-type", FRESH_DUEL_FIELDS)!
    expect(d.stakeCoinType).toBe("0x2::sui::SUI")
  })
})
