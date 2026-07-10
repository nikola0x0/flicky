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
 * Server-side self-sponsor fallback (entirely inside this file — the web
 * flow above never changes):
 *   `create` tries Enoki first. If Enoki is unconfigured (no
 *   ENOKI_PRIVATE_KEY) or `createSponsoredTransaction` throws, the server
 *   reconstructs the transaction from `transactionKindBytes`, sets itself
 *   (`env.sponsorSecretKey`) as gas owner, builds + sponsor-signs it, and
 *   stashes `{bytes, sponsorSignature}` in an in-memory TTL map keyed by
 *   digest — returning the SAME `{bytes, digest}` shape Enoki would, so
 *   the client still just signs `bytes` as sender. `execute` looks the
 *   digest up in that map first; if present, it submits with both the
 *   sender's and the sponsor's signatures directly via
 *   `client.core.executeTransaction`, otherwise it falls through to
 *   Enoki's `executeSponsoredTransaction` as before.
 *
 * Allowlist:
 *   Every entry function flicky's PTBs issue is listed below. Enoki
 *   rejects any transaction whose MoveCalls escape this list — protects
 *   the sponsor wallet from being drained by an attacker crafting
 *   arbitrary transactions through the public sponsor route. The
 *   self-sponsor fallback enforces the same allowlist itself (Enoki isn't
 *   in the loop to do it) before it will sponsor-sign anything.
 */
import { EnokiClient } from "@mysten/enoki"
import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions"
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { normalizeSuiObjectId, toBase64 } from "@mysten/sui/utils"
import { env } from "./env"
import { makeLogger } from "./log"
import { clientIp, consume } from "./ratelimit"
import { decodeKeypair, getSuiClient } from "./lib/sui"

export { env }

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
  "duel::finalize_test_one_price",
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
const SWAP_FNS = ["swap::swap_x_for_y", "swap::swap_y_for_x"]

/**
 * Account registry functions (6-24 protocol).
 *
 * Player accounts in Enoki ZkLogin context — registry for account discovery
 * and account-level operations (funding, withdrawals, auth generation).
 */
const ACCOUNT_FNS = [
  "account_registry::new",
  "account::share",
  "account::generate_auth",
  "account::deposit_funds",
  "account::withdraw_funds",
]

const DEEPBOOK_PREDICT_FNS = [
  "expiry_market::load_live_pricer",
  "expiry_market::mint_exact_quantity",
  "expiry_market::mint_exact_amount",
  "expiry_market::redeem_live",
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
      "in apps/server/.env before serving sponsored mainnet transactions."
  )
}

function resolveFlickyPackage(network: EnokiNetwork): string {
  const override = process.env[`FLICKY_PACKAGE_${network.toUpperCase()}`]
  if (override) return override
  if (network === "testnet" && env.flickyPackageId) return env.flickyPackageId
  throw new Error(
    `Cannot resolve flicky package for ${network} — set FLICKY_PACKAGE_${network.toUpperCase()} ` +
      `(or publish via apps/contracts on testnet to populate deployed.json).`
  )
}

function resolveAccountPackage(network: EnokiNetwork): string {
  const override = process.env[`ACCOUNT_PACKAGE_${network.toUpperCase()}`]
  if (override) return override
  if (network === "testnet" && env.accountPackageId) return env.accountPackageId
  throw new Error(
    `Cannot resolve account package for ${network} — set ACCOUNT_PACKAGE_${network.toUpperCase()} ` +
      `(or publish via apps/contracts on testnet to populate deployed.json).`
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
  const account = resolveAccountPackage(network)
  const deepbook = resolveDeepbookPackage(network)
  const swap = resolveSwapPackage(network)
  const targets = [
    ...FLICKY_FNS.map((fn) => `${flicky}::${fn}`),
    ...ACCOUNT_FNS.map((fn) => `${account}::${fn}`),
    ...DEEPBOOK_PREDICT_FNS.map((fn) => `${deepbook}::${fn}`),
  ]
  if (swap) targets.push(...SWAP_FNS.map((fn) => `${swap}::${fn}`))
  return targets
}

// ─── CORS ───────────────────────────────────────────────────────────────────

export function sponsorCorsHeaders(
  reqOrigin: string | null
): Record<string, string> {
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
  const match =
    reqOrigin && allowed.includes(reqOrigin) ? reqOrigin : allowed[0]
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

function jsonRes(
  body: unknown,
  status: number,
  origin: string | null
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...sponsorCorsHeaders(origin),
    },
  })
}

let _enoki: EnokiClient | null = null
function getEnoki(): EnokiClient | null {
  if (_enoki) return _enoki
  if (!env.enokiPrivateKey) return null
  _enoki = new EnokiClient({ apiKey: env.enokiPrivateKey })
  return _enoki
}

// ─── Self-sponsor fallback ──────────────────────────────────────────────────

let _sponsorKeypair: Ed25519Keypair | null = null
let _sponsorKeypairAttempted = false

/**
 * Lazy, memoized — same shape as `getEnoki()`. Returns null (rather than
 * throwing) when `env.sponsorSecretKey` is unset OR malformed, so a bad/
 * missing key degrades to "self-sponsor unavailable" instead of crashing
 * the whole HTTP server at import time.
 */
function getSponsorKeypair(): Ed25519Keypair | null {
  if (_sponsorKeypair) return _sponsorKeypair
  if (_sponsorKeypairAttempted) return null
  _sponsorKeypairAttempted = true
  if (!env.sponsorSecretKey) return null
  try {
    _sponsorKeypair = decodeKeypair(env.sponsorSecretKey)
    return _sponsorKeypair
  } catch (e) {
    log.error(
      `SPONSOR_SECRET_KEY (or KEEPER_SECRET_KEY/BOT_SECRET_KEY) is not a valid bech32 suiprivkey1… key: ${e instanceof Error ? e.message : String(e)}`
    )
    return null
  }
}

/**
 * Extract fully-qualified `pkg::module::fn` targets for every MoveCall
 * command in `tx`. Pure/synchronous — `getData()` reads the in-memory
 * transaction builder, no RPC involved.
 */
export function moveCallTargets(tx: Transaction): string[] {
  const data = tx.getData() as {
    commands: Array<{
      $kind: string
      MoveCall?: { package: string; module: string; function: string }
    }>
  }
  return data.commands
    .filter((c) => c.$kind === "MoveCall" && c.MoveCall)
    .map((c) => {
      const mc = c.MoveCall as {
        package: string
        module: string
        function: string
      }
      return `${normalizeSuiObjectId(mc.package)}::${mc.module}::${mc.function}`
    })
}

const SYSTEM_FRAMEWORK_PKGS = new Set([
  normalizeSuiObjectId("0x1"),
  normalizeSuiObjectId("0x2"),
  normalizeSuiObjectId("0x3"),
])

/**
 * Defense against sponsoring arbitrary transactions through the self-sponsor
 * path (Enoki's own `allowedMoveCallTargets` isn't in the loop here since
 * Enoki is being bypassed). Throws on the first non-allowlisted MoveCall.
 * System-framework packages (0x1/0x2/0x3) are always allowed — see below.
 */
export function assertSelfSponsorTargetsAllowed(
  tx: Transaction,
  network: EnokiNetwork
): void {
  const allowed = new Set(
    buildAllowedTargets(network).map((t) => {
      const [pkg, mod, fn] = t.split("::")
      return `${normalizeSuiObjectId(pkg)}::${mod}::${fn}`
    })
  )
  const targets = moveCallTargets(tx)
  for (const target of targets) {
    const pkg = target.split("::")[0]
    // Sui system-framework packages (0x1/0x2/0x3) are coin/pay/framework
    // plumbing that coin resolution (merge/split for a multi-coin stake or a
    // `coinWithBalance`) legitimately emits. They operate only on the sender's
    // own objects — they can't drain the sponsor (gas-only exposure) or reach
    // arbitrary app logic — and Enoki accepts them too, so allow them here.
    if (SYSTEM_FRAMEWORK_PKGS.has(pkg)) continue
    if (!allowed.has(target)) {
      throw new Error(
        `self-sponsor: MoveCall target not allowlisted: ${target} (all targets: ${targets.join(", ")})`
      )
    }
  }
}

interface SelfSponsorEntry {
  bytes: Uint8Array
  sponsorSignature: string
  expiresAt: number
}

// create→execute is seconds apart in the happy path; 5 min covers a slow
// wallet-approval popup without holding stale entries indefinitely.
const SELF_SPONSOR_TTL_MS = 5 * 60 * 1000
const selfSponsorStore = new Map<string, SelfSponsorEntry>()

function pruneSelfSponsorStore(): void {
  const now = Date.now()
  for (const [digest, entry] of selfSponsorStore) {
    if (entry.expiresAt <= now) selfSponsorStore.delete(digest)
  }
}

setInterval(pruneSelfSponsorStore, 60_000).unref?.()

/**
 * Build, sponsor-sign, and stash a self-sponsored transaction. Returns the
 * SAME `{bytes, digest}` shape `enoki.createSponsoredTransaction` returns —
 * the caller (web) signs `bytes` as sender exactly as it would in the Enoki
 * path.
 *
 * `tx.build({ client })` against a `SuiGrpcClient` triggers server-side gas
 * selection (fullnode `simulateTransaction` with `doGasSelection: true`)
 * whenever `gasData.budget`/`payment` are unset, using `gasData.owner` (set
 * via `setGasOwner`) as the coin owner — so the sponsor's SUI coins are
 * resolved automatically without a manual `listCoins` round trip.
 */
async function selfSponsorCreate(
  network: EnokiNetwork,
  transactionKindBytes: string,
  sender: string,
  sponsorKeypair: Ed25519Keypair
): Promise<{ bytes: string; digest: string }> {
  if (network !== env.network) {
    throw new Error(
      `self-sponsor: requested network "${network}" does not match this server's SUI_NETWORK ("${env.network}")`
    )
  }

  const tx = Transaction.fromKind(transactionKindBytes)
  assertSelfSponsorTargetsAllowed(tx, network)
  tx.setSender(sender)
  tx.setGasOwner(sponsorKeypair.toSuiAddress())

  const bytes = await tx.build({ client: getSuiClient() })
  const digest = TransactionDataBuilder.getDigestFromBytes(bytes)
  const { signature: sponsorSignature } =
    await sponsorKeypair.signTransaction(bytes)

  pruneSelfSponsorStore()
  selfSponsorStore.set(digest, {
    bytes,
    sponsorSignature,
    expiresAt: Date.now() + SELF_SPONSOR_TTL_MS,
  })

  return { bytes: toBase64(bytes), digest }
}

/**
 * Submit a self-sponsored transaction with both signatures. Per the SDK's
 * documented sponsored-transaction flow, signature order is
 * [senderSignature, sponsorSignature]. Deletes the store entry either way
 * so a digest can't be replayed.
 */
async function selfSponsorExecute(
  digest: string,
  senderSignature: string
): Promise<{ digest: string }> {
  const entry = selfSponsorStore.get(digest)
  if (!entry) {
    throw new Error(`self-sponsor: unknown or expired digest ${digest}`)
  }
  selfSponsorStore.delete(digest)

  const result = await getSuiClient().core.executeTransaction({
    transaction: entry.bytes,
    signatures: [senderSignature, entry.sponsorSignature],
  })
  if (result.$kind !== "Transaction" || !result.Transaction.status.success) {
    const reason =
      (result.$kind === "Transaction"
        ? result.Transaction.status.error?.message
        : result.FailedTransaction?.status.error?.message) ?? "unknown"
    throw new Error(`self-sponsor execute failed: ${reason}`)
  }
  return { digest: result.Transaction.digest }
}

const bootSponsorKeypair = getSponsorKeypair()
if (bootSponsorKeypair) {
  log.info(
    `self-sponsor fallback available — sponsor address ${bootSponsorKeypair.toSuiAddress()}`
  )
} else if (env.sponsorSecretKey) {
  log.warn(
    "self-sponsor fallback unavailable — SPONSOR_SECRET_KEY is set but invalid"
  )
} else {
  log.warn(
    "self-sponsor fallback unavailable — set SPONSOR_SECRET_KEY (or KEEPER_SECRET_KEY / BOT_SECRET_KEY)"
  )
}

/**
 * Handle a POST /sponsor request. Returns null if the path/method isn't
 * sponsor-related so the caller can fall through to other handlers.
 */
export async function handleSponsorRequest(
  req: Request
): Promise<Response | null> {
  const url = new URL(req.url)
  if (url.pathname !== "/sponsor") return null

  const origin = req.headers.get("origin")

  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: sponsorCorsHeaders(origin),
    })
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
      origin
    )
  }

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return jsonRes({ error: "Invalid JSON body" }, 400, origin)
  }

  if (body.action === "create") {
    // Default to testnet so the client doesn't have to send `network`
    // for the common case. Explicit values are validated.
    const networkRaw = (body.network as string | undefined) ?? "testnet"
    if (networkRaw !== "testnet" && networkRaw !== "mainnet") {
      return jsonRes(
        { error: "network must be testnet | mainnet" },
        400,
        origin
      )
    }
    const network = networkRaw as EnokiNetwork
    const transactionKindBytes = body.transactionKindBytes as string | undefined
    const sender = body.sender as string | undefined
    if (!transactionKindBytes || !sender) {
      return jsonRes(
        { error: "Missing transactionKindBytes or sender" },
        400,
        origin
      )
    }
    return handleCreate(network, transactionKindBytes, sender, origin)
  }

  if (body.action === "execute") {
    const digest = body.digest as string | undefined
    const signature = body.signature as string | undefined
    if (!digest || !signature) {
      return jsonRes({ error: "Missing digest or signature" }, 400, origin)
    }
    return handleExecute(digest, signature, origin)
  }

  return jsonRes(
    { error: "Unknown action — use 'create' or 'execute'" },
    400,
    origin
  )
}

/**
 * Enoki-primary, self-sponsor-fallback `create`. Enoki is tried first
 * (only if configured); on any failure — unconfigured or a thrown error —
 * falls through to the server's own sponsor key. Only a truly unavailable
 * fallback (no sponsor key, or the self-sponsor build itself failing)
 * produces an error response.
 */
// Circuit breaker: after ANY Enoki failure (create OR execute) we open the
// circuit for a window, during which `create` skips Enoki and self-sponsors
// directly. This is what makes self-sponsor a real *fallback* for a
// persistently-failing Enoki (e.g. repeated 502s at execute — which `create`
// can't foresee): the failed request trips the circuit, and the client's
// retry then self-sponsors from `create`. The circuit auto-closes after the
// window so Enoki is retried once it recovers.
const ENOKI_CIRCUIT_MS = 60_000
let enokiUnhealthyUntil = 0
function tripEnokiCircuit(reason: string): void {
  enokiUnhealthyUntil = Date.now() + ENOKI_CIRCUIT_MS
  log.warn(
    `[sponsor] enoki circuit OPEN ${ENOKI_CIRCUIT_MS}ms — self-sponsoring: ${reason}`
  )
}
function enokiCircuitOpen(): boolean {
  return Date.now() < enokiUnhealthyUntil
}

async function handleCreate(
  network: EnokiNetwork,
  transactionKindBytes: string,
  sender: string,
  origin: string | null
): Promise<Response> {
  const enoki = getEnoki()
  let enokiFailureReason: string | null = null

  if (enoki && !enokiCircuitOpen()) {
    try {
      const result = await enoki.createSponsoredTransaction({
        network,
        transactionKindBytes,
        sender,
        allowedMoveCallTargets: buildAllowedTargets(network),
        allowedAddresses: [sender],
      })
      log.info(`[sponsor] enoki create · sender ${sender}`)
      return jsonRes(
        { bytes: result.bytes, digest: result.digest },
        200,
        origin
      )
    } catch (err) {
      enokiFailureReason = err instanceof Error ? err.message : String(err)
      tripEnokiCircuit(enokiFailureReason)
      log.warn(
        `[sponsor] enoki create failed, trying self-sponsor fallback: ${enokiFailureReason}`
      )
    }
  } else if (enoki) {
    enokiFailureReason = "enoki circuit open (recent failure) — self-sponsoring"
  } else {
    enokiFailureReason = "ENOKI_PRIVATE_KEY not configured"
  }

  const sponsorKeypair = getSponsorKeypair()
  if (!sponsorKeypair) {
    return jsonRes(
      {
        error: "Sponsor unavailable",
        detail:
          `Enoki: ${enokiFailureReason}. Self-sponsor fallback also unavailable — ` +
          "set SPONSOR_SECRET_KEY (or KEEPER_SECRET_KEY / BOT_SECRET_KEY).",
      },
      503,
      origin
    )
  }

  try {
    const result = await selfSponsorCreate(
      network,
      transactionKindBytes,
      sender,
      sponsorKeypair
    )
    log.info(
      `[sponsor] self-sponsor fallback create (enoki: ${enokiFailureReason}) · sender ${sender}`
    )
    return jsonRes(result, 200, origin)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn(`[sponsor] self-sponsor create failed: ${message}`)
    return jsonRes(
      { error: "Self-sponsor call failed", detail: message },
      502,
      origin
    )
  }
}

/**
 * `execute` decides Enoki vs. self-sponsor by digest: if `create` stashed
 * this digest in the self-sponsor store, this transaction was built and
 * sponsor-signed server-side and must be submitted directly via
 * `client.core.executeTransaction`. Otherwise it's an Enoki-created digest
 * and goes through `executeSponsoredTransaction` as before.
 */
async function handleExecute(
  digest: string,
  signature: string,
  origin: string | null
): Promise<Response> {
  if (selfSponsorStore.has(digest)) {
    try {
      const result = await selfSponsorExecute(digest, signature)
      log.info(`[sponsor] self-sponsor execute · ${result.digest}`)
      return jsonRes(result, 200, origin)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn(`[sponsor] self-sponsor execute failed: ${message}`)
      return jsonRes(
        { error: "Self-sponsor call failed", detail: message },
        502,
        origin
      )
    }
  }

  const enoki = getEnoki()
  if (!enoki) {
    return jsonRes(
      {
        error: "Sponsor unavailable",
        detail:
          "Digest not found in self-sponsor store and ENOKI_PRIVATE_KEY is not configured.",
      },
      503,
      origin
    )
  }

  try {
    const result = await enoki.executeSponsoredTransaction({
      digest,
      signature,
    })
    log.info(`[sponsor] enoki execute · ${result.digest}`)
    return jsonRes({ digest: result.digest }, 200, origin)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Trip the circuit so the client's retry self-sponsors from `create`
    // (these signed Enoki bytes can't be reused for self-sponsor — different
    // gas — so this attempt still fails, but the retry won't).
    tripEnokiCircuit(message)
    log.warn(`[sponsor] enoki execute failed: ${message}`)
    return jsonRes(
      { error: "Enoki call failed", detail: message, retryable: true },
      502,
      origin
    )
  }
}
