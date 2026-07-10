/**
 * deriveWrapperFor return-contract tests. The critical safety property: a
 * `null` must mean "the registry authoritatively says no wrapper exists
 * yet" (a clean `derived_wrapper_exists === false` read) — never "the
 * devInspect failed". A failed devInspect MUST throw, so a transient RPC
 * error can't masquerade as "no wrapper" (which would make the web mint a
 * duplicate deposit path). See predict.ts for the contract.
 *
 * deriveWrapperFor is cache-first, so every call touches the Postgres
 * `predict_manager` table (reused as the owner→wrapper cache) — the suite
 * runs only against a throwaway TEST_DATABASE_URL (see test-preload.ts)
 * and skips otherwise.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import type { SuiGrpcClient } from "@mysten/sui/grpc"
import { bcs } from "@mysten/sui/bcs"
import * as predict from "./predict"
import * as db from "./db"
import { HAS_TEST_DB, resetTables } from "./test-db"

const boolBytes = (v: boolean) => bcs.bool().serialize(v).toBytes()
const addrBytes = (addr: string) => bcs.Address.serialize(addr).toBytes()

const WRAPPER = "0x" + "42".repeat(32)

/**
 * Fake gRPC client whose `core.simulateTransaction` returns one scripted
 * devInspect result per call, in order — mirroring
 * `derived_wrapper_exists` then (if reached) `derived_wrapper_address`.
 * `undefined` entries throw (RPC error mid-call); over-reading past the
 * scripted queue also throws.
 */
function clientFromReturns(
  returns: Array<Uint8Array | "throw">,
): SuiGrpcClient {
  let i = 0
  return {
    core: {
      simulateTransaction: async () => {
        if (i >= returns.length) throw new Error("over-read past scripted devInspect calls")
        const next = returns[i++]
        if (next === "throw") throw new Error("RPC unavailable")
        return { commandResults: [{ returnValues: [{ bcs: next }] }] }
      },
    },
  } as unknown as SuiGrpcClient
}

describe.skipIf(!HAS_TEST_DB)("deriveWrapperFor return contract", () => {
  beforeEach(async () => {
    await resetTables()
  })

  afterAll(async () => {
    await db.closeDb()
  })

  test("returns the derived wrapper address when derived_wrapper_exists is true", async () => {
    const c = clientFromReturns([boolBytes(true), addrBytes(WRAPPER)])
    expect(await predict.deriveWrapperFor(c, "0xalice")).toBe(WRAPPER)
  })

  test("returns null (authoritative) when derived_wrapper_exists is false", async () => {
    const c = clientFromReturns([boolBytes(false)])
    expect(await predict.deriveWrapperFor(c, "0xnobody")).toBeNull()
  })

  test("THROWS on an RPC error during derived_wrapper_exists — never a false null", async () => {
    const c = clientFromReturns(["throw"])
    expect(predict.deriveWrapperFor(c, "0xowner")).rejects.toThrow("RPC unavailable")
  })

  test("THROWS on an RPC error during derived_wrapper_address (after exists=true)", async () => {
    const c = clientFromReturns([boolBytes(true), "throw"])
    expect(predict.deriveWrapperFor(c, "0xowner")).rejects.toThrow("RPC unavailable")
  })

  test("a cache hit short-circuits without touching the client", async () => {
    await db.cacheManager("0xcached", WRAPPER)
    // A client with no scripted responses would throw (over-read) if any
    // devInspect ran; the cache must win before that.
    const c = clientFromReturns([])
    expect(await predict.deriveWrapperFor(c, "0xcached")).toBe(WRAPPER)
  })

  test("memoizes a freshly-derived wrapper into the cache", async () => {
    const c = clientFromReturns([boolBytes(true), addrBytes(WRAPPER)])
    await predict.deriveWrapperFor(c, "0xfresh")
    expect(await db.getCachedManager("0xfresh")).toBe(WRAPPER)
  })
})
