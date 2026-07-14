/**
 * Avatar-icon selection, persisted server-side (`player_profile`) and shared
 * across all clients — opponents, the leaderboard, everyone.
 *
 * The public interface is unchanged from the previous localStorage version
 * (`useAvatarIcon` / `getAvatarIcon` / `setAvatarIcon`), so `PlayerAvatar`
 * and the picker don't change. Internally it's a session cache keyed by the
 * (lowercased) address, filled by **batched** `GET /avatars` requests on
 * demand — a whole screen of avatars collapses into one request, and each
 * address is fetched once per session. A pick writes through to
 * `POST /avatar` optimistically. A thin localStorage seed of the local
 * user's own last pick avoids a gradient→icon flash on their own avatar at
 * boot.
 */
import { useEffect, useSyncExternalStore } from "react"
import { CONFIG } from "@/lib/config"
import { AVATAR_ICONS, isValidIconId } from "@/lib/avatar-icons"

const API = CONFIG.serverHttpUrl
const SELF_KEY = "flicky.avatar.self"
const MAX_PER_REQUEST = 100

// address(lowercase) → iconId | null. Presence = known; absence = not yet
// fetched (rendering that address schedules a batched fetch).
const cache = new Map<string, string | null>()
const pending = new Set<string>()
const inflight = new Set<string>()
let flushScheduled = false

// Addresses a fetch has confirmed have NO `player_profile` row at all —
// as opposed to a row with `avatar_icon = NULL` (an explicit gradient-only
// choice). `cache` alone can't tell those apart (both read back as `null`);
// `ensureStarterAvatar` needs the distinction to know when to auto-assign.
const confirmedAbsent = new Set<string>()
// Addresses currently mid-assignment, guarding against `ensureStarterAvatar`
// being invoked twice for the same key before the first call's fetch
// resolves (e.g. React StrictMode's dev double-effect) — without this, both
// calls would independently roll a random icon and race their writes.
const assigning = new Set<string>()

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

function norm(address: string): string {
  return address.toLowerCase()
}

// ─── Batched reads ───────────────────────────────────────────────────────────

function enqueue(key: string): void {
  if (cache.has(key) || inflight.has(key)) return
  pending.add(key)
  if (!flushScheduled) {
    flushScheduled = true
    queueMicrotask(flush)
  }
}

function flush(): void {
  flushScheduled = false
  const batch = [...pending].filter((k) => !cache.has(k) && !inflight.has(k))
  pending.clear()
  if (batch.length === 0) return
  for (const k of batch) inflight.add(k)
  for (let i = 0; i < batch.length; i += MAX_PER_REQUEST) {
    void fetchChunk(batch.slice(i, i + MAX_PER_REQUEST))
  }
}

async function fetchChunk(addresses: string[]): Promise<void> {
  try {
    const res = await fetch(
      `${API}/avatars?addresses=${addresses.map(encodeURIComponent).join(",")}`
    )
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const map = (await res.json()) as Record<string, unknown>
    // Every requested address is now "known": a valid id, or null for
    // "no row" / explicit gradient-only / anything unexpected.
    for (const a of addresses) {
      if (!Object.hasOwn(map, a)) confirmedAbsent.add(a)
      const v = map[a]
      cache.set(a, isValidIconId(v) ? v : null)
    }
    emit()
  } catch {
    // Transient failure — do NOT cache, so a later remount can retry; the
    // avatars render gradient-only until then.
    emit()
  } finally {
    for (const a of addresses) inflight.delete(a)
  }
}

/** Warm the cache for a known set of addresses (e.g. the leaderboard list). */
export function prefetchAvatarIcons(addresses: string[]): void {
  for (const a of addresses) enqueue(norm(a))
}

/** Resolves once `key` is no longer awaiting a fetch, one way or another. */
function whenSettled(key: string): Promise<void> {
  const settled = () =>
    cache.has(key) || (!pending.has(key) && !inflight.has(key))
  if (settled()) return Promise.resolve()
  return new Promise((resolve) => {
    const unsub = subscribe(() => {
      if (settled()) {
        unsub()
        resolve()
      }
    })
  })
}

/**
 * Give a brand-new signed-in address a random starter icon, so a first
 * login isn't a bare gradient. Distinguishes "never had a profile row"
 * from "explicitly cleared to gradient-only" (the server keeps that as a
 * present-but-null row) via `confirmedAbsent`, fed by the *same* batched
 * fetch every `PlayerAvatar` on screen already triggers — piggybacking on
 * `enqueue` instead of firing an independent request avoids a race where
 * a second, later-resolving fetch for the same address (issued before the
 * assignment landed) would overwrite the freshly-assigned icon back to
 * null. A no-op for any address that already has a row either way. Safe
 * to call every session (e.g. from the game shell, keyed on the signed-in
 * address) — it's a no-op past the very first time.
 */
export function ensureStarterAvatar(address: string): void {
  const key = norm(address)
  if (cache.has(key) || assigning.has(key)) return
  assigning.add(key)
  void (async () => {
    try {
      enqueue(key)
      await whenSettled(key)
      if (!confirmedAbsent.has(key)) return // row exists — real pick or explicit gradient
      const id = AVATAR_ICONS[Math.floor(Math.random() * AVATAR_ICONS.length)].id
      setAvatarIcon(address, id)
    } finally {
      assigning.delete(key)
    }
  })()
}

// ─── Public read/write (same signatures as the localStorage version) ─────────

/** Cached icon for `address` (sync). null if unknown or gradient-only. */
export function getAvatarIcon(address: string): string | null {
  return cache.get(norm(address)) ?? null
}

/**
 * Set (or clear, with null) the local user's icon: optimistic cache update +
 * write-through to the server. Called only for the signed-in user's own
 * address (from the picker).
 */
export function setAvatarIcon(address: string, id: string | null): void {
  const key = norm(address)
  const value = id && isValidIconId(id) ? id : null
  cache.set(key, value)
  writeSelf(key, value)
  emit()
  void postAvatar(key, value)
}

async function postAvatar(
  address: string,
  iconId: string | null
): Promise<void> {
  try {
    await fetch(`${API}/avatar`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address, iconId }),
    })
  } catch {
    // Best-effort: the optimistic local value stays; the server just didn't
    // record it (a later pick / reload reconciles).
  }
}

/**
 * Reactive icon for `address`. Returns the cached value; on a cache miss it
 * schedules a batched fetch and returns null (gradient) until it resolves.
 */
export function useAvatarIcon(address?: string): string | null {
  const key = address ? norm(address) : undefined
  const value = useSyncExternalStore(
    subscribe,
    () => (key && cache.has(key) ? (cache.get(key) ?? null) : null),
    () => null
  )
  useEffect(() => {
    if (key && !cache.has(key)) enqueue(key)
  }, [key])
  return value
}

// ─── Local user's own-pick seed (avoids a self-avatar flash at boot) ─────────

function writeSelf(address: string, iconId: string | null): void {
  try {
    globalThis.localStorage?.setItem(
      SELF_KEY,
      JSON.stringify({ address, iconId })
    )
  } catch {
    /* quota / unavailable — the server copy is the source of truth anyway */
  }
}

function seedSelf(): void {
  try {
    const raw = globalThis.localStorage?.getItem(SELF_KEY)
    if (!raw) return
    const { address, iconId } = JSON.parse(raw) as {
      address?: unknown
      iconId?: unknown
    }
    if (typeof address === "string") {
      cache.set(norm(address), isValidIconId(iconId) ? iconId : null)
    }
  } catch {
    /* ignore a malformed seed */
  }
}

seedSelf()
