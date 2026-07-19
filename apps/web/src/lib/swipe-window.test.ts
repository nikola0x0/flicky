import { expect, test } from "bun:test"
import {
  CARD_SWIPE_BUFFER_MS,
  cardSwipeRemainingMs,
  SWIPE_WINDOW_MS,
  swipeWindowRemainingMs,
} from "./swipe-window"

test("SWIPE_WINDOW_MS matches the contract's 5-minute window", () => {
  expect(SWIPE_WINDOW_MS).toBe(300_000)
})

test("full window remaining at start with no clock skew", () => {
  expect(
    swipeWindowRemainingMs({ startedAtMs: 0, serverClockOffsetMs: 0, nowMs: 0 })
  ).toBe(300_000)
})

test("counts down as wall-clock advances", () => {
  expect(
    swipeWindowRemainingMs({
      startedAtMs: 0,
      serverClockOffsetMs: 0,
      nowMs: 150_000,
    })
  ).toBe(150_000)
})

test("goes negative once the window has elapsed", () => {
  expect(
    swipeWindowRemainingMs({
      startedAtMs: 0,
      serverClockOffsetMs: 0,
      nowMs: 300_001,
    })
  ).toBe(-1)
})

test("server offset corrects a fast client clock", () => {
  // Client clock reads 10_000 but the server is 4s behind it (offset -4000),
  // so the true elapsed time is 6_000 → 294_000 remaining.
  expect(
    swipeWindowRemainingMs({
      startedAtMs: 0,
      serverClockOffsetMs: -4_000,
      nowMs: 10_000,
    })
  ).toBe(294_000)
})

test("cardSwipeRemainingMs: deadline is expiry minus the tx buffer", () => {
  // Market expires at 180_000; buffer is subtracted so the swipe still lands
  // while the market is live. At now=0 → 180_000 − buffer remaining.
  expect(
    cardSwipeRemainingMs({
      cardExpiryMs: 180_000,
      serverClockOffsetMs: 0,
      nowMs: 0,
    })
  ).toBe(180_000 - CARD_SWIPE_BUFFER_MS)
})

test("cardSwipeRemainingMs: goes negative once past the buffered deadline", () => {
  // At now = expiry − buffer + 1 the deadline has just passed.
  expect(
    cardSwipeRemainingMs({
      cardExpiryMs: 180_000,
      serverClockOffsetMs: 0,
      nowMs: 180_000 - CARD_SWIPE_BUFFER_MS + 1,
    })
  ).toBe(-1)
})

test("cardSwipeRemainingMs: null when the card's expiry is unknown", () => {
  expect(
    cardSwipeRemainingMs({
      cardExpiryMs: undefined,
      serverClockOffsetMs: 0,
      nowMs: 0,
    })
  ).toBeNull()
})

test("cardSwipeRemainingMs: applies the server clock offset", () => {
  // Client clock is 4s ahead of server (offset -4000): true now is 4s earlier,
  // so 4_000 more ms remain than the raw client clock implies.
  expect(
    cardSwipeRemainingMs({
      cardExpiryMs: 180_000,
      serverClockOffsetMs: -4_000,
      nowMs: 10_000,
    })
  ).toBe(180_000 - CARD_SWIPE_BUFFER_MS - (10_000 - 4_000))
})
