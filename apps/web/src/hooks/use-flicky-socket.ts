import { useEffect, useRef, useState, useCallback } from "react"
import { CONFIG } from "@/lib/config"
import type { ServerMsg, ClientMsg } from "@/lib/protocol"

export type Unsubscribe = () => void

/**
 * Connect to the Flicky WS server. Returns:
 *
 *   - `wsOpen`: connection state.
 *   - `send`: write a typed ClientMsg (no-op until open).
 *   - `onMessage(handler)`: subscribe to ALL incoming server msgs.
 *     Each subscribed handler is invoked for every message — caller
 *     filters by `msg.type`. Returns an unsubscribe fn — wire it through
 *     a useEffect cleanup so handlers don't leak.
 *
 * Multiple components can subscribe simultaneously without racing on a
 * single `lastMsg` slot (which would drop messages between renders).
 *
 * **Auto-reconnect:** if the socket closes (server restart under
 * `bun --watch`, idle timeout, network blip), reconnect with exponential
 * backoff capped at 10s. Without this the player has to reload the page
 * any time `bun dev` rebuilds the server.
 */
const MIN_BACKOFF_MS = 500
const MAX_BACKOFF_MS = 10_000

/**
 * Client→server keepalive interval.
 *
 * Nothing else guarantees traffic on an idle socket: the server only
 * pushes on rooms/oracles the socket has actually subscribed to, so one
 * parked in the lobby can sit completely silent — long enough for Bun's
 * 120s default `idleTimeout`, or any proxy in between, to close it. The
 * player then eats a reconnect (and, mid-duel, a re-subscribe) for no
 * reason. The server answers `ping` with `pong`; we don't care about the
 * reply, only that bytes move often enough to keep the connection alive.
 */
const KEEPALIVE_MS = 30_000

/**
 * @param address  Wallet address to announce via `hello` once connected.
 *   Optional — the socket connects anonymously without it (oracle/room
 *   read streams don't require identity) and sends `hello` as soon as an
 *   address arrives.
 * @param options.enabled  Set `false` to skip connecting entirely (e.g.
 *   demo/mock views that synthesize their own data). Defaults to `true`.
 *   Note: pass the real `address` and gate via `enabled` — don't pass
 *   `undefined` as `address` to disable, since that now connects
 *   anonymously rather than staying offline.
 */
export function useFlickySocket(
  address?: string,
  options?: { enabled?: boolean }
) {
  const enabled = options?.enabled ?? true
  const wsRef = useRef<WebSocket | null>(null)
  const handlersRef = useRef<Set<(msg: ServerMsg) => void>>(new Set())
  // Latest address, read inside the connection lifecycle without making
  // the socket depend on it — see below. Synced in an effect (not during
  // render) so it doesn't trip the refs-during-render lint.
  const addressRef = useRef(address)
  useEffect(() => {
    addressRef.current = address
  }, [address])
  const [wsOpen, setWsOpen] = useState(false)

  // Connect once on mount (while enabled). The socket is intentionally
  // NOT gated on `address`: the read streams (oracle ticks, room_state)
  // work for anonymous sockets, so spectator/read-only views (e.g.
  // duel-view) need ticks before — or without — a connected wallet. We
  // only send `hello` to announce identity once an address exists (in
  // onopen if present, or via the effect below when it arrives later).
  useEffect(() => {
    if (!enabled) return
    // Per-effect-instance flags. `unmounted` flips on cleanup so a
    // pending close→reconnect timeout doesn't fire after the component
    // tore down (or after StrictMode's synthetic cleanup in dev).
    let unmounted = false
    let attempt = 0
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let keepaliveTimer: ReturnType<typeof setInterval> | null = null

    const stopKeepalive = () => {
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer)
        keepaliveTimer = null
      }
    }

    const connect = () => {
      if (unmounted) return
      const ws = new WebSocket(CONFIG.serverWsUrl)
      wsRef.current = ws

      ws.onopen = () => {
        if (unmounted) return
        attempt = 0
        setWsOpen(true)
        const addr = addressRef.current
        if (addr) {
          ws.send(
            JSON.stringify({ type: "hello", address: addr } satisfies ClientMsg)
          )
        }
        // Re-armed per connection so a reconnected socket is kept alive too.
        stopKeepalive()
        keepaliveTimer = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) return
          ws.send(JSON.stringify({ type: "ping" } satisfies ClientMsg))
        }, KEEPALIVE_MS)
      }

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data) as ServerMsg
          // Snapshot handlers so a handler unsubscribing during fan-out
          // doesn't skip a sibling subscriber.
          for (const h of Array.from(handlersRef.current)) h(msg)
        } catch (err) {
          console.error("WS parse error", err)
        }
      }

      ws.onerror = () => {
        // Don't reconnect here — onclose always fires after onerror and
        // it's the canonical reconnect trigger. Just log.
        console.warn("WS error (will retry via onclose)")
      }

      ws.onclose = () => {
        stopKeepalive()
        setWsOpen(false)
        wsRef.current = null
        if (unmounted) return
        // Exponential backoff with jitter: 0.5s, 1s, 2s, 4s, 8s, 10s…
        const base = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** attempt)
        const delay = base * (0.75 + Math.random() * 0.5)
        attempt += 1
        reconnectTimer = setTimeout(connect, delay)
      }
    }

    connect()

    return () => {
      unmounted = true
      stopKeepalive()
      if (reconnectTimer) clearTimeout(reconnectTimer)
      const ws = wsRef.current
      if (ws) {
        // Detach handlers BEFORE close so the onclose path doesn't
        // schedule a reconnect for a socket we intentionally tore down.
        ws.onopen = null
        ws.onmessage = null
        ws.onerror = null
        ws.onclose = null
        ws.close()
        wsRef.current = null
      }
      setWsOpen(false)
    }
    // Connect once (per enabled toggle) — independent of `address`.
  }, [enabled])

  // Announce identity when the wallet connects (or changes) on an
  // already-open socket, without tearing the connection down. On first
  // open with an address already present, onopen handles the hello and
  // this is a no-op (socket still CONNECTING when this runs).
  useEffect(() => {
    if (!enabled || !address) return
    const ws = wsRef.current
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "hello", address } satisfies ClientMsg))
    }
  }, [address, enabled])

  const send = useCallback((msg: ClientMsg) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg))
    }
  }, [])

  const onMessage = useCallback(
    (handler: (msg: ServerMsg) => void): Unsubscribe => {
      handlersRef.current.add(handler)
      return () => {
        handlersRef.current.delete(handler)
      }
    },
    []
  )

  return { wsOpen, send, onMessage }
}
