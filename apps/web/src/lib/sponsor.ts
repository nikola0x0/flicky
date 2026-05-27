/**
 * Sponsored-transaction client helper.
 *
 * Server pairs (POST /sponsor on apps/server):
 *   { action: "create",  network, transactionKindBytes, sender }
 *     → { bytes, digest }
 *   { action: "execute", digest, signature }
 *     → { digest }
 *
 * The flow is:
 *   1. Build the PTB normally.
 *   2. Serialize JUST the transaction kind (no gas) via
 *      `tx.build({ onlyTransactionKind: true })`.
 *   3. POST to /sponsor create — server adds Enoki sponsor + gas, returns
 *      the full transaction bytes + digest.
 *   4. Player signs those bytes with their wallet (`signTransaction` — NOT
 *      signAndExecute, because the sponsor pays gas).
 *   5. POST signature back to /sponsor execute — server submits to Sui.
 *
 * If the server isn't configured (ENOKI_PRIVATE_KEY missing → /sponsor
 * returns 503), `signAndExecuteWithSponsorOrFallback` falls back to the
 * regular wallet-paid path so the app keeps working.
 */
import { toBase64, fromBase64 } from "@mysten/sui/utils"
import type { Transaction } from "@mysten/sui/transactions"
import type { SuiJsonRpcClient } from "@mysten/sui/jsonRpc"

const SPONSOR_URL =
  import.meta.env.VITE_SPONSOR_URL ?? "http://localhost:3001"

type Network = "testnet" | "mainnet"
const NETWORK = (import.meta.env.VITE_SUI_NETWORK ?? "testnet") as Network

interface SignerLike {
  toSuiAddress(): string
  signTransaction(bytes: Uint8Array): Promise<{ signature: string }>
}

interface SponsorCreateResponse {
  bytes: string
  digest: string
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
 * to sponsor (typically 503 = ENOKI_PRIVATE_KEY missing). The wrapper
 * `signAndExecuteWithSponsorOrFallback` treats this as the only error
 * that's safe to fall back from — everything else propagates so the
 * player doesn't end up paying gas from a wallet that's supposed to
 * only ever hold dUSDC (see CLAUDE.md "Sponsored gas end-to-end").
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
    let res: Response
    try {
      res = await fetch(`${SPONSOR_URL}/sponsor`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    } catch (e) {
      throw new SponsorUnreachableError(
        `sponsor unreachable: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
    if (res.status !== 429 || attempt >= MAX_RETRIES) return res
    // Read retryMs hint from body without consuming the original Response,
    // by cloning. Fallback to expontial backoff if missing/malformed.
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
 * Try the sponsor path. If the server isn't available or returns a
 * non-2xx, throws — callers can catch and fall back to wallet-pay.
 */
export async function executeSponsored(
  client: SuiJsonRpcClient,
  tx: Transaction,
  signer: SignerLike,
): Promise<{ digest: string }> {
  const sender = signer.toSuiAddress()
  const kindBytes = await tx.build({ client, onlyTransactionKind: true })

  const createRes = await postSponsorWithRetry({
    action: "create",
    network: NETWORK,
    transactionKindBytes: toBase64(kindBytes),
    sender,
  })
  if (createRes.status === 503) {
    const body = await createRes.text()
    throw new SponsorUnconfiguredError(`sponsor disabled (503): ${body}`)
  }
  if (!createRes.ok) {
    const body = await createRes.text()
    throw new Error(`sponsor create failed: ${createRes.status} ${body}`)
  }
  const { bytes, digest } = (await createRes.json()) as SponsorCreateResponse

  // Player signs the sponsored bytes with their wallet. signTransaction
  // returns { signature } only — wallet does NOT submit.
  const { signature } = await signer.signTransaction(fromBase64(bytes))

  const execRes = await postSponsorWithRetry({
    action: "execute",
    digest,
    signature,
  })
  if (!execRes.ok) {
    const body = await execRes.text()
    throw new Error(`sponsor execute failed: ${execRes.status} ${body}`)
  }
  return (await execRes.json()) as SponsorExecuteResponse
}

/**
 * Try the sponsor path. Only fall back to wallet-paid gas when the
 * sponsor server is unconfigured (503) or unreachable (fetch threw) —
 * those are dev-only states. For everything else (4xx, 5xx that isn't
 * 503, sponsor returned bad bytes, wallet refused to sign sponsored
 * bytes, etc.) propagate the original error rather than masking it as
 * "No valid gas coins found", which is the misleading wallet-fallback
 * error players see when their dUSDC-only zkLogin wallet has no SUI.
 */
export async function signAndExecuteWithSponsorOrFallback(
  client: SuiJsonRpcClient,
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
