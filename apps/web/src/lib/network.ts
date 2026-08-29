/**
 * Active-network resolution for the whole client.
 *
 * The network is decided ONCE at module load and never changes for the life
 * of the page: `CONFIG` (lib/config.ts), the dApp Kit client, the GraphQL
 * client, and the WS socket are all frozen against it. Switching networks
 * therefore goes through `setNetwork`, which persists the choice and
 * reloads — that also tears down the wallet session, the react-query cache,
 * and any in-flight duel state, all of which are network-bound and would be
 * wrong to carry across a switch.
 *
 * Resolution order: localStorage → `VITE_SUI_NETWORK` → "testnet".
 */

export type FlickyNetwork = "testnet" | "mainnet"

export const DEFAULT_NETWORK: FlickyNetwork = "testnet"

const STORAGE_KEY = "flicky.network"

function isNetwork(v: unknown): v is FlickyNetwork {
  return v === "testnet" || v === "mainnet"
}

/**
 * Networks the switcher offers, from `VITE_SUI_NETWORKS` (comma-separated).
 * Defaults to both. Set it to just "testnet" to hide the switcher entirely
 * (e.g. a deploy that should never expose mainnet).
 *
 * An EMPTY value counts as unset, not as "no networks" — a `.env` file that
 * declares `VITE_SUI_NETWORKS=` as a placeholder would otherwise parse to an
 * empty list and silently remove the switcher. Same reason `??` is avoided
 * throughout lib/config.ts.
 */
function loadAvailableNetworks(): FlickyNetwork[] {
  const raw = import.meta.env.VITE_SUI_NETWORKS
  const source =
    typeof raw === "string" && raw.trim() !== "" ? raw : "testnet,mainnet"
  const parsed = source
    .split(",")
    .map((s: string) => s.trim())
    .filter(isNetwork)
  // Never return an empty list — a deploy that misspells every entry should
  // still boot on the default network rather than render a dead app.
  return parsed.length > 0 ? parsed : [DEFAULT_NETWORK]
}

export const AVAILABLE_NETWORKS: FlickyNetwork[] = loadAvailableNetworks()

// localStorage throws outright in some contexts (private windows, browsers
// set to block site data), so every access is guarded — a storage failure
// must degrade to the default network, never break boot.
function readStored(): FlickyNetwork | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return isNetwork(raw) ? raw : null
  } catch {
    return null
  }
}

function resolveActiveNetwork(): FlickyNetwork {
  const stored = readStored()
  // A stored network that's no longer offered (deploy narrowed
  // VITE_SUI_NETWORKS) must not strand the user on a dead config.
  if (stored && AVAILABLE_NETWORKS.includes(stored)) return stored

  // Empty / misspelled falls through to the default rather than throwing —
  // `isNetwork` rejects "" for us.
  const fromEnv = import.meta.env.VITE_SUI_NETWORK
  if (isNetwork(fromEnv)) return fromEnv

  return DEFAULT_NETWORK
}

/** The network this page load is pinned to. Read once, never reassigned. */
export const ACTIVE_NETWORK: FlickyNetwork = resolveActiveNetwork()

export const IS_MAINNET = ACTIVE_NETWORK === "mainnet"

/**
 * Persist `next` and reload onto it. No-op when already active, so a
 * double-tap in the switcher can't trigger a pointless reload.
 */
export function setNetwork(next: FlickyNetwork): void {
  if (next === ACTIVE_NETWORK) return
  try {
    localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // Can't persist (private window / blocked storage). Reloading anyway
    // would just land back on the current network and look like a no-op,
    // so bail out rather than pretend the switch happened.
    return
  }
  window.location.reload()
}

/** Human label for the network chip / badges. */
export function networkLabel(net: FlickyNetwork): string {
  return net === "mainnet" ? "mainnet" : "testnet"
}
