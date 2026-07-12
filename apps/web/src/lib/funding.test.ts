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

test("SWIPE_QUANTITY matches the server's per-swipe notional (3 dUSDC)", () => {
  expect(SWIPE_QUANTITY).toBe(3_000_000n)
})

test("MAX_PREMIUM_BUDGET is a full 5-card deck of premiums (15 dUSDC)", () => {
  expect(MAX_PREMIUM_BUDGET).toBe(15_000_000n)
})

test("requiredManagerBalance = stake + 15 dUSDC for every staked tier", () => {
  // The number a player must hold in their AccountWrapper to clear the
  // server gate — stake + worst-case premium budget, both drawn from the
  // account. Must equal server requiredQueueBalance(tier).
  expect(requiredManagerBalance(STAKE_TIERS.starter)).toBe(16_000_000n) // 1 + 15
  expect(requiredManagerBalance(STAKE_TIERS.casual)).toBe(18_000_000n) // 3 + 15
  expect(requiredManagerBalance(STAKE_TIERS.standard)).toBe(20_000_000n) // 5 + 15
  expect(requiredManagerBalance(STAKE_TIERS.high_roller)).toBe(25_000_000n) // 10 + 15
})

test("requiredManagerBalance is always ≥ the MIN_MANAGER_BALANCE floor", () => {
  // Even a hypothetical zero-stake never drops below the protocol account
  // minimum (mirrors the server's floor at MIN_BALANCE_FOR_QUEUE).
  expect(requiredManagerBalance(0n)).toBe(15_000_000n)
  expect(requiredManagerBalance(0n)).toBeGreaterThanOrEqual(MIN_MANAGER_BALANCE)
})

test("requiredManagerBalance tracks the generic stake + budget formula", () => {
  for (const stake of Object.values(STAKE_TIERS)) {
    const expected = stake + MAX_PREMIUM_BUDGET
    const floored = expected > MIN_MANAGER_BALANCE ? expected : MIN_MANAGER_BALANCE
    expect(requiredManagerBalance(stake)).toBe(floored)
  }
})
