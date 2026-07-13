import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import {
  BGM_FILE,
  getBgmVolume,
  getSfxVolume,
  setBgmVolume,
  setSfxVolume,
  SFX_FILES,
} from "./sound"

// The manifest is the contract between code and committed assets — a
// renamed or forgotten file fails here instead of silently at runtime.
test("every manifest entry maps to a committed file", () => {
  const all = [...Object.values(SFX_FILES), BGM_FILE]
  const missing = all.filter(
    (p) => !existsSync(join(import.meta.dir, "../../public", p))
  )
  expect(missing).toEqual([])
})

test("setSfxVolume updates and clamps to [0, 1]", () => {
  const before = getSfxVolume()
  setSfxVolume(0.4)
  expect(getSfxVolume()).toBe(0.4)
  setSfxVolume(5)
  expect(getSfxVolume()).toBe(1)
  setSfxVolume(-1)
  expect(getSfxVolume()).toBe(0)
  setSfxVolume(before)
})

test("setBgmVolume updates and clamps to [0, 1]", () => {
  const before = getBgmVolume()
  setBgmVolume(0.2)
  expect(getBgmVolume()).toBe(0.2)
  setBgmVolume(5)
  expect(getBgmVolume()).toBe(1)
  setBgmVolume(-1)
  expect(getBgmVolume()).toBe(0)
  setBgmVolume(before)
})
