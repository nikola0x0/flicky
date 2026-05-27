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
 */
export function useFlickySocket(address?: string) {
  const wsRef = useRef<WebSocket | null>(null)
  const handlersRef = useRef<Set<(msg: ServerMsg) => void>>(new Set())
  const [wsOpen, setWsOpen] = useState(false)

  useEffect(() => {
    if (!address) return
    const ws = new WebSocket(CONFIG.serverWsUrl)
    wsRef.current = ws

    ws.onopen = () => {
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

    ws.onclose = () => setWsOpen(false)

    return () => {
      ws.close()
      wsRef.current = null
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
