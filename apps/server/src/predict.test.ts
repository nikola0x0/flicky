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
const ALICE = "0x" + "a1".repeat(32)
const BOB = "0x" + "b0".repeat(32)

/**
 * Fake gRPC client whose `core.simulateTransaction` returns one scripted
 * devInspect result per call, in order — mirroring
 * `derived_wrapper_exists` then (if reached) `derived_wrapper_address`.
 * `undefined` entries throw (RPC error mid-call); over-reading past the
 * scripted queue also throws.
 *
 * The scripted value is duplicated at commandResults[0] AND [1]: callers
 * that read commandIndex 0 (deriveWrapperFor's exists/address calls) and
 * callers that read commandIndex 1 (readAccountBalance's chained
 * load_account -> balance PTB) both see it regardless of which single
 * command they're actually simulating here.
 */
function clientFromReturns(
  returns: Array<Uint8Array | "throw">
): SuiGrpcClient {
  let i = 0
  return {
    core: {
      simulateTransaction: async () => {
        if (i >= returns.length)
          throw new Error("over-read past scripted devInspect calls")
        const next = returns[i++]
        if (next === "throw") throw new Error("RPC unavailable")
        const result = { returnValues: [{ bcs: next }] }
        return { commandResults: [result, result] }
      },
    },
  } as unknown as SuiGrpcClient
}

const u64Bytes = (v: bigint) => bcs.u64().serialize(v).toBytes()

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
    expect(predict.deriveWrapperFor(c, "0xowner")).rejects.toThrow(
      "RPC unavailable"
    )
  })

  test("THROWS on an RPC error during derived_wrapper_address (after exists=true)", async () => {
    const c = clientFromReturns([boolBytes(true), "throw"])
    expect(predict.deriveWrapperFor(c, "0xowner")).rejects.toThrow(
      "RPC unavailable"
    )
  })

  test("a cache hit short-circuits without touching the client", async () => {
    // Written under the namespaced key, exactly as deriveWrapperFor itself
    // would write it (see the memoize test below) — simulates a
    // previously-resolved 6-24 wrapper, not a raw DB poke.
    await db.cacheManager(predict.WRAPPER_CACHE_PREFIX + "0xcached", WRAPPER)
    // A client with no scripted responses would throw (over-read) if any
    // devInspect ran; the cache must win before that.
    const c = clientFromReturns([])
    expect(await predict.deriveWrapperFor(c, "0xcached")).toBe(WRAPPER)
  })

  test("memoizes a freshly-derived wrapper into the cache under the namespaced key", async () => {
    const c = clientFromReturns([boolBytes(true), addrBytes(WRAPPER)])
    await predict.deriveWrapperFor(c, "0xfresh")
    expect(
      await db.getCachedManager(predict.WRAPPER_CACHE_PREFIX + "0xfresh")
    ).toBe(WRAPPER)
    // And NOT under the bare owner key — that's the legacy 4-16 shape.
    expect(await db.getCachedManager("0xfresh")).toBeNull()
  })

  test("a legacy 4-16 row keyed by bare owner address is NEVER returned as a wrapper", async () => {
    // Simulates a REUSED Postgres carrying a stale row from the deleted
    // `findManagerFor`: a `PredictManager` id keyed by bare owner address,
    // with no namespace prefix. If deriveWrapperFor's cache read matched
    // this row, the legacy PredictManager id would leak out as if it were
    // a validated 6-24 AccountWrapper — see the SAFETY note in predict.ts.
    const legacyManagerId = "0x" + "99".repeat(32)
    await db.cacheManager("0xlegacy", legacyManagerId)

    // The cache miss must fall through to a real devInspect derivation
    // (scripted responses below) rather than short-circuiting on the
    // legacy row, and the result must be the freshly-derived wrapper, not
    // the legacy id.
    const c = clientFromReturns([boolBytes(true), addrBytes(WRAPPER)])
    const resolved = await predict.deriveWrapperFor(c, "0xlegacy")
    expect(resolved).toBe(WRAPPER)
    expect(resolved).not.toBe(legacyManagerId)
  })
})

/**
 * checkQueueBalanceGate's balance read is a devInspect against a
 * load-balanced gRPC endpoint — a single call can land on a replica that
 * hasn't yet caught up to a deposit the player just made client-side (see
 * `waitForManagerBalance` in web's deepbook.ts, which absorbs the same lag
 * on the client). The gate must retry a lagging "insufficient" read before
 * rejecting, the way the oracle preflight in ws/handlers.ts already retries
 * a momentary market dip — otherwise a real just-completed deposit produces
 * a spurious `insufficient_balance` error immediately after success.
 */
describe.skipIf(!HAS_TEST_DB)("checkQueueBalanceGate balance-read retry", () => {
  beforeEach(async () => {
    await resetTables()
  })

  afterAll(async () => {
    await db.closeDb()
  })

  test("absorbs one stale-replica read and succeeds once balance catches up", async () => {
    const required = 16_000_000n
    // exists, address (wrapper resolution) — then two balance reads: the
    // first still reflects the pre-deposit balance, the second (post-retry)
    // reflects the deposit having landed.
    const c = clientFromReturns([
      boolBytes(true),
      addrBytes(WRAPPER),
      u64Bytes(1_000_000n),
      u64Bytes(20_000_000n),
    ])
    const gate = await predict.checkQueueBalanceGate(c, ALICE, required)
    expect(gate.ok).toBe(true)
    if (gate.ok) expect(gate.balance).toBe(20_000_000n)
  })

  test("still reports insufficient_balance once retries are exhausted", async () => {
    const required = 16_000_000n
    const c = clientFromReturns([
      boolBytes(true),
      addrBytes(WRAPPER),
      u64Bytes(1_000_000n),
      u64Bytes(1_000_000n),
      u64Bytes(1_000_000n),
    ])
    const gate = await predict.checkQueueBalanceGate(c, BOB, required)
    expect(gate.ok).toBe(false)
    if (!gate.ok && gate.reason === "insufficient_balance") {
      expect(gate.balance).toBe(1_000_000n)
    } else {
      throw new Error(`expected insufficient_balance, got ${JSON.stringify(gate)}`)
    }
  })
})

/**
 * `requiredQueueBalance` is pure (just STAKE_TIERS arithmetic, no RPC/DB),
 * so — unlike the suite above — these run unconditionally, with no
 * TEST_DATABASE_URL gate.
 *
 * required = tierStake + 5 cards × 3 dUSDC premium budget (15 dUSDC),
 * floored at the absolute 5 dUSDC minimum.
 */
describe("requiredQueueBalance", () => {
  test("standard tier: stake 5 + 15 premium budget", () => {
    expect(predict.requiredQueueBalance("standard")).toBe(20_000_000n)
  })

  test("high_roller tier: stake 10 + 15 premium budget", () => {
    expect(predict.requiredQueueBalance("high_roller")).toBe(25_000_000n)
  })

  test("starter tier: stake 1 + 15 premium budget", () => {
    expect(predict.requiredQueueBalance("starter")).toBe(16_000_000n)
  })
})
