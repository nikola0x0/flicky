import { useEffect, useLayoutEffect, useRef, useState } from "react"
import type { CSSProperties, FormEvent } from "react"
import { useCurrentAccount } from "@mysten/dapp-kit-react"

import { PixelButton } from "@/components/pixel-button"
import { PlayerAvatar } from "@/components/player-avatar"
import { useFlickySocket } from "@/hooks/use-flicky-socket"

const BLUE_BRAND_STYLE = {
  "--btn-bg": "#4094fb",
  "--btn-highlight": "#7eb6ff",
} as CSSProperties

// Mirror the server's `chat_send` clamp (apps/server/src/ws/chat.ts).
const MAX_TEXT_LEN = 256

interface ChatMsg {
  id: number
  from: string
  text: string
  timestampMs: number
}

/**
 * /game/inventory — global chat room. Wires the shared WS channel already
 * served by `apps/server/src/ws/chat.ts` (`chat_send` → `chat_message`,
 * `chat_history` on hello) into a scrolling message list + composer,
 * styled to match the rest of the game frame (navy panels, pixel font,
 * `PixelButton`, `PlayerAvatar`) — same recipe as the history screen.
 *
 * The game layout only mounts this route for a signed-in account, so a
 * wallet address is always present to attribute + send messages.
 */
export default function GameChat() {
  const account = useCurrentAccount()
  const address = account?.address
  const { wsOpen, send, onMessage } = useFlickySocket(address)

  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [draft, setDraft] = useState("")

  // Upsert by id so the history snapshot and the live broadcast of a
  // message we just sent (the server echoes to everyone, sender included)
  // never double up. Ids are monotonically increasing, so a stable sort
  // keeps chronological order without extra bookkeeping.
  useEffect(() => {
    return onMessage((msg) => {
      if (msg.type === "chat_history") {
        setMessages(msg.messages)
      } else if (msg.type === "chat_message") {
        setMessages((prev) => {
          if (prev.some((m) => m.id === msg.id)) return prev
          return [
            ...prev,
            {
              id: msg.id,
              from: msg.from,
              text: msg.text,
              timestampMs: msg.timestampMs,
            },
          ]
        })
      }
    })
  }, [onMessage])

  const scrollRef = useRef<HTMLDivElement>(null)
  // Pin to the newest message on every update. useLayoutEffect so the
  // jump happens before paint — no flash of the list scrolled up.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  const trimmed = draft.trim()
  const canSend = wsOpen && trimmed.length > 0

  const handleSend = (e: FormEvent) => {
    e.preventDefault()
    if (!canSend) return
    send({ type: "chat_send", text: trimmed })
    setDraft("")
  }

  return (
    <div className="flex h-full flex-col font-pixel text-white">
      <header className="flex items-center justify-between px-4 py-4">
        <h1 className="flex items-center gap-2.5 text-4xl tracking-[0.2em] uppercase">
          <img
            src="/icons/message.png"
            alt=""
            aria-hidden
            className="size-8 [image-rendering:pixelated]"
          />
          chat
        </h1>
        <ConnDot open={wsOpen} />
      </header>

      <div
        ref={scrollRef}
        className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 pb-3 [mask-image:linear-gradient(to_bottom,transparent_0%,black_6%,black_100%)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {messages.length === 0 ? (
          <Empty />
        ) : (
          <ul className="flex flex-col gap-3">
            {messages.map((m) => (
              <MessageRow key={m.id} msg={m} own={sameAddr(m.from, address)} />
            ))}
          </ul>
        )}
      </div>

      <form
        onSubmit={handleSend}
        className="flex items-center gap-2 border-t-2 border-black/40 bg-[#151837] px-3 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value.slice(0, MAX_TEXT_LEN))}
          placeholder={wsOpen ? "say something…" : "connecting…"}
          maxLength={MAX_TEXT_LEN}
          aria-label="message"
          className="min-w-0 flex-1 rounded-md border-2 border-black/40 bg-black/30 px-3 py-2.5 text-[15px] text-white placeholder:text-white/35 focus:ring-1 focus:ring-white/15 focus:outline-none"
        />
        {draft.length > MAX_TEXT_LEN - 40 && (
          <span className="shrink-0 text-xs text-white/40 tabular-nums">
            {MAX_TEXT_LEN - draft.length}
          </span>
        )}
        <PixelButton
          type="submit"
          disabled={!canSend}
          style={BLUE_BRAND_STYLE}
          className="h-11 shrink-0 px-4 text-base"
        >
          send
        </PixelButton>
      </form>
    </div>
  )
}

function MessageRow({ msg, own }: { msg: ChatMsg; own: boolean }) {
  return (
    <li
      className={`flex items-end gap-2 ${own ? "flex-row-reverse" : "flex-row"}`}
    >
      <PlayerAvatar address={msg.from} size={32} className="mb-4" />
      <div
        className={`flex max-w-[78%] flex-col gap-1 ${own ? "items-end" : "items-start"}`}
      >
        <div className="flex items-center gap-2 px-1">
          {!own && (
            <span className="text-xs tracking-[0.14em] text-white/45 uppercase">
              {shortAddr(msg.from)}
            </span>
          )}
          <span className="text-[10px] text-white/30 tabular-nums">
            {clockTime(msg.timestampMs)}
          </span>
        </div>
        <div
          className={`rounded-2xl px-3 py-2 text-[15px] leading-snug break-words ${
            own
              ? "rounded-br-sm bg-[#39508a] text-white ring-1 ring-white/10"
              : "rounded-bl-sm bg-black/35 text-white ring-1 ring-white/5"
          }`}
        >
          {msg.text}
        </div>
      </div>
    </li>
  )
}

function ConnDot({ open }: { open: boolean }) {
  return (
    <span className="flex items-center gap-1.5 rounded bg-black/30 px-2.5 py-1 text-xs tracking-[0.18em] text-white/55 uppercase backdrop-blur-sm">
      <span
        className={`inline-block size-1.5 rounded-full ${
          open ? "bg-emerald-400" : "animate-pulse bg-amber-400"
        }`}
      />
      {open ? "live" : "…"}
    </span>
  )
}

function Empty() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
      <img
        src="/icons/message.png"
        alt=""
        aria-hidden
        className="size-12 opacity-50 [image-rendering:pixelated]"
      />
      <p className="max-w-[26ch] text-sm leading-relaxed tracking-wider text-white/50 uppercase">
        no messages yet — say hi to the lobby.
      </p>
    </div>
  )
}

function sameAddr(a: string, b?: string): boolean {
  return Boolean(b) && a.toLowerCase() === b!.toLowerCase()
}

function shortAddr(a: string): string {
  if (!a || a.length < 12) return a
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

/** Wall-clock HH:MM for a message timestamp. */
function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  })
}
