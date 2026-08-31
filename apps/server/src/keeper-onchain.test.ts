/**
 * Keeper settlement reads, against REAL testnet data.
 *
 * The acceptance criterion from the cold-storage plan: market
 * `0xc4b094e765e36bb8…` must read back `64493721012300` — exactly the
 * `settlementPrice` that duel `0xf950887b…` actually recorded on card 0 when
 * the keeper settled it in July. That makes this a regression test with a
 * known-correct answer rather than a self-consistent mock.
 *
 * Network-dependent by design: the whole point is proving the keeper can
 * settle with zero HTTP calls to a Mysten host. Skips (rather than fails) if
 * the fullnode is unreachable, so an offline checkout isn't red.
 */
import { describe, expect, test } from "bun:test"
import { SuiGrpcClient } from "@mysten/sui/grpc"
import { readMarketSettlement } from "./keeper"

const client = new SuiGrpcClient({
  network: "testnet",
  baseUrl: "https://fullnode.testnet.sui.io:443",
})

// Settled markets from stranded duel 0xf950887b…, with the prices its already
// settled cards recorded on chain.
const SETTLED_A =
  "0xc4b094e765e36bb8f4b135070859a7d9931a991cd7dfafda4b4052cdac565b0c"
const SETTLED_A_PRICE = 64_493_721_012_300n
const SETTLED_B =
  "0x93bc42bfc83dc9c7837ef33c1e9fce2c52874710e761dd5774f01af27e997142"
const SETTLED_B_PRICE = 64_506_717_955_110n
// Created 2026-08-17; expiry passed but it never settled.
const NEVER_SETTLED =
  "0x1fc9221e4ab3ab81c9573e885cbc7f75452616763a1b47c03642cc4c40ef1336"

let online = true
try {
  await client.core.getObject({ objectId: SETTLED_A })
} catch {
  online = false
}
const maybe = online ? test : test.skip

describe("readMarketSettlement (on-chain)", () => {
  maybe("recovers the exact price a settled card was scored at", async () => {
    const s = await readMarketSettlement(SETTLED_A, client)
    expect(s.settled).toBe(true)
    expect(s.settlementPrice).toBe(SETTLED_A_PRICE)
  })

  maybe("recovers a second market independently", async () => {
    const s = await readMarketSettlement(SETTLED_B, client)
    expect(s.settled).toBe(true)
    expect(s.settlementPrice).toBe(SETTLED_B_PRICE)
  })

  maybe("makes NO http call to a mystenlabs host", async () => {
    const realFetch = globalThis.fetch
    const hits: string[] = []
    globalThis.fetch = (async (input: unknown, init?: unknown) => {
      const url = String(input)
      if (url.includes("mystenlabs.com")) hits.push(url)
      return realFetch(input as string, init as RequestInit)
    }) as typeof fetch
    try {
      await readMarketSettlement(SETTLED_A, client)
      expect(hits).toEqual([])
    } finally {
      globalThis.fetch = realFetch
    }
  })

  maybe(
    "a nonexistent object is unsettled-and-retry, never settled-at-zero",
    async () => {
      const s = await readMarketSettlement("0x" + "0".repeat(64), client)
      expect(s.settled).toBe(false)
      expect(s.settlementPrice).toBeNull()
    }
  )

  test("fails closed when the read throws", async () => {
    const broken = {
      core: {
        getObject: async () => {
          throw new Error("boom")
        },
      },
    } as unknown as SuiGrpcClient
    const s = await readMarketSettlement(SETTLED_A, broken)
    expect(s.settled).toBe(false)
    expect(s.settlementPrice).toBeNull()
  })

  test("a null settlement_price is not settled", async () => {
    // Real unsettled markets report null, not 0 — verified against
    // 0x1fc9221e…, whose expiry passed before the settler stopped.
    const stub = {
      core: {
        getObject: async () => ({
          object: { json: { settlement_price: null } },
        }),
      },
    } as unknown as SuiGrpcClient
    expect((await readMarketSettlement("0xdead", stub)).settled).toBe(false)
  })

  test("8-21 nested strike_exposure.settlement_price counts as settled", async () => {
    // predict-testnet-8-21 does not put settlement_price on the object
    // root. The settled price lives under strike_exposure — confirmed
    // live 2026-08-31 on market 0xdff4d6ac… (duel 0x9ecf…7f6e card 0):
    // indexer MarketSettled = 78163816154180, top-level field absent.
    const stub = {
      core: {
        getObject: async () => ({
          object: {
            json: {
              expiry: "1788163260000",
              strike_exposure: { settlement_price: "78163816154180" },
            },
          },
        }),
      },
    } as unknown as SuiGrpcClient
    const s = await readMarketSettlement("0xdead", stub)
    expect(s.settled).toBe(true)
    expect(s.settlementPrice).toBe(78_163_816_154_180n)
  })

  test("8-21 unsettled (nested null, no top-level) is not settled", async () => {
    const stub = {
      core: {
        getObject: async () => ({
          object: {
            json: {
              expiry: "1788163500000",
              strike_exposure: { settlement_price: null },
            },
          },
        }),
      },
    } as unknown as SuiGrpcClient
    const s = await readMarketSettlement("0xdead", stub)
    expect(s.settled).toBe(false)
    expect(s.settlementPrice).toBeNull()
  })

  maybe("a real never-settled market reads as unsettled", async () => {
    // Created 2026-08-17, expiry passed, but the settler stopped before it
    // ran — so this object EXISTS and reports settlement_price: null. That
    // distinction (exists-but-unsettled vs. missing) is the one that matters.
    const s = await readMarketSettlement(NEVER_SETTLED, client)
    expect(s.settled).toBe(false)
    expect(s.settlementPrice).toBeNull()
  })
})
