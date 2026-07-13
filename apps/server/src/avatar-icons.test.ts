import { expect, test } from "bun:test"
import { AVATAR_ICON_IDS, isValidIconId } from "./avatar-icons"

test("mirrors the web manifest's 44 ids", () => {
  // Keep in lockstep with apps/web/src/lib/avatar-icons.ts. If that
  // manifest changes count, update this list too.
  expect(AVATAR_ICON_IDS.size).toBe(44)
})

test("isValidIconId accepts known ids, rejects everything else", () => {
  expect(isValidIconId("apple")).toBe(true)
  expect(isValidIconId("crab")).toBe(true)
  expect(isValidIconId("not-a-food")).toBe(false)
  expect(isValidIconId("")).toBe(false)
  expect(isValidIconId(null)).toBe(false)
  expect(isValidIconId(123)).toBe(false)
})
