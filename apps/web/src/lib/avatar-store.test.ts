import { afterEach, beforeEach, expect, test } from "bun:test"
import {
  getAvatarIcon,
  prefetchAvatarIcons,
  setAvatarIcon,
} from "./avatar-store"

// The store is a module singleton (cache persists across tests), so each
// test uses unique addresses to stay isolated. fetch is mocked to record
// calls and serve a configurable GET response.

type Call = { url: string; method: string; body?: string }
let calls: Call[]
let getResponse: Record<string, string | null>
const origFetch = globalThis.fetch

beforeEach(() => {
  calls = []
  getResponse = {}
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body as string | undefined,
    })
    if (url.includes("/avatars?")) {
      return new Response(JSON.stringify(getResponse), { status: 200 })
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = origFetch
})

const tick = () => new Promise((r) => setTimeout(r, 10))

test("setAvatarIcon updates the cache optimistically, lowercasing the address", () => {
  setAvatarIcon("0xAAA1", "apple")
  expect(getAvatarIcon("0xaaa1")).toBe("apple")
})

test("setAvatarIcon writes the pick through to POST /avatar", async () => {
  setAvatarIcon("0xAAA2", "crab")
  await tick()
  const post = calls.find((c) => c.method === "POST")
  expect(post?.url).toContain("/avatar")
  expect(JSON.parse(post!.body!)).toEqual({ address: "0xaaa2", iconId: "crab" })
})

test("setAvatarIcon with an unknown id clears to null", () => {
  setAvatarIcon("0xbbb1", "pizza")
  expect(getAvatarIcon("0xbbb1")).toBeNull()
})

test("prefetch fills the cache from a single batched GET", async () => {
  getResponse = { "0xccc1": "crab", "0xddd1": null }
  prefetchAvatarIcons(["0xCCC1", "0xddd1", "0xeee1"])
  await tick()
  expect(getAvatarIcon("0xccc1")).toBe("crab")
  expect(getAvatarIcon("0xddd1")).toBeNull() // explicit null in response
  expect(getAvatarIcon("0xeee1")).toBeNull() // absent in response → null
  const gets = calls.filter((c) => c.method === "GET")
  expect(gets).toHaveLength(1)
  expect(gets[0].url).toContain("0xccc1")
  expect(gets[0].url).toContain("0xeee1")
})

test("prefetch batches many addresses into one request", async () => {
  prefetchAvatarIcons(["0xf1", "0xf2", "0xf3", "0xf4"])
  await tick()
  expect(calls.filter((c) => c.method === "GET")).toHaveLength(1)
})

test("an already-cached address is not re-fetched", async () => {
  getResponse = { "0xg1": "apple" }
  prefetchAvatarIcons(["0xg1"])
  await tick()
  const before = calls.filter((c) => c.method === "GET").length
  prefetchAvatarIcons(["0xg1"])
  await tick()
  expect(calls.filter((c) => c.method === "GET").length).toBe(before)
})
