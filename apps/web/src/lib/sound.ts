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

const MUTE_KEY = "flicky.audio.muted"
const SFX_VOLUME = 0.6
const BGM_VOLUME = 0.3

let muted = readMuted()
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

function readMuted(): boolean {
  try {
    return globalThis.localStorage?.getItem(MUTE_KEY) === "1"
  } catch {
    return false
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
      sfxGain.gain.value = SFX_VOLUME
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

/** Fire-and-forget. No-op when muted, locked, or not yet loaded. */
export function playSfx(name: SfxName): void {
  if (muted || !unlocked || !ctx || !sfxGain) return
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

/** Request the music loop. Idempotent; respects mute + unlock state. */
export function startBgm(): void {
  bgmWanted = true
  if (!bgmEl && typeof Audio !== "undefined") {
    bgmEl = new Audio(BGM_FILE)
    bgmEl.loop = true
    bgmEl.volume = BGM_VOLUME
  }
  syncBgm()
}

export function stopBgm(): void {
  bgmWanted = false
  syncBgm()
}

/** Single reconciler: play exactly when wanted+unlocked+unmuted+visible. */
function syncBgm(): void {
  if (!bgmEl) return
  const hidden = typeof document !== "undefined" && document.hidden
  if (bgmWanted && unlocked && !muted && !hidden) {
    void bgmEl.play().catch(() => {})
  } else {
    bgmEl.pause()
  }
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", syncBgm)
}

// ─── Mute (persisted) ────────────────────────────────────────────────────────

export function getMuted(): boolean {
  return muted
}

export function toggleMuted(): void {
  muted = !muted
  try {
    globalThis.localStorage?.setItem(MUTE_KEY, muted ? "1" : "0")
  } catch {
    /* storage unavailable — mute still applies for this session */
  }
  syncBgm()
  emit()
}

/** Reactive mute state for the header toggle. */
export function useMuted(): boolean {
  return useSyncExternalStore(subscribe, getMuted, () => false)
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
