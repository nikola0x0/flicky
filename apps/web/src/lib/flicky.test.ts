import { describe, expect, test } from "bun:test"
import { Transaction } from "@mysten/sui/transactions"
import type { SuiObjectResponse } from "@mysten/sui/jsonRpc"
import {
  buildCreateDuelTx,
  buildJoinDuelTx,
  buildRevealDeckTx,
  buildSettleAndFinalizeTx,
  buildSwipeTx,
  computeDeckHash,
  oracleStrikes,
  parseDuel,
  type DeckCard,
} from "./flicky"
import { CONFIG } from "./config"

// === oracleStrikes ===

describe("oracleStrikes", () => {
  test("derives 5 strikes at default percentages around the reference price", () => {
    const ref = 80_000_000_000_000n // $80k in 1e9
    const strikes = oracleStrikes(ref)
    expect(strikes).toHaveLength(5)
    expect(strikes[0]).toBe((ref * 95n) / 100n)
    expect(strikes[1]).toBe((ref * 98n) / 100n)
    expect(strikes[2]).toBe(ref)
    expect(strikes[3]).toBe((ref * 102n) / 100n)
    expect(strikes[4]).toBe((ref * 105n) / 100n)
  })

  test("honors a custom percentage grid", () => {
    const ref = 100_000_000_000n
    const strikes = oracleStrikes(ref, [90n, 100n, 110n])
    expect(strikes).toEqual([90_000_000_000n, 100_000_000_000n, 110_000_000_000n])
  })

  test("strikes are strictly monotonic", () => {
    const strikes = oracleStrikes(50_000_000_000_000n)
    for (let i = 1; i < strikes.length; i++) {
      expect(strikes[i] > strikes[i - 1]).toBe(true)
    }
  })
})

// === parseDuel ===

function makeDuelObject(overrides: Partial<Record<string, unknown>> = {}): SuiObjectResponse {
  return {
    data: {
      objectId: "0xabc",
      version: "1",
      digest: "fake",
      type: `${CONFIG.packageId}::duel::Duel<0x2::sui::SUI>`,
      content: {
        dataType: "moveObject",
        type: `${CONFIG.packageId}::duel::Duel<0x2::sui::SUI>`,
        hasPublicTransfer: false,
        fields: {
          id: { id: "0xabc000000000000000000000000000000000000000000000000000000000beef" },
          status: "2",
          cards: Array.from({ length: 5 }, (_, i) => ({
            type: `${CONFIG.packageId}::duel::Card`,
            fields: {
              oracle_id: "0xdeadbeef",
              strike: String(80_000_000_000_000n + BigInt(i) * 1_000_000_000n),
            },
          })),
          creator: "0xaaaaaa",
          challenger: "0xbbbbbb",
          p0_stake: { type: "0x2::balance::Balance<0x2::sui::SUI>", fields: { value: "10000000" } },
          p1_stake: { type: "0x2::balance::Balance<0x2::sui::SUI>", fields: { value: "10000000" } },
          p0_score: "3000000000",
          p1_score: "2500000000",
          p0_next_card_idx: "2",
          p1_next_card_idx: "1",
          p0_last_swipe_or_start_ms: "100",
          p1_last_swipe_or_start_ms: "150",
          settled_count: "1",
          started_at_ms: "1000",
          card_settlements: ["80000001000000000", null, null, null, null],
          p0_swipes: [
            {
              type: `${CONFIG.packageId}::duel::Swipe`,
              fields: { is_up: true, p_swiped: "499000000", decide_time_ms: "2000" },
            },
            null,
            null,
            null,
            null,
          ],
          p1_swipes: [null, null, null, null, null],
          ...overrides,
        },
      },
    },
  } as unknown as SuiObjectResponse
}

describe("parseDuel", () => {
  test("parses every top-level field", () => {
    const d = parseDuel(makeDuelObject())
    expect(d.status).toBe("ACTIVE")
    expect(d.creator).toBe("0xaaaaaa")
    expect(d.challenger).toBe("0xbbbbbb")
    expect(d.stakeCoinType).toBe("0x2::sui::SUI")
    expect(d.p0Stake).toBe(10_000_000n)
    expect(d.p1Stake).toBe(10_000_000n)
    expect(d.p0Score).toBe(3_000_000_000n)
    expect(d.p1Score).toBe(2_500_000_000n)
    expect(d.p0NextCardIdx).toBe(2n)
    expect(d.p1NextCardIdx).toBe(1n)
    expect(d.settledCount).toBe(1n)
    expect(d.startedAtMs).toBe(1000n)
    expect(d.p0LastSwipeOrStartMs).toBe(100n)
    expect(d.p1LastSwipeOrStartMs).toBe(150n)
  })

  test("parses 5 cards with strikes", () => {
    const d = parseDuel(makeDuelObject())
    expect(d.cards).toHaveLength(5)
    expect(d.cards[0].strike).toBe(80_000_000_000_000n)
    expect(d.cards[4].strike).toBe(80_000_000_000_000n + 4_000_000_000n)
  })

  test("parses card_settlements as Option (string | null)", () => {
    const d = parseDuel(makeDuelObject())
    expect(d.cardSettlements[0]).toBe(80_000_001_000_000_000n)
    expect(d.cardSettlements[1]).toBeNull()
  })

  test("parses p0/p1 swipes Option array", () => {
    const d = parseDuel(makeDuelObject())
    expect(d.p0Swipes[0]).toEqual({
      isUp: true,
      pSwiped: 499_000_000n,
      decideTimeMs: 2_000n,
    })
    expect(d.p0Swipes[1]).toBeNull()
    expect(d.p1Swipes.every((s) => s === null)).toBe(true)
  })

  test("maps numeric status to enum string", () => {
    for (const [raw, expected] of [
      ["1", "PENDING"],
      ["2", "ACTIVE"],
      ["3", "COMPLETE"],
    ] as const) {
      const d = parseDuel(makeDuelObject({ status: raw }))
      expect(d.status).toBe(expected)
    }
  })

  test("throws if response is not a moveObject", () => {
    const bad = { data: { content: { dataType: "package" } } } as unknown as SuiObjectResponse
    expect(() => parseDuel(bad)).toThrow(/not a Move object/)
  })
})

// === PTB builders — verify shape via Transaction.getData() ===

function moveCallTargets(tx: Transaction): string[] {
  const data = tx.getData()
  const calls: string[] = []
  for (const cmd of data.commands) {
    if ("MoveCall" in cmd && cmd.MoveCall) {
      const mc = cmd.MoveCall
      calls.push(`${mc.package}::${mc.module}::${mc.function}`)
    }
  }
  return calls
}

describe("PTB builders", () => {
  const oracleId = "0xdeadbeef0000000000000000000000000000000000000000000000000000beef"
  const duelId = "0xfeedface0000000000000000000000000000000000000000000000000000face"
  const strikes: bigint[] = [95n, 98n, 100n, 102n, 105n].map(
    (p) => (80_000_000_000_000n * p) / 100n,
  )

  test("buildCreateDuelTx emits exactly one duel::create_duel call", async () => {
    const cards: DeckCard[] = strikes.map((strike) => ({ oracleId, strike }))
    const hash = await computeDeckHash(cards)
    const tx = buildCreateDuelTx(hash, 10_000_000n)
    const targets = moveCallTargets(tx)
    expect(targets).toHaveLength(1)
    expect(targets[0]).toMatch(/::duel::create_duel$/)
  })

  test("buildCreateDuelTx rejects deck hash of wrong length", () => {
    const bad = new Uint8Array(16)
    expect(() => buildCreateDuelTx(bad, 1n)).toThrow(/32 bytes/)
  })

  test("buildRevealDeckTx emits 5 new_card + 1 reveal_deck", () => {
    const cards: DeckCard[] = strikes.map((strike) => ({ oracleId, strike }))
    const tx = buildRevealDeckTx(duelId, cards)
    const targets = moveCallTargets(tx)
    expect(targets.filter((t) => t.endsWith("::duel::new_card"))).toHaveLength(5)
    expect(targets.filter((t) => t.endsWith("::duel::reveal_deck"))).toHaveLength(1)
  })

  test("buildRevealDeckTx rejects wrong card count", () => {
    expect(() => buildRevealDeckTx(duelId, [])).toThrow(/exactly 5/)
  })

  test("computeDeckHash returns 32 bytes deterministically", async () => {
    const cards: DeckCard[] = strikes.map((strike) => ({ oracleId, strike }))
    const a = await computeDeckHash(cards)
    const b = await computeDeckHash(cards)
    expect(a).toHaveLength(32)
    expect(Array.from(a)).toEqual(Array.from(b))
    // Different deck → different hash.
    const c = await computeDeckHash([
      ...cards.slice(0, 4),
      { oracleId, strike: cards[4].strike + 1n },
    ])
    expect(Array.from(a)).not.toEqual(Array.from(c))
  })

  test("buildJoinDuelTx emits exactly one duel::join_duel call", () => {
    const tx = buildJoinDuelTx(duelId, 10_000_000n)
    const targets = moveCallTargets(tx)
    expect(targets.filter((t) => t.endsWith("::duel::join_duel"))).toHaveLength(1)
  })

  test("buildSwipeTx emits exactly one duel::record_swipe call", () => {
    const tx = buildSwipeTx(duelId, oracleId, 0, true)
    const targets = moveCallTargets(tx)
    expect(targets).toHaveLength(1)
    expect(targets[0]).toMatch(/::duel::record_swipe$/)
  })

  test("buildSettleAndFinalizeTx emits 5 settle_card + 1 finalize", () => {
    const tx = buildSettleAndFinalizeTx(duelId, oracleId)
    const targets = moveCallTargets(tx)
    const settles = targets.filter((t) => t.endsWith("::duel::settle_card"))
    const finalizes = targets.filter((t) => t.endsWith("::duel::finalize"))
    expect(settles).toHaveLength(5)
    expect(finalizes).toHaveLength(1)
  })

  test("builders bake the configured package address into the call target", () => {
    const tx = buildSwipeTx(duelId, oracleId, 0, true)
    const targets = moveCallTargets(tx)
    expect(targets[0].startsWith(CONFIG.packageId)).toBe(true)
  })
})
