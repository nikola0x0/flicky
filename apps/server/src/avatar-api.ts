/**
 * Avatar-icon persistence over `player_profile`.
 *
 *   GET  /avatars?addresses=a,b,c  → { "0xa": "apple", "0xb": null }
 *   POST /avatar   { address, iconId }  → { ok: true }
 *
 * Reads are batched by the client and cached, so a full screen of avatars
 * is one request; writes fire only on a deliberate pick. Trust model
 * matches the rest of the app — the address is taken from the request
 * (same as WS `hello`) — but the value is constrained to the 44 known
 * icon ids, so nothing arbitrary can land in the table. Guards: per-IP
 * rate limit, ≤100 addresses per read, id validation, and an origin gate
 * on the write (reuses the sponsor's ALLOWED_ORIGIN check).
 */
import { getAvatarIcons, setAvatarIcon } from "./db"
import { isValidIconId } from "./avatar-icons"
import { json } from "./lib/http"
import { clientIp, consume } from "./ratelimit"
import { isSponsorOriginAllowed } from "./sponsor"

const MAX_ADDRESSES = 100

/** Trim, lowercase, drop non-`0x`, dedupe, cap at MAX_ADDRESSES. */
export function parseAddresses(param: string | null): string[] {
  if (!param) return []
  const seen = new Set<string>()
  for (const raw of param.split(",")) {
    const a = raw.trim().toLowerCase()
    if (a.startsWith("0x") && a.length > 2) seen.add(a)
    if (seen.size >= MAX_ADDRESSES) break
  }
  return [...seen]
}

/**
 * Validate a POST body into `{ address, iconId }`, or null if malformed.
 * `iconId` must be null (gradient-only) or one of the 44 known ids —
 * this is what keeps arbitrary data out of the table. Address is
 * lowercased so reads and writes match regardless of client casing.
 */
export function parseSetBody(
  body: unknown
): { address: string; iconId: string | null } | null {
  if (!body || typeof body !== "object") return null
  const b = body as Record<string, unknown>
  const address = b.address
  if (typeof address !== "string" || !address.startsWith("0x")) return null
  const iconId = b.iconId
  if (iconId === null) return { address: address.toLowerCase(), iconId: null }
  if (isValidIconId(iconId)) return { address: address.toLowerCase(), iconId }
  return null
}

export async function handleAvatarRequest(
  req: Request,
  url: URL
): Promise<Response | null> {
  if (url.pathname === "/avatars" && req.method === "GET") {
    const rl = consume("avatar:read", clientIp(req, null))
    if (!rl.ok) return json({ error: "rate limited", retryMs: rl.retryMs }, 429)
    const addresses = parseAddresses(url.searchParams.get("addresses"))
    try {
      return json(await getAvatarIcons(addresses))
    } catch (e) {
      return json(
        {
          error: "avatar read failed",
          detail: e instanceof Error ? e.message : String(e),
        },
        500
      )
    }
  }

  if (url.pathname === "/avatar" && req.method === "POST") {
    if (!isSponsorOriginAllowed(req.headers.get("origin"))) {
      return json({ error: "origin not allowed" }, 403)
    }
    const rl = consume("avatar:write", clientIp(req, null))
    if (!rl.ok) return json({ error: "rate limited", retryMs: rl.retryMs }, 429)
    let body: unknown
    try {
      body = await req.json()
    } catch {
      return json({ error: "invalid JSON body" }, 400)
    }
    const parsed = parseSetBody(body)
    if (!parsed) return json({ error: "bad address or unknown iconId" }, 400)
    try {
      await setAvatarIcon(parsed.address, parsed.iconId)
      return json({ ok: true })
    } catch (e) {
      return json(
        {
          error: "avatar write failed",
          detail: e instanceof Error ? e.message : String(e),
        },
        500
      )
    }
  }

  return null
}
