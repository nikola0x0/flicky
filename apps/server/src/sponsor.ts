/**
 * Address-balance sponsored-transaction service.
 *
 * The server holds a sponsor **keypair** (`SPONSOR_SECRET_KEY`) whose SUI
 * sits in its on-chain **address balance** (funded once via
 * `0x2::coin::send_funds` — see `src/scripts/fund-sponsor.ts`). Gas is paid
 * from that balance with an empty gas payment (`setGasPayment([])`), NOT from
 * nominated gas coins, so concurrent sponsored transactions don't contend for
 * a shared gas coin.
 *
 * Protocol (client-builds flow — the SDK-recommended one):
 *
 *   GET  /sponsor
 *     → { sponsor, network }               so the client learns the gas owner
 *
 *   POST /sponsor  { transaction, userSignature }
 *     → { digest }                         validated, co-signed, executed
 *
 * The client sets the sponsor as gas owner + an empty gas payment, builds the
 * transaction, and the player's wallet signs the *final* bytes. It POSTs those
 * bytes + the user signature; the server validates them against the policy
 * below, adds the sponsor's signature, and executes. The client falls back to
 * wallet-paid gas (dev only) when the server is unreachable / unconfigured —
 * wired in `apps/web/src/lib/sponsor.ts`.
 *
 * Policy (validators, replacing Enoki's `allowedMoveCallTargets`):
 *   - `defaults()`   — valid sender (not the sponsor), address-balance-only
 *                      gas, gas coin unused, sender-only withdrawals, dry-run
 *                      succeeds, bounded epoch expiration.
 *   - `userSignatureMatchesSender()` — the supplied signature is the sender's,
 *                      verified before the sponsor co-signs.
 *   - `gasBudget({ max })` — cap the gas the sponsor will cover.
 *   - `allowedFunctions([...])` — every entry function flicky's PTBs issue.
 *                      Any MoveCall outside this list is rejected, protecting
 *                      the sponsor's balance from being drained by arbitrary
 *                      transactions through the public route.
 */
import {
  allowedFunctions,
  createSponsor,
  defaults,
  gasBudget,
  userSignatureMatchesSender,
  type Sponsor,
} from "@mysten-incubation/sponsor"
import { env } from "./env"
import { decodeKeypair, getSuiClient } from "./lib/sui"
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
  "duel::create_duel_free",
  "duel::join_duel",
  "duel::join_duel_free",
  "duel::reveal_deck",
  "duel::record_swipe",
  "duel::record_swipe_free",
  "duel::claim_reveal_timeout",
  "duel::refund_duel",
  // Two-phase settle/finalize: `settle_card × deck_size` scores each
  // card against its own oracle and accumulates per-player payout/premium
  // onto the Duel, then `finalize` distributes the pot. `finalize_test_*`
  // is the dev shortcut that internally settles+finalizes in one call.
  "duel::settle_card",
  "duel::settle_card_free",
  "duel::finalize",
  "duel::finalize_free",
  "duel::finalize_test_one_oracle",
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

export type SponsorNetwork = "testnet" | "mainnet"

/**
 * DeepBook Predict package ids per network. Testnet defaults to what
 * `env.ts` exposes; mainnet is intentionally not baked in — set
 * `DEEPBOOK_PREDICT_PACKAGE_MAINNET` (or the legacy single-name
 * `DEEPBOOK_PREDICT_PACKAGE_ID` if you only target one network) at
 * deploy time so a typo can't silently approve an attacker's package.
 */
function resolveDeepbookPackage(network: SponsorNetwork): string {
  if (network === "testnet") return env.deepbookPredictPackageId
  // network === "mainnet"
  const mainnet =
    process.env.DEEPBOOK_PREDICT_PACKAGE_MAINNET ??
    (network === ("mainnet" as SponsorNetwork) ? null : null)
  if (mainnet) return mainnet
  throw new Error(
    "DeepBook Predict mainnet package not configured. Set DEEPBOOK_PREDICT_PACKAGE_MAINNET " +
      "in apps/server/.env before serving sponsored mainnet transactions.",
  )
}

function resolveFlickyPackage(network: SponsorNetwork): string {
  const override = process.env[`FLICKY_PACKAGE_${network.toUpperCase()}`]
  if (override) return override
  if (network === "testnet" && env.flickyPackageId) return env.flickyPackageId
  throw new Error(
    `Cannot resolve flicky package for ${network} — set FLICKY_PACKAGE_${network.toUpperCase()} ` +
      `(or publish via apps/contracts on testnet to populate deployed.json).`,
  )
}

function resolveSwapPackage(network: SponsorNetwork): string | null {
  const override = process.env[`SWAP_PACKAGE_${network.toUpperCase()}`]
  if (override) return override
  if (network === "testnet") return env.swapPackageId
  // Mainnet swap pkg not configured yet — return null and just skip
  // allowlisting swap so a typo can't approve a wrong package.
  return null
}

export function buildAllowedTargets(network: SponsorNetwork): string[] {
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
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

// ─── Sponsor instance ────────────────────────────────────────────────────────

/**
 * The sponsor is bound to a single network (`env.network`) and client — its
 * funded address balance and allowlist only make sense there. The web client
 * reads the network back from `GET /sponsor`; per-request `network` overrides
 * are intentionally ignored (a mismatched network would just fail the dry-run).
 */
function sponsorNetwork(): SponsorNetwork {
  return env.network === "mainnet" ? "mainnet" : "testnet"
}

let _sponsor: Sponsor | null = null
function getSponsor(): Sponsor | null {
  if (_sponsor) return _sponsor
  if (!env.sponsorSecretKey) return null
  const signer = decodeKeypair(env.sponsorSecretKey)
  _sponsor = createSponsor({
    signer,
    client: getSuiClient(),
    validate: [
      defaults(),
      userSignatureMatchesSender(),
      gasBudget({ max: env.sponsorMaxGasBudget }),
      allowedFunctions(buildAllowedTargets(sponsorNetwork())),
    ],
  })
  return _sponsor
}

// ─── Handler ────────────────────────────────────────────────────────────────

function jsonRes(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...sponsorCorsHeaders(origin) },
  })
}

/**
 * Handle a /sponsor request. Returns null if the path isn't sponsor-related so
 * the caller can fall through to other handlers.
 */
export async function handleSponsorRequest(req: Request): Promise<Response | null> {
  const url = new URL(req.url)
  if (url.pathname !== "/sponsor") return null

  const origin = req.headers.get("origin")

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: sponsorCorsHeaders(origin) })
  }
  if (!isSponsorOriginAllowed(origin)) {
    return jsonRes({ error: "Origin not allowed" }, 403, origin)
  }

  const sponsor = getSponsor()
  if (!sponsor) {
    return jsonRes({ error: "SPONSOR_SECRET_KEY not configured" }, 503, origin)
  }

  // GET /sponsor — config: the gas owner + network the client builds against.
  if (req.method === "GET") {
    return jsonRes({ sponsor: sponsor.address, network: sponsorNetwork() }, 200, origin)
  }
  if (req.method !== "POST") {
    return jsonRes({ error: "GET or POST only" }, 405, origin)
  }

  const gate = consume("sponsor", clientIp(req, null))
  if (!gate.ok) {
    return jsonRes({ error: "rate limited", retryMs: gate.retryMs }, 429, origin)
  }

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return jsonRes({ error: "Invalid JSON body" }, 400, origin)
  }

  const transaction = body.transaction as string | undefined
  const userSignature = body.userSignature as string | string[] | undefined
  if (!transaction || !userSignature) {
    return jsonRes({ error: "Missing transaction or userSignature" }, 400, origin)
  }

  try {
    // signAndExecuteTransaction validates the policy, co-signs, and executes.
    // A policy decline is RETURNED ($kind: 'Rejected'), not thrown — only
    // genuine errors (network, malformed bytes) reach the catch below.
    const result = await sponsor.signAndExecuteTransaction({ transaction, userSignature })

    switch (result.$kind) {
      case "Rejected":
        return jsonRes(
          {
            error: "Sponsor policy rejected the transaction",
            reason: result.reason,
            issues: result.issues,
          },
          403,
          origin,
        )
      case "FailedTransaction":
        // Executed on-chain but aborted — the sponsor's gas is spent either way.
        return jsonRes(
          {
            error: "Transaction executed but failed on-chain",
            digest: result.FailedTransaction.digest,
          },
          502,
          origin,
        )
      case "Transaction":
        return jsonRes({ digest: result.Transaction.digest }, 200, origin)
      default: {
        const exhaustive: never = result
        return jsonRes({ error: "Unexpected sponsor result", detail: exhaustive }, 500, origin)
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn(`sponsor call failed: ${message}`)
    return jsonRes({ error: "Sponsor call failed", detail: message }, 502, origin)
  }
}
