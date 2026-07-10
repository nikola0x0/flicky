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
  commitDeck,
  decideDeckSize,
  fetchDeck,
  hashToHex,
  knownHashCount,
  POS_INF_TICK,
  rememberDeck,
  resolveDeckBounds,
  snapToAdmissionTick,
  type DeckCardOut,
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

const ZERO = "0x0000000000000000000000000000000000000000000000000000000000000000"
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
  { expiryMarketId: addr("01"), expiry: 1_000_000, tickSize: TICK_SIZE, admissionTickSize: ADMISSION_TICK_SIZE },
  { expiryMarketId: addr("02"), expiry: 2_000_000, tickSize: TICK_SIZE, admissionTickSize: ADMISSION_TICK_SIZE },
  { expiryMarketId: addr("03"), expiry: 3_000_000, tickSize: TICK_SIZE, admissionTickSize: ADMISSION_TICK_SIZE },
  { expiryMarketId: addr("04"), expiry: 4_000_000, tickSize: TICK_SIZE, admissionTickSize: ADMISSION_TICK_SIZE },
  { expiryMarketId: addr("05"), expiry: 5_000_000, tickSize: TICK_SIZE, admissionTickSize: ADMISSION_TICK_SIZE },
]

describe("snapToAdmissionTick", () => {
  test("rounds to the nearest admission_tick_size multiple, returned as a tick index", () => {
    // admission grid: …, 1_000_000_000, 2_000_000_000, … (tick=1e7 → 100 ticks/admission-step)
    expect(snapToAdmissionTick(1_000_000_000n, TICK_SIZE, ADMISSION_TICK_SIZE)).toBe(100n)
    expect(snapToAdmissionTick(1_499_999_999n, TICK_SIZE, ADMISSION_TICK_SIZE)).toBe(100n)
    expect(snapToAdmissionTick(1_500_000_000n, TICK_SIZE, ADMISSION_TICK_SIZE)).toBe(200n)
    expect(snapToAdmissionTick(1_900_000_000n, TICK_SIZE, ADMISSION_TICK_SIZE)).toBe(200n)
  })

  test("output satisfies the on-chain admission grid: (tick*tickSize) % admissionTickSize == 0", () => {
    for (const raw of [0n, 999_999n, 1_000_001n, 63_837_582_739_850n, 999_999_999_999n]) {
      const tick = snapToAdmissionTick(raw, TICK_SIZE, ADMISSION_TICK_SIZE)
      const strike = tick * TICK_SIZE
      expect(strike % ADMISSION_TICK_SIZE).toBe(0n)
    }
  })

  test("clamps negative raw strikes to zero", () => {
    expect(snapToAdmissionTick(-1_000_000n, TICK_SIZE, ADMISSION_TICK_SIZE)).toBe(0n)
  })

  test("admissionTickSize <= 0 falls back to a plain tick index", () => {
    expect(snapToAdmissionTick(1_234_567n, 1n, 0n)).toBe(1_234_567n)
  })

  test("throws on non-positive tickSize", () => {
    expect(() => snapToAdmissionTick(1_000n, 0n, ADMISSION_TICK_SIZE)).toThrow()
  })
})

describe("buildDeck", () => {
  test("returns one card per market, in order", () => {
    const cards = buildDeck(FIVE_MARKETS, SPOT, SEED_A)
    expect(cards).toHaveLength(5)
    for (let i = 0; i < 5; i++) {
      expect(cards[i].expiryMarketId).toBe(FIVE_MARKETS[i].expiryMarketId)
    }
  })

  test("every card's strike sits on the market's admission grid", () => {
    const cards = buildDeck(FIVE_MARKETS, SPOT, SEED_A)
    for (const c of cards) {
      expect(c.strike % ADMISSION_TICK_SIZE).toBe(0n)
    }
  })

  test("UP-favored → lowerTick = strikeTick, higherTick = POS_INF_TICK", () => {
    const cards = buildDeck(FIVE_MARKETS, SPOT, SEED_A)
    for (const c of cards) {
      const strikeTick = c.strike / TICK_SIZE
      if (c.isUpFavored) {
        expect(c.lowerTick).toBe(strikeTick)
        expect(c.higherTick).toBe(POS_INF_TICK)
      }
    }
  })

  test("DOWN-favored → lowerTick = 0, higherTick = strikeTick", () => {
    const cards = buildDeck(FIVE_MARKETS, SPOT, SEED_A)
    for (const c of cards) {
      const strikeTick = c.strike / TICK_SIZE
      if (!c.isUpFavored) {
        expect(c.lowerTick).toBe(0n)
        expect(c.higherTick).toBe(strikeTick)
      }
    }
  })

  test("isUpFavored matches strike being below spot, DOWN-favored above", () => {
    const cards = buildDeck(FIVE_MARKETS, SPOT, SEED_A)
    for (const c of cards) {
      if (c.isUpFavored) expect(c.strike < SPOT).toBe(true)
      else expect(c.strike > SPOT).toBe(true)
    }
  })

  test("alternating-signed strike offsets — signs balance like allocateSignBalance", () => {
    const cards = buildDeck(FIVE_MARKETS, SPOT, SEED_A)
    const upCount = cards.filter((c) => c.isUpFavored).length
    const downCount = cards.filter((c) => !c.isUpFavored).length
    // N=5 (odd) → 3/2 split either way.
    expect(Math.max(upCount, downCount)).toBe(3)
    expect(Math.min(upCount, downCount)).toBe(2)
  })

  test("each card's expiryMarketId is distinct", () => {
    const cards = buildDeck(FIVE_MARKETS, SPOT, SEED_A)
    const ids = new Set(cards.map((c) => c.expiryMarketId))
    expect(ids.size).toBe(5)
  })

  test("deterministic — same seed, same output", () => {
    const a = buildDeck(FIVE_MARKETS, SPOT, SEED_A)
    const b = buildDeck(FIVE_MARKETS, SPOT, SEED_A)
    expect(a).toEqual(b)
  })

  test("different seed → different deck shape", () => {
    const a = buildDeck(FIVE_MARKETS, SPOT, SEED_A)
    const b = buildDeck(FIVE_MARKETS, SPOT, SEED_B)
    const aKey = a.map((c) => `${c.strike}:${c.isUpFavored}`).join(",")
    const bKey = b.map((c) => `${c.strike}:${c.isUpFavored}`).join(",")
    expect(aKey).not.toBe(bKey)
  })

  test("works for smaller deck sizes (3-4 cards, auto-deck-size)", () => {
    for (const n of [3, 4]) {
      const cards = buildDeck(FIVE_MARKETS.slice(0, n), SPOT, SEED_A)
      expect(cards).toHaveLength(n)
    }
  })

  test("throws when env.deckStrikeMode is svi_quote (not implemented yet)", () => {
    const original = env.deckStrikeMode
    // @ts-expect-error — test-only mutation of a readonly env field.
    env.deckStrikeMode = "svi_quote"
    try {
      expect(() => buildDeck(FIVE_MARKETS, SPOT, SEED_A)).toThrow(/svi_quote/)
    } finally {
      // @ts-expect-error — restore.
      env.deckStrikeMode = original
    }
  })
})

describe("commitDeck", () => {
  test("hashes the price-space deck down to {oracle_id, strike} pairs", () => {
    const cards = buildDeck(FIVE_MARKETS, SPOT, SEED_A)
    const deck = commitDeck(cards)
    expect(deck.cards).toHaveLength(5)
    for (let i = 0; i < 5; i++) {
      expect(deck.cards[i].oracle_id).toBe(cards[i].expiryMarketId)
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
      oracle_id: bcs.Address,
      strike: bcs.u64(),
    })
    const DeckBcs = bcs.vector(CardBcs)
    const outCards: DeckCardOut[] = buildDeck(FIVE_MARKETS, SPOT, SEED_A)
    const deck = commitDeck(outCards)
    const expectedBytes = DeckBcs.serialize(
      deck.cards.map((c) => ({
        oracle_id: c.oracle_id,
        strike: c.strike.toString(),
      })),
    ).toBytes()
    const expected = "0x" + createHash("sha256").update(expectedBytes).digest("hex")
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
      allocateZones(5, testPrgStream(SEED_A)),
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

describe("decideDeckSize (greedy 3–5)", () => {
  const band = { min: 3, max: 5 }

  test("5 live → deck of 5", () => {
    expect(decideDeckSize(5, band)).toEqual({ ok: true, deckSize: 5 })
  })

  test("4 live → deck of 4", () => {
    expect(decideDeckSize(4, band)).toEqual({ ok: true, deckSize: 4 })
  })

  test("3 live → deck of 3", () => {
    expect(decideDeckSize(3, band)).toEqual({ ok: true, deckSize: 3 })
  })

  test("2 live → not ok (below min)", () => {
    expect(decideDeckSize(2, band).ok).toBe(false)
  })

  test("more live than max → capped at max", () => {
    expect(decideDeckSize(9, band)).toEqual({ ok: true, deckSize: 5 })
  })
})

// DB-backed: runs only with a TEST_DATABASE_URL (see test-preload.ts).
describe.skipIf(!HAS_TEST_DB)("rememberDeck + fetchDeck (Postgres store)", () => {
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
      expect(fetched![i].oracle_id).toBe(deck.cards[i].oracle_id)
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
})
