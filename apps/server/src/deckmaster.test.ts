import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { bcs } from "@mysten/sui/bcs"
import {
  buildDeckFromOracles,
  fetchDeck,
  hashToHex,
  knownHashCount,
  rememberDeck,
  type OracleSnapshot,
} from "./deckmaster"

const ZERO = "0x0000000000000000000000000000000000000000000000000000000000000000"
function addr(suffix: string): string {
  // Pad a short suffix to a full 32-byte Sui address.
  return ZERO.slice(0, 66 - suffix.length) + suffix
}

const SEED_A = new Uint8Array(32).fill(0xa1)
const SEED_B = new Uint8Array(32).fill(0xb2)

const FIVE_ORACLES: OracleSnapshot[] = [
  { id: addr("01"), expiry: 1_000_000n, spot: 100_000_000_000n, forward: 100_000_000_000n },
  { id: addr("02"), expiry: 2_000_000n, spot: 100_000_000_000n, forward: 100_000_000_000n },
  { id: addr("03"), expiry: 3_000_000n, spot: 100_000_000_000n, forward: 100_000_000_000n },
  { id: addr("04"), expiry: 4_000_000n, spot: 100_000_000_000n, forward: 100_000_000_000n },
  { id: addr("05"), expiry: 5_000_000n, spot: 100_000_000_000n, forward: 100_000_000_000n },
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

  test("strikes are drawn from STRIKE_PCT_POOL × forward / 100", () => {
    const deck = buildDeckFromOracles(FIVE_ORACLES, SEED_A)
    const POOL = [98n, 102n, 95n, 105n, 100n, 99n, 101n, 97n, 103n, 90n, 110n]
    for (let i = 0; i < 5; i++) {
      const pct = (deck.cards[i].strike * 100n) / FIVE_ORACLES[i].forward
      expect(POOL).toContain(pct)
    }
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
