import { expect, test } from "bun:test"
import { AVATAR_ICONS, iconSrc, isValidIconId } from "./avatar-icons"

test("manifest has all 44 sliced tiles", () => {
  expect(AVATAR_ICONS.length).toBe(44)
})

test("every icon id is unique", () => {
  const ids = AVATAR_ICONS.map((i) => i.id)
  expect(new Set(ids).size).toBe(ids.length)
})

test("iconSrc maps to the served /avatars path", () => {
  expect(iconSrc("apple")).toBe("/avatars/apple.png")
})

test("isValidIconId accepts known ids and rejects everything else", () => {
  expect(isValidIconId("apple")).toBe(true)
  expect(isValidIconId("not-a-food")).toBe(false)
  expect(isValidIconId(null)).toBe(false)
  expect(isValidIconId(undefined)).toBe(false)
})
