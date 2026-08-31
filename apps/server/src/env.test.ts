/**
 * Env bigint parsing. `.env.example` documents optional vars as
 * `SPONSOR_MAX_GAS_BUDGET=` (empty). Bun's dotenv loads that as `""`,
 * and `BigInt("")` is `0n` — which made the sponsor policy cap every
 * transaction at 0 MIST (`GAS_BUDGET_TOO_HIGH`).
 */
import { describe, expect, test } from "bun:test"
import { parseEnvBigInt } from "./env"

describe("parseEnvBigInt", () => {
  test("empty string falls back instead of becoming 0n", () => {
    expect(parseEnvBigInt("", 100_000_000n)).toBe(100_000_000n)
  })

  test("whitespace-only falls back", () => {
    expect(parseEnvBigInt("  ", 100_000_000n)).toBe(100_000_000n)
  })

  test("unset falls back", () => {
    expect(parseEnvBigInt(undefined, 100_000_000n)).toBe(100_000_000n)
  })

  test("parses a real MIST value", () => {
    expect(parseEnvBigInt("50000000", 100_000_000n)).toBe(50_000_000n)
  })
})
