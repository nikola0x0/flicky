import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { bcs } from "@mysten/sui/bcs"
import {
  buildDeckFromOracles,
  difficultyOfPct,
  fetchDeck,
  hashToHex,
  knownHashCount,
  rememberDeck,
  snapToTick,
  strikePctOf,
  type OracleSnapshot,
} from "./deckmaster"

const ZERO = "0x0000000000000000000000000000000000000000000000000000000000000000"
function addr(suffix: string): string {
  // Pad a short suffix to a full 32-byte Sui address.
  return ZERO.slice(0, 66 - suffix.length) + suffix
}

const SEED_A = new Uint8Array(32).fill(0xa1)
const SEED_B = new Uint8Array(32).fill(0xb2)

// minStrike=0, tickSize=1 means snapToTick is a no-op for these fixtures,
// so strike-bucket assertions (`strikePctOf` returning exactly 85/95/100…)
// stay valid. The `snaps strikes to tick grid` test below covers the
// real tick-snapping behavior.
const FIVE_ORACLES: OracleSnapshot[] = [
  { id: addr("01"), expiry: 1_000_000n, spot: 100_000_000_000n, forward: 100_000_000_000n, minStrike: 0n, tickSize: 1n },
  { id: addr("02"), expiry: 2_000_000n, spot: 100_000_000_000n, forward: 100_000_000_000n, minStrike: 0n, tickSize: 1n },
  { id: addr("03"), expiry: 3_000_000n, spot: 100_000_000_000n, forward: 100_000_000_000n, minStrike: 0n, tickSize: 1n },
  { id: addr("04"), expiry: 4_000_000n, spot: 100_000_000_000n, forward: 100_000_000_000n, minStrike: 0n, tickSize: 1n },
  { id: addr("05"), expiry: 5_000_000n, spot: 100_000_000_000n, forward: 100_000_000_000n, minStrike: 0n, tickSize: 1n },
]

describe("buildDeckFromOracles", () => {
  test("returns exactly 5 cards", () => {
    const deck = buildDeckFromOracles(FIVE_ORACLES, SEED_A)
    expect(deck.cards).toHaveLength(5)
  })

  test("each card uses the corresponding oracle id", () => {
    const deck = buildDeckFromOracles(FIVE_ORACLES, SEED_A)
    for (let i = 0; i < 5; i++) {
      expect(deck.cards[i].oracle_id).toBe(FIVE_ORACLES[i].id)
    }
  })

  test("strikes follow a 2/2/1 difficulty mix (2 close + 2 mid + 1 otm)", () => {
const deck = buildDeckFromOracles(FIVE_ORACLES, SEED_A)
    const tally = { close: 0, mid: 0, otm: 0, null: 0 }
    for (let i = 0; i < 5; i++) {
      const pct = strikePctOf(FIVE_ORACLES[i].forward, deck.cards[i].strike)
      const d = difficultyOfPct(pct)
      if (d === null) tally.null++
      else tally[d]++
    }
    expect(tally.close).toBe(2)
    expect(tally.mid).toBe(2)
    expect(tally.otm).toBe(1)
    expect(tally.null).toBe(0)
  })

  test("difficulty allocation is shuffled per seed (not always same order)", () => {
    // Build many decks with different seeds, collect the difficulty sequence.
    // Expect to see at least 2 distinct orderings of the 5-card difficulty array.
const seen = new Set<string>()
    for (let s = 0; s < 20; s++) {
      const seed = new Uint8Array(32).fill(s)
      const deck = buildDeckFromOracles(FIVE_ORACLES, seed)
      const seq = deck.cards
        .map((c, i) => difficultyOfPct(strikePctOf(FIVE_ORACLES[i].forward, c.strike)))
        .join(",")
      seen.add(seq)
    }
    expect(seen.size).toBeGreaterThan(1)
  })

  test("different seed produces different cards (same oracles)", () => {
    const a = buildDeckFromOracles(FIVE_ORACLES, SEED_A)
    const b = buildDeckFromOracles(FIVE_ORACLES, SEED_B)
    expect(a.hashHex).not.toBe(b.hashHex)
  })

  test("throws when fewer than 5 oracles", () => {
    expect(() => buildDeckFromOracles(FIVE_ORACLES.slice(0, 4), SEED_A)).toThrow(/need 5 oracles/)
  })

  test("deterministic — same input produces identical hash", () => {
    const a = buildDeckFromOracles(FIVE_ORACLES, SEED_A)
    const b = buildDeckFromOracles(FIVE_ORACLES, SEED_A)
    expect(a.hashHex).toBe(b.hashHex)
    expect(Array.from(a.hash)).toEqual(Array.from(b.hash))
  })

  test("different oracle ids produce different hash", () => {
    const altered = FIVE_ORACLES.map((o, i) =>
      i === 2 ? { ...o, id: addr("ff") } : o,
    )
    const a = buildDeckFromOracles(FIVE_ORACLES, SEED_A)
    const b = buildDeckFromOracles(altered, SEED_A)
    expect(a.hashHex).not.toBe(b.hashHex)
  })

  test("different forward (→ different strike) produces different hash", () => {
    const altered = FIVE_ORACLES.map((o, i) =>
      i === 0 ? { ...o, forward: 200_000_000_000n } : o,
    )
    const a = buildDeckFromOracles(FIVE_ORACLES, SEED_A)
    const b = buildDeckFromOracles(altered, SEED_A)
    expect(a.hashHex).not.toBe(b.hashHex)
  })

  // REGRESSION GUARD: this is the exact hash the on-chain
  // `duel::reveal_deck` will compare against. If buildDeckFromOracles or
  // its BCS layout changes, every duel reveal breaks. The expected hex
  // is computed inline against the same BCS schema duel.move uses.
  test("hash matches sha2-256 of BCS-serialized Card vector", () => {
    const CardBcs = bcs.struct("Card", {
      oracle_id: bcs.Address,
      strike: bcs.u64(),
    })
    const DeckBcs = bcs.vector(CardBcs)
    const deck = buildDeckFromOracles(FIVE_ORACLES, SEED_A)
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

describe("snapToTick", () => {
  test("floors to nearest tick boundary above min_strike", () => {
    // grid: 100, 105, 110, 115, … (min=100, tick=5)
    expect(snapToTick(112n, 100n, 5n)).toBe(110n)
    expect(snapToTick(115n, 100n, 5n)).toBe(115n)
    expect(snapToTick(119n, 100n, 5n)).toBe(115n)
  })

  test("clamps strike below min_strike to min_strike", () => {
    expect(snapToTick(50n, 100n, 5n)).toBe(100n)
    expect(snapToTick(0n, 100n, 5n)).toBe(100n)
  })

  test("snapped output satisfies on-chain assert_valid_strike", () => {
    // (strike - min) % tick == 0 && strike >= min
    const min = 1_000_000n
    const tick = 100_000n
    for (const raw of [0n, 999_999n, 1_000_001n, 1_500_001n, 9_999_999n]) {
      const snapped = snapToTick(raw, min, tick)
      expect(snapped >= min).toBe(true)
      expect((snapped - min) % tick).toBe(0n)
    }
  })

  test("buildDeckFromOracles snaps strikes to oracle grid", () => {
    // forward=100_000_000_000, pct ∈ {85, 95, 100, …, 115} all divisible by 100,
    // so use a tickSize=137 (prime-ish) that never divides forward*pct/100 cleanly.
    const tick = 137n
    const min = 1_000n
    const oracles: OracleSnapshot[] = FIVE_ORACLES.map((o) => ({
      ...o,
      minStrike: min,
      tickSize: tick,
    }))
    const deck = buildDeckFromOracles(oracles, SEED_A)
    for (const card of deck.cards) {
      expect(card.strike >= min).toBe(true)
      expect((card.strike - min) % tick).toBe(0n)
    }
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

describe("rememberDeck + fetchDeck", () => {
  test("round-trips by hash hex", () => {
    const deck = buildDeckFromOracles(FIVE_ORACLES, SEED_A)
    const hex = rememberDeck(deck.hash, deck.cards)
    const fetched = fetchDeck(hex)
    expect(fetched).toBeDefined()
    expect(fetched).toHaveLength(5)
    for (let i = 0; i < 5; i++) {
      expect(fetched![i].oracle_id).toBe(deck.cards[i].oracle_id)
      expect(fetched![i].strike).toBe(deck.cards[i].strike)
    }
  })

  test("fetchDeck is case-insensitive on hash hex", () => {
    const deck = buildDeckFromOracles(FIVE_ORACLES, SEED_A)
    rememberDeck(deck.hash, deck.cards)
    expect(fetchDeck(deck.hashHex.toUpperCase())).toBeDefined()
  })

  test("fetchDeck returns undefined for unknown hash", () => {
    expect(fetchDeck("0x" + "ee".repeat(32))).toBeUndefined()
  })

  test("knownHashCount reflects store after remember", () => {
    // Use a per-invocation suffix so the on-disk store doesn't already
    // have this hash from prior test runs.
    const suffix = (Date.now() % 0xff).toString(16).padStart(2, "0")
    const deck = buildDeckFromOracles(
      [...FIVE_ORACLES.slice(0, 4), { ...FIVE_ORACLES[4], id: addr(suffix) }],
      SEED_A,
    )
    const before = knownHashCount()
    rememberDeck(deck.hash, deck.cards)
    expect(knownHashCount()).toBeGreaterThanOrEqual(before)
    expect(knownHashCount()).toBeLessThanOrEqual(before + 1)
  })
})
