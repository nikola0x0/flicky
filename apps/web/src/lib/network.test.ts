/**
 * Network resolution + the config slice it selects.
 *
 * Runs under `bun test`, where there is no `localStorage` and no Vite env —
 * so this exercises the fallback path (no stored choice, no VITE_SUI_NETWORK
 * → testnet), which is also exactly what a fresh browser sees.
 */
import { describe, expect, test } from "bun:test"

import { ACTIVE_NETWORK, AVAILABLE_NETWORKS, DEFAULT_NETWORK } from "./network"
import { CONFIG, DUELS_ENABLED, apiUrl, explorerObjectUrl } from "./config"

describe("network resolution", () => {
  test("defaults to testnet with no stored choice and no env", () => {
    expect(DEFAULT_NETWORK).toBe("testnet")
    expect(ACTIVE_NETWORK).toBe("testnet")
  })

  test("offers both networks by default", () => {
    expect(AVAILABLE_NETWORKS).toContain("testnet")
    expect(AVAILABLE_NETWORKS).toContain("mainnet")
  })

  test("reading localStorage without a DOM does not throw", () => {
    // The module already evaluated above; reaching this line at all proves
    // the guarded read degraded instead of blowing up at import time.
    expect(typeof ACTIVE_NETWORK).toBe("string")
  })
})

describe("CONFIG", () => {
  test("selects the active network's slice", () => {
    expect(CONFIG.network).toBe(ACTIVE_NETWORK)
    expect(CONFIG.explorerNetwork).toBe("testnet")
  })

  test("testnet resolves real Predict ids, so duels are enabled", () => {
    expect(DUELS_ENABLED).toBe(true)
    expect(CONFIG.deepbookPredictPackageId).toStartWith("0x")
    expect(CONFIG.deepbookPredictPackageId).not.toBe("0x0")
    expect(CONFIG.packageId).not.toBe("0x0")
  })

  test("stake type is SUI on every network", () => {
    expect(CONFIG.stakeType).toBe("0x2::sui::SUI")
  })
})

describe("apiUrl", () => {
  test("appends the active network to a bare path", () => {
    expect(apiUrl("/leaderboard")).toBe(
      `${CONFIG.serverHttpUrl}/leaderboard?network=testnet`
    )
  })

  test("uses & when the path already carries a query string", () => {
    expect(apiUrl("/duels/recent?limit=20")).toBe(
      `${CONFIG.serverHttpUrl}/duels/recent?limit=20&network=testnet`
    )
  })
})

describe("explorerObjectUrl", () => {
  test("points at the active network's suiscan path", () => {
    expect(explorerObjectUrl("0xabc")).toBe(
      "https://suiscan.xyz/testnet/object/0xabc"
    )
  })
})

/**
 * Regression guard for the empty-string hazard.
 *
 * `.env` templates declare mainnet placeholders as `VITE_FOO_MAINNET=`, which
 * Vite inlines as `""`. `"" ?? fallback` is `""`, so a `??`-based resolver
 * produced an empty package id AND a `predictAvailable` that computed true
 * (because `"" !== "0x0"`) — the mainnet gate would never have engaged. The
 * config resolver treats empty as unset for exactly this reason.
 */
describe("empty env values count as unset", () => {
  test("AVAILABLE_NETWORKS is never empty", () => {
    expect(AVAILABLE_NETWORKS.length).toBeGreaterThan(0)
  })

  test("no config field resolves to an empty string", () => {
    for (const [key, value] of Object.entries(CONFIG)) {
      if (typeof value !== "string") continue
      expect(value, `CONFIG.${key} should not be empty`).not.toBe("")
    }
  })

  test("every id-shaped field looks like an id or the unset sentinel", () => {
    const idFields = [
      CONFIG.packageId,
      CONFIG.deepbookPredictPackageId,
      CONFIG.protocolConfigId,
      CONFIG.accountRegistryId,
      CONFIG.accumulatorRootId,
    ]
    for (const v of idFields) expect(v).toStartWith("0x")
  })
})
