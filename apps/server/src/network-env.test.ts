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
  test("testnet resolves the baked-in 8-21 defaults", () => {
    const ne = networkEnv("testnet")
    expect(ne.network).toBe("testnet")
    expect(ne.deepbookPredictPackageId).toBe(
      "0x421041754244cf0e985fb9c9f5e1f49428caf3df4cde3a7b266d8e18ea63597b"
    )
    expect(ne.accountPackageId).toBe(
      "0xa94ec89b6cbb3e2609c7ca65bd77885b7513f852922ebdf8e766851fb6f85259"
    )
    expect(ne.accountRegistryId).toBe(
      "0x5682c73d657de1546374e632369a25c82744c8a20e9b4f47e6558e3d4bde88d3"
    )
    expect(ne.bsValueStoreId).toBe(
      "0x9b64cc860ac09e6dcd675fc579c1048792ddce51cc018f2ca16aeb4a1a5684a3"
    )
    expect(ne.bsSviStoreId).toBe(
      "0xd5bc586e99c8d595e0ba5e0a2ef2295e652db8934ffbeda630d60e207bedab8f"
    )
    expect(ne.predictIndexerUrl).toBe(
      "https://predict-server-v4.testnet.mystenlabs.com"
    )
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
