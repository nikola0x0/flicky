/**
 * findManagerFor return-contract tests. The critical safety property: a
 * `null` must mean "scanned the whole event stream, found none" — never
 * "the scan failed". A failed scan MUST throw, so a transient RPC error
 * can't masquerade as a missing manager (which would make the web mint a
 * duplicate PredictManager). See predict.ts for the contract.
 *
 * findManagerFor is cache-first, so every call touches the Postgres
 * `predict_manager` table — the suite runs only against a throwaway
 * TEST_DATABASE_URL (see test-preload.ts) and skips otherwise.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import type { SuiGrpcClient } from "@mysten/sui/grpc"
import { normalizeSuiObjectId } from "@mysten/sui/utils"
import * as predict from "./predict"
import * as db from "./db"
import { HAS_TEST_DB, resetTables } from "./test-db"

/** Mirror the id normalization findManagerFor applies before returning. */
const mgr = (owner: string, i: number) =>
  normalizeSuiObjectId(`0xmgr_${owner}_${i}`)

/** A page of PredictManagerCreated events as the RPC would return them. */
function page(owners: string[], hasNextPage: boolean) {
  return {
    data: owners.map((owner, i) => ({
      parsedJson: { manager_id: `0xmgr_${owner}_${i}`, owner },
    })),
    hasNextPage,
    nextCursor: hasNextPage ? { txDigest: "tx", eventSeq: "0" } : null,
  }
}

/** Fake client that returns `pages` in order, then throws if over-read. */
function clientFromPages(pages: ReturnType<typeof page>[]): SuiGrpcClient {
  let i = 0
  return {
    queryEvents: async () => {
      if (i >= pages.length) throw new Error("over-read past scripted pages")
      return pages[i++]
    },
  } as unknown as SuiGrpcClient
}

/** Fake client whose queryEvents always rejects (RPC down). */
function throwingClient(): SuiGrpcClient {
  return {
    queryEvents: async () => {
      throw new Error("RPC unavailable")
    },
  } as unknown as SuiGrpcClient
}

describe.skipIf(!HAS_TEST_DB)("findManagerFor return contract", () => {
  beforeEach(async () => {
    await resetTables()
  })

  afterAll(async () => {
    await db.closeDb()
  })

  test("returns the manager id when the owner is on the first page", async () => {
    const c = clientFromPages([page(["0xalice", "0xbob"], false)])
    expect(await predict.findManagerFor(c, "0xbob")).toBe(mgr("0xbob", 1))
  })

  test("finds a manager buried several pages deep (proves multi-page walk)", async () => {
    const c = clientFromPages([
      page(["0xa", "0xb"], true),
      page(["0xc", "0xd"], true),
      page(["0xe", "0xtarget"], false),
    ])
    expect(await predict.findManagerFor(c, "0xtarget")).toBe(mgr("0xtarget", 1))
  })

  test("returns null ONLY after exhausting the stream (hasNextPage=false)", async () => {
    const c = clientFromPages([
      page(["0xa", "0xb"], true),
      page(["0xc", "0xd"], false),
    ])
    expect(await predict.findManagerFor(c, "0xnobody")).toBeNull()
  })

  test("THROWS on an RPC error mid-scan — never a false null", async () => {
    expect(predict.findManagerFor(throwingClient(), "0xowner")).rejects.toThrow(
      "RPC unavailable",
    )
  })

  test("a cache hit short-circuits without touching the client", async () => {
    await db.cacheManager("0xcached", "0xmgr_cached")
    // A throwing client would blow up if the scan ran; the cache must win.
    expect(await predict.findManagerFor(throwingClient(), "0xcached")).toBe(
      "0xmgr_cached",
    )
  })

  test("memoizes a freshly-resolved manager into the cache", async () => {
    const c = clientFromPages([page(["0xfresh"], false)])
    await predict.findManagerFor(c, "0xfresh")
    expect(await db.getCachedManager("0xfresh")).toBe(mgr("0xfresh", 0))
  })
})
