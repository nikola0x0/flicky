/**
 * Keeper parsing tests — focus on the pure helpers that decode on-chain
 * shapes. The full settle PTB path involves RPC + signing and is
 * exercised by `src/scripts/e2e.test.ts` (opt-in live testnet).
 */
import { describe, expect, test } from "bun:test"
import {
  hexFromBytes,
  isTerminalSettleError,
  parseDuelFromObject,
  parseSwipe,
} from "./keeper"

describe("isTerminalSettleError", () => {
  test("EDuelNotActive (named) → terminal, stop retrying", () => {
    expect(
      isTerminalSettleError("MoveAbort in flicky::duel: EDuelNotActive"),
    ).toBe(true)
  })

  test("raw duel abort code 2 → terminal", () => {
    expect(
      isTerminalSettleError(
        'MoveAbort(MoveLocation { module: ModuleId { address: 0xabc, name: Identifier("duel") }, function: 5, instruction: 10, function_name: Some("finalize") }, 2) in command 6',
      ),
    ).toBe(true)
  })

  test("predict_manager::decrease_position abort → terminal (position already redeemed)", () => {
    // The exact dry-run budget error the keeper hit on a stuck duel: a
    // redeem aborts because the player's Predict position was already
    // redeemed (EInsufficientPosition, code 1). Before the fix the keeper
    // logged this every poll forever.
    const msg =
      'Dry run failed, could not automatically determine a budget: MoveAbort(MoveLocation { module: ModuleId { address: f5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138, name: Identifier("predict_manager") }, function: 9, instruction: 24, function_name: Some("decrease_position") }, 1) in command 7'
    expect(isTerminalSettleError(msg)).toBe(true)
  })

  test("transient RPC / network error → NOT terminal (keep retrying)", () => {
    expect(isTerminalSettleError("fetch failed: ECONNRESET")).toBe(false)
    expect(isTerminalSettleError("Unexpected status code: 429")).toBe(false)
    expect(isTerminalSettleError("request timed out")).toBe(false)
  })
})

describe("hexFromBytes", () => {
  test("string input passes through with 0x lowercase", () => {
    expect(hexFromBytes("0xABCDEF")).toBe("0xabcdef")
    // gRPC json encodes vector<u8> as base64 — decode to hex
    expect(hexFromBytes("q83v")).toBe("0xabcdef") // base64 of [0xab,0xcd,0xef]
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
      is_up: true,
      quantity: "1000000",
      premium: "250000",
    })
    expect(out).not.toBeNull()
    expect(out!.isUp).toBe(true)
    expect(out!.quantity).toBe(1_000_000n)
    expect(out!.premium).toBe(250_000n)
  })

  test("preserves false is_up (regression for the old shape that used p_swiped)", () => {
    const out = parseSwipe({
      is_up: false,
      quantity: "1",
      premium: "2",
    })
    expect(out?.isUp).toBe(false)
  })
})

describe("parseDuelFromObject", () => {
  const FRESH_DUEL_FIELDS = {
    id: "0x6aeaf9f99c0090f6f2e14be729e90f0473255479469971444d36e7f401f3faaa",
    status: "2", // ACTIVE
    deck_hash: [0xab, 0xcd, 0xef] as number[],
    creator: "0x9c08a74cca711f45a176765e9db499f01def450fa90320a4c23934b2082aa882",
    challenger: "0x62dab70b5e879cd3a215fee9569587da86b362492dc41f2a2573f569755f4cc8",
    p0_stake: "5000000",
    p1_stake: "5000000",
    cards: [
      {
        oracle_id: "0x420f5040ea1dec75a15183b2bc39aee40e6f5f26643b6f186357224050614ece",
        strike: "74098253655589",
      },
      {
        oracle_id: "0x2c2057537b36280fbaf4a7d7448a9b99aa17e4fa5f08fa1cedcdc81ef7cc159b",
        strike: "75123456789012",
      },
    ],
    p0_swipes: [
      { is_up: true, quantity: "100000", premium: "30000" },
      null,
    ],
    p1_swipes: [
      null,
      { is_up: false, quantity: "200000", premium: "80000" },
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
    expect(d.cards[0].oracleId).toBe(FRESH_DUEL_FIELDS.cards[0].oracle_id)
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
        { is_up: true, p_swiped: "500000000", decide_time_ms: "2000" },
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
