import { expect, test } from "bun:test"
import {
  MAX_PREMIUM_BUDGET,
  MIN_MANAGER_BALANCE,
  requiredManagerBalance,
  SWIPE_QUANTITY,
} from "./funding"
import { STAKE_TIERS } from "./protocol"

// These constants MUST stay in lockstep with the server's queue gate
// (apps/server/src/predict.ts: SWIPE_QUANTITY_MIST, MAX_DECK_SIZE,
// requiredQueueBalance). If they drift, the web deposits an amount the server
// then rejects at queue_join — the exact deposit-then-bounce bug this fixes.

test("SWIPE_QUANTITY matches the server's per-swipe notional (6 dUSDC)", () => {
  expect(SWIPE_QUANTITY).toBe(6_000_000n)
})

test("MAX_PREMIUM_BUDGET is a full 5-card deck of premiums (30 dUSDC)", () => {
  expect(MAX_PREMIUM_BUDGET).toBe(30_000_000n)
})

test("requiredManagerBalance = stake + 30 dUSDC for every staked tier", () => {
  // The number a player must hold in their AccountWrapper to clear the
  // server gate — stake + worst-case premium budget, both drawn from the
  // account. Must equal server requiredQueueBalance(tier).
  expect(requiredManagerBalance(STAKE_TIERS.starter)).toBe(31_000_000n) // 1 + 30
  expect(requiredManagerBalance(STAKE_TIERS.casual)).toBe(33_000_000n) // 3 + 30
  expect(requiredManagerBalance(STAKE_TIERS.standard)).toBe(35_000_000n) // 5 + 30
  expect(requiredManagerBalance(STAKE_TIERS.high_roller)).toBe(40_000_000n) // 10 + 30
})

test("requiredManagerBalance is always ≥ the MIN_MANAGER_BALANCE floor", () => {
  // Even a hypothetical zero-stake never drops below the protocol account
  // minimum (mirrors the server's floor at MIN_BALANCE_FOR_QUEUE).
  expect(requiredManagerBalance(0n)).toBe(30_000_000n)
  expect(requiredManagerBalance(0n)).toBeGreaterThanOrEqual(MIN_MANAGER_BALANCE)
})

test("requiredManagerBalance tracks the generic stake + budget formula", () => {
  for (const stake of Object.values(STAKE_TIERS)) {
    const expected = stake + MAX_PREMIUM_BUDGET
    const floored = expected > MIN_MANAGER_BALANCE ? expected : MIN_MANAGER_BALANCE
    expect(requiredManagerBalance(stake)).toBe(floored)
  }
})
