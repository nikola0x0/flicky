import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { bcs } from "@mysten/sui/bcs"
import { closeDb } from "./db"
import { env } from "./env"
import { HAS_TEST_DB, resetTables } from "./test-db"
import {
  allocateSignBalance,
  allocateZones,
  buildDeck,
  buildPracticeDeck,
  commitDeck,
  decideDeckSize,
  fetchDeck,
  hashToHex,
  knownHashCount,
  classifyTier,
  MID_LIFETIME_MAX_MS,
  POS_INF_TICK,
  PRACTICE_EXPIRY_OFFSETS_MS,
  rememberDeck,
  resolveDeckBounds,
  selectMarketRows,
  selectTieredMarkets,
  SHORT_LIFETIME_MAX_MS,
  snapToAdmissionTick,
  type DeckCardOut,
  type MarketRow,
  type MarketSnapshot,
  type Zone,
} from "./deckmaster"

/** Tiny PRG mirroring the one in deckmaster.ts so tests don't depend on
 *  the un-exported internal. SHA-256 in counter mode over a 32-byte seed. */
function* testPrgStream(seed: Uint8Array): Generator<number, never> {
  let counter = 0
  while (true) {
    const h = createHash("sha256")
    h.update(seed)
    h.update(Buffer.from(String(counter)))
    const out = h.digest()
    for (let i = 0; i < out.length; i++) yield out[i]
    counter++
  }
}

const ZERO =
  "0x0000000000000000000000000000000000000000000000000000000000000000"
function addr(suffix: string): string {
  // Pad a short suffix to a full 32-byte Sui address.
  return ZERO.slice(0, 66 - suffix.length) + suffix
}

const SEED_A = new Uint8Array(32).fill(0xa1)
const SEED_B = new Uint8Array(32).fill(0xb2)

// Matches confirmed live 6-24 testnet market params (probed 2026-07-10):
// tick_size = 1e7, admission_tick_size = 1e9 (100 ticks per admission step).
const TICK_SIZE = 10_000_000n
const ADMISSION_TICK_SIZE = 1_000_000_000n

// $60,000.00 in the 1e9-fixed unit `normalized_spot` uses.
const SPOT = 60_000_000_000_000n

const FIVE_MARKETS: MarketSnapshot[] = [
  {
    expiryMarketId: addr("01"),
    expiry: 1_000_000,
    tickSize: TICK_SIZE,
    admissionTickSize: ADMISSION_TICK_SIZE,
  },
  {
    expiryMarketId: addr("02"),
    expiry: 2_000_000,
    tickSize: TICK_SIZE,
    admissionTickSize: ADMISSION_TICK_SIZE,
  },
  {
    expiryMarketId: addr("03"),
    expiry: 3_000_000,
    tickSize: TICK_SIZE,
    admissionTickSize: ADMISSION_TICK_SIZE,
  },
  {
    expiryMarketId: addr("04"),
    expiry: 4_000_000,
    tickSize: TICK_SIZE,
    admissionTickSize: ADMISSION_TICK_SIZE,
  },
  {
    expiryMarketId: addr("05"),
    expiry: 5_000_000,
    tickSize: TICK_SIZE,
    admissionTickSize: ADMISSION_TICK_SIZE,
  },
]

describe("snapToAdmissionTick", () => {
  test("rounds to the nearest admission_tick_size multiple, returned as a tick index", () => {
    // admission grid: …, 1_000_000_000, 2_000_000_000, … (tick=1e7 → 100 ticks/admission-step)
    expect(
      snapToAdmissionTick(1_000_000_000n, TICK_SIZE, ADMISSION_TICK_SIZE)
    ).toBe(100n)
    expect(
      snapToAdmissionTick(1_499_999_999n, TICK_SIZE, ADMISSION_TICK_SIZE)
    ).toBe(100n)
    expect(
      snapToAdmissionTick(1_500_000_000n, TICK_SIZE, ADMISSION_TICK_SIZE)
    ).toBe(200n)
    expect(
      snapToAdmissionTick(1_900_000_000n, TICK_SIZE, ADMISSION_TICK_SIZE)
    ).toBe(200n)
  })

  test("output satisfies the on-chain admission grid: (tick*tickSize) % admissionTickSize == 0", () => {
    for (const raw of [
      0n,
      999_999n,
      1_000_001n,
      63_837_582_739_850n,
      999_999_999_999n,
    ]) {
      const tick = snapToAdmissionTick(raw, TICK_SIZE, ADMISSION_TICK_SIZE)
      const strike = tick * TICK_SIZE
      expect(strike % ADMISSION_TICK_SIZE).toBe(0n)
    }
  })

  test("clamps negative raw strikes to zero", () => {
    expect(
      snapToAdmissionTick(-1_000_000n, TICK_SIZE, ADMISSION_TICK_SIZE)
    ).toBe(0n)
  })

  test("admissionTickSize <= 0 falls back to a plain tick index", () => {
    expect(snapToAdmissionTick(1_234_567n, 1n, 0n)).toBe(1_234_567n)
  })

  test("throws on non-positive tickSize", () => {
    expect(() => snapToAdmissionTick(1_000n, 0n, ADMISSION_TICK_SIZE)).toThrow()
  })
})

describe("buildDeck", () => {
  test("returns one card per market, in order (deckSize == markets.length)", () => {
    const cards = buildDeck(FIVE_MARKETS, SPOT, SEED_A, 5)
    expect(cards).toHaveLength(5)
    for (let i = 0; i < 5; i++) {
      expect(cards[i].expiryMarketId).toBe(FIVE_MARKETS[i].expiryMarketId)
    }
  })

  test("every card's strike sits on the market's admission grid", () => {
    const cards = buildDeck(FIVE_MARKETS, SPOT, SEED_A, 5)
    for (const c of cards) {
      expect(c.strike % ADMISSION_TICK_SIZE).toBe(0n)
    }
  })

  test("UP-favored → lowerTick = strikeTick, higherTick = POS_INF_TICK", () => {
    const cards = buildDeck(FIVE_MARKETS, SPOT, SEED_A, 5)
    for (const c of cards) {
      const strikeTick = c.strike / TICK_SIZE
      if (c.isUpFavored) {
        expect(c.lowerTick).toBe(strikeTick)
        expect(c.higherTick).toBe(POS_INF_TICK)
      }
    }
  })

  test("DOWN-favored → lowerTick = 0, higherTick = strikeTick", () => {
    const cards = buildDeck(FIVE_MARKETS, SPOT, SEED_A, 5)
    for (const c of cards) {
      const strikeTick = c.strike / TICK_SIZE
      if (!c.isUpFavored) {
        expect(c.lowerTick).toBe(0n)
        expect(c.higherTick).toBe(strikeTick)
      }
    }
  })

  test("isUpFavored matches strike being below spot, DOWN-favored above", () => {
    const cards = buildDeck(FIVE_MARKETS, SPOT, SEED_A, 5)
    for (const c of cards) {
      if (c.isUpFavored) expect(c.strike < SPOT).toBe(true)
      else expect(c.strike > SPOT).toBe(true)
    }
  })

  test("alternating-signed strike offsets — signs balance like allocateSignBalance", () => {
    const cards = buildDeck(FIVE_MARKETS, SPOT, SEED_A, 5)
    const upCount = cards.filter((c) => c.isUpFavored).length
    const downCount = cards.filter((c) => !c.isUpFavored).length
    // N=5 (odd) → 3/2 split either way.
    expect(Math.max(upCount, downCount)).toBe(3)
    expect(Math.min(upCount, downCount)).toBe(2)
  })

  test("each card's expiryMarketId is distinct when deckSize == markets.length", () => {
    const cards = buildDeck(FIVE_MARKETS, SPOT, SEED_A, 5)
    const ids = new Set(cards.map((c) => c.expiryMarketId))
    expect(ids.size).toBe(5)
  })

  test("deterministic — same seed, same output", () => {
    const a = buildDeck(FIVE_MARKETS, SPOT, SEED_A, 5)
    const b = buildDeck(FIVE_MARKETS, SPOT, SEED_A, 5)
    expect(a).toEqual(b)
  })

  test("different seed → different deck shape", () => {
    const a = buildDeck(FIVE_MARKETS, SPOT, SEED_A, 5)
    const b = buildDeck(FIVE_MARKETS, SPOT, SEED_B, 5)
    const aKey = a.map((c) => `${c.strike}:${c.isUpFavored}`).join(",")
    const bKey = b.map((c) => `${c.strike}:${c.isUpFavored}`).join(",")
    expect(aKey).not.toBe(bKey)
  })

  test("works for smaller deck sizes (3-4 cards, auto-deck-size)", () => {
    for (const n of [3, 4]) {
      const cards = buildDeck(FIVE_MARKETS.slice(0, n), SPOT, SEED_A, n)
      expect(cards).toHaveLength(n)
    }
  })

  test("deckSize defaults to markets.length when omitted", () => {
    const cards = buildDeck(FIVE_MARKETS, SPOT, SEED_A)
    expect(cards).toHaveLength(5)
  })

  test("throws when env.deckStrikeMode is svi_quote (not implemented yet)", () => {
    const original = env.deckStrikeMode
    // @ts-expect-error — test-only mutation of a readonly env field.
    env.deckStrikeMode = "svi_quote"
    try {
      expect(() => buildDeck(FIVE_MARKETS, SPOT, SEED_A, 5)).toThrow(
        /svi_quote/
      )
    } finally {
      // @ts-expect-error — restore.
      env.deckStrikeMode = original
    }
  })

  test("throws when markets is empty", () => {
    expect(() => buildDeck([], SPOT, SEED_A, 5)).toThrow()
  })

  test("deckSize <= 0 returns []", () => {
    expect(buildDeck(FIVE_MARKETS, SPOT, SEED_A, 0)).toEqual([])
    expect(buildDeck(FIVE_MARKETS, SPOT, SEED_A, -1)).toEqual([])
  })

  test("one market, deckSize 5 → all 5 cards on that market, 5 distinct strikes", () => {
    const oneMarket = [FIVE_MARKETS[0]]
    const cards = buildDeck(oneMarket, SPOT, SEED_A, 5)
    expect(cards).toHaveLength(5)
    for (const c of cards) {
      expect(c.expiryMarketId).toBe(FIVE_MARKETS[0].expiryMarketId)
    }
    expect(new Set(cards.map((c) => c.strike)).size).toBe(5)
  })

  test("three markets, deckSize 5 → round-robin distribution, distinct (market,strike) pairs", () => {
    const threeMarkets = FIVE_MARKETS.slice(0, 3)
    const cards = buildDeck(threeMarkets, SPOT, SEED_A, 5)
    expect(cards).toHaveLength(5)
    // Round-robin: markets[0,1,2,0,1] for indices 0..4.
    expect(cards[0].expiryMarketId).toBe(threeMarkets[0].expiryMarketId)
    expect(cards[1].expiryMarketId).toBe(threeMarkets[1].expiryMarketId)
    expect(cards[2].expiryMarketId).toBe(threeMarkets[2].expiryMarketId)
    expect(cards[3].expiryMarketId).toBe(threeMarkets[0].expiryMarketId)
    expect(cards[4].expiryMarketId).toBe(threeMarkets[1].expiryMarketId)
    // Every market used.
    const usedMarkets = new Set(cards.map((c) => c.expiryMarketId))
    expect(usedMarkets.size).toBe(3)
    // Distinct (market, strike) pairs — no duplicate on-chain cards.
    const pairs = new Set(cards.map((c) => `${c.expiryMarketId}:${c.strike}`))
    expect(pairs.size).toBe(5)
  })

  test("two markets, deckSize 5 → 3+2 split, distinct strikes within each market", () => {
    const twoMarkets = FIVE_MARKETS.slice(0, 2)
    const cards = buildDeck(twoMarkets, SPOT, SEED_A, 5)
    expect(cards).toHaveLength(5)
    const byMarket = new Map<string, bigint[]>()
    for (const c of cards) {
      const arr = byMarket.get(c.expiryMarketId) ?? []
      arr.push(c.strike)
      byMarket.set(c.expiryMarketId, arr)
    }
    expect(byMarket.size).toBe(2)
    for (const strikes of byMarket.values()) {
      expect(new Set(strikes).size).toBe(strikes.length)
    }
    const pairs = new Set(cards.map((c) => `${c.expiryMarketId}:${c.strike}`))
    expect(pairs.size).toBe(5)
  })
})

describe("commitDeck", () => {
  test("hashes the price-space deck down to {expiryMarketId, strike} pairs", () => {
    const cards = buildDeck(FIVE_MARKETS, SPOT, SEED_A)
    const deck = commitDeck(cards)
    expect(deck.cards).toHaveLength(5)
    for (let i = 0; i < 5; i++) {
      expect(deck.cards[i].expiryMarketId).toBe(cards[i].expiryMarketId)
      expect(deck.cards[i].strike).toBe(cards[i].strike)
    }
  })

  test("deterministic — same input, identical hash", () => {
    const cards = buildDeck(FIVE_MARKETS, SPOT, SEED_A)
    const a = commitDeck(cards)
    const b = commitDeck(cards)
    expect(a.hashHex).toBe(b.hashHex)
    expect(Array.from(a.hash)).toEqual(Array.from(b.hash))
  })

  test("different seed → different hash", () => {
    const a = commitDeck(buildDeck(FIVE_MARKETS, SPOT, SEED_A))
    const b = commitDeck(buildDeck(FIVE_MARKETS, SPOT, SEED_B))
    expect(a.hashHex).not.toBe(b.hashHex)
  })

  // REGRESSION GUARD: this is the exact hash the on-chain
  // `duel::reveal_deck` will compare against. If commitDeck or its BCS
  // layout changes, every duel reveal breaks. The expected hex is
  // computed inline against the same BCS schema duel.move uses.
  test("hash matches sha2-256 of BCS-serialized Card vector", () => {
    const CardBcs = bcs.struct("Card", {
      expiry_market_id: bcs.Address,
      strike: bcs.u64(),
    })
    const DeckBcs = bcs.vector(CardBcs)
    const outCards: DeckCardOut[] = buildDeck(FIVE_MARKETS, SPOT, SEED_A)
    const deck = commitDeck(outCards)
    const expectedBytes = DeckBcs.serialize(
      deck.cards.map((c) => ({
        expiry_market_id: c.expiryMarketId,
        strike: c.strike.toString(),
      }))
    ).toBytes()
    const expected =
      "0x" + createHash("sha256").update(expectedBytes).digest("hex")
    expect(deck.hashHex).toBe(expected)
  })
})

describe("hashToHex", () => {
  test("prefixes 0x, lowercase, 64 hex chars for 32 bytes", () => {
    const h = new Uint8Array(32).fill(0xab)
    expect(hashToHex(h)).toBe("0x" + "ab".repeat(32))
  })

  test("zero-pads single nibbles", () => {
    const h = new Uint8Array([0x01, 0x0a, 0xff])
    expect(hashToHex(h)).toBe("0x010aff")
  })
})

describe("allocateSignBalance", () => {
  test("even N → exactly N/2 of each sign", () => {
    for (const n of [2, 4, 6, 10]) {
      const signs = allocateSignBalance(n, testPrgStream(SEED_A))
      expect(signs).toHaveLength(n)
      const ups = signs.filter((s) => s === 1).length
      const downs = signs.filter((s) => s === -1).length
      expect(ups).toBe(n / 2)
      expect(downs).toBe(n / 2)
    }
  })

  test("odd N → split (N+1)/2 + (N-1)/2 (PRG picks which sign gets extra)", () => {
    for (const n of [3, 5, 7]) {
      const signs = allocateSignBalance(n, testPrgStream(SEED_A))
      expect(signs).toHaveLength(n)
      const ups = signs.filter((s) => s === 1).length
      const downs = signs.filter((s) => s === -1).length
      // One side has the extra, the other has half (rounded down).
      expect(Math.max(ups, downs)).toBe(Math.ceil(n / 2))
      expect(Math.min(ups, downs)).toBe(Math.floor(n / 2))
    }
  })

  test("never returns ATM (0) — every card is forced aggressive", () => {
    for (let s = 0; s < 16; s++) {
      const seed = new Uint8Array(32).fill(s)
      const signs = allocateSignBalance(5, testPrgStream(seed))
      expect(signs.every((x) => x === 1 || x === -1)).toBe(true)
    }
  })

  test("order varies per seed (PRG-shuffled)", () => {
    const seen = new Set<string>()
    for (let s = 0; s < 20; s++) {
      const seed = new Uint8Array(32).fill(s)
      const signs = allocateSignBalance(5, testPrgStream(seed))
      seen.add(signs.join(","))
    }
    expect(seen.size).toBeGreaterThan(2) // at least a few different orderings
  })

  test("N=1 → single sign (PRG picks)", () => {
    const signs = allocateSignBalance(1, testPrgStream(SEED_A))
    expect(signs).toHaveLength(1)
    expect(signs[0] === 1 || signs[0] === -1).toBe(true)
  })

  test("N=0 → empty array", () => {
    expect(allocateSignBalance(0, testPrgStream(SEED_A))).toEqual([])
  })
})

describe("allocateZones", () => {
  const tally = (zones: Zone[]) => ({
    close: zones.filter((z) => z === "close").length,
    mid: zones.filter((z) => z === "mid").length,
    edge: zones.filter((z) => z === "edge").length,
  })

  test("5 cards → 2 close + 2 mid + 1 edge", () => {
    expect(tally(allocateZones(5, testPrgStream(SEED_A)))).toEqual({
      close: 2,
      mid: 2,
      edge: 1,
    })
  })

  test("4 cards → 1 close + 2 mid + 1 edge", () => {
    expect(tally(allocateZones(4, testPrgStream(SEED_A)))).toEqual({
      close: 1,
      mid: 2,
      edge: 1,
    })
  })

  test("3 cards → 1 of each", () => {
    expect(tally(allocateZones(3, testPrgStream(SEED_A)))).toEqual({
      close: 1,
      mid: 1,
      edge: 1,
    })
  })

  test("degraded small sizes: 2 → close+mid, 1 → close, 0 → empty", () => {
    expect(tally(allocateZones(2, testPrgStream(SEED_A)))).toEqual({
      close: 1,
      mid: 1,
      edge: 0,
    })
    expect(allocateZones(1, testPrgStream(SEED_A))).toEqual(["close"])
    expect(allocateZones(0, testPrgStream(SEED_A))).toEqual([])
  })

  test(">5 repeats the 2/2/1 pattern (7 → 4 close + 2 mid + 1 edge)", () => {
    expect(tally(allocateZones(7, testPrgStream(SEED_A)))).toEqual({
      close: 4,
      mid: 2,
      edge: 1,
    })
  })

  test("order varies per seed (PRG-shuffled) and is deterministic per seed", () => {
    const seen = new Set<string>()
    for (let s = 0; s < 20; s++) {
      const seed = new Uint8Array(32).fill(s)
      seen.add(allocateZones(5, testPrgStream(seed)).join(","))
    }
    expect(seen.size).toBeGreaterThan(1)
    expect(allocateZones(5, testPrgStream(SEED_A))).toEqual(
      allocateZones(5, testPrgStream(SEED_A))
    )
  })
})

describe("resolveDeckBounds", () => {
  test("defaults to the 3–5 band when nothing is passed", () => {
    expect(resolveDeckBounds({})).toEqual({ min: 3, max: 5 })
  })

  test("honors caller min/max", () => {
    expect(resolveDeckBounds({ minDeckSize: 2, maxDeckSize: 4 })).toEqual({
      min: 2,
      max: 4,
    })
  })

  test("clamps to the contract's [1, 20] range", () => {
    expect(resolveDeckBounds({ minDeckSize: 0, maxDeckSize: 99 })).toEqual({
      min: 1,
      max: 20,
    })
  })

  test("forces min ≤ max when min exceeds max", () => {
    expect(resolveDeckBounds({ minDeckSize: 9, maxDeckSize: 4 })).toEqual({
      min: 4,
      max: 4,
    })
  })

  test("explicit deckSize collapses the band (back-compat strict path)", () => {
    expect(resolveDeckBounds({ deckSize: 5 })).toEqual({ min: 5, max: 5 })
  })
})

describe("decideDeckSize (deck size decoupled from market count)", () => {
  const band = { min: 3, max: 5 }

  test("5 live → deck of max (5), built via multi-card-per-market round-robin", () => {
    expect(decideDeckSize(5, band)).toEqual({ ok: true, deckSize: 5 })
  })

  test("4 live → still deck of max (5)", () => {
    expect(decideDeckSize(4, band)).toEqual({ ok: true, deckSize: 5 })
  })

  test("3 live → still deck of max (5)", () => {
    expect(decideDeckSize(3, band)).toEqual({ ok: true, deckSize: 5 })
  })

  test("2 live → ok, deck of max (5) — multi-card-per-market covers the gap", () => {
    expect(decideDeckSize(2, band)).toEqual({ ok: true, deckSize: 5 })
  })

  test("1 live → ok (single-market near-ATM decks are fine post-probe)", () => {
    expect(decideDeckSize(1, band)).toEqual({ ok: true, deckSize: 5 })
  })

  test("0 live → not ok", () => {
    expect(decideDeckSize(0, band).ok).toBe(false)
  })

  test("more live than max → still capped at max", () => {
    expect(decideDeckSize(9, band)).toEqual({ ok: true, deckSize: 5 })
  })

  test("explicit deckSize band (min==max==n) → deckSize n, ok once ≥1 live", () => {
    expect(decideDeckSize(2, { min: 3, max: 3 })).toEqual({
      ok: true,
      deckSize: 3,
    })
    expect(decideDeckSize(1, { min: 3, max: 3 })).toEqual({
      ok: true,
      deckSize: 3,
    })
    expect(decideDeckSize(0, { min: 3, max: 3 }).ok).toBe(false)
  })
})

describe("selectMarketRows (pure market filter/de-dupe/sort/slice)", () => {
  const now = 1_000_000
  const minHeadroomMs = 100_000
  const maxHorizonMs = 1_000_000
  const opts = { now, minHeadroomMs, maxHorizonMs, count: 5 }

  test("excludes markets past maxHorizonMs", () => {
    const rows: MarketRow[] = [
      {
        expiry_market_id: addr("01"),
        propbook_underlying_id: 1,
        expiry: now + maxHorizonMs + 1,
        tick_size: "1",
        admission_tick_size: "1",
        kind: "market_created",
      },
      {
        expiry_market_id: addr("02"),
        propbook_underlying_id: 1,
        expiry: now + maxHorizonMs,
        tick_size: "1",
        admission_tick_size: "1",
        kind: "market_created",
      },
    ]
    const result = selectMarketRows(rows, opts)
    expect(result).toHaveLength(1)
    expect(result[0].expiryMarketId).toBe(addr("02"))
  })

  test("excludes markets inside minHeadroomMs (expiry <= now + minHeadroomMs)", () => {
    const rows: MarketRow[] = [
      {
        expiry_market_id: addr("01"),
        propbook_underlying_id: 1,
        expiry: now + minHeadroomMs,
        tick_size: "1",
        admission_tick_size: "1",
        kind: "market_created",
      },
      {
        expiry_market_id: addr("02"),
        propbook_underlying_id: 1,
        expiry: now + minHeadroomMs + 1,
        tick_size: "1",
        admission_tick_size: "1",
        kind: "market_created",
      },
    ]
    const result = selectMarketRows(rows, opts)
    expect(result).toHaveLength(1)
    expect(result[0].expiryMarketId).toBe(addr("02"))
  })

  test("excludes propbook_underlying_id !== 1", () => {
    const rows: MarketRow[] = [
      {
        expiry_market_id: addr("01"),
        propbook_underlying_id: 2,
        expiry: now + 500_000,
        tick_size: "1",
        admission_tick_size: "1",
        kind: "market_created",
      },
      {
        expiry_market_id: addr("02"),
        propbook_underlying_id: 1,
        expiry: now + 500_000,
        tick_size: "1",
        admission_tick_size: "1",
        kind: "market_created",
      },
    ]
    const result = selectMarketRows(rows, opts)
    expect(result).toHaveLength(1)
    expect(result[0].expiryMarketId).toBe(addr("02"))
  })

  test("excludes kind !== market_created", () => {
    const rows: MarketRow[] = [
      {
        expiry_market_id: addr("01"),
        propbook_underlying_id: 1,
        expiry: now + 500_000,
        tick_size: "1",
        admission_tick_size: "1",
        kind: "something_else",
      },
      {
        expiry_market_id: addr("02"),
        propbook_underlying_id: 1,
        expiry: now + 500_000,
        tick_size: "1",
        admission_tick_size: "1",
        kind: "market_created",
      },
    ]
    const result = selectMarketRows(rows, opts)
    expect(result).toHaveLength(1)
    expect(result[0].expiryMarketId).toBe(addr("02"))
  })

  test("de-dupes by normalized expiry_market_id (keeps first)", () => {
    const rows: MarketRow[] = [
      {
        expiry_market_id: addr("01"),
        propbook_underlying_id: 1,
        expiry: now + 200_000,
        tick_size: "1",
        admission_tick_size: "1",
        kind: "market_created",
      },
      {
        expiry_market_id: addr("01"), // Same as first (after normalization)
        propbook_underlying_id: 1,
        expiry: now + 300_000, // Different expiry
        tick_size: "2",
        admission_tick_size: "2",
        kind: "market_created",
      },
    ]
    const result = selectMarketRows(rows, opts)
    expect(result).toHaveLength(1)
    expect(result[0].expiry).toBe(now + 200_000)
    expect(result[0].tickSize).toBe(1n)
  })

  test("sorts by expiry ascending (soonest-first)", () => {
    const rows: MarketRow[] = [
      {
        expiry_market_id: addr("01"),
        propbook_underlying_id: 1,
        expiry: now + 800_000,
        tick_size: "1",
        admission_tick_size: "1",
        kind: "market_created",
      },
      {
        expiry_market_id: addr("02"),
        propbook_underlying_id: 1,
        expiry: now + 200_000,
        tick_size: "1",
        admission_tick_size: "1",
        kind: "market_created",
      },
      {
        expiry_market_id: addr("03"),
        propbook_underlying_id: 1,
        expiry: now + 500_000,
        tick_size: "1",
        admission_tick_size: "1",
        kind: "market_created",
      },
    ]
    const result = selectMarketRows(rows, opts)
    expect(result).toHaveLength(3)
    expect(result[0].expiry).toBe(now + 200_000)
    expect(result[1].expiry).toBe(now + 500_000)
    expect(result[2].expiry).toBe(now + 800_000)
  })

  test("caps result at count", () => {
    const rows: MarketRow[] = [
      {
        expiry_market_id: addr("01"),
        propbook_underlying_id: 1,
        expiry: now + 200_000,
        tick_size: "1",
        admission_tick_size: "1",
        kind: "market_created",
      },
      {
        expiry_market_id: addr("02"),
        propbook_underlying_id: 1,
        expiry: now + 300_000,
        tick_size: "1",
        admission_tick_size: "1",
        kind: "market_created",
      },
      {
        expiry_market_id: addr("03"),
        propbook_underlying_id: 1,
        expiry: now + 400_000,
        tick_size: "1",
        admission_tick_size: "1",
        kind: "market_created",
      },
    ]
    const result = selectMarketRows(rows, { ...opts, count: 2 })
    expect(result).toHaveLength(2)
    expect(result[0].expiryMarketId).toBe(addr("01"))
    expect(result[1].expiryMarketId).toBe(addr("02"))
  })

  test("converts tick_size and admission_tick_size to BigInt", () => {
    const rows: MarketRow[] = [
      {
        expiry_market_id: addr("01"),
        propbook_underlying_id: 1,
        expiry: now + 500_000,
        tick_size: "10000000",
        admission_tick_size: "1000000000",
        kind: "market_created",
      },
    ]
    const result = selectMarketRows(rows, opts)
    expect(result).toHaveLength(1)
    expect(result[0].tickSize).toBe(10_000_000n)
    expect(result[0].admissionTickSize).toBe(1_000_000_000n)
  })
})

// DB-backed: runs only with a TEST_DATABASE_URL (see test-preload.ts).
describe.skipIf(!HAS_TEST_DB)(
  "rememberDeck + fetchDeck (Postgres store)",
  () => {
    beforeEach(async () => {
      await resetTables()
    })

    afterAll(async () => {
      await closeDb()
    })

    test("round-trips by hash hex", async () => {
      const deck = commitDeck(buildDeck(FIVE_MARKETS, SPOT, SEED_A))
      const hex = await rememberDeck(deck.hash, deck.cards)
      const fetched = await fetchDeck(hex)
      expect(fetched).toBeDefined()
      expect(fetched).toHaveLength(5)
      for (let i = 0; i < 5; i++) {
        expect(fetched![i].expiryMarketId).toBe(deck.cards[i].expiryMarketId)
        expect(fetched![i].strike).toBe(deck.cards[i].strike)
      }
    })

    test("fetchDeck is case-insensitive on hash hex", async () => {
      const deck = commitDeck(buildDeck(FIVE_MARKETS, SPOT, SEED_A))
      await rememberDeck(deck.hash, deck.cards)
      expect(await fetchDeck(deck.hashHex.toUpperCase())).toBeDefined()
    })

    test("fetchDeck returns undefined for unknown hash", async () => {
      expect(await fetchDeck("0x" + "ee".repeat(32))).toBeUndefined()
    })

    test("knownHashCount reflects store after remember", async () => {
      const before = await knownHashCount()
      const deck = commitDeck(buildDeck(FIVE_MARKETS, SPOT, SEED_A))
      await rememberDeck(deck.hash, deck.cards)
      expect(await knownHashCount()).toBe(before + 1)
    })
  }
)

describe("buildPracticeDeck", () => {
  const SPOT = 67_000_000_000_000n // $67k, 1e9-fixed

  test("returns 5 cards with the staggered expiry offsets, in order", () => {
    const cards = buildPracticeDeck(SPOT, SEED_A)
    expect(cards.length).toBe(5)
    expect(cards.map((c) => c.expiryOffsetMs)).toEqual([
      ...PRACTICE_EXPIRY_OFFSETS_MS,
    ])
  })

  test("strikes sit on the correct side of spot for their pUp", () => {
    // pUp > 0.5 → UP favored → strike below spot; pUp < 0.5 → above.
    for (const c of buildPracticeDeck(SPOT, SEED_A)) {
      expect(c.pUp).not.toBe(0.5)
      if (c.pUp > 0.5) expect(c.strike < SPOT).toBe(true)
      else expect(c.strike > SPOT).toBe(true)
    }
  })

  test("strikes are near-ATM (0 < |offset| < 20 bps) at 15-45s horizons", () => {
    for (const c of buildPracticeDeck(SPOT, SEED_A)) {
      const diff = c.strike > SPOT ? c.strike - SPOT : SPOT - c.strike
      expect(diff > 0n).toBe(true)
      expect(Number((diff * 10_000n) / SPOT)).toBeLessThan(20)
    }
  })

  test("pUp values come from the zone ladder, sign-balanced 2/3 or 3/2", () => {
    const cards = buildPracticeDeck(SPOT, SEED_A)
    const favored = cards.map((c) => Math.max(c.pUp, 1 - c.pUp))
    for (const p of favored) expect([0.56, 0.61, 0.63]).toContain(p)
    const upFavored = cards.filter((c) => c.pUp > 0.5).length
    expect(upFavored === 2 || upFavored === 3).toBe(true)
  })

  test("deterministic per seed, varies across seeds", () => {
    expect(buildPracticeDeck(SPOT, SEED_A)).toEqual(
      buildPracticeDeck(SPOT, SEED_A)
    )
    expect(buildPracticeDeck(SPOT, SEED_A)).not.toEqual(
      buildPracticeDeck(SPOT, SEED_B)
    )
  })

  test("rejects non-positive spot", () => {
    expect(() => buildPracticeDeck(0n, SEED_A)).toThrow()
  })
})

describe("classifyTier", () => {
  test("short at and below SHORT_LIFETIME_MAX_MS, mid above", () => {
    expect(classifyTier(3 * 60 * 1000)).toBe("short")
    expect(classifyTier(SHORT_LIFETIME_MAX_MS)).toBe("short")
    expect(classifyTier(SHORT_LIFETIME_MAX_MS + 1)).toBe("mid")
  })

  test("mid at and below MID_LIFETIME_MAX_MS, long above", () => {
    expect(classifyTier(15 * 60 * 1000)).toBe("mid")
    expect(classifyTier(MID_LIFETIME_MAX_MS)).toBe("mid")
    expect(classifyTier(MID_LIFETIME_MAX_MS + 1)).toBe("long")
  })

  test("unknown lifetime (no creation time) classifies as long", () => {
    expect(classifyTier(undefined)).toBe("long")
  })
})

describe("selectTieredMarkets (2 short + 3 mid, short-first)", () => {
  const now = 10_000_000
  const SHORT_LIFE = 3 * 60 * 1000 // 180_000
  const MID_LIFE = 15 * 60 * 1000 // 900_000
  const LONG_LIFE = 180 * 60 * 1000
  const opts = {
    now,
    shortCount: 2,
    midCount: 3,
    shortTtlFloorMs: 90_000,
    midTtlFloorMs: 330_000,
    maxHorizonMs: 3 * 60 * 60 * 1000,
  }

  /** Row expiring `ttlMs` from now with `lifetimeMs` from creation to expiry. */
  function row(id: string, ttlMs: number, lifetimeMs: number): MarketRow {
    const expiry = now + ttlMs
    return {
      expiry_market_id: addr(id),
      propbook_underlying_id: 1,
      expiry,
      tick_size: "1",
      admission_tick_size: "1",
      kind: "market_created",
      checkpoint_timestamp_ms: expiry - lifetimeMs,
    }
  }

  test("composes shorts + mids, returned sorted by expiry ascending", () => {
    const rows = [
      row("m1", 600_000, MID_LIFE),
      row("s1", 170_000, SHORT_LIFE),
      row("m2", 400_000, MID_LIFE),
      row("s2", 150_000, SHORT_LIFE),
      row("m3", 800_000, MID_LIFE),
    ]
    const out = selectTieredMarkets(rows, opts)
    expect(out.map((m) => m.expiry)).toEqual([
      now + 150_000, // s2
      now + 170_000, // s1
      now + 400_000, // m2
      now + 600_000, // m1
      now + 800_000, // m3
    ])
  })

  test("drops shorts below the short TTL floor and mids below the mid floor", () => {
    const rows = [
      row("s_ok", 150_000, SHORT_LIFE),
      row("s_low", 50_000, SHORT_LIFE), // < 90s floor
      row("m_ok", 400_000, MID_LIFE),
      row("m_low", 200_000, MID_LIFE), // < 330s floor
    ]
    const out = selectTieredMarkets(rows, opts)
    expect(out.map((m) => m.expiryMarketId)).toEqual([
      addr("s_ok"),
      addr("m_ok"),
    ])
  })

  test("caps each tier at its requested count, freshest shorts / soonest mids", () => {
    const rows = [
      row("s1", 120_000, SHORT_LIFE),
      row("s2", 160_000, SHORT_LIFE),
      row("s3", 175_000, SHORT_LIFE), // 3 shorts, only 2 wanted → freshest 2 (s3,s2)
      row("m1", 400_000, MID_LIFE),
      row("m2", 500_000, MID_LIFE),
      row("m3", 600_000, MID_LIFE),
      row("m4", 700_000, MID_LIFE), // 4 mids, only 3 wanted → soonest 3 (m1,m2,m3)
    ]
    const out = selectTieredMarkets(rows, opts).map((m) => m.expiryMarketId)
    expect(out).not.toContain(addr("s1")) // stalest short dropped
    expect(out).not.toContain(addr("m4")) // latest mid dropped
    expect(out).toEqual([
      addr("s2"),
      addr("s3"),
      addr("m1"),
      addr("m2"),
      addr("m3"),
    ])
  })

  test("rows with no creation time are long-tier → never picked as short/mid", () => {
    const noCreate: MarketRow = {
      expiry_market_id: addr("nc"),
      propbook_underlying_id: 1,
      expiry: now + 150_000,
      tick_size: "1",
      admission_tick_size: "1",
      kind: "market_created",
    }
    expect(selectTieredMarkets([noCreate], opts)).toEqual([])
  })

  test("excludes non-BTC, wrong kind, expired, and beyond-horizon rows", () => {
    const rows: MarketRow[] = [
      { ...row("btc", 150_000, SHORT_LIFE) },
      { ...row("eth", 150_000, SHORT_LIFE), propbook_underlying_id: 2 },
      { ...row("wrong", 150_000, SHORT_LIFE), kind: "market_settled" },
      { ...row("expired", -1000, SHORT_LIFE) },
      { ...row("far", opts.maxHorizonMs + 1000, LONG_LIFE) },
    ]
    expect(
      selectTieredMarkets(rows, opts).map((m) => m.expiryMarketId)
    ).toEqual([addr("btc")])
  })

  test("returns [] when no safe short/mid markets are live", () => {
    const rows = [row("long", 60 * 60 * 1000, LONG_LIFE)]
    expect(selectTieredMarkets(rows, opts)).toEqual([])
  })
})
