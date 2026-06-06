import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { bcs } from "@mysten/sui/bcs"
import {
  allocateSignBalance,
  allocateZones,
  atmStrike,
  buildAndProbeDeck,
  buildDeckFromOracles,
  decideDeckSize,
  difficultyOfPct,
  OFFSET_CANDIDATES_BPS,
  fetchDeck,
  hashToHex,
  knownHashCount,
  pickMaxAmplitudeStrike,
  rememberDeck,
  resolveDeckBounds,
  selectDeckOracleRows,
  selectViableOracles,
  quoteInZone,
  snapToTick,
  strikePctOf,
  zoneDistance,
  type OracleRow,
  type OracleSnapshot,
  type ProbeFn,
  type ProbeResult,
  type QuoteBand,
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

/** SuiClient stand-in — never invoked because we always pass a probe override. */
const NULL_CLIENT = null as unknown as Parameters<typeof buildAndProbeDeck>[0]

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

// === pickMaxAmplitudeStrike — the max-amplitude search ===

const ONE_ORACLE: OracleSnapshot = {
  id: addr("01"),
  expiry: 1_000_000n,
  spot: 100_000_000_000n,
  forward: 100_000_000_000n,
  minStrike: 0n,
  tickSize: 1n,
}

const VIABLE_5050: ProbeResult = {
  viable: true,
  askUp: 500_000_000n,
  askDown: 500_000_000n,
}
const NOT_VIABLE: ProbeResult = { viable: false, askUp: 0n, askDown: 0n }

/** Build a probe that accepts strikes within `±maxAbsBps` of forward,
 *  always quoting a flat 50/50 when viable. */
function probeWithCeiling(maxAbsBps: number): ProbeFn {
  return async (o, strike) => {
    const fwd = o.forward
    const diff = strike > fwd ? strike - fwd : fwd - strike
    const absBps = Number((diff * 10_000n) / fwd)
    return absBps <= maxAbsBps ? VIABLE_5050 : NOT_VIABLE
  }
}

describe("pickMaxAmplitudeStrike", () => {
  test("when the SVI accepts everything, picks the MOST aggressive (2000 bps)", async () => {
    const pick = await pickMaxAmplitudeStrike(
      ONE_ORACLE,
      testPrgStream(SEED_A),
      async () => VIABLE_5050,
    )
    expect(pick).not.toBeNull()
    expect(Math.abs(pick!.bps)).toBe(2000)
  })

  test("when SVI caps at ±500 bps, picks exactly ±500 (not lower, not 0)", async () => {
    const pick = await pickMaxAmplitudeStrike(
      ONE_ORACLE,
      testPrgStream(SEED_A),
      probeWithCeiling(500),
    )
    expect(pick).not.toBeNull()
    expect(Math.abs(pick!.bps)).toBe(500)
  })

  test("when SVI caps at ±150 bps, picks ±100 (next viable down from 150)", async () => {
    // OFFSET_CANDIDATES_BPS has 200, 100 — 150 is between them, so the
    // search finds 100 (the most aggressive viable candidate ≤ ceiling).
    const pick = await pickMaxAmplitudeStrike(
      ONE_ORACLE,
      testPrgStream(SEED_A),
      probeWithCeiling(150),
    )
    expect(pick).not.toBeNull()
    expect(Math.abs(pick!.bps)).toBe(100)
  })

  test("when SVI rejects everything except ATM, returns 0 (fallback)", async () => {
    const pick = await pickMaxAmplitudeStrike(
      ONE_ORACLE,
      testPrgStream(SEED_A),
      probeWithCeiling(0),
    )
    expect(pick).not.toBeNull()
    expect(pick!.bps).toBe(0)
  })

  test("when SVI rejects EVERYTHING (probe always false), returns null", async () => {
    const pick = await pickMaxAmplitudeStrike(
      ONE_ORACLE,
      testPrgStream(SEED_A),
      async () => NOT_VIABLE,
    )
    expect(pick).toBeNull()
  })

  test("early-exits: one probe when the most aggressive strike prices", async () => {
    let calls = 0
    const probe: ProbeFn = async () => {
      calls++
      return VIABLE_5050
    }
    await pickMaxAmplitudeStrike(ONE_ORACLE, testPrgStream(SEED_A), probe, +1)
    expect(calls).toBe(1)
  })

  test("walks no further than needed: ATM-only → exactly ladder+1 probes", async () => {
    let calls = 0
    const probe: ProbeFn = async (o, strike) => {
      calls++
      return strike === atmStrike(o) ? VIABLE_5050 : NOT_VIABLE
    }
    const pick = await pickMaxAmplitudeStrike(
      ONE_ORACLE,
      testPrgStream(SEED_A),
      probe,
      +1,
    )
    expect(pick!.bps).toBe(0)
    expect(calls).toBe(OFFSET_CANDIDATES_BPS.length + 1)
  })

  test("PRG flip alternates UP-side vs DOWN-side at each |bps| level", async () => {
    // With a permissive probe, both ±2000 work. The PRG decides which sign
    // ends up first in `ordered` (and therefore which sign Promise.all
    // returns first). Two different seeds should yield different signs.
    const seedsTried = new Set<number>()
    for (let s = 0; s < 16 && seedsTried.size < 2; s++) {
      const seed = new Uint8Array(32).fill(s)
      const pick = await pickMaxAmplitudeStrike(
        ONE_ORACLE,
        testPrgStream(seed),
        async () => VIABLE_5050,
      )
      seedsTried.add(Math.sign(pick!.bps))
    }
    expect(seedsTried.size).toBe(2) // saw both +sign and −sign
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

describe("pickMaxAmplitudeStrike with signBias", () => {
  test("signBias=+1 only returns strike > forward", async () => {
    const pick = await pickMaxAmplitudeStrike(
      ONE_ORACLE,
      testPrgStream(SEED_A),
      async () => VIABLE_5050,
      +1,
    )
    expect(pick).not.toBeNull()
    expect(pick!.bps).toBeGreaterThan(0)
    expect(pick!.strike > ONE_ORACLE.forward).toBe(true)
  })

  test("signBias=-1 only returns strike < forward", async () => {
    const pick = await pickMaxAmplitudeStrike(
      ONE_ORACLE,
      testPrgStream(SEED_A),
      async () => VIABLE_5050,
      -1,
    )
    expect(pick).not.toBeNull()
    expect(pick!.bps).toBeLessThan(0)
    expect(pick!.strike < ONE_ORACLE.forward).toBe(true)
  })

  test("signBias=+1 with capped probe → max |bps| on that side", async () => {
    const pick = await pickMaxAmplitudeStrike(
      ONE_ORACLE,
      testPrgStream(SEED_A),
      probeWithCeiling(500),
      +1,
    )
    expect(pick!.bps).toBe(500)
  })
})

describe("buildAndProbeDeck (end-to-end with mock probe)", () => {
  test("picks ±500 bps on every card when the SVI ceiling is 500", async () => {
    const deck = await buildAndProbeDeck(
      NULL_CLIENT,
      FIVE_ORACLES,
      SEED_A,
      probeWithCeiling(500),
    )
    expect(deck.cards).toHaveLength(5)
    for (let i = 0; i < 5; i++) {
      const fwd = FIVE_ORACLES[i].forward
      const strike = deck.cards[i].strike
      const diff = strike > fwd ? strike - fwd : fwd - strike
      const absBps = Number((diff * 10_000n) / fwd)
      expect(absBps).toBe(500)
    }
  })

  test("doesn't collapse to ATM when ANY aggressive offset works (this was the bug)", async () => {
    // Regression guard: with the old code, ANY probe failure on the
    // single-bucket PRG pick would collapse to ATM. With the coarse ladder
    // a probe that allows ±300 bps should land EVERY card at 200 — the most
    // aggressive rung ≤300 — never ATM.
    const deck = await buildAndProbeDeck(
      NULL_CLIENT,
      FIVE_ORACLES,
      SEED_A,
      probeWithCeiling(300),
    )
    for (let i = 0; i < 5; i++) {
      const fwd = FIVE_ORACLES[i].forward
      const strike = deck.cards[i].strike
      const diff = strike > fwd ? strike - fwd : fwd - strike
      const absBps = Number((diff * 10_000n) / fwd)
      expect(absBps).toBe(200)
    }
  })

  test("deck has balanced sign distribution (never all-UP or all-DOWN)", async () => {
    // 5-card deck → 3+2 of one sign vs other, PRG-picked. Across many
    // seeds we should see both 3-up-2-down and 3-down-2-up but never 5/0.
    const distributions = new Set<string>()
    for (let s = 0; s < 16; s++) {
      const seed = new Uint8Array(32).fill(s)
      const deck = await buildAndProbeDeck(
        NULL_CLIENT,
        FIVE_ORACLES,
        seed,
        async () => VIABLE_5050, // accept everything → max amplitude land
      )
      let ups = 0
      let downs = 0
      for (let i = 0; i < 5; i++) {
        const fwd = FIVE_ORACLES[i].forward
        const strike = deck.cards[i].strike
        if (strike > fwd) ups++
        else if (strike < fwd) downs++
      }
      expect(Math.max(ups, downs)).toBe(3)
      expect(Math.min(ups, downs)).toBe(2)
      distributions.add(`${ups}-${downs}`)
    }
    // Both 3-2 and 2-3 should appear across 16 seeds.
    expect(distributions.has("3-2")).toBe(true)
    expect(distributions.has("2-3")).toBe(true)
  })

  test("throws when even ATM is rejected (oracle pricing config unset)", async () => {
    await expect(
      buildAndProbeDeck(
        NULL_CLIENT,
        FIVE_ORACLES,
        SEED_A,
        async () => NOT_VIABLE,
      ),
    ).rejects.toThrow(/no viable strike/)
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

describe("selectDeckOracleRows", () => {
  const NOW = 1_000_000_000_000 // fixed epoch-ms for determinism
  const MIN = 10 * 60 * 1000 // 10 min headroom
  const MAX = 3 * 60 * 60 * 1000 // 3h horizon
  const base = {
    spot: 100n,
    forward: 100n,
    active: true,
    settled: false,
    asset: "BTC",
  }
  const row = (id: string, minsOut: number): OracleRow => ({
    ...base,
    id,
    expiry: BigInt(NOW + minsOut * 60 * 1000),
  })
  const opts = {
    nowMs: NOW,
    headroomMs: MIN,
    maxHorizonMs: MAX,
    asset: "BTC",
    cap: 5,
  }

  test("excludes oracles expiring beyond the horizon (long-dated)", () => {
    const rows = [row("0x1", 30), row("0x2", 60), row("0x3", 7 * 24 * 60)]
    const out = selectDeckOracleRows(rows, opts)
    expect(out.map((r) => r.id)).toEqual(["0x1", "0x2"])
  })

  test("excludes oracles inside the headroom floor", () => {
    const rows = [row("0x1", 5), row("0x2", 30)]
    expect(selectDeckOracleRows(rows, opts).map((r) => r.id)).toEqual(["0x2"])
  })

  test("sorts soonest-expiry first", () => {
    const rows = [row("0x3", 90), row("0x1", 20), row("0x2", 45)]
    expect(selectDeckOracleRows(rows, opts).map((r) => r.id)).toEqual([
      "0x1",
      "0x2",
      "0x3",
    ])
  })

  test("caps at the requested count", () => {
    const rows = [20, 30, 40, 50, 60, 70].map((m, i) => row(`0x${i}`, m))
    expect(selectDeckOracleRows(rows, { ...opts, cap: 3 })).toHaveLength(3)
  })

  test("drops inactive, settled, asset-mismatch, and zero-price rows", () => {
    const rows = [
      row("0x1", 30),
      { ...row("0x2", 35), active: false },
      { ...row("0x3", 40), settled: true },
      { ...row("0x4", 45), asset: "ETH" },
      { ...row("0x5", 50), forward: 0n },
    ]
    expect(selectDeckOracleRows(rows, opts).map((r) => r.id)).toEqual(["0x1"])
  })
})

describe("selectViableOracles", () => {
  // probe override that rejects every strike for the given oracle ids
  // (mimics an oracle whose pricing config is unset → no viable strike).
  const failing = (...ids: string[]): ProbeFn => {
    const bad = new Set(ids)
    return async (o) => (bad.has(o.id) ? NOT_VIABLE : VIABLE_5050)
  }

  test("all viable → returns the first `max`, soonest-first", async () => {
    const out = await selectViableOracles(
      NULL_CLIENT,
      FIVE_ORACLES,
      3,
      async () => VIABLE_5050,
    )
    expect(out.map((o) => o.id)).toEqual([addr("01"), addr("02"), addr("03")])
  })

  test("drops oracles whose ATM probe fails, preserving order", async () => {
    const out = await selectViableOracles(
      NULL_CLIENT,
      FIVE_ORACLES,
      5,
      failing(addr("02"), addr("04")),
    )
    expect(out.map((o) => o.id)).toEqual([addr("01"), addr("03"), addr("05")])
  })

  test("caps the viable set at `max`", async () => {
    const out = await selectViableOracles(
      NULL_CLIENT,
      FIVE_ORACLES,
      2,
      failing(addr("02")),
    )
    expect(out.map((o) => o.id)).toEqual([addr("01"), addr("03")])
  })

  test("returns all viable when fewer than `max` survive", async () => {
    const out = await selectViableOracles(
      NULL_CLIENT,
      FIVE_ORACLES,
      5,
      failing(addr("02"), addr("03"), addr("04"), addr("05")),
    )
    expect(out.map((o) => o.id)).toEqual([addr("01")])
  })
})

// === probability zones ===

const BAND: QuoteBand = { min: 200_000_000n, max: 800_000_000n } // 20/80

describe("quoteInZone (default 20/80 band)", () => {
  test("close = [45%, 55%]", () => {
    expect(quoteInZone(450_000_000n, "close", BAND)).toBe(true)
    expect(quoteInZone(500_000_000n, "close", BAND)).toBe(true)
    expect(quoteInZone(550_000_000n, "close", BAND)).toBe(true)
    expect(quoteInZone(449_999_999n, "close", BAND)).toBe(false)
    expect(quoteInZone(550_000_001n, "close", BAND)).toBe(false)
  })

  test("mid = [30%, 45%) ∪ (55%, 70%]", () => {
    expect(quoteInZone(300_000_000n, "mid", BAND)).toBe(true)
    expect(quoteInZone(449_999_999n, "mid", BAND)).toBe(true)
    expect(quoteInZone(450_000_000n, "mid", BAND)).toBe(false)
    expect(quoteInZone(550_000_001n, "mid", BAND)).toBe(true)
    expect(quoteInZone(700_000_000n, "mid", BAND)).toBe(true)
    expect(quoteInZone(700_000_001n, "mid", BAND)).toBe(false)
  })

  test("edge = [band-min, 30%) ∪ (70%, band-max]", () => {
    expect(quoteInZone(200_000_000n, "edge", BAND)).toBe(true)
    expect(quoteInZone(299_999_999n, "edge", BAND)).toBe(true)
    expect(quoteInZone(300_000_000n, "edge", BAND)).toBe(false)
    expect(quoteInZone(700_000_001n, "edge", BAND)).toBe(true)
    expect(quoteInZone(800_000_000n, "edge", BAND)).toBe(true)
    expect(quoteInZone(199_999_999n, "edge", BAND)).toBe(false)
    expect(quoteInZone(800_000_001n, "edge", BAND)).toBe(false)
  })

  test("tight band collapses edge into mid (spec: DECK_QUOTE_MIN_PROB=0.35)", () => {
    const tight: QuoteBand = { min: 350_000_000n, max: 650_000_000n }
    // edge's own intervals are empty → falls back to mid's (clipped).
    expect(quoteInZone(400_000_000n, "edge", tight)).toBe(true)
    expect(quoteInZone(500_000_000n, "edge", tight)).toBe(false) // close, not mid
  })

  test("pathologically tight band collapses everything into the band itself", () => {
    const tiny: QuoteBand = { min: 480_000_000n, max: 520_000_000n }
    expect(quoteInZone(500_000_000n, "edge", tiny)).toBe(true)
    expect(quoteInZone(500_000_000n, "mid", tiny)).toBe(true)
  })
})

describe("zoneDistance", () => {
  test("zero inside the zone", () => {
    expect(zoneDistance(500_000_000n, "close", BAND)).toBe(0n)
    expect(zoneDistance(250_000_000n, "edge", BAND)).toBe(0n)
  })

  test("distance to the nearest interval boundary", () => {
    // 50% to edge: low interval ends at 30%−1, high starts at 70%+1.
    expect(zoneDistance(500_000_000n, "edge", BAND)).toBe(200_000_001n)
    // 25% to close: close starts at 45%.
    expect(zoneDistance(250_000_000n, "close", BAND)).toBe(200_000_000n)
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
