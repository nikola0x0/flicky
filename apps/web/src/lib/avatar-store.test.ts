import { beforeEach, expect, test } from "bun:test"
import { avatarKey, getAvatarIcon, setAvatarIcon } from "./avatar-store"

// bun:test has no DOM — install a minimal in-memory localStorage.
class MemStorage {
  private m = new Map<string, string>()
  getItem(k: string) {
    return this.m.has(k) ? (this.m.get(k) as string) : null
  }
  setItem(k: string, v: string) {
    this.m.set(k, v)
  }
  removeItem(k: string) {
    this.m.delete(k)
  }
  clear() {
    this.m.clear()
  }
  key() {
    return null
  }
  get length() {
    return this.m.size
  }
}

beforeEach(() => {
  ;(globalThis as unknown as { localStorage: Storage }).localStorage =
    new MemStorage() as unknown as Storage
})

const ADDR = "0xABCDEF"

test("avatarKey lowercases and namespaces the address", () => {
  expect(avatarKey(ADDR)).toBe("flicky.avatar.0xabcdef")
})

test("set then get round-trips a valid icon id", () => {
  setAvatarIcon(ADDR, "apple")
  expect(getAvatarIcon(ADDR)).toBe("apple")
})

test("an invalid id is rejected and not stored", () => {
  setAvatarIcon(ADDR, "not-a-food")
  expect(getAvatarIcon(ADDR)).toBeNull()
})

test("setting null clears the selection", () => {
  setAvatarIcon(ADDR, "apple")
  setAvatarIcon(ADDR, null)
  expect(getAvatarIcon(ADDR)).toBeNull()
})
