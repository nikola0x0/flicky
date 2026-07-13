import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { BGM_FILE, getMuted, SFX_FILES, toggleMuted } from "./sound"

// The manifest is the contract between code and committed assets — a
// renamed or forgotten file fails here instead of silently at runtime.
test("every manifest entry maps to a committed file", () => {
  const all = [...Object.values(SFX_FILES), BGM_FILE]
  const missing = all.filter(
    (p) => !existsSync(join(import.meta.dir, "../../public", p))
  )
  expect(missing).toEqual([])
})

test("toggleMuted flips and flips back", () => {
  const before = getMuted()
  toggleMuted()
  expect(getMuted()).toBe(!before)
  toggleMuted()
  expect(getMuted()).toBe(before)
})
