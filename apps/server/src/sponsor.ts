/**
 * Enoki sponsored-transaction service.
 *
 * Two-step protocol:
 *
 *   POST /sponsor  { action: "create", network, transactionKindBytes, sender }
 *     → { bytes, digest }                  Enoki sponsor signature pre-baked
 *
 *   POST /sponsor  { action: "execute", digest, signature }
 *     → { digest }                         Final on-chain digest
 *
 * Client signs the `bytes` field returned from `create` with the user's
 * wallet (`signTransaction`, NOT signAndExecute — the wallet must NOT pay
 * gas), then POSTs the resulting signature back as `execute`. The
 * fallback path (wallet-paid signAndExecute) is wired in
 * `apps/web/src/lib/sponsor.ts` so a server outage degrades gracefully.
 *
 * Allowlist:
 *   Every entry function flicky's PTBs issue is listed below. Enoki
 *   rejects any transaction whose MoveCalls escape this list — protects
 *   the sponsor wallet from being drained by an attacker crafting
 *   arbitrary transactions through the public sponsor route.
 */
import { EnokiClient } from "@mysten/enoki"
import { env } from "./env"
import { makeLogger } from "./log"
import { clientIp, consume } from "./ratelimit"

const log = makeLogger("sponsor")

// ─── Allowlist of MoveCall targets ──────────────────────────────────────────

/**
 * Functions sponsored from the **flicky duel package** (the one in
 * `apps/contracts/sources/duel.move`). The swap module is published
 * SEPARATELY (`apps/contracts/swap/`) — see SWAP_FNS below.
 */
const FLICKY_FNS = [
  "duel::new_card",
  "duel::create_duel",
  "duel::join_duel",
  "duel::reveal_deck",
  "duel::record_swipe",
  "duel::settle_card",
  "duel::finalize",
  "duel::settle_card_v2",
  "duel::finalize_v2",
]

/**
 * Player-facing AMM swap functions (separate package).
 *
 * The swap module is a generic `Pool<X, Y>` AMM — `swap_x_for_y` /
 * `swap_y_for_x` are the two directions a player calls for SUI↔dUSDC
 * top-up. Pool admin (`create_pool`, `add_liquidity`, `remove_liquidity`)
 * is intentionally NOT in this list — only treasury wallets do that and
 * they don't need sponsored gas.
 */
const SWAP_FNS = [
  "swap::swap_x_for_y",
  "swap::swap_y_for_x",
]

const DEEPBOOK_PREDICT_FNS = [
  "predict::create_manager",
  "predict::mint",
  "predict::redeem",
  "predict::redeem_permissionless",
  "predict_manager::deposit",
  "predict_manager::withdraw",
  "market_key::up",
  "market_key::down",
]

export type EnokiNetwork = "testnet" | "mainnet"

/**
 * DeepBook Predict package ids per network. Testnet defaults to what
 * `env.ts` exposes; mainnet is intentionally not baked in — set
 * `DEEPBOOK_PREDICT_PACKAGE_MAINNET` (or the legacy single-name
 * `DEEPBOOK_PREDICT_PACKAGE_ID` if you only target one network) at
 * deploy time so a typo can't silently approve an attacker's package.
 */
function resolveDeepbookPackage(network: EnokiNetwork): string {
  if (network === "testnet") return env.deepbookPredictPackageId
  // network === "mainnet"
  const mainnet =
    process.env.DEEPBOOK_PREDICT_PACKAGE_MAINNET ??
    (network === ("mainnet" as EnokiNetwork) ? null : null)
  if (mainnet) return mainnet
  throw new Error(
    "DeepBook Predict mainnet package not configured. Set DEEPBOOK_PREDICT_PACKAGE_MAINNET " +
      "in apps/server/.env before serving sponsored mainnet transactions.",
  )
}

function resolveFlickyPackage(network: EnokiNetwork): string {
  const override = process.env[`FLICKY_PACKAGE_${network.toUpperCase()}`]
  if (override) return override
  if (network === "testnet" && env.flickyPackageId) return env.flickyPackageId
  throw new Error(
    `Cannot resolve flicky package for ${network} — set FLICKY_PACKAGE_${network.toUpperCase()} ` +
      `(or publish via apps/contracts on testnet to populate deployed.json).`,
  )
}

function resolveSwapPackage(network: EnokiNetwork): string | null {
  const override = process.env[`SWAP_PACKAGE_${network.toUpperCase()}`]
  if (override) return override
  if (network === "testnet") return env.swapPackageId
  // Mainnet swap pkg not configured yet — return null and just skip
  // allowlisting swap so a typo can't approve a wrong package.
  return null
}

export function buildAllowedTargets(network: EnokiNetwork): string[] {
  const flicky = resolveFlickyPackage(network)
  const deepbook = resolveDeepbookPackage(network)
  const swap = resolveSwapPackage(network)
  const targets = [
    ...FLICKY_FNS.map((fn) => `${flicky}::${fn}`),
    ...DEEPBOOK_PREDICT_FNS.map((fn) => `${deepbook}::${fn}`),
  ]
  if (swap) targets.push(...SWAP_FNS.map((fn) => `${swap}::${fn}`))
  return targets
}

// ─── CORS ───────────────────────────────────────────────────────────────────

export function sponsorCorsHeaders(reqOrigin: string | null): Record<string, string> {
  const raw = env.allowedOrigin?.trim()
  if (!raw || raw === "*") {
    return {
      "Access-Control-Allow-Origin": reqOrigin || "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    }
  }
  const allowed = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  const match = reqOrigin && allowed.includes(reqOrigin) ? reqOrigin : allowed[0]
  return {
    "Access-Control-Allow-Origin": match,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  }
}

export function isSponsorOriginAllowed(reqOrigin: string | null): boolean {
  const raw = env.allowedOrigin?.trim()
  if (!raw || raw === "*") return true
  if (!reqOrigin) return false
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(reqOrigin)
}

// ─── Handler ────────────────────────────────────────────────────────────────

function jsonRes(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...sponsorCorsHeaders(origin) },
  })
}

let _enoki: EnokiClient | null = null
function getEnoki(): EnokiClient | null {
  if (_enoki) return _enoki
  if (!env.enokiPrivateKey) return null
  _enoki = new EnokiClient({ apiKey: env.enokiPrivateKey })
  return _enoki
}

/**
 * Handle a POST /sponsor request. Returns null if the path/method isn't
 * sponsor-related so the caller can fall through to other handlers.
 */
export async function handleSponsorRequest(req: Request): Promise<Response | null> {
  const url = new URL(req.url)
  if (url.pathname !== "/sponsor") return null

  const origin = req.headers.get("origin")

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: sponsorCorsHeaders(origin) })
  }
  if (req.method !== "POST") {
    return jsonRes({ error: "POST only" }, 405, origin)
  }
  if (!isSponsorOriginAllowed(origin)) {
    return jsonRes({ error: "Origin not allowed" }, 403, origin)
  }
  const gate = consume("sponsor", clientIp(req, null))
  if (!gate.ok) {
    return jsonRes(
      { error: "rate limited", retryMs: gate.retryMs },
      429,
      origin,
    )
  }

  const enoki = getEnoki()
  if (!enoki) {
    return jsonRes({ error: "ENOKI_PRIVATE_KEY not configured" }, 503, origin)
  }

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return jsonRes({ error: "Invalid JSON body" }, 400, origin)
  }

  try {
    if (body.action === "create") {
      // Default to testnet so the client doesn't have to send `network`
      // for the common case. Explicit values are validated.
      const networkRaw = (body.network as string | undefined) ?? "testnet"
      if (networkRaw !== "testnet" && networkRaw !== "mainnet") {
        return jsonRes({ error: "network must be testnet | mainnet" }, 400, origin)
      }
      const network = networkRaw as EnokiNetwork
      const transactionKindBytes = body.transactionKindBytes as string | undefined
      const sender = body.sender as string | undefined
      if (!transactionKindBytes || !sender) {
        return jsonRes(
          { error: "Missing transactionKindBytes or sender" },
          400,
          origin,
        )
      }
      const result = await enoki.createSponsoredTransaction({
        network,
        transactionKindBytes,
        sender,
        allowedMoveCallTargets: buildAllowedTargets(network),
        allowedAddresses: [sender],
      })
      return jsonRes({ bytes: result.bytes, digest: result.digest }, 200, origin)
    }

    if (body.action === "execute") {
      const digest = body.digest as string | undefined
      const signature = body.signature as string | undefined
      if (!digest || !signature) {
        return jsonRes({ error: "Missing digest or signature" }, 400, origin)
      }
      const result = await enoki.executeSponsoredTransaction({ digest, signature })
      return jsonRes({ digest: result.digest }, 200, origin)
    }

    return jsonRes(
      { error: "Unknown action — use 'create' or 'execute'" },
      400,
      origin,
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn(`enoki call failed: ${message}`)
    return jsonRes({ error: "Enoki call failed", detail: message }, 502, origin)
  }
}
