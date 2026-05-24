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

const log = makeLogger("predict")

/** PRD §Matchmaking: entry requires PredictManager balance ≥ 5 dUSDC. */
export const MIN_BALANCE_FOR_QUEUE = 5_000_000n // 5 dUSDC, 6 decimals

export async function findManagerFor(
  client: SuiClient,
  owner: string,
): Promise<string | null> {
  try {
    let cursor: { txDigest: string; eventSeq: string } | null | undefined = null
    for (let page = 0; page < 5; page++) {
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
        if (p.owner === owner) return normalizeSuiObjectId(p.manager_id)
      }
      if (!evts.hasNextPage) break
      cursor = evts.nextCursor
    }
    return null
  } catch (e) {
    log.warn(`findManagerFor(${owner}): ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
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
  const managerId = await findManagerFor(client, owner)
  if (!managerId) return { ok: false, reason: "no_manager" }
  const balance = await readManagerBalance(client, owner, managerId)
  if (balance === null) return { ok: false, reason: "rpc_failed", managerId }
  if (balance < MIN_BALANCE_FOR_QUEUE) {
    return { ok: false, reason: "insufficient_balance", managerId, balance }
  }
  return { ok: true, managerId, balance }
}
