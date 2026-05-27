/**
 * Tiny in-memory token-bucket rate limiter.
 *
 * Keyed by an opaque string the caller picks — typically `ip:route` for
 * HTTP or `addr:msgtype` for WS. Each key has its own bucket with
 * `capacity` tokens that refill linearly at `refillPerSec`.
 *
 * Trade-offs vs a sliding-window or a shared (redis-backed) limiter:
 * - **In-memory**: each Bun process has its own buckets. Fine for one
 *   instance; if we ever fan out, switch to a shared store.
 * - **Token bucket**: allows short bursts up to `capacity`, smooths
 *   sustained load by `refillPerSec`. Right for "1 request/2s with
 *   small bursts" use cases.
 * - **No GC**: buckets accumulate one entry per unique key. Idle keys
 *   stay until the next sweep. We run a periodic sweep every 60 s to
 *   drop fully-refilled buckets (no longer constraining anything).
 */
import { makeLogger } from "./log"

const log = makeLogger("ratelimit")

interface Bucket {
  tokens: number
  lastRefillMs: number
}

export interface RateLimitConfig {
  /** Max burst. */
  capacity: number
  /** Steady-state rate (tokens per second). */
  refillPerSec: number
}

const buckets = new Map<string, Bucket>()
const configs = new Map<string, RateLimitConfig>()

export function registerLimit(routeKey: string, cfg: RateLimitConfig): void {
  configs.set(routeKey, cfg)
}

/**
 * Consume one token from `${routeKey}:${who}`. Returns `{ ok: true }`
 * when allowed, or `{ ok: false, retryMs }` when rate-limited.
 */
export function consume(
  routeKey: string,
  who: string,
): { ok: true } | { ok: false; retryMs: number } {
  const cfg = configs.get(routeKey)
  if (!cfg) return { ok: true } // unconfigured route = no limit

  const key = `${routeKey}:${who}`
  const now = Date.now()
  let b = buckets.get(key)
  if (!b) {
    b = { tokens: cfg.capacity, lastRefillMs: now }
    buckets.set(key, b)
  }
  const elapsedMs = now - b.lastRefillMs
  if (elapsedMs > 0) {
    b.tokens = Math.min(cfg.capacity, b.tokens + (elapsedMs / 1000) * cfg.refillPerSec)
    b.lastRefillMs = now
  }
  if (b.tokens >= 1) {
    b.tokens -= 1
    return { ok: true }
  }
  const needed = 1 - b.tokens
  return { ok: false, retryMs: Math.ceil((needed / cfg.refillPerSec) * 1000) }
}

// GC fully-refilled buckets every 60 s so memory doesn't grow without
// bound when traffic is spiky-then-quiet.
setInterval(() => {
  let dropped = 0
  for (const [key, b] of buckets) {
    const cfg = configs.get(key.split(":")[0])
    if (!cfg) {
      buckets.delete(key)
      dropped++
      continue
    }
    if (b.tokens >= cfg.capacity) {
      buckets.delete(key)
      dropped++
    }
  }
  if (dropped > 0) log.info(`gc dropped ${dropped} idle buckets`)
}, 60_000).unref?.()

/**
 * Best-effort IP extractor. Honors `x-forwarded-for` from common
 * reverse proxies (Cloudflare / nginx) but falls back to the socket
 * IP exposed by Bun.serve via `server.requestIP`.
 */
export function clientIp(req: Request, fallback: string | null): string {
  const xff = req.headers.get("x-forwarded-for")
  if (xff) return xff.split(",")[0].trim()
  return fallback ?? "unknown"
}

// ─── Route configs ──────────────────────────────────────────────────────────
//
// Tuned per-endpoint based on the cost of the underlying work:
//   - deckmaster:generate hits RPC + writes disk → 1 req / 5 s, burst 3
//   - sponsor             Enoki call (paid)       → 2 req/s sustained,
//                                                    burst 200
//     A single match burns ~6 sponsor calls per player (create/join_duel
//     + 5 swipes). In dev two windows share an IP, and in prod a NAT can
//     put dozens of players behind one. The previous 5/60s burst tripped
//     mid-match. Generous limits here are fine — the real cost gate is
//     Enoki itself + the per-tx allowlist. Tighten once we key by
//     address instead of IP.
//   - practice_start      RPC                     → 1 req / 10 s, burst 2
//   - queue_join          RPC (balance check)     → 1 req / 2 s,  burst 3

registerLimit("deckmaster:generate", { capacity: 3, refillPerSec: 1 / 5 })
registerLimit("sponsor", { capacity: 200, refillPerSec: 2 })
registerLimit("ws:practice_start", { capacity: 2, refillPerSec: 1 / 10 })
registerLimit("ws:queue_join", { capacity: 3, refillPerSec: 1 / 2 })
//   - chat_send / chat_react        1 msg / 1.5 s, burst 4
registerLimit("ws:chat_send", { capacity: 4, refillPerSec: 1 / 1.5 })
registerLimit("ws:chat_react", { capacity: 6, refillPerSec: 1 / 1 })
