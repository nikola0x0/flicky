/**
 * Sponsored-transaction client helper (address-balance sponsor).
 *
 * Server (apps/server):
 *   GET  /sponsor              → { sponsor, network }
 *   POST /sponsor  { transaction, userSignature } → { digest }
 *
 * Flow (client-builds — the SDK-recommended path):
 *   1. Learn the sponsor address (GET /sponsor, cached). A failure HERE is the
 *      only fallback-eligible state (server down / unconfigured) — detected
 *      BEFORE we touch the transaction, so the original stays pristine for the
 *      wallet-paid fallback.
 *   2. Set the sponsor as gas owner with an empty gas payment (address-balance
 *      gas) and build. `build` resolves inputs + coinWithBalance intents and
 *      makes the fullnode attach the address-balance `ValidDuring` expiration.
 *   3. Player signs the FINAL bytes with their wallet (`signTransaction` — NOT
 *      signAndExecute, because the sponsor pays gas).
 *   4. POST the bytes + user signature — the server validates the policy,
 *      adds the sponsor's signature, and executes.
 *
 * If the server isn't reachable / configured (GET /sponsor throws or 503s),
 * `signAndExecuteWithSponsorOrFallback` falls back to the regular wallet-paid
 * path so the app keeps working in dev.
 */
import { toBase64 } from "@mysten/sui/utils"
import type { Transaction } from "@mysten/sui/transactions"
import type { ClientWithCoreApi } from "@mysten/sui/client"

const SPONSOR_URL =
  import.meta.env.VITE_SPONSOR_URL ?? "http://localhost:3001"

// Optional static override — skips the GET /sponsor round-trip when the
// sponsor address is known at build time. Otherwise it's fetched once.
const SPONSOR_ADDRESS_OVERRIDE = import.meta.env.VITE_SPONSOR_ADDRESS as
  | string
  | undefined

interface SignerLike {
  toSuiAddress(): string
  signTransaction(bytes: Uint8Array): Promise<{ signature: string }>
}

interface SponsorExecuteResponse {
  digest: string
}

interface FallbackSigner {
  signAndExecuteTransaction(args: { transaction: Transaction }): Promise<{
    digest: string
  }>
}

/**
 * Sentinel error thrown when the sponsor server is reachable but refuses
 * to sponsor (503 = SPONSOR_SECRET_KEY missing). The wrapper
 * `signAndExecuteWithSponsorOrFallback` treats this as one of only two errors
 * that are safe to fall back from — everything else propagates so the player
 * doesn't end up paying gas from a wallet that's supposed to only ever hold
 * dUSDC (see CLAUDE.md "Sponsored gas end-to-end").
 */
class SponsorUnconfiguredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SponsorUnconfiguredError"
  }
}

/**
 * Network-level failure (fetch threw, e.g. DNS / connection refused).
 * Also fallback-eligible in dev when the server isn't up.
 */
class SponsorUnreachableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SponsorUnreachableError"
  }
}

// Cache the sponsor address across calls. Only successful lookups are cached
// (the var is set on success only), so a transient failure retries next swipe.
let cachedSponsorAddress: string | null = null

/**
 * Resolve the sponsor's address (the gas owner the client builds against).
 * Throws `SponsorUnreachableError` / `SponsorUnconfiguredError` — both
 * fallback-eligible — when the server is down or has no sponsor key.
 */
async function getSponsorAddress(): Promise<string> {
  if (cachedSponsorAddress) return cachedSponsorAddress
  if (SPONSOR_ADDRESS_OVERRIDE) {
    cachedSponsorAddress = SPONSOR_ADDRESS_OVERRIDE
    return cachedSponsorAddress
  }
  let res: Response
  try {
    res = await fetch(`${SPONSOR_URL}/sponsor`, { method: "GET" })
  } catch (e) {
    throw new SponsorUnreachableError(
      `sponsor config unreachable: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
  if (res.status === 503) {
    const body = await res.text()
    throw new SponsorUnconfiguredError(`sponsor disabled (503): ${body}`)
  }
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`sponsor config failed: ${res.status} ${body}`)
  }
  const data = (await res.json()) as { sponsor?: string }
  if (!data.sponsor) throw new Error("sponsor config missing address")
  cachedSponsorAddress = data.sponsor
  return cachedSponsorAddress
}

/**
 * POST to /sponsor with automatic retry on 429. Server's rate-limit
 * response includes `retryMs` — we respect it (clamped to a sane range)
 * and retry up to `MAX_RETRIES` times. Other non-2xx statuses surface
 * to the caller unchanged.
 */
const MAX_RETRIES = 3
const MIN_RETRY_MS = 250
const MAX_RETRY_MS = 5_000

async function postSponsorWithRetry(body: unknown): Promise<Response> {
  let attempt = 0
  while (true) {
    const res = await fetch(`${SPONSOR_URL}/sponsor`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    if (res.status !== 429 || attempt >= MAX_RETRIES) return res
    // Read retryMs hint from body without consuming the original Response,
    // by cloning. Fall back to exponential backoff if missing/malformed.
    let retryMs = MIN_RETRY_MS * 2 ** attempt
    try {
      const txt = await res.clone().text()
      const parsed = JSON.parse(txt) as { retryMs?: number }
      if (typeof parsed.retryMs === "number" && parsed.retryMs > 0) {
        retryMs = parsed.retryMs
      }
    } catch {
      /* keep backoff default */
    }
    retryMs = Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, retryMs))
    await new Promise((r) => setTimeout(r, retryMs))
    attempt += 1
  }
}

/**
 * Try the sponsor path. If the server is down / unconfigured (detected at the
 * config step, before `tx` is touched) it throws a fallback-eligible error;
 * once past that point the transaction has been mutated with the sponsor as
 * gas owner, so any later failure propagates (a wallet-paid fallback would try
 * to sign bytes whose gas owner is the sponsor).
 */
export async function executeSponsored(
  client: ClientWithCoreApi,
  tx: Transaction,
  signer: SignerLike,
): Promise<{ digest: string }> {
  const sender = signer.toSuiAddress()

  // Fallback-eligible failures live entirely in this call — it runs before we
  // mutate `tx`, so the wrapper's fallback sees a clean transaction.
  const sponsor = await getSponsorAddress()

  // Set address-balance sponsored gas and build the final bytes. `build`
  // resolves object inputs + coinWithBalance intents (client provided) and
  // attaches the `ValidDuring` expiration the sponsor's policy requires.
  tx.setSender(sender)
  tx.setGasOwner(sponsor)
  tx.setGasPayment([])
  const bytes = await tx.build({ client })

  // Player signs the FINAL sponsored bytes. signTransaction returns
  // { signature } only — the wallet does NOT submit.
  const { signature } = await signer.signTransaction(bytes)

  const res = await postSponsorWithRetry({
    transaction: toBase64(bytes),
    userSignature: signature,
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`sponsor execute failed: ${res.status} ${body}`)
  }
  return (await res.json()) as SponsorExecuteResponse
}

/**
 * Try the sponsor path. Only fall back to wallet-paid gas when the sponsor
 * server is unconfigured (503) or unreachable (fetch threw) — those are
 * dev-only states, both detected at the config step before the transaction is
 * built with sponsor gas. For everything else (4xx, other 5xx, sponsor
 * rejected the policy, wallet refused to sign, execution failed) propagate the
 * original error rather than masking it as "No valid gas coins found", which
 * is the misleading wallet-fallback error players see when their dUSDC-only
 * zkLogin wallet has no SUI.
 */
export async function signAndExecuteWithSponsorOrFallback(
  client: ClientWithCoreApi,
  tx: Transaction,
  signer: SignerLike,
  fallback: FallbackSigner,
): Promise<{ digest: string; sponsored: boolean }> {
  try {
    const res = await executeSponsored(client, tx, signer)
    return { ...res, sponsored: true }
  } catch (e) {
    if (
      e instanceof SponsorUnconfiguredError ||
      e instanceof SponsorUnreachableError
    ) {
      console.warn(
        "[sponsor] falling back to wallet-paid gas:",
        e instanceof Error ? e.message : String(e),
      )
      const res = await fallback.signAndExecuteTransaction({ transaction: tx })
      return { digest: res.digest, sponsored: false }
    }
    console.error(
      "[sponsor] aborting (not falling back to wallet-paid gas):",
      e instanceof Error ? e.message : String(e),
    )
    throw e
  }
}
