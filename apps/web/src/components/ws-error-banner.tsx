import { useEffect, useState } from "react"
import type { Unsubscribe } from "@/hooks/use-flicky-socket"
import type { ServerMsg } from "@/lib/protocol"

type Subscribe = (handler: (msg: ServerMsg) => void) => Unsubscribe

interface ErrorEntry {
  id: number
  code: string
  message: string
}

/**
 * Codes the player shouldn't see as scary red banners — either benign
 * throttling or transient retries the system already handles. The
 * `match_setup_failed` toast is also a soft notice but uses friendly
 * copy via `describe()` rather than being hidden entirely (it explains
 * the silent retry happening behind the scenes).
 */
const SILENT_CODES = new Set<string>(["rate_limited", "pong"])

/**
 * Friendly copy for known WS error codes. Anything else falls through
 * to the server's raw `message`. Keep the map small — most errors should
 * be self-explanatory once the surrounding context (queue / duel) is in
 * play.
 */
function describe(code: string, fallback: string): { title: string; body: string } {
  switch (code) {
    case "match_setup_failed":
      return {
        title: "trouble setting up the match",
        body: "we'll keep retrying — hang tight or cancel to step out of the queue.",
      }
    case "oracles_unavailable":
      return {
        title: "oracles not ready",
        body: "the price feed is short a card — try again in a couple of minutes.",
      }
    case "no_address":
      return {
        title: "session not ready",
        body: "please sign in again.",
      }
    case "practice_no_queue":
      return {
        title: "wrong mode",
        body: "practice mode doesn't use the queue.",
      }
    default:
      return { title: "something went wrong", body: fallback }
  }
}

/**
 * Auto-dismissing toast bar pinned to the top of the mobile frame.
 * Subscribes to every WS `error` and renders the most recent one. Older
 * banners are replaced (not stacked) — by the time a player reads two
 * errors they want to know the latest state, not a history.
 *
 * Auto-dismiss after `dismissMs` (default 6s). Manual dismiss via ✕.
 */
export function WsErrorBanner({
  onMessage,
  dismissMs = 6000,
}: {
  onMessage: Subscribe
  dismissMs?: number
}) {
  const [entry, setEntry] = useState<ErrorEntry | null>(null)

  useEffect(() => {
    let seq = 0
    return onMessage((msg) => {
      if (msg.type !== "error") return
      if (SILENT_CODES.has(msg.code)) return
      seq += 1
      setEntry({ id: seq, code: msg.code, message: msg.message })
    })
  }, [onMessage])

  useEffect(() => {
    if (!entry) return
    const t = setTimeout(() => setEntry(null), dismissMs)
    return () => clearTimeout(t)
  }, [entry, dismissMs])

  if (!entry) return null
  const { title, body } = describe(entry.code, entry.message)

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute inset-x-3 top-3 z-50 flex justify-center"
    >
      <div className="pointer-events-auto flex w-full items-start gap-3 rounded-md border-2 border-black/55 bg-[#3a1717] px-3 py-2.5 font-pixel shadow-[inset_0_-2px_0_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.08),0_4px_0_rgba(0,0,0,0.45)] animate-in slide-in-from-top-2 fade-in duration-200">
        <img
          src="/icons/warn.png"
          alt=""
          aria-hidden
          onError={(e) => {
            // Icon is optional — drop it silently if the asset isn't shipped.
            ;(e.currentTarget as HTMLImageElement).style.display = "none"
          }}
          className="mt-0.5 size-5 shrink-0 [image-rendering:pixelated]"
        />
        <div className="flex-1">
          <div className="text-sm tracking-[0.18em] text-[#ffb4b4] uppercase">
            {title}
          </div>
          <div className="mt-0.5 text-sm text-white/85">{body}</div>
        </div>
        <button
          type="button"
          onClick={() => setEntry(null)}
          aria-label="dismiss"
          className="grid size-6 shrink-0 place-items-center rounded text-white/55 transition-colors hover:bg-white/10 hover:text-white"
        >
          ✕
        </button>
      </div>
    </div>
  )
}
