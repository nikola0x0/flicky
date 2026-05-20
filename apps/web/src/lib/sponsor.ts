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

  const createRes = await fetch(`${SPONSOR_URL}/sponsor`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "create",
      network: NETWORK,
      transactionKindBytes: toBase64(kindBytes),
      sender,
    }),
  })
  if (!createRes.ok) {
    const body = await createRes.text()
    throw new Error(`sponsor create failed: ${createRes.status} ${body}`)
  }
  const { bytes, digest } = (await createRes.json()) as SponsorCreateResponse

  // Player signs the sponsored bytes with their wallet. signTransaction
  // returns { signature } only — wallet does NOT submit.
  const { signature } = await signer.signTransaction(fromBase64(bytes))

  const execRes = await fetch(`${SPONSOR_URL}/sponsor`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "execute", digest, signature }),
  })
  if (!execRes.ok) {
    const body = await execRes.text()
    throw new Error(`sponsor execute failed: ${execRes.status} ${body}`)
  }
  return (await execRes.json()) as SponsorExecuteResponse
}

/**
 * Convenience: try the sponsor path; if it 503s (server unconfigured)
 * or the network call fails, fall back to wallet-paid signAndExecute.
 * Lets the rest of the app use one entrypoint regardless of whether
 * Enoki is wired.
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
  } catch {
    const res = await fallback.signAndExecuteTransaction({ transaction: tx })
    return { digest: res.digest, sponsored: false }
  }
}
