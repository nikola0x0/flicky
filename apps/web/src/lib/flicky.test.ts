import { describe, expect, test } from "bun:test"
import { Transaction } from "@mysten/sui/transactions"
import {
  buildCreateDuelDusdcTx,
  buildCreateDuelTx,
  buildJoinDuelDusdcTx,
  buildJoinDuelTx,
  buildRefundDuelTx,
  buildRevealDeckTx,
  buildSwipeTx,
  computeDeckHash,
  oracleStrikes,
  parseDuel,
  refundEligibility,
  REFUND_TIMEOUT_MS,
  type DeckCard,
} from "./flicky"
import { CONFIG } from "./config"
import { DEEPBOOK } from "./deepbook"

// The dUSDC create/join builders no longer read wallet coins — the stake is
// withdrawn from the player's AccountWrapper, resolved via `resolveWrapper`
// (a `GET /manager` fetch). The `client` arg is now unused, so a bare stub
// suffices; the wrapper is what the builders actually need.
function mockClient() {
  return {} as unknown as Parameters<typeof buildCreateDuelDusdcTx>[0]
}

const WRAPPER =
  "0x9a72b27ab9be920c8e11e0f7a1aca2d1f02f13967b58a9279cea9c327bf1a80a"

// Stub `globalThis.fetch` so `resolveWrapper`'s `GET /manager` returns the
// given wrapper (or `null` = "no funding account"). Returns a restore fn.
function mockManagerFetch(wrapper: string | null): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async () =>
    ({
      ok: true,
      json: async () => ({ ok: true, wrapper }),
    }) as unknown as Response) as typeof fetch
  return () => {
    globalThis.fetch = original
  }
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

// === refundEligibility ===

describe("refundEligibility", () => {
  const P0 = "0xaaaaaa"
  const P1 = "0xbbbbbb"
  const START = 1_000_000
  const AFTER_TIMEOUT = START + REFUND_TIMEOUT_MS + 1
  const swipe = { isUp: true } as const

  // 5-card row where each player swiped the given number of cards.
  function row(p0Swipes: number, p1Swipes: number, status = "ACTIVE") {
    return {
      status,
      creator: P0,
      challenger: P1,
      cardCount: 5,
      startedAtMs: START,
      swipes: Array.from({ length: 5 }, (_, i) => ({
        p0Swipe: i < p0Swipes ? swipe : null,
        p1Swipe: i < p1Swipes ? swipe : null,
      })),
    }
  }

  test("PENDING: creator can cancel, others cannot", () => {
    const d = row(0, 0, "PENDING")
    expect(refundEligibility(d, P0, AFTER_TIMEOUT)).toBe("cancel")
    expect(refundEligibility(d, P1, AFTER_TIMEOUT)).toBeNull()
  })

  test("ACTIVE abandoned duel: either player can refund after 1h", () => {
    const d = row(5, 0)
    expect(refundEligibility(d, P0, AFTER_TIMEOUT)).toBe("refund")
    expect(refundEligibility(d, P1, AFTER_TIMEOUT)).toBe("refund")
  })

  test("ACTIVE: no refund before the 1h timeout", () => {
    expect(refundEligibility(row(5, 0), P0, START + 60_000)).toBeNull()
  })

  test("ACTIVE: both decks complete must finalize, not refund", () => {
    expect(refundEligibility(row(5, 5), P0, AFTER_TIMEOUT)).toBeNull()
  })

  test("non-players never see a refund path", () => {
    expect(refundEligibility(row(5, 0), "0xcccccc", AFTER_TIMEOUT)).toBeNull()
  })

  test("COMPLETE duels are never refundable", () => {
    expect(refundEligibility(row(5, 0, "COMPLETE"), P0, AFTER_TIMEOUT)).toBeNull()
  })
})

// === buildRefundDuelTx ===

describe("buildRefundDuelTx", () => {
  test("builds a transaction without touching wallet coins", () => {
    const tx = buildRefundDuelTx("0xd0e1", DUSDC)
    expect(tx).toBeInstanceOf(Transaction)
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
    const restore = mockManagerFetch(WRAPPER)
    try {
      const tx = await buildCreateDuelDusdcTx(
        mockClient(),
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
      // Stake is withdrawn from the AccountWrapper, not the wallet.
      const targets = moveCallTargets(tx)
      expect(targets.some((t) => t.endsWith("::account::withdraw_funds"))).toBe(
        true
      )
    } finally {
      restore()
    }
  })

  test("buildCreateDuelDusdcTx throws when there is no funding account", async () => {
    const cards: DeckCard[] = strikes.map((strike) => ({
      expiryMarketId: marketId,
      strike,
    }))
    const hash = await computeDeckHash(cards)
    const restore = mockManagerFetch(null)
    try {
      await expect(
        buildCreateDuelDusdcTx(mockClient(), "0xabc", hash, 1_000_000n, DUSDC)
      ).rejects.toThrow(/no funding account/)
    } finally {
      restore()
    }
  })

  test("buildJoinDuelDusdcTx emits one join_duel with dUSDC type arg", async () => {
    const restore = mockManagerFetch(WRAPPER)
    try {
      const tx = await buildJoinDuelDusdcTx(
        mockClient(),
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
    } finally {
      restore()
    }
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

  test("buildRevealDeckTx rejects an out-of-range card count", () => {
    expect(() => buildRevealDeckTx(duelId, [])).toThrow(/1.20 cards/)
  })

  test("buildRevealDeckTx accepts a non-5 deck size (e.g. 3 cards)", () => {
    const cards: DeckCard[] = strikes
      .slice(0, 3)
      .map((strike) => ({ expiryMarketId: marketId, strike }))
    const tx = buildRevealDeckTx(duelId, cards)
    const targets = moveCallTargets(tx)
    expect(targets.filter((t) => t.endsWith("::duel::new_card"))).toHaveLength(
      3
    )
    expect(
      targets.filter((t) => t.endsWith("::duel::reveal_deck"))
    ).toHaveLength(1)
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
    stakeCoinType: DUSDC,
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

  test("buildSwipeTx (staked) record_swipe type arg matches the duel's stake coin type, not SUI", () => {
    // Regression: record_swipe<T> must match the Duel<T>'s escrow coin.
    // Staked duels are created exclusively as Duel<DUSDC> — passing
    // CONFIG.stakeType (SUI) here would abort every staked swipe on chain.
    const tx = buildSwipeTx(stakedSwipeArgs)
    const data = tx.getData()
    const recordSwipe = data.commands.find(
      (c) => "MoveCall" in c && c.MoveCall?.function === "record_swipe"
    )
    expect(recordSwipe).toBeDefined()
    const typeArgs = (recordSwipe as { MoveCall: { typeArguments?: string[] } })
      .MoveCall.typeArguments
    expect(typeArgs).toEqual([stakedSwipeArgs.stakeCoinType])
    expect(typeArgs).not.toEqual([CONFIG.stakeType])
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
