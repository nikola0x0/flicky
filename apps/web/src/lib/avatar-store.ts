/**
 * Per-address avatar-icon selection, persisted in localStorage. Cosmetic
 * and client-only: keyed by wallet address so the local player's choice
 * follows their address across sessions, and PlayerAvatar reads it back
 * for whatever address it renders. Only the local user's own key is ever
 * present in their browser, so opponents fall back to a gradient-only
 * avatar automatically. Mirrors the guarded-localStorage pattern in
 * lib/deepbook.ts.
 */
import { useSyncExternalStore } from "react"
import { isValidIconId } from "@/lib/avatar-icons"

const PREFIX = "flicky.avatar."

export function avatarKey(address: string): string {
  return PREFIX + address.toLowerCase()
}

const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

function read(address: string): string | null {
  try {
    const raw = globalThis.localStorage?.getItem(avatarKey(address))
    return isValidIconId(raw) ? raw : null
  } catch {
    return null
  }
}

export function getAvatarIcon(address: string): string | null {
  return read(address)
}

export function setAvatarIcon(address: string, id: string | null): void {
  try {
    const key = avatarKey(address)
    if (id && isValidIconId(id)) {
      globalThis.localStorage?.setItem(key, id)
    } else {
      globalThis.localStorage?.removeItem(key)
    }
  } catch {
    // quota exceeded / unavailable — the selection just won't persist.
  }
  emit()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/**
 * Reactive read of the icon stored for `address`. Re-renders when the
 * selection changes via setAvatarIcon in the same tab. Returns null when
 * there is no address or no valid stored icon. Returns a primitive, so
 * useSyncExternalStore's identity check is stable (no render loop).
 */
export function useAvatarIcon(address?: string): string | null {
  return useSyncExternalStore(
    subscribe,
    () => (address ? read(address) : null),
    () => null
  )
}
