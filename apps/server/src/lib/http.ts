/**
 * Shared HTTP helpers — JSON responses + the wildcard CORS preflight used
 * by every endpoint except `/sponsor` (which has stricter origin rules
 * configured via ALLOWED_ORIGIN).
 */
import { env } from "../env"
import { isNetwork, type Network } from "../network-env"

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

// ─── Per-network request routing ────────────────────────────────────────────

/**
 * Resolve the `?network=` query param for a read endpoint.
 *
 * One process serves every network in `env.enabledNetworks`, so a client on
 * mainnet must be able to ask for mainnet data explicitly instead of silently
 * getting the default network's. Omitted → the default network, which is what
 * every pre-multi-network caller meant.
 *
 * Returns a `Response` (400) when the param names a network this deploy
 * doesn't serve — better a clear rejection than quietly answering about a
 * different chain than the caller asked about.
 */
export function resolveNetworkParam(
  url: URL
): { network: Network } | { error: Response } {
  const raw = url.searchParams.get("network")
  if (!raw) return { network: env.network }
  if (
    !isNetwork(raw) ||
    !(env.enabledNetworks as readonly string[]).includes(raw)
  ) {
    return {
      error: json(
        {
          error: "unknown_network",
          detail: `network "${raw}" is not served here`,
          enabled: env.enabledNetworks,
        },
        400
      ),
    }
  }
  return { network: raw }
}

/**
 * 503 for a network whose DeepBook Predict deployment doesn't exist.
 *
 * Predict is testnet-only today, so every deck / oracle / settlement read is
 * unanswerable on mainnet. Saying so plainly beats returning an empty list,
 * which reads as "no markets right now" and sends the client into a retry
 * loop against a chain that will never have any.
 */
export function networkUnavailable(network: Network): Response {
  return json(
    {
      error: "network_unavailable",
      network,
      detail:
        `DeepBook Predict is not deployed on ${network}, so markets, decks, ` +
        `and settlement data are unavailable there.`,
    },
    503
  )
}
