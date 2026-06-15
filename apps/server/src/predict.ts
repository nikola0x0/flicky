/**
 * DeepBook Predict reads — used by the WS balance gate (before queueing)
 * and the settle keeper (when redeeming positions). Both need to look up
 * a player's PredictManager + its dUSDC balance.
 *
 * `PredictManager` is a shared object with an internal `owner: address`
 * field, so we can't enumerate via `getOwnedObjects`. Instead we walk
 * `PredictManagerCreated` events newest-first and match the `owner`
 * field. Mirrors the web client's `findPredictManager`.
 */
import type { SuiClient } from "@mysten/sui/client"
import { Transaction } from "@mysten/sui/transactions"
import { bcs } from "@mysten/sui/bcs"
import { normalizeSuiObjectId } from "@mysten/sui/utils"
import { env } from "./env"
import { makeLogger } from "./log"
import { getCachedManager, cacheManager } from "./db"

const log = makeLogger("predict")

// Safety backstop for the event scan: a manager's `PredictManagerCreated`
// event lives at a fixed depth, but testnet churn (duplicate managers per
// owner) keeps pushing it deeper. We scan until found or the stream is
// exhausted; this cap only guards against a misbehaving RPC that never
// reports `hasNextPage: false`. 5000 events ≈ the full testnet history.
const MAX_MANAGER_SCAN_PAGES = 100

/** PRD §Matchmaking: entry requires PredictManager balance ≥ 5 dUSDC. */
export const MIN_BALANCE_FOR_QUEUE = 5_000_000n // 5 dUSDC, 6 decimals

/**
 * Resolve the PredictManager logically owned by `owner`.
 *
 * Fast path: a persistent SQLite cache (owner → manager_id). Manager ids
 * are permanent, so a hit is authoritative and skips all RPC.
 *
 * Slow path (cache miss): walk `PredictManagerCreated` events newest-first
 * until we match `owner` or the stream is exhausted, then memoize. The scan
 * is deliberately UNBOUNDED — an earlier 250-event cap silently dropped
 * managers older than the window, so the keeper and queue gate reported
 * "missing manager" for players whose manager was simply buried under newer
 * (often duplicate) creations.
 *
 * RETURN CONTRACT — callers depend on this:
 *   - string  → found.
 *   - null    → AUTHORITATIVE "no manager": we paged to the end of the
 *               stream (`hasNextPage === false`) without a match.
 *   - throws  → the scan could NOT be completed (RPC error, or it hit the
 *               page cap before exhausting). Callers MUST NOT treat this as
 *               "no manager" — doing so lets a transient RPC blip read as a
 *               missing manager, and the web bootstrap would mint a
 *               duplicate (the very churn that buried managers to begin
 *               with). Surface a retryable error instead.
 */
export async function findManagerFor(
  client: SuiClient,
  owner: string,
): Promise<string | null> {
  const cached = await getCachedManager(owner)
  if (cached) return cached
  let cursor: { txDigest: string; eventSeq: string } | null | undefined = null
  // No try/catch: a queryEvents rejection propagates so the caller can tell
  // "scan failed" apart from "scanned everything, found none".
  for (let page = 0; page < MAX_MANAGER_SCAN_PAGES; page++) {
    const evts = await client.queryEvents({
      query: {
        MoveEventType: `${env.deepbookPredictPackageId}::predict_manager::PredictManagerCreated`,
      },
      limit: 50,
      order: "descending",
      cursor,
    })
    for (const e of evts.data) {
      const p = e.parsedJson as { manager_id: string; owner: string }
      if (p.owner === owner) {
        const id = normalizeSuiObjectId(p.manager_id)
        await cacheManager(owner, id)
        return id
      }
    }
    if (!evts.hasNextPage) return null // scanned the whole stream — authoritative
    cursor = evts.nextCursor
  }
  // Ran out of page budget before reaching the end — the scan is INCOMPLETE,
  // not exhausted. Never seen at current volume (~10 pages), but we must not
  // pretend "none found".
  throw new Error(
    `findManagerFor(${owner}): scan hit ${MAX_MANAGER_SCAN_PAGES}-page cap without exhausting the event stream`,
  )
}

/**
 * Read a PredictManager's dUSDC balance via devInspect — no signing /
 * gas required, but the sender address must be syntactically valid (we
 * pass the owner's address so the call looks natural in traces).
 *
 * Returns null if the call fails for any reason; callers decide whether
 * to fail open or closed.
 */
export async function readManagerBalance(
  client: SuiClient,
  address: string,
  managerId: string,
): Promise<bigint | null> {
  try {
    const tx = new Transaction()
    tx.moveCall({
      target: `${env.deepbookPredictPackageId}::predict_manager::balance`,
      typeArguments: [env.dusdcCoinType],
      arguments: [tx.object(managerId)],
    })
    const res = await client.devInspectTransactionBlock({
      sender: address,
      transactionBlock: tx,
    })
    const ret = res.results?.[0]?.returnValues?.[0]
    if (!ret) return null
    return BigInt(bcs.u64().parse(new Uint8Array(ret[0])))
  } catch (e) {
    log.warn(`readManagerBalance(${managerId}): ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

export type BalanceGateResult =
  | { ok: true; managerId: string; balance: bigint }
  | { ok: false; reason: "no_manager" }
  | { ok: false; reason: "insufficient_balance"; managerId: string; balance: bigint }
  | { ok: false; reason: "rpc_failed"; managerId?: string }

export async function checkQueueBalanceGate(
  client: SuiClient,
  owner: string,
): Promise<BalanceGateResult> {
  let managerId: string | null
  try {
    managerId = await findManagerFor(client, owner)
  } catch (e) {
    // Incomplete scan ≠ "no manager". Fail as retryable so the player is
    // told to try again, not (wrongly) that they have no PredictManager.
    log.warn(
      `checkQueueBalanceGate(${owner}): manager lookup failed: ${e instanceof Error ? e.message : String(e)}`,
    )
    return { ok: false, reason: "rpc_failed" }
  }
  if (!managerId) return { ok: false, reason: "no_manager" }
  const balance = await readManagerBalance(client, owner, managerId)
  if (balance === null) return { ok: false, reason: "rpc_failed", managerId }
  if (balance < MIN_BALANCE_FOR_QUEUE) {
    return { ok: false, reason: "insufficient_balance", managerId, balance }
  }
  return { ok: true, managerId, balance }
}
