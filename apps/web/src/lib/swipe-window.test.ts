import { expect, test } from "bun:test"
import { SWIPE_WINDOW_MS, swipeWindowRemainingMs } from "./swipe-window"

test("SWIPE_WINDOW_MS matches the contract's 10-minute window", () => {
  expect(SWIPE_WINDOW_MS).toBe(600_000)
})

test("full window remaining at start with no clock skew", () => {
  expect(
    swipeWindowRemainingMs({ startedAtMs: 0, serverClockOffsetMs: 0, nowMs: 0 }),
  ).toBe(600_000)
})

test("counts down as wall-clock advances", () => {
  expect(
    swipeWindowRemainingMs({
      startedAtMs: 0,
      serverClockOffsetMs: 0,
      nowMs: 300_000,
    }),
  ).toBe(300_000)
})

test("goes negative once the window has elapsed", () => {
  expect(
    swipeWindowRemainingMs({
      startedAtMs: 0,
      serverClockOffsetMs: 0,
      nowMs: 600_001,
    }),
  ).toBe(-1)
})

test("server offset corrects a fast client clock", () => {
  // Client clock reads 10_000 but the server is 4s behind it (offset -4000),
  // so the true elapsed time is 6_000 → 594_000 remaining.
  expect(
    swipeWindowRemainingMs({
      startedAtMs: 0,
      serverClockOffsetMs: -4_000,
      nowMs: 10_000,
    }),
  ).toBe(594_000)
})
