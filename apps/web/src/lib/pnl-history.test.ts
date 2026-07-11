import { expect, test } from "bun:test"
import {
  MAX_SAMPLES,
  Y_FLOOR_MICRO,
  yAmpFor,
  relativeTimeLabels,
  trimHistory,
  serializeHistory,
  parseHistory,
  type Sample,
  type Boundary,
} from "./pnl-history"

test("yAmpFor floors at Y_FLOOR_MICRO for empty samples", () => {
  expect(yAmpFor([], true)).toBe(Number((Y_FLOOR_MICRO * 115n) / 100n))
})

test("yAmpFor frames the larger side, padded 15%", () => {
  const samples: Sample[] = [{ t: 0, p0: 2_000_000n, p1: -500_000n }]
  expect(yAmpFor(samples, true)).toBe(Number((2_000_000n * 115n) / 100n))
  expect(yAmpFor(samples, false)).toBe(Number((2_000_000n * 115n) / 100n))
})

test("relativeTimeLabels spaces n marks; last is now", () => {
  const l = relativeTimeLabels(0, 120_000, 3)
  expect(l.map((x) => x.t)).toEqual([0, 60_000, 120_000])
  expect(l.map((x) => x.label)).toEqual(["0:00", "1:00", "now"])
})

test("relativeTimeLabels pads seconds", () => {
  const l = relativeTimeLabels(0, 5_000, 2)
  expect(l[0].label).toBe("0:00")
  expect(l[1].label).toBe("now")
})

test("trimHistory keeps newest MAX_SAMPLES and drops stale boundaries", () => {
  const samples: Sample[] = Array.from({ length: MAX_SAMPLES + 5 }, (_, i) => ({
    t: i * 1000,
    p0: BigInt(i),
    p1: 0n,
  }))
  const boundaries: Boundary[] = [
    { t: 0, idx: 0 },
    { t: (MAX_SAMPLES + 4) * 1000, idx: 1 },
  ]
  const r = trimHistory(samples, boundaries)
  expect(r.samples.length).toBe(MAX_SAMPLES)
  expect(r.samples[0].t).toBe(5 * 1000)
  expect(r.firstT).toBe(5 * 1000)
  expect(r.boundaries).toEqual([{ t: (MAX_SAMPLES + 4) * 1000, idx: 1 }])
})

test("serializeHistory/parseHistory round-trips bigints beyond 2^53", () => {
  const big = 9_007_199_254_740_993n
  const samples: Sample[] = [
    { t: 1000, p0: big, p1: -big },
    { t: 2000, p0: 0n, p1: 3n },
  ]
  const boundaries: Boundary[] = [{ t: 1500, idx: 0 }]
  const parsed = parseHistory(serializeHistory("duel-x", samples, boundaries))
  expect(parsed).not.toBeNull()
  expect(parsed!.duelId).toBe("duel-x")
  expect(parsed!.samples).toEqual(samples)
  expect(parsed!.boundaries).toEqual(boundaries)
  expect(parsed!.firstT).toBe(1000)
})

test("parseHistory returns null on corrupt/mismatched input", () => {
  expect(parseHistory(null)).toBeNull()
  expect(parseHistory("not json")).toBeNull()
  expect(
    parseHistory(
      JSON.stringify({ v: 2, duelId: "x", samples: [], boundaries: [] })
    )
  ).toBeNull()
  expect(
    parseHistory(
      JSON.stringify({ v: 1, duelId: 123, samples: [], boundaries: [] })
    )
  ).toBeNull()
  expect(
    parseHistory(
      JSON.stringify({ v: 1, duelId: "x", samples: "nope", boundaries: [] })
    )
  ).toBeNull()
})
