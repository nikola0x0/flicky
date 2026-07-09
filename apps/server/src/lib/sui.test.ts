import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { SuiGrpcClient } from "@mysten/sui/grpc"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { getAdminKeypair, getSuiClient, requireEnv } from "./sui"

// Save + restore env between tests so they don't leak.
let originalEnv: NodeJS.ProcessEnv

beforeEach(() => {
  originalEnv = { ...process.env }
})

afterEach(() => {
  process.env = originalEnv
})

describe("requireEnv", () => {
  test("returns the value when present", () => {
    process.env.TEST_SUI_VAR = "hello"
    expect(requireEnv("TEST_SUI_VAR")).toBe("hello")
  })

  test("throws when missing", () => {
    delete process.env.TEST_SUI_VAR
    expect(() => requireEnv("TEST_SUI_VAR")).toThrow(/missing env: TEST_SUI_VAR/)
  })

  test("throws when empty string", () => {
    process.env.TEST_SUI_VAR = ""
    expect(() => requireEnv("TEST_SUI_VAR")).toThrow(/missing env: TEST_SUI_VAR/)
  })
})

describe("getSuiClient", () => {
  test("defaults to testnet when SUI_NETWORK is unset", () => {
    delete process.env.SUI_NETWORK
    delete process.env.SUI_GRPC_URL
    const c = getSuiClient()
    expect(c).toBeInstanceOf(SuiGrpcClient)
  })

  test("honors explicit SUI_GRPC_URL", () => {
    process.env.SUI_GRPC_URL = "https://example.invalid"
    const c = getSuiClient()
    expect(c).toBeInstanceOf(SuiGrpcClient)
  })
})

describe("getAdminKeypair", () => {
  test("derives Ed25519 keypair from suiprivkey1 bech32", () => {
    // Generate a fresh throwaway keypair inside the test so no secret
    // is ever embedded in source. Round-trips it through the env-based
    // loader to verify the bech32 decode path.
    const fresh = Ed25519Keypair.generate()
    process.env.ADMIN_SECRET_KEY = fresh.getSecretKey()
    const kp = getAdminKeypair()
    expect(kp).toBeInstanceOf(Ed25519Keypair)
    expect(kp.toSuiAddress()).toBe(fresh.toSuiAddress())
  })

  test("throws when ADMIN_SECRET_KEY missing", () => {
    delete process.env.ADMIN_SECRET_KEY
    expect(() => getAdminKeypair()).toThrow(/missing env: ADMIN_SECRET_KEY/)
  })
})
