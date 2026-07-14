/**
 * Game audio — SFX through Web Audio (decoded buffers, so rapid swipes
 * overlap instead of cutting each other off) and background music
 * through a looping <audio> element (streams, no full decode). No deps.
 *
 * Browser autoplay policy: nothing may sound before the first user
 * gesture. `installAudioUnlock()` (mounted once by the game layout)
 * creates/resumes the AudioContext on the first pointerdown/keydown and
 * starts the music if it was requested. Audio is enhancement-only:
 * every load/play error is swallowed — a missing file must never break
 * the game (hence the manifest test in sound.test.ts).
 *
 * Volume is two independent, persisted 0-1 sliders (sfx, music) rather
 * than a single mute flag — dragging either to 0 is equivalent to
 * muting that channel; there's no separate master-mute state.
 */
import { useEffect, useRef, useSyncExternalStore } from "react"

export type SfxName =
  | "swipe-up"
  | "swipe-down"
  | "card-win"
  | "card-loss"
  | "match-found"
  | "duel-win"
  | "duel-lose"
  | "click"
  | "modal-open"
  | "modal-close"

export const SFX_FILES: Record<SfxName, string> = {
  "swipe-up": "/sounds/swipe-up.mp3",
  "swipe-down": "/sounds/swipe-down.mp3",
  "card-win": "/sounds/card-win.mp3",
  "card-loss": "/sounds/card-loss.mp3",
  "match-found": "/sounds/match-found.mp3",
  "duel-win": "/sounds/duel-win.mp3",
  "duel-lose": "/sounds/duel-lose.mp3",
  click: "/sounds/click.mp3",
  "modal-open": "/sounds/modal-open.mp3",
  "modal-close": "/sounds/modal-close.mp3",
}

export const BGM_FILE = "/sounds/bgm.mp3"

const SFX_VOLUME_KEY = "flicky.audio.sfxVolume"
const BGM_VOLUME_KEY = "flicky.audio.bgmVolume"
// Sliders are a multiplier (0-1) on top of these tuned mix levels, not raw
// gain — so "100%" means the game's designed balance, not full amplitude.
const SFX_VOLUME_BASE = 0.6
const BGM_VOLUME_BASE = 0.3

let sfxVolume = readVolume(SFX_VOLUME_KEY)
let bgmVolume = readVolume(BGM_VOLUME_KEY)
let unlocked = false
let ctx: AudioContext | null = null
let sfxGain: GainNode | null = null
const buffers = new Map<SfxName, AudioBuffer>()
let bgmEl: HTMLAudioElement | null = null
let bgmWanted = false

const listeners = new Set<() => void>()
function emit() {
  for (const l of listeners) l()
}
function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1
}

function readVolume(key: string): number {
  try {
    const raw = globalThis.localStorage?.getItem(key)
    return raw === null || raw === undefined ? 1 : clamp01(Number(raw))
  } catch {
    return 1
  }
}

// ─── Unlock + SFX ────────────────────────────────────────────────────────────

/**
 * One-time first-gesture unlock. Mount once (game layout); returns an
 * uninstaller. Idempotent — a second gesture is a no-op.
 */
export function installAudioUnlock(): () => void {
  if (typeof window === "undefined") return () => {}
  const onGesture = () => {
    off()
    unlock()
  }
  const off = () => {
    window.removeEventListener("pointerdown", onGesture)
    window.removeEventListener("keydown", onGesture)
  }
  window.addEventListener("pointerdown", onGesture)
  window.addEventListener("keydown", onGesture)
  return off
}

function unlock(): void {
  if (unlocked) return
  unlocked = true
  try {
    if (typeof AudioContext !== "undefined") {
      ctx = new AudioContext()
      sfxGain = ctx.createGain()
      sfxGain.gain.value = SFX_VOLUME_BASE * sfxVolume
      sfxGain.connect(ctx.destination)
      void ctx.resume().catch(() => {})
      for (const name of Object.keys(SFX_FILES) as SfxName[]) {
        void loadBuffer(name)
      }
    }
  } catch {
    /* no audio on this platform — stay silent */
  }
  syncBgm()
}

async function loadBuffer(name: SfxName): Promise<void> {
  if (!ctx || buffers.has(name)) return
  try {
    const res = await fetch(SFX_FILES[name])
    const data = await res.arrayBuffer()
    buffers.set(name, await ctx.decodeAudioData(data))
  } catch {
    /* missing/undecodable file — that one sfx stays silent */
  }
}

/** Fire-and-forget. No-op when silenced, locked, or not yet loaded. */
export function playSfx(name: SfxName): void {
  if (sfxVolume === 0 || !unlocked || !ctx || !sfxGain) return
  const buffer = buffers.get(name)
  if (!buffer) return
  try {
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.connect(sfxGain)
    src.start()
  } catch {
    /* enhancement only */
  }
}

// ─── BGM ─────────────────────────────────────────────────────────────────────

/** Request the music loop. Idempotent; respects volume + unlock state. */
export function startBgm(): void {
  bgmWanted = true
  if (!bgmEl && typeof Audio !== "undefined") {
    bgmEl = new Audio(BGM_FILE)
    bgmEl.loop = true
    bgmEl.volume = BGM_VOLUME_BASE * bgmVolume
  }
  syncBgm()
}

export function stopBgm(): void {
  bgmWanted = false
  syncBgm()
}

/** Single reconciler: play exactly when wanted+unlocked+audible+visible. */
function syncBgm(): void {
  if (!bgmEl) return
  const hidden = typeof document !== "undefined" && document.hidden
  if (bgmWanted && unlocked && bgmVolume > 0 && !hidden) {
    void bgmEl.play().catch(() => {})
  } else {
    bgmEl.pause()
  }
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", syncBgm)
}

// ─── Volume (persisted, independent sfx/music channels) ─────────────────────

export function getSfxVolume(): number {
  return sfxVolume
}

/** 0-1. Applies live to already-loaded SFX; persisted across sessions. */
export function setSfxVolume(v: number): void {
  sfxVolume = clamp01(v)
  try {
    globalThis.localStorage?.setItem(SFX_VOLUME_KEY, String(sfxVolume))
  } catch {
    /* storage unavailable — volume still applies for this session */
  }
  if (sfxGain) sfxGain.gain.value = SFX_VOLUME_BASE * sfxVolume
  emit()
}

/** Reactive sfx volume (0-1) for the settings slider. */
export function useSfxVolume(): number {
  return useSyncExternalStore(subscribe, getSfxVolume, () => 1)
}

export function getBgmVolume(): number {
  return bgmVolume
}

/** 0-1. Applies live to the playing track; persisted across sessions. */
export function setBgmVolume(v: number): void {
  bgmVolume = clamp01(v)
  try {
    globalThis.localStorage?.setItem(BGM_VOLUME_KEY, String(bgmVolume))
  } catch {
    /* storage unavailable — volume still applies for this session */
  }
  if (bgmEl) bgmEl.volume = BGM_VOLUME_BASE * bgmVolume
  syncBgm()
  emit()
}

/** Reactive music volume (0-1) for the settings slider. */
export function useBgmVolume(): number {
  return useSyncExternalStore(subscribe, getBgmVolume, () => 1)
}

// ─── Modal open/close chirps ─────────────────────────────────────────────────

/**
 * Drop-in for portal modals driven by an `open` prop: plays modal-open /
 * modal-close on transitions. Call it BEFORE the component's early
 * `if (!open) return null` (rules of hooks). Silent at mount.
 */
export function useModalSfx(open: boolean): void {
  const prev = useRef(open)
  useEffect(() => {
    if (prev.current === open) return
    prev.current = open
    playSfx(open ? "modal-open" : "modal-close")
  }, [open])
}
