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
 * Env:
 *   ENOKI_PRIVATE_KEY    Enoki app private key (works for testnet + mainnet
 *                        from one key — Enoki dashboard configures both).
 *   ALLOWED_ORIGIN       Comma-separated origins allowed to call /sponsor,
 *                        e.g. "https://flicky.app,http://localhost:5173".
 *                        Leave UNSET (or "*") to allow any origin.
 *
 *   FLICKY_PACKAGE_TESTNET, FLICKY_PACKAGE_MAINNET   (optional)
 *     Override the package id baked into the allowlist. When unset we read
 *     apps/contracts/deployed.json.
 *
 * Allowlist:
 *   Every entry function flicky's PTBs ever issue is listed below. Enoki
 *   rejects any transaction whose MoveCalls include a target NOT in this
 *   list — protects the sponsor wallet from being drained by an attacker
 *   crafting arbitrary transactions through the public sponsor route.
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { EnokiClient } from "@mysten/enoki"

// ─── Allowlist of MoveCall targets ──────────────────────────────────────────

const FLICKY_FNS = [
  "duel::new_card",
  "duel::create_duel",
  "duel::join_duel",
  "duel::reveal_deck",
  "duel::record_swipe",
  "duel::settle_card",
  "duel::finalize",
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

// On-chain DeepBook Predict packageId is stable across networks for this
// hackathon — we only target testnet for now, mainnet would need its own
// entry.
const DEEPBOOK_PREDICT_PACKAGES: Record<EnokiNetwork, string> = {
  testnet: "0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138",
  mainnet: "0x0",
}

// Sui framework calls that PTBs may issue (e.g. share-object after create).
// Currently flicky doesn't compose with sui::transfer in its own PTBs but
// the entry remains for future expansion.
const SUI_FRAMEWORK_FNS: string[] = []

export type EnokiNetwork = "testnet" | "mainnet"

interface DeployedJson {
  packageId: string | null
}

function loadFlickyPackageId(network: EnokiNetwork): string {
  const envOverride = process.env[`FLICKY_PACKAGE_${network.toUpperCase()}`]
  if (envOverride) return envOverride
  if (network === "mainnet") {
    throw new Error("Mainnet flicky package not configured (no deployed.json)")
  }
  const path = resolve(import.meta.dir, "../../contracts/deployed.json")
  try {
    const deployed = JSON.parse(readFileSync(path, "utf-8")) as DeployedJson
    if (!deployed.packageId) throw new Error("deployed.json has no packageId")
    return deployed.packageId
  } catch (e) {
    throw new Error(
      `Cannot resolve flicky package for ${network}: ${e instanceof Error ? e.message : e}`,
    )
  }
}

export function buildAllowedTargets(network: EnokiNetwork): string[] {
  const flicky = loadFlickyPackageId(network)
  const deepbook = DEEPBOOK_PREDICT_PACKAGES[network]
  return [
    ...FLICKY_FNS.map((fn) => `${flicky}::${fn}`),
    ...DEEPBOOK_PREDICT_FNS.map((fn) => `${deepbook}::${fn}`),
    ...SUI_FRAMEWORK_FNS,
  ]
}

// ─── CORS ───────────────────────────────────────────────────────────────────

export function sponsorCorsHeaders(reqOrigin: string | null): Record<string, string> {
  const raw = process.env.ALLOWED_ORIGIN?.trim()
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
  const raw = process.env.ALLOWED_ORIGIN?.trim()
  if (!raw || raw === "*") return true
  if (!reqOrigin) return false
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(reqOrigin)
}

// ─── Handler ────────────────────────────────────────────────────────────────

function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...sponsorCorsHeaders(origin) },
  })
}

/** Lazy-init: we don't want to throw on server boot when the key is unset. */
let _enoki: EnokiClient | null = null
function getEnoki(): EnokiClient | null {
  if (_enoki) return _enoki
  const apiKey = process.env.ENOKI_PRIVATE_KEY
  if (!apiKey) return null
  _enoki = new EnokiClient({ apiKey })
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
    return json({ error: "POST only" }, 405, origin)
  }
  if (!isSponsorOriginAllowed(origin)) {
    return json({ error: "Origin not allowed" }, 403, origin)
  }

  const enoki = getEnoki()
  if (!enoki) {
    return json({ error: "ENOKI_PRIVATE_KEY not configured" }, 503, origin)
  }

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return json({ error: "Invalid JSON body" }, 400, origin)
  }

  try {
    if (body.action === "create") {
      const network = body.network as EnokiNetwork | undefined
      const transactionKindBytes = body.transactionKindBytes as string | undefined
      const sender = body.sender as string | undefined
      if (network !== "testnet" && network !== "mainnet") {
        return json({ error: "network must be testnet | mainnet" }, 400, origin)
      }
      if (!transactionKindBytes || !sender) {
        return json(
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
      return json({ bytes: result.bytes, digest: result.digest }, 200, origin)
    }

    if (body.action === "execute") {
      const digest = body.digest as string | undefined
      const signature = body.signature as string | undefined
      if (!digest || !signature) {
        return json({ error: "Missing digest or signature" }, 400, origin)
      }
      const result = await enoki.executeSponsoredTransaction({ digest, signature })
      return json({ digest: result.digest }, 200, origin)
    }

    return json(
      { error: "Unknown action — use 'create' or 'execute'" },
      400,
      origin,
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return json({ error: "Enoki call failed", detail: message }, 502, origin)
  }
}
