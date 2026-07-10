import { describe, expect, test } from "bun:test"
import { Transaction } from "@mysten/sui/transactions"
import {
  buildCreateDuelDusdcTx,
  buildCreateDuelTx,
  buildJoinDuelDusdcTx,
  buildJoinDuelTx,
  buildRevealDeckTx,
  buildSwipeTx,
  computeDeckHash,
  oracleStrikes,
  parseDuel,
  type DeckCard,
} from "./flicky"
import { CONFIG } from "./config"
import { DEEPBOOK } from "./deepbook"

// Minimal gRPC client mock for the dUSDC builders. They only call
// `client.core.listCoins({ owner, coinType })`; nothing else.
function mockClient(coins: Array<{ objectId: string; balance: string }>) {
  return {
    core: {
      listCoins: async () => ({
        objects: coins,
        hasNextPage: false,
        cursor: null,
      }),
    },
  } as unknown as Parameters<typeof buildCreateDuelDusdcTx>[0]
}

const DUSDC =
  "0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC"

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
    expect(strikes).toEqual([
      90_000_000_000n,
      100_000_000_000n,
      110_000_000_000n,
    ])
  })

  test("strikes are strictly monotonic", () => {
    const strikes = oracleStrikes(50_000_000_000_000n)
    for (let i = 1; i < strikes.length; i++) {
      expect(strikes[i] > strikes[i - 1]).toBe(true)
    }
  })
})

// === parseDuel ===

const DUEL_TYPE = `${CONFIG.packageId}::duel::Duel<0x2::sui::SUI>`

// Flat gRPC json shape of a Duel (`client.core.getObject`'s `obj.object.json`):
// no `.fields` nesting, bare `id`, `Balance` as a bare string, `vector<u8>`
// as number[] (or base64), `Option<Swipe>` as the swipe or null.
function makeDuelFields(
  overrides: Partial<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    id: "0xabc000000000000000000000000000000000000000000000000000000000beef",
    status: "2",
    tier: "1",
    deck_size: "5",
    deck_hash: new Array(32).fill(0xab),
    cards: Array.from({ length: 5 }, (_, i) => ({
      expiry_market_id: "0xdeadbeef",
      strike: String(80_000_000_000_000n + BigInt(i) * 1_000_000_000n),
    })),
    creator: "0xaaaaaa",
    challenger: "0xbbbbbb",
    p0_stake: "10000000",
    p1_stake: "10000000",
    // Per-card settle state — card 0 settled @ 80_000_001 / 1e9.
    cards_settled: [true, false, false, false, false],
    card_settlement_prices: ["80000001000000000", "0", "0", "0", "0"],
    settled_count: "1",
    // Net PnL accumulators: p0 won card 0, p1 lost it.
    p0_payout: "20000",
    p0_premium: "8000",
    p1_payout: "0",
    p1_premium: "12000",
    p0_next_card_idx: "2",
    p1_next_card_idx: "1",
    started_at_ms: "1000",
    p0_swipes: [
      {
        is_up: true,
        quantity: "20000",
        order_id: "424242",
      },
      null,
      null,
      null,
      null,
    ],
    p1_swipes: [null, null, null, null, null],
    ...overrides,
  }
}

describe("parseDuel", () => {
  test("parses every top-level field", () => {
    const d = parseDuel(makeDuelFields(), DUEL_TYPE)
    expect(d.status).toBe("ACTIVE")
    expect(d.tier).toBe(1)
    expect(d.creator).toBe("0xaaaaaa")
    expect(d.challenger).toBe("0xbbbbbb")
    expect(d.stakeCoinType).toBe("0x2::sui::SUI")
    expect(d.deckSize).toBe(5n)
    expect(d.p0Stake).toBe(10_000_000n)
    expect(d.p1Stake).toBe(10_000_000n)
    expect(d.p0Payout).toBe(20_000n)
    expect(d.p0Premium).toBe(8_000n)
    expect(d.p1Payout).toBe(0n)
    expect(d.p1Premium).toBe(12_000n)
    expect(d.p0NextCardIdx).toBe(2n)
    expect(d.p1NextCardIdx).toBe(1n)
    expect(d.settledCount).toBe(1n)
    expect(d.startedAtMs).toBe(1000n)
  })

  test("parses 5 cards with strikes", () => {
    const d = parseDuel(makeDuelFields(), DUEL_TYPE)
    expect(d.cards).toHaveLength(5)
    expect(d.cards[0].strike).toBe(80_000_000_000_000n)
    expect(d.cards[4].strike).toBe(80_000_000_000_000n + 4_000_000_000n)
  })

  test("parses per-card settle state (cardsSettled + cardSettlementPrices)", () => {
    const d = parseDuel(makeDuelFields(), DUEL_TYPE)
    expect(d.cardsSettled).toEqual([true, false, false, false, false])
    expect(d.cardSettlementPrices[0]).toBe(80_000_001_000_000_000n)
    expect(d.cardSettlementPrices[1]).toBe(0n)
  })

  test("parses p0/p1 swipes Option array", () => {
    const d = parseDuel(makeDuelFields(), DUEL_TYPE)
    expect(d.p0Swipes[0]).toEqual({
      isUp: true,
      quantity: 20_000n,
      orderId: 424_242n,
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
      const d = parseDuel(makeDuelFields({ status: raw }), DUEL_TYPE)
      expect(d.status).toBe(expected)
    }
  })

  test("throws if json is not a Move object", () => {
    expect(() => parseDuel(null)).toThrow(/not a Move object/)
    expect(() => parseDuel(undefined)).toThrow(/not a Move object/)
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
  const marketId =
    "0xdeadbeef0000000000000000000000000000000000000000000000000000beef"
  const duelId =
    "0xfeedface0000000000000000000000000000000000000000000000000000face"
  const strikes: bigint[] = [95n, 98n, 100n, 102n, 105n].map(
    (p) => (80_000_000_000_000n * p) / 100n
  )

  test("buildCreateDuelTx emits exactly one duel::create_duel call", async () => {
    const cards: DeckCard[] = strikes.map((strike) => ({
      expiryMarketId: marketId,
      strike,
    }))
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
    const cards: DeckCard[] = strikes.map((strike) => ({
      expiryMarketId: marketId,
      strike,
    }))
    const hash = await computeDeckHash(cards)
    const client = mockClient([
      { objectId: "0xc0", balance: "10000000" },
      { objectId: "0xc1", balance: "5000000" },
    ])
    const tx = await buildCreateDuelDusdcTx(
      client,
      "0x86fcc7fdc63be1a6b31c5288e7b87a6b985f16d1af490fcb54f2501d5fa8e78c",
      hash,
      5_000_000n,
      DUSDC
    )
    const data = tx.getData()
    const createDuel = data.commands.find(
      (c) => "MoveCall" in c && c.MoveCall?.function === "create_duel"
    )
    expect(createDuel).toBeDefined()
    expect(
      (createDuel as { MoveCall: { typeArguments?: string[] } }).MoveCall
        .typeArguments
    ).toEqual([DUSDC])
  })

  test("buildCreateDuelDusdcTx throws when wallet has no dUSDC", async () => {
    const cards: DeckCard[] = strikes.map((strike) => ({
      expiryMarketId: marketId,
      strike,
    }))
    const hash = await computeDeckHash(cards)
    const client = mockClient([])
    await expect(
      buildCreateDuelDusdcTx(client, "0xabc", hash, 1_000_000n, DUSDC)
    ).rejects.toThrow(/no .*DUSDC coins/)
  })

  test("buildJoinDuelDusdcTx emits one join_duel with dUSDC type arg", async () => {
    const client = mockClient([{ objectId: "0xc0", balance: "10000000" }])
    const tx = await buildJoinDuelDusdcTx(
      client,
      "0xabc",
      duelId,
      1_000_000n,
      DUSDC
    )
    const data = tx.getData()
    const joinDuel = data.commands.find(
      (c) => "MoveCall" in c && c.MoveCall?.function === "join_duel"
    )
    expect(joinDuel).toBeDefined()
    expect(
      (joinDuel as { MoveCall: { typeArguments?: string[] } }).MoveCall
        .typeArguments
    ).toEqual([DUSDC])
  })

  test("buildRevealDeckTx emits 5 new_card + 1 reveal_deck", () => {
    const cards: DeckCard[] = strikes.map((strike) => ({
      expiryMarketId: marketId,
      strike,
    }))
    const tx = buildRevealDeckTx(duelId, cards)
    const targets = moveCallTargets(tx)
    expect(targets.filter((t) => t.endsWith("::duel::new_card"))).toHaveLength(
      5
    )
    expect(
      targets.filter((t) => t.endsWith("::duel::reveal_deck"))
    ).toHaveLength(1)
  })

  test("buildRevealDeckTx rejects wrong card count", () => {
    expect(() => buildRevealDeckTx(duelId, [])).toThrow(/exactly 5/)
  })

  test("computeDeckHash returns 32 bytes deterministically", async () => {
    const cards: DeckCard[] = strikes.map((strike) => ({
      expiryMarketId: marketId,
      strike,
    }))
    const a = await computeDeckHash(cards)
    const b = await computeDeckHash(cards)
    expect(a).toHaveLength(32)
    expect(Array.from(a)).toEqual(Array.from(b))
    // Different deck → different hash.
    const c = await computeDeckHash([
      ...cards.slice(0, 4),
      { expiryMarketId: marketId, strike: cards[4].strike + 1n },
    ])
    expect(Array.from(a)).not.toEqual(Array.from(c))
  })

  test("buildJoinDuelTx emits exactly one duel::join_duel call", () => {
    const tx = buildJoinDuelTx(duelId, 10_000_000n)
    const targets = moveCallTargets(tx)
    expect(targets.filter((t) => t.endsWith("::duel::join_duel"))).toHaveLength(
      1
    )
  })

  // Staked-tier swipe: bundles the DeepBook mint (generate_auth,
  // load_live_pricer, mint_exact_quantity) + flicky's record_swipe in one
  // PTB — see buildStakedSwipeTx in lib/deepbook.ts.
  const stakedSwipeArgs = {
    tier: "staked" as const,
    duelId,
    wrapperId: "0x2",
    marketId,
    strike: 80_000_000_000_000n,
    tickSize: 1_000_000_000n,
    cardIdx: 0,
    isUp: true,
    quantity: 20_000n,
  }

  test("buildSwipeTx (staked) emits exactly one duel::record_swipe call", () => {
    const tx = buildSwipeTx(stakedSwipeArgs)
    const targets = moveCallTargets(tx)
    expect(
      targets.filter((t) => t.endsWith("::duel::record_swipe"))
    ).toHaveLength(1)
  })

  test("buildSwipeTx (staked) bundles the DeepBook mint before record_swipe", () => {
    const tx = buildSwipeTx(stakedSwipeArgs)
    const targets = moveCallTargets(tx)
    expect(targets.some((t) => t.endsWith("::account::generate_auth"))).toBe(
      true
    )
    expect(
      targets.some((t) => t.endsWith("::expiry_market::load_live_pricer"))
    ).toBe(true)
    expect(
      targets.some((t) => t.endsWith("::expiry_market::mint_exact_quantity"))
    ).toBe(true)
    // record_swipe is the last command, chaining the mint's order id.
    expect(targets[targets.length - 1]).toMatch(/::duel::record_swipe$/)
  })

  test("buildSwipeTx (free) emits exactly one record_swipe_free call, no mint", () => {
    const tx = buildSwipeTx({
      tier: "free",
      duelId,
      cardIdx: 0,
      isUp: true,
    })
    const targets = moveCallTargets(tx)
    expect(targets).toHaveLength(1)
    expect(targets[0]).toMatch(/::duel::record_swipe_free$/)
  })

  test("builders bake the configured package address into the call target", () => {
    const tx = buildSwipeTx({
      tier: "free",
      duelId,
      cardIdx: 0,
      isUp: true,
    })
    const targets = moveCallTargets(tx)
    expect(targets[0].startsWith(CONFIG.packageId)).toBe(true)
  })

  test("buildSwipeTx (staked) bakes the DeepBook predict package into the mint calls", () => {
    const tx = buildSwipeTx(stakedSwipeArgs)
    const targets = moveCallTargets(tx)
    expect(
      targets.some((t) => t.startsWith(DEEPBOOK.deepbookPredictPackageId))
    ).toBe(true)
  })
})
