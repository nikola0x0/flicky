/**
 * Chat + WebSocket test panel.
 *
 * Connects to the Flicky backend at `CONFIG.serverWsUrl` and exposes:
 *
 *   - Connection state (auto-reconnect on wallet change)
 *   - Global chat: `chat_send` + `chat_history` backfill + live broadcasts
 *   - Per-duel emoji reactions: `chat_react` (server filters to creator + challenger)
 *   - Matchmaking queue: `queue_join { tier }` / `queue_leave`
 *   - Practice mode: `practice_start` (returns deck + bot swipes, no chain)
 *   - Live oracle ticks: `oracle_subscribe / unsubscribe`
 *   - Duel-room state: `room_subscribe / unsubscribe`
 *
 * Every message received is mirrored to the right-side OutputPanel via
 * `onOutput`, so the developer can copy the raw JSON straight into a
 * bug report or another test rig.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useCurrentAccount } from '@mysten/dapp-kit'
import { CONFIG } from '../../config'

type PanelOutput = {
  type: 'success' | 'error' | 'info'
  title: string
  data: string
  txDigest?: string
}

interface Props {
  onOutput: (o: PanelOutput) => void
}

interface ChatMessage {
  id: number
  from: string
  text: string
  timestampMs: number
}

const TIERS = ['practice', 'starter', 'casual', 'standard', 'high_roller'] as const
type Tier = (typeof TIERS)[number]

function short(addr: string, n = 4): string {
  if (!addr || addr.length <= n * 2 + 2) return addr
  return `${addr.slice(0, n + 2)}…${addr.slice(-n)}`
}

function fmtTime(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  return d.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export default function ChatPanel({ onOutput }: Props) {
  const account = useCurrentAccount()
  const wsUrl = CONFIG.serverWsUrl

  // ─── WS state ─────────────────────────────────────────────────────────────
  const wsRef = useRef<WebSocket | null>(null)
  const [status, setStatus] = useState<'idle' | 'connecting' | 'open' | 'closed'>('idle')
  const [autoConnect, setAutoConnect] = useState(true)

  // ─── Chat state ───────────────────────────────────────────────────────────
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const scrollerRef = useRef<HTMLDivElement | null>(null)

  // ─── Sub-surfaces ─────────────────────────────────────────────────────────
  const [tier, setTier] = useState<Tier>('casual')
  const [queueStatus, setQueueStatus] = useState<string>('idle')
  const [matchInfo, setMatchInfo] = useState<string | null>(null)
  const [practiceSession, setPracticeSession] = useState<unknown>(null)
  const [oracleIdsInput, setOracleIdsInput] = useState('')
  const [oracleTicks, setOracleTicks] = useState<Record<string, unknown>>({})
  const [roomIdInput, setRoomIdInput] = useState('')
  const [roomStates, setRoomStates] = useState<Record<string, unknown>>({})
  const [emojiInput, setEmojiInput] = useState('🔥')
  const [emojiDuelId, setEmojiDuelId] = useState('')
  const [lastError, setLastError] = useState<string | null>(null)

  const wsConnected = status === 'open'

  // ─── WS lifecycle ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!autoConnect || !account) return
    const ws = new WebSocket(wsUrl)
    wsRef.current = ws
    setStatus('connecting')

    ws.onopen = () => {
      setStatus('open')
      ws.send(JSON.stringify({ type: 'hello', address: account.address }))
      onOutput({
        type: 'success',
        title: 'WS connected',
        data: `${wsUrl}\nsent hello {address: ${account.address}}`,
      })
    }

    ws.onmessage = (e) => {
      let msg: { type: string; [k: string]: unknown }
      try {
        msg = JSON.parse(typeof e.data === 'string' ? e.data : '')
      } catch {
        return
      }

      switch (msg.type) {
        case 'hello':
          break
        case 'chat_history':
          setMessages((msg.messages as ChatMessage[]) ?? [])
          break
        case 'chat_message':
          setMessages((prev) => [
            ...prev,
            msg as unknown as ChatMessage,
          ])
          break
        case 'chat_reaction':
          // Surface reactions inline as a system message — handy for
          // visually confirming the player-only filter works.
          setMessages((prev) => [
            ...prev,
            {
              id: -Date.now(),
              from: (msg.from as string) ?? '?',
              text: `[reaction on ${short((msg.duelId as string) ?? '')}] ${msg.emoji}`,
              timestampMs: (msg.timestampMs as number) ?? Date.now(),
            },
          ])
          break
        case 'queue_status':
          setQueueStatus(
            `tier=${msg.tier} size=${msg.size} waitMs=${msg.waitMs}`,
          )
          break
        case 'queue_left':
          setQueueStatus('left')
          setMatchInfo(null)
          break
        case 'match_found':
          setMatchInfo(JSON.stringify(msg, null, 2))
          setQueueStatus('matched')
          break
        case 'practice_session':
          setPracticeSession(msg)
          break
        case 'oracle_tick': {
          const id = msg.oracleId as string
          setOracleTicks((prev) => ({ ...prev, [id]: msg }))
          break
        }
        case 'room_state': {
          const id = msg.duelId as string
          setRoomStates((prev) => ({ ...prev, [id]: msg }))
          break
        }
        case 'match_tick':
        case 'pong':
          // High-frequency / heartbeat — keep them out of the chat
          // pane and just relay to the output panel below.
          break
        case 'error':
          setLastError(`${msg.code as string}: ${msg.message as string}`)
          break
      }

      onOutput({
        type: msg.type === 'error' ? 'error' : 'info',
        title: msg.type,
        data: JSON.stringify(msg, null, 2),
      })
    }

    ws.onerror = () => {
      onOutput({
        type: 'error',
        title: 'WS error',
        data: `failed to talk to ${wsUrl} — is apps/server running on ${wsUrl}?`,
      })
    }

    ws.onclose = () => {
      setStatus('closed')
    }

    return () => {
      ws.close()
      wsRef.current = null
    }
  }, [autoConnect, account, wsUrl, onOutput])

  // Auto-scroll chat to the latest message.
  useEffect(() => {
    scrollerRef.current?.scrollTo({
      top: scrollerRef.current.scrollHeight,
      behavior: 'smooth',
    })
  }, [messages])

  // ─── Helpers ──────────────────────────────────────────────────────────────
  function send(msg: object): boolean {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      onOutput({
        type: 'error',
        title: 'WS not open',
        data: 'connect first',
      })
      return false
    }
    ws.send(JSON.stringify(msg))
    return true
  }

  const sendChat = () => {
    const text = draft.trim()
    if (!text) return
    if (send({ type: 'chat_send', text })) setDraft('')
  }

  const onQueueJoin = () => {
    setMatchInfo(null)
    send({ type: 'queue_join', tier })
  }

  const onQueueLeave = () => send({ type: 'queue_leave' })

  const onPracticeStart = () => {
    setPracticeSession(null)
    send({ type: 'practice_start' })
  }

  const onOracleSubscribe = () => {
    const ids = oracleIdsInput
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter((s) => s.startsWith('0x'))
    if (ids.length === 0) {
      onOutput({
        type: 'error',
        title: 'oracle_subscribe',
        data: 'provide at least one 0x… oracle id',
      })
      return
    }
    send({ type: 'oracle_subscribe', oracleIds: ids })
  }

  const onOracleUnsubscribe = () => {
    const ids = oracleIdsInput
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter((s) => s.startsWith('0x'))
    if (ids.length > 0) send({ type: 'oracle_unsubscribe', oracleIds: ids })
  }

  const onRoomSubscribe = () => {
    if (!roomIdInput.startsWith('0x')) {
      onOutput({
        type: 'error',
        title: 'room_subscribe',
        data: 'duelId must be 0x…',
      })
      return
    }
    send({ type: 'room_subscribe', duelId: roomIdInput })
  }

  const onRoomUnsubscribe = () => {
    if (roomIdInput.startsWith('0x'))
      send({ type: 'room_unsubscribe', duelId: roomIdInput })
  }

  const onEmojiReact = () => {
    if (!emojiDuelId.startsWith('0x') || !emojiInput) {
      onOutput({
        type: 'error',
        title: 'chat_react',
        data: 'provide a 0x… duelId and an emoji',
      })
      return
    }
    send({ type: 'chat_react', duelId: emojiDuelId, emoji: emojiInput })
  }

  const onPing = () => send({ type: 'ping' })

  const onReconnect = () => {
    wsRef.current?.close()
    setAutoConnect(false)
    setTimeout(() => setAutoConnect(true), 50)
  }

  // ─── Derived ──────────────────────────────────────────────────────────────
  const statusColor = useMemo(() => {
    if (status === 'open') return 'bg-green-700 text-green-100'
    if (status === 'connecting') return 'bg-yellow-700 text-yellow-100'
    return 'bg-red-800 text-red-100'
  }, [status])

  return (
    <div className="flex h-full flex-col gap-4">
      {/* ─── Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold flex items-center gap-2">
            💬 Chat &amp; WebSocket
          </h2>
          <p className="mt-0.5 text-xs text-gray-400">
            Connects to <code className="text-gray-300">{wsUrl}</code> ·
            test the full <code className="text-gray-300">/ws</code> surface
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`rounded px-2 py-1 text-xs font-semibold ${statusColor}`}>
            {status.toUpperCase()}
          </span>
          <button
            onClick={onReconnect}
            className="rounded border border-gray-700 bg-gray-850 px-3 py-1 text-xs text-gray-200 hover:bg-gray-800"
          >
            ↻ reconnect
          </button>
          <button
            onClick={onPing}
            disabled={!wsConnected}
            className="rounded border border-gray-700 bg-gray-850 px-3 py-1 text-xs text-gray-200 hover:bg-gray-800 disabled:opacity-40"
          >
            ping
          </button>
        </div>
      </div>

      {!account && (
        <div className="rounded border border-yellow-800 bg-yellow-950/60 p-3 text-xs text-yellow-200">
          ⚠️ Connect your wallet (top-right). The panel sends a{' '}
          <code>hello {'{address}'}</code> on connect using your wallet address;
          the backend's chat / matchmaking / room paths require that.
        </div>
      )}

      {/* ─── Chat ───────────────────────────────────────────────────────── */}
      <section className="flex flex-1 flex-col overflow-hidden rounded border border-gray-800 bg-gray-950">
        <header className="border-b border-gray-800 bg-gray-900 px-4 py-2 text-xs uppercase tracking-wider text-gray-400">
          Global Chat
        </header>
        <div
          ref={scrollerRef}
          className="flex-1 overflow-y-auto p-3 font-mono text-xs"
        >
          {messages.length === 0 ? (
            <p className="text-gray-500">
              No messages yet. Send one below — every connected socket will
              receive it.
            </p>
          ) : (
            messages.map((m) => (
              <div key={m.id} className="mb-1">
                <span className="text-gray-500">{fmtTime(m.timestampMs)}</span>{' '}
                <span
                  className={
                    m.from === account?.address
                      ? 'font-semibold text-blue-300'
                      : 'font-semibold text-gray-200'
                  }
                >
                  {short(m.from)}
                </span>
                <span className="text-gray-100">: {m.text}</span>
              </div>
            ))
          )}
        </div>
        <div className="flex gap-2 border-t border-gray-800 bg-gray-900 p-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && sendChat()}
            placeholder={
              wsConnected ? 'Type a message and press Enter…' : 'Not connected'
            }
            disabled={!wsConnected}
            className="flex-1 rounded border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-100 disabled:opacity-40"
            maxLength={256}
          />
          <button
            onClick={sendChat}
            disabled={!wsConnected || !draft.trim()}
            className="rounded bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-40"
          >
            Send
          </button>
        </div>
        {lastError && (
          <div className="border-t border-red-900 bg-red-950/50 px-3 py-1.5 text-xs text-red-200">
            {lastError}{' '}
            <button
              onClick={() => setLastError(null)}
              className="ml-1 text-red-400 hover:text-red-200"
            >
              dismiss
            </button>
          </div>
        )}
      </section>

      {/* ─── Sub-surfaces (collapsible) ─────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 text-xs">
        {/* Matchmaking */}
        <details
          open
          className="rounded border border-gray-800 bg-gray-900 p-3"
        >
          <summary className="cursor-pointer text-sm font-semibold text-gray-200">
            🎯 Matchmaking queue
          </summary>
          <div className="mt-3 space-y-2">
            <label className="block text-gray-400">tier</label>
            <select
              value={tier}
              onChange={(e) => setTier(e.target.value as Tier)}
              className="w-full rounded border border-gray-700 bg-gray-950 px-2 py-1 text-gray-100"
            >
              {TIERS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <div className="flex gap-2">
              <button
                onClick={onQueueJoin}
                disabled={!wsConnected}
                className="flex-1 rounded bg-emerald-700 px-2 py-1 text-white hover:bg-emerald-600 disabled:opacity-40"
              >
                queue_join
              </button>
              <button
                onClick={onQueueLeave}
                disabled={!wsConnected}
                className="flex-1 rounded bg-gray-700 px-2 py-1 text-white hover:bg-gray-600 disabled:opacity-40"
              >
                queue_leave
              </button>
            </div>
            <div className="text-gray-400">
              status: <span className="text-gray-200">{queueStatus}</span>
            </div>
            {matchInfo && (
              <pre className="mt-2 max-h-32 overflow-auto rounded bg-gray-950 p-2 text-[10px] text-emerald-300">
                {matchInfo}
              </pre>
            )}
          </div>
        </details>

        {/* Practice */}
        <details
          open
          className="rounded border border-gray-800 bg-gray-900 p-3"
        >
          <summary className="cursor-pointer text-sm font-semibold text-gray-200">
            🤖 Practice mode
          </summary>
          <div className="mt-3 space-y-2">
            <p className="text-gray-400">
              Solo-vs-bot. Server returns a 5-card deck + pre-decided bot
              swipes; no chain commit.
            </p>
            <button
              onClick={onPracticeStart}
              disabled={!wsConnected}
              className="w-full rounded bg-purple-700 px-2 py-1 text-white hover:bg-purple-600 disabled:opacity-40"
            >
              practice_start
            </button>
            {practiceSession ? (
              <pre className="mt-2 max-h-40 overflow-auto rounded bg-gray-950 p-2 text-[10px] text-purple-300">
                {JSON.stringify(practiceSession, null, 2)}
              </pre>
            ) : null}
          </div>
        </details>

        {/* Oracle ticks */}
        <details className="rounded border border-gray-800 bg-gray-900 p-3">
          <summary className="cursor-pointer text-sm font-semibold text-gray-200">
            🔭 Oracle live ticks
          </summary>
          <div className="mt-3 space-y-2">
            <label className="block text-gray-400">
              oracleIds (comma or space-separated)
            </label>
            <textarea
              value={oracleIdsInput}
              onChange={(e) => setOracleIdsInput(e.target.value)}
              placeholder="0xabc…  0xdef…"
              rows={2}
              className="w-full rounded border border-gray-700 bg-gray-950 px-2 py-1 text-gray-100"
            />
            <div className="flex gap-2">
              <button
                onClick={onOracleSubscribe}
                disabled={!wsConnected}
                className="flex-1 rounded bg-blue-700 px-2 py-1 text-white hover:bg-blue-600 disabled:opacity-40"
              >
                subscribe
              </button>
              <button
                onClick={onOracleUnsubscribe}
                disabled={!wsConnected}
                className="flex-1 rounded bg-gray-700 px-2 py-1 text-white hover:bg-gray-600 disabled:opacity-40"
              >
                unsubscribe
              </button>
            </div>
            {Object.keys(oracleTicks).length > 0 && (
              <pre className="mt-2 max-h-40 overflow-auto rounded bg-gray-950 p-2 text-[10px] text-blue-300">
                {JSON.stringify(oracleTicks, null, 2)}
              </pre>
            )}
          </div>
        </details>

        {/* Rooms */}
        <details className="rounded border border-gray-800 bg-gray-900 p-3">
          <summary className="cursor-pointer text-sm font-semibold text-gray-200">
            🚪 Duel rooms
          </summary>
          <div className="mt-3 space-y-2">
            <label className="block text-gray-400">duelId</label>
            <input
              value={roomIdInput}
              onChange={(e) => setRoomIdInput(e.target.value)}
              placeholder="0x…"
              className="w-full rounded border border-gray-700 bg-gray-950 px-2 py-1 text-gray-100"
            />
            <div className="flex gap-2">
              <button
                onClick={onRoomSubscribe}
                disabled={!wsConnected}
                className="flex-1 rounded bg-amber-700 px-2 py-1 text-white hover:bg-amber-600 disabled:opacity-40"
              >
                room_subscribe
              </button>
              <button
                onClick={onRoomUnsubscribe}
                disabled={!wsConnected}
                className="flex-1 rounded bg-gray-700 px-2 py-1 text-white hover:bg-gray-600 disabled:opacity-40"
              >
                unsubscribe
              </button>
            </div>
            {Object.keys(roomStates).length > 0 && (
              <pre className="mt-2 max-h-40 overflow-auto rounded bg-gray-950 p-2 text-[10px] text-amber-300">
                {JSON.stringify(roomStates, null, 2)}
              </pre>
            )}
          </div>
        </details>

        {/* Emoji reactions */}
        <details className="col-span-2 rounded border border-gray-800 bg-gray-900 p-3">
          <summary className="cursor-pointer text-sm font-semibold text-gray-200">
            🎉 Emoji reactions (per-duel, server filters to players)
          </summary>
          <div className="mt-3 grid grid-cols-3 gap-2">
            <input
              value={emojiDuelId}
              onChange={(e) => setEmojiDuelId(e.target.value)}
              placeholder="duelId (0x…)"
              className="col-span-2 rounded border border-gray-700 bg-gray-950 px-2 py-1 text-gray-100"
            />
            <input
              value={emojiInput}
              onChange={(e) => setEmojiInput(e.target.value)}
              placeholder="🔥"
              maxLength={16}
              className="rounded border border-gray-700 bg-gray-950 px-2 py-1 text-center text-gray-100"
            />
          </div>
          <button
            onClick={onEmojiReact}
            disabled={!wsConnected}
            className="mt-2 w-full rounded bg-pink-700 px-2 py-1 text-white hover:bg-pink-600 disabled:opacity-40"
          >
            chat_react
          </button>
          <p className="mt-2 text-[10px] text-gray-500">
            Server looks up the duel mirror; only the duel's creator +
            challenger sockets receive the reaction. Spectators in the room do
            NOT.
          </p>
        </details>
      </div>
    </div>
  )
}
