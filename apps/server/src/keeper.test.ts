/**
 * Keeper parsing tests — focus on the pure helpers that decode on-chain
 * shapes. The full settle PTB path involves RPC + signing and is
 * exercised by `src/scripts/e2e.test.ts` (opt-in live testnet).
 */
import { describe, expect, test } from "bun:test"
import { Transaction } from "@mysten/sui/transactions"
import { env } from "./env"
import {
  hexFromBytes,
  isTerminalSettleError,
  parseDuelFromObject,
  parseSwipe,
  readyCardIndices,
  resolveCardPremiums,
} from "./keeper"

describe("isTerminalSettleError", () => {
  test("EDuelNotActive (named) → terminal, stop retrying", () => {
    expect(
      isTerminalSettleError("MoveAbort in flicky::duel: EDuelNotActive")
    ).toBe(true)
  })

  test("raw duel abort code 2 → terminal", () => {
    expect(
      isTerminalSettleError(
        'MoveAbort(MoveLocation { module: ModuleId { address: 0xabc, name: Identifier("duel") }, function: 5, instruction: 10, function_name: Some("finalize") }, 2) in command 6'
      )
    ).toBe(true)
  })

  test("predict_manager::decrease_position abort → terminal (4-16 legacy: position already redeemed)", () => {
    // The exact dry-run budget error the keeper hit on a stuck duel: a
    // redeem aborts because the player's Predict position was already
    // redeemed (EInsufficientPosition, code 1). Before the fix the keeper
    // logged this every poll forever.
    const msg =
      'Dry run failed, could not automatically determine a budget: MoveAbort(MoveLocation { module: ModuleId { address: f5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138, name: Identifier("predict_manager") }, function: 9, instruction: 24, function_name: Some("decrease_position") }, 1) in command 7'
    expect(isTerminalSettleError(msg)).toBe(true)
  })

  test("EZeroSettlement (named) → NOT terminal (keeper-fed price of 0; retry with a resolved price)", () => {
    expect(
      isTerminalSettleError("MoveAbort in flicky::duel: EZeroSettlement")
    ).toBe(false)
  })

  test("raw duel abort code 14 → NOT terminal", () => {
    expect(
      isTerminalSettleError(
        'MoveAbort(MoveLocation { module: ModuleId { address: 0xabc, name: Identifier("duel") }, function: 12, instruction: 3, function_name: Some("settle_card") }, 14) in command 0'
      )
    ).toBe(false)
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

  test("parses {is_up, quantity, order_id} into SwipeLite (6-24 shape)", () => {
    const out = parseSwipe({
      is_up: true,
      quantity: "1000000",
      order_id: "123456789012345678901234567890",
    })
    expect(out).not.toBeNull()
    expect(out!.isUp).toBe(true)
    expect(out!.quantity).toBe(1_000_000n)
    expect(out!.orderId).toBe(123456789012345678901234567890n)
  })

  test("preserves false is_up", () => {
    const out = parseSwipe({
      is_up: false,
      quantity: "1",
      order_id: "2",
    })
    expect(out?.isUp).toBe(false)
  })
})

describe("parseDuelFromObject", () => {
  const FRESH_DUEL_FIELDS = {
    id: "0x6aeaf9f99c0090f6f2e14be729e90f0473255479469971444d36e7f401f3faaa",
    status: "2", // ACTIVE
    deck_hash: [0xab, 0xcd, 0xef] as number[],
    creator:
      "0x9c08a74cca711f45a176765e9db499f01def450fa90320a4c23934b2082aa882",
    challenger:
      "0x62dab70b5e879cd3a215fee9569587da86b362492dc41f2a2573f569755f4cc8",
    p0_stake: "5000000",
    p1_stake: "5000000",
    cards: [
      {
        expiry_market_id:
          "0x420f5040ea1dec75a15183b2bc39aee40e6f5f26643b6f186357224050614ece",
        strike: "74098253655589",
      },
      {
        expiry_market_id:
          "0x2c2057537b36280fbaf4a7d7448a9b99aa17e4fa5f08fa1cedcdc81ef7cc159b",
        strike: "75123456789012",
      },
    ],
    p0_swipes: [{ is_up: true, quantity: "100000", order_id: "111" }, null],
    p1_swipes: [null, { is_up: false, quantity: "200000", order_id: "222" }],
  }

  test("returns null when fields missing or wrong shape", () => {
    expect(parseDuelFromObject(undefined, null)).toBeNull()
    expect(parseDuelFromObject(undefined, "string")).toBeNull()
    expect(parseDuelFromObject(undefined, {})).toBeNull()
  })

  test("extracts core fields + maps status", () => {
    const d = parseDuelFromObject(
      "0xPKG::duel::Duel<0xCT::dusdc::DUSDC>",
      FRESH_DUEL_FIELDS
    )
    expect(d).not.toBeNull()
    expect(d!.status).toBe("ACTIVE")
    expect(d!.stakeCoinType).toBe("0xCT::dusdc::DUSDC")
    expect(d!.creator).toBe(FRESH_DUEL_FIELDS.creator)
    expect(d!.challenger).toBe(FRESH_DUEL_FIELDS.challenger)
    expect(d!.p0Stake).toBe(5_000_000n)
    expect(d!.p1Stake).toBe(5_000_000n)
  })

  test("parses cards with normalized expiry_market_id + bigint strike (6-24 shape)", () => {
    const d = parseDuelFromObject(undefined, FRESH_DUEL_FIELDS)!
    expect(d.cards).toHaveLength(2)
    expect(d.cards[0].strike).toBe(74_098_253_655_589n)
    expect(d.cards[0].expiryMarketId).toBe(
      FRESH_DUEL_FIELDS.cards[0].expiry_market_id
    )
  })

  test("p0_swipes / p1_swipes parsed with quantity + order_id (6-24 contract shape)", () => {
    const d = parseDuelFromObject(undefined, FRESH_DUEL_FIELDS)!
    // P0 swiped card 0 UP with quantity 100k, order_id 111
    expect(d.p0Swipes[0]).not.toBeNull()
    expect(d.p0Swipes[0]!.isUp).toBe(true)
    expect(d.p0Swipes[0]!.quantity).toBe(100_000n)
    expect(d.p0Swipes[0]!.orderId).toBe(111n)
    expect(d.p0Swipes[1]).toBeNull()
    // P1 swiped card 1 DOWN with quantity 200k, order_id 222
    expect(d.p1Swipes[0]).toBeNull()
    expect(d.p1Swipes[1]).not.toBeNull()
    expect(d.p1Swipes[1]!.isUp).toBe(false)
    expect(d.p1Swipes[1]!.quantity).toBe(200_000n)
    expect(d.p1Swipes[1]!.orderId).toBe(222n)
  })

  test("REGRESSION: rejects the legacy {is_up, premium} 4-16 shape (missing order_id)", () => {
    // If the contract reverts to the old swipe shape, order_id will come
    // back as `undefined` → BigInt(undefined) throws. We want a clear
    // failure rather than silently wrong numbers.
    const legacyFields = {
      ...FRESH_DUEL_FIELDS,
      p0_swipes: [
        // Old (4-16) shape — order_id field is missing.
        { is_up: true, quantity: "500000", premium: "30000" },
        null,
      ],
    } as unknown as typeof FRESH_DUEL_FIELDS
    expect(() => parseDuelFromObject(undefined, legacyFields)).toThrow()
  })

  test("falls back to SUI stake coin type when type tag is malformed", () => {
    const d = parseDuelFromObject("not-a-Duel-type", FRESH_DUEL_FIELDS)!
    expect(d.stakeCoinType).toBe("0x2::sui::SUI")
  })

  test("cards_settled defaults to all-false when absent (backward compat)", () => {
    const d = parseDuelFromObject(undefined, FRESH_DUEL_FIELDS)!
    expect(d.cardsSettled).toEqual([false, false])
  })

  test("cards_settled is read through when present", () => {
    const d = parseDuelFromObject(undefined, {
      ...FRESH_DUEL_FIELDS,
      cards_settled: [true, false],
    })!
    expect(d.cardsSettled).toEqual([true, false])
  })
})

describe("settle PTB shape (6-24 model)", () => {
  // Builds the same PTB shape `Keeper.tryClose` builds, given already-resolved
  // keeper-fed values (settlement price, premiums, wrappers) — asserts arg
  // counts/order without touching RPC/signing.
  const packageId =
    "0xf1a1c1c1000000000000000000000000000000000000000000000000000001"
  const duelId =
    "0xd0e10000000000000000000000000000000000000000000000000000000001"
  const stakeCoinType =
    "0xc01e000000000000000000000000000000000000000000000000000000001::dusdc::DUSDC"
  const p0Wrapper =
    "0x00000000000000000000000000000000000000000000000000000000000a01"
  const p1Wrapper =
    "0x00000000000000000000000000000000000000000000000000000000000a02"
  const expiryMarketId =
    "0x0000000000000000000000000000000000000000000000000000000000e001"
  const orderId = 42n

  test("settle_card is built with 7 args incl. settlement_price + both premiums", () => {
    const tx = new Transaction()
    tx.moveCall({
      target: `${packageId}::duel::settle_card`,
      typeArguments: [stakeCoinType],
      arguments: [
        tx.object(duelId),
        tx.object(p0Wrapper),
        tx.object(p1Wrapper),
        tx.pure.u64(0n),
        tx.pure.u64(63_800_000_000_000n), // settlement_price
        tx.pure.u64(30_000n), // p0_premium
        tx.pure.u64(80_000n), // p1_premium
      ],
    })
    const data = tx.getData()
    const call = data.commands[0]
    expect(call.$kind).toBe("MoveCall")
    if (call.$kind !== "MoveCall") throw new Error("unreachable")
    expect(call.MoveCall.function).toBe("settle_card")
    expect(call.MoveCall.arguments).toHaveLength(7)
    expect(call.MoveCall.typeArguments).toEqual([stakeCoinType])
  })

  test("finalize is built with duel + clock (2 args)", () => {
    const tx = new Transaction()
    tx.moveCall({
      target: `${packageId}::duel::finalize`,
      typeArguments: [stakeCoinType],
      arguments: [tx.object(duelId), tx.object("0x6")],
    })
    const call = tx.getData().commands[0]
    expect(call.$kind).toBe("MoveCall")
    if (call.$kind !== "MoveCall") throw new Error("unreachable")
    expect(call.MoveCall.function).toBe("finalize")
    expect(call.MoveCall.arguments).toHaveLength(2)
  })

  test("redeem_settled is built with the 10-arg 6-24 object graph and NO type argument (non-generic — DUSDC is hardcoded inside)", () => {
    const tx = new Transaction()
    tx.moveCall({
      target: `${env.deepbookPredictPackageId}::expiry_market::redeem_settled`,
      arguments: [
        tx.object(expiryMarketId),
        tx.object(env.accountRegistryId),
        tx.object(p0Wrapper),
        tx.object(env.protocolConfigId),
        tx.object(env.oracleRegistryId),
        tx.object(env.pythFeedId),
        tx.pure.u256(orderId),
        tx.pure.u64(1_000_000n),
        tx.object(env.accumulatorRootId),
        tx.object("0x6"),
      ],
    })
    const call = tx.getData().commands[0]
    expect(call.$kind).toBe("MoveCall")
    if (call.$kind !== "MoveCall") throw new Error("unreachable")
    expect(call.MoveCall.function).toBe("redeem_settled")
    expect(call.MoveCall.module).toBe("expiry_market")
    expect(call.MoveCall.arguments).toHaveLength(10)
    // `redeem_settled` takes ZERO type parameters — passing one aborts the
    // whole settle PTB (Move arity mismatch). See keeper.ts moveCall above.
    expect(call.MoveCall.typeArguments).toEqual([])
  })
})

describe("resolveCardPremiums (symmetric fallback)", () => {
  test("both resolved → passes through real values", () => {
    expect(
      resolveCardPremiums(
        { value: 30_000n, resolved: true },
        { value: 80_000n, resolved: true }
      )
    ).toEqual({ p0Premium: 30_000n, p1Premium: 80_000n })
  })

  test("p0 fails, p1 resolves to a real (non-zero) value → BOTH zeroed, not just p0", () => {
    // Regression for the asymmetric-fallback bug: val0 = p0_payout +
    // p1_premium vs val1 = p1_payout + p0_premium — feeding p1's real
    // premium while p0 falls back to 0 would bias the winner decision.
    expect(
      resolveCardPremiums(
        { value: 0n, resolved: false },
        { value: 80_000n, resolved: true }
      )
    ).toEqual({ p0Premium: 0n, p1Premium: 0n })
  })

  test("p1 fails, p0 resolves to a real (non-zero) value → BOTH zeroed, not just p1", () => {
    expect(
      resolveCardPremiums(
        { value: 30_000n, resolved: true },
        { value: 0n, resolved: false }
      )
    ).toEqual({ p0Premium: 0n, p1Premium: 0n })
  })

  test("both fail → both zeroed (already symmetric)", () => {
    expect(
      resolveCardPremiums(
        { value: 0n, resolved: false },
        { value: 0n, resolved: false }
      )
    ).toEqual({ p0Premium: 0n, p1Premium: 0n })
  })
})

describe("readyCardIndices (per-card incremental settlement)", () => {
  const cards = [
    { expiryMarketId: "0xshort1" },
    { expiryMarketId: "0xshort2" },
    { expiryMarketId: "0xlong" }, // e.g. a multi-hour straggler market
  ]

  test("a settled market with an unsettled card → that card is ready", () => {
    const settlementByMarket = new Map([["0xshort1", 63_000_000_000_000n]])
    expect(
      readyCardIndices(cards, [false, false, false], settlementByMarket)
    ).toEqual([0])
  })

  test("mixed deck: short markets settle, one long straggler doesn't block them", () => {
    // This is the exact scenario the fix targets: cards 0 and 1 finished
    // minutes ago, card 2's market won't expire for hours.
    const settlementByMarket = new Map([
      ["0xshort1", 63_000_000_000_000n],
      ["0xshort2", 63_100_000_000_000n],
    ])
    expect(
      readyCardIndices(cards, [false, false, false], settlementByMarket)
    ).toEqual([0, 1])
  })

  test("already-settled cards are excluded even if the market has a price", () => {
    const settlementByMarket = new Map([
      ["0xshort1", 63_000_000_000_000n],
      ["0xshort2", 63_100_000_000_000n],
    ])
    // Card 0 already settled on-chain in an earlier pass.
    expect(
      readyCardIndices(cards, [true, false, false], settlementByMarket)
    ).toEqual([1])
  })

  test("no eligible markets → empty", () => {
    expect(readyCardIndices(cards, [false, false, false], new Map())).toEqual(
      []
    )
  })

  test("all cards already settled → empty, even with prices available", () => {
    const settlementByMarket = new Map([
      ["0xshort1", 63_000_000_000_000n],
      ["0xshort2", 63_100_000_000_000n],
      ["0xlong", 63_200_000_000_000n],
    ])
    expect(
      readyCardIndices(cards, [true, true, true], settlementByMarket)
    ).toEqual([])
  })

  test("two cards sharing one market both become ready together", () => {
    const sharedCards = [
      { expiryMarketId: "0xshared" },
      { expiryMarketId: "0xshared" },
    ]
    const settlementByMarket = new Map([["0xshared", 63_000_000_000_000n]])
    expect(
      readyCardIndices(sharedCards, [false, false], settlementByMarket)
    ).toEqual([0, 1])
  })
})
