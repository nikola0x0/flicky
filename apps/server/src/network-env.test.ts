/**
 * Per-network env resolution.
 *
 * The rule that matters here is the asymmetry: testnet may fall back to a
 * bare (unsuffixed) var and a baked-in default, mainnet may not. A mainnet id
 * that silently inherits a testnet value is how a mainnet PTB ends up
 * targeting a testnet package — and how the sponsor would allowlist one.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { networkEnv, pick, UNSET_ID } from "./network-env"

const TOUCHED = [
  "DEEPBOOK_PREDICT_PACKAGE",
  "DEEPBOOK_PREDICT_PACKAGE_ID",
  "DEEPBOOK_PREDICT_PACKAGE_MAINNET",
  "DEEPBOOK_PREDICT_PACKAGE_ID_MAINNET",
  "DEEPBOOK_PREDICT_PACKAGE_TESTNET",
  "FLICKY_PACKAGE_MAINNET",
  "PROTOCOL_CONFIG_ID_MAINNET",
  "SUI_GRPC_URL_MAINNET",
]

afterEach(() => {
  for (const k of TOUCHED) delete process.env[k]
})

describe("pick", () => {
  test("mainnet reads only the _MAINNET name, never the bare one", () => {
    process.env.DEEPBOOK_PREDICT_PACKAGE = "0xtestnetvalue"
    expect(pick("DEEPBOOK_PREDICT_PACKAGE", "mainnet")).toBeUndefined()

    process.env.DEEPBOOK_PREDICT_PACKAGE_MAINNET = "0xmainnetvalue"
    expect(pick("DEEPBOOK_PREDICT_PACKAGE", "mainnet")).toBe("0xmainnetvalue")
  })

  test("testnet accepts the bare name and the _TESTNET suffix", () => {
    process.env.DEEPBOOK_PREDICT_PACKAGE = "0xbare"
    expect(pick("DEEPBOOK_PREDICT_PACKAGE", "testnet")).toBe("0xbare")

    // Suffixed wins over bare — it's the more specific statement.
    process.env.DEEPBOOK_PREDICT_PACKAGE_TESTNET = "0xsuffixed"
    expect(pick("DEEPBOOK_PREDICT_PACKAGE", "testnet")).toBe("0xsuffixed")
  })

  test("historical _ID spelling still resolves on both networks", () => {
    process.env.DEEPBOOK_PREDICT_PACKAGE_ID = "0xlegacybare"
    expect(pick("DEEPBOOK_PREDICT_PACKAGE", "testnet")).toBe("0xlegacybare")

    process.env.DEEPBOOK_PREDICT_PACKAGE_ID_MAINNET = "0xlegacymainnet"
    expect(pick("DEEPBOOK_PREDICT_PACKAGE", "mainnet")).toBe("0xlegacymainnet")
  })

  test("returns undefined when nothing is set", () => {
    expect(pick("DEFINITELY_NOT_SET_ANYWHERE", "mainnet")).toBeUndefined()
    expect(pick("DEFINITELY_NOT_SET_ANYWHERE", "testnet")).toBeUndefined()
  })
})

describe("networkEnv", () => {
  test("testnet resolves the baked-in 6-24 defaults", () => {
    const ne = networkEnv("testnet")
    expect(ne.network).toBe("testnet")
    expect(ne.deepbookPredictPackageId).not.toBe(UNSET_ID)
    expect(ne.deepbookPredictPackageId).toStartWith("0x")
    expect(ne.predictIndexerUrl).toContain("testnet")
  })

  test("mainnet leaves Predict ids unset — no testnet bleed-through", () => {
    const ne = networkEnv("mainnet")
    expect(ne.network).toBe("mainnet")
    expect(ne.deepbookPredictPackageId).toBe(UNSET_ID)
    expect(ne.protocolConfigId).toBe(UNSET_ID)
    expect(ne.accountRegistryId).toBe(UNSET_ID)
    // An unresolvable host, so a stray fetch fails fast rather than silently
    // reading testnet market data while the user is on mainnet.
    expect(ne.predictIndexerUrl).toContain(".invalid")
  })

  test("predictAvailable is false on mainnet until BOTH ids are supplied", () => {
    expect(networkEnv("mainnet").predictAvailable).toBe(false)

    process.env.DEEPBOOK_PREDICT_PACKAGE_MAINNET = "0xpredictmainnet"
    expect(networkEnv("mainnet").predictAvailable).toBe(false)

    process.env.FLICKY_PACKAGE_MAINNET = "0xflickymainnet"
    expect(networkEnv("mainnet").predictAvailable).toBe(true)
  })

  test("testnet predictAvailable is true out of the box", () => {
    expect(networkEnv("testnet").predictAvailable).toBe(true)
  })

  test("a _MAINNET override is picked up without a restart", () => {
    expect(networkEnv("mainnet").protocolConfigId).toBe(UNSET_ID)
    process.env.PROTOCOL_CONFIG_ID_MAINNET = "0xcfg"
    // Resolution is uncached on purpose — a memo here would serve stale
    // config after any env change.
    expect(networkEnv("mainnet").protocolConfigId).toBe("0xcfg")
  })

  test("node endpoints default per network and are overridable", () => {
    expect(networkEnv("testnet").grpcUrl).toContain("testnet")
    expect(networkEnv("mainnet").grpcUrl).toContain("mainnet")

    process.env.SUI_GRPC_URL_MAINNET = "https://private.example:443"
    expect(networkEnv("mainnet").grpcUrl).toBe("https://private.example:443")
  })

  test("deployed.json is not used as a mainnet flicky package fallback", () => {
    // deployed.json records network: "testnet"; using it for mainnet would
    // hand a testnet package id to a mainnet PTB.
    expect(networkEnv("mainnet").flickyPackageId).toBeNull()
    expect(networkEnv("testnet").flickyPackageId).not.toBeNull()
  })
})
