import { describe, expect, test } from "bun:test"
import { Transaction } from "@mysten/sui/transactions"
import type { SuiObjectResponse } from "@mysten/sui/jsonRpc"
import {
  buildCreateDuelDusdcTx,
  buildCreateDuelTx,
  buildJoinDuelDusdcTx,
  buildJoinDuelTx,
  buildRevealDeckTx,
  buildFinalizeTx,
  buildSwipeTx,
  computeDeckHash,
  oracleStrikes,
  parseDuel,
  type DeckCard,
} from "./flicky"
import { CONFIG } from "./config"

// Minimal SuiClient mock for the dUSDC builders. They only call
// `client.getCoins({ owner, coinType })`; nothing else.
function mockClient(coins: Array<{ coinObjectId: string; balance: string }>) {
  return {
    getCoins: async () => ({ data: coins }),
  } as unknown as Parameters<typeof buildCreateDuelDusdcTx>[0]
}

const DUSDC = "0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC"

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

  test("buildCreateDuelDusdcTx emits one create_duel with dUSDC type arg", async () => {
    const cards: DeckCard[] = strikes.map((strike) => ({ oracleId, strike }))
    const hash = await computeDeckHash(cards)
    const client = mockClient([
      { coinObjectId: "0xc0", balance: "10000000" },
      { coinObjectId: "0xc1", balance: "5000000" },
    ])
    const tx = await buildCreateDuelDusdcTx(
      client,
      "0x86fcc7fdc63be1a6b31c5288e7b87a6b985f16d1af490fcb54f2501d5fa8e78c",
      hash,
      5_000_000n,
      DUSDC,
    )
    const data = tx.getData()
    const createDuel = data.commands.find(
      (c) => "MoveCall" in c && c.MoveCall?.function === "create_duel",
    )
    expect(createDuel).toBeDefined()
    expect((createDuel as { MoveCall: { typeArguments?: string[] } }).MoveCall.typeArguments).toEqual([DUSDC])
  })

  test("buildCreateDuelDusdcTx throws when wallet has no dUSDC", async () => {
    const cards: DeckCard[] = strikes.map((strike) => ({ oracleId, strike }))
    const hash = await computeDeckHash(cards)
    const client = mockClient([])
    await expect(
      buildCreateDuelDusdcTx(client, "0xabc", hash, 1_000_000n, DUSDC),
    ).rejects.toThrow(/no .*DUSDC coins/)
  })

  test("buildJoinDuelDusdcTx emits one join_duel with dUSDC type arg", async () => {
    const client = mockClient([{ coinObjectId: "0xc0", balance: "10000000" }])
    const tx = await buildJoinDuelDusdcTx(client, "0xabc", duelId, 1_000_000n, DUSDC)
    const data = tx.getData()
    const joinDuel = data.commands.find(
      (c) => "MoveCall" in c && c.MoveCall?.function === "join_duel",
    )
    expect(joinDuel).toBeDefined()
    expect((joinDuel as { MoveCall: { typeArguments?: string[] } }).MoveCall.typeArguments).toEqual([DUSDC])
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

  const swipeArgs = {
    duelId,
    managerId: "0x2",
    oracleId,
    cardIdx: 0,
    isUp: true,
    quantity: 20_000n,
  }
  const finalizeCards: DeckCard[] = Array.from({ length: 5 }, () => ({
    oracleId,
    strike: 100_000_000_000n,
  }))

  test("buildSwipeTx emits exactly one duel::record_swipe call", () => {
    const tx = buildSwipeTx(swipeArgs)
    const targets = moveCallTargets(tx)
    expect(targets).toHaveLength(1)
    expect(targets[0]).toMatch(/::duel::record_swipe$/)
  })

  test("buildFinalizeTx emits exactly one duel::finalize_multi call", () => {
    const tx = buildFinalizeTx(duelId, finalizeCards, "0x10", "0x11")
    const targets = moveCallTargets(tx)
    const finalizes = targets.filter((t) => t.endsWith("::duel::finalize_multi"))
    expect(targets).toHaveLength(1)
    expect(finalizes).toHaveLength(1)
  })

  test("builders bake the configured package address into the call target", () => {
    const tx = buildSwipeTx(swipeArgs)
    const targets = moveCallTargets(tx)
    expect(targets[0].startsWith(CONFIG.packageId)).toBe(true)
  })
})
