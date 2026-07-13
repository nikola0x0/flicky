import { expect, test } from "bun:test"
import { parseAddresses, parseSetBody } from "./avatar-api"

test("parseAddresses splits, trims, lowercases, and dedupes", () => {
  expect(parseAddresses(" 0xAbc , 0xdef,0xabc ")).toEqual(["0xabc", "0xdef"])
})

test("parseAddresses drops non-0x and empty entries", () => {
  expect(parseAddresses("0xabc,,garbage,0x")).toEqual(["0xabc"])
})

test("parseAddresses returns [] for null/empty", () => {
  expect(parseAddresses(null)).toEqual([])
  expect(parseAddresses("")).toEqual([])
})

test("parseAddresses caps at 100 addresses", () => {
  const many = Array.from({ length: 250 }, (_, i) => `0x${i}`).join(",")
  expect(parseAddresses(many)).toHaveLength(100)
})

test("parseSetBody accepts a valid id, lowercasing the address", () => {
  expect(parseSetBody({ address: "0xABC", iconId: "apple" })).toEqual({
    address: "0xabc",
    iconId: "apple",
  })
})

test("parseSetBody accepts null iconId (gradient-only)", () => {
  expect(parseSetBody({ address: "0xabc", iconId: null })).toEqual({
    address: "0xabc",
    iconId: null,
  })
})

test("parseSetBody rejects an unknown iconId", () => {
  expect(parseSetBody({ address: "0xabc", iconId: "not-a-food" })).toBeNull()
})

test("parseSetBody rejects a non-0x / missing address", () => {
  expect(parseSetBody({ address: "abc", iconId: "apple" })).toBeNull()
  expect(parseSetBody({ iconId: "apple" })).toBeNull()
  expect(parseSetBody(null)).toBeNull()
  expect(parseSetBody("nope")).toBeNull()
})
