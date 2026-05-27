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

export function useFlickySocket(address?: string) {
  const wsRef = useRef<WebSocket | null>(null)
  const handlersRef = useRef<Set<(msg: ServerMsg) => void>>(new Set())
  const [wsOpen, setWsOpen] = useState(false)

  useEffect(() => {
    if (!address) return

    // Per-effect-instance flags. `unmounted` flips on cleanup so a
    // pending close→reconnect timeout doesn't fire after the component
    // tore down (or after StrictMode's synthetic cleanup in dev).
    let unmounted = false
    let attempt = 0
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null

    const connect = () => {
      if (unmounted) return
      const ws = new WebSocket(CONFIG.serverWsUrl)
      wsRef.current = ws

      ws.onopen = () => {
        if (unmounted) return
        attempt = 0
        setWsOpen(true)
        ws.send(JSON.stringify({ type: "hello", address } satisfies ClientMsg))
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
  }, [address])

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
    [],
  )

  return { wsOpen, send, onMessage }
}
