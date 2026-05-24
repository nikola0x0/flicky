/**
 * Shared HTTP helpers — JSON responses + the wildcard CORS preflight used
 * by every endpoint except `/sponsor` (which has stricter origin rules
 * configured via ALLOWED_ORIGIN).
 */
export const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, jsonReplacer), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  })
}

export function corsPreflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS })
}

/** BigInt → string so `JSON.stringify` doesn't throw. */
function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value
}
