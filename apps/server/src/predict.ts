/**
 * DeepBook Predict reads — used by the WS balance gate (before queueing)
 * and the settle keeper (when redeeming positions).
 *
 * 6-24 model (current, only model left in this file): a player's funding
 * account is a deterministic `account::AccountWrapper` derived from
 * `(AccountRegistry, owner)` — see `deriveWrapperFor`/`readAccountBalance`
 * below. No event scan needed.
 *
 * The 4-16 `findManagerFor` (walked `PredictManagerCreated` events to
 * resolve a legacy `PredictManager` shared object) was deleted in Plan 2
 * Task 6 — `keeper.ts` fully migrated to the account model in Task 5, and
 * grep confirmed no remaining importers. The `predict_manager` Postgres
 * table is still live: it's reused as the owner→wrapper cache for
 * `deriveWrapperFor` below.
 */
import type { SuiGrpcClient } from "@mysten/sui/grpc"
import { Transaction } from "@mysten/sui/transactions"
import { bcs } from "@mysten/sui/bcs"
import { normalizeSuiObjectId } from "@mysten/sui/utils"
import { env } from "./env"
import { makeLogger } from "./log"
import { getCachedManager, cacheManager } from "./db"

const log = makeLogger("predict")

/**
 * Run a devInspect PTB and return the raw BCS bytes of one command's first
 * return value (`commandIndex` selects which command in a chained PTB,
 * default the only/first one).
 *
 * Single call site for `client.core.simulateTransaction` in this file: the
 * gRPC client's TS surface doesn't (yet) declare that method, so it's a
 * pre-existing baseline typecheck error (see progress.md). Routing every
 * devInspect through here keeps that at exactly one diagnostic no matter
 * how many devInspect call sites this file grows — don't inline a second
 * `client.core.simulateTransaction` call elsewhere.
 */
async function devInspectReturn(
  client: SuiGrpcClient,
  sender: string,
  build: (tx: Transaction) => void,
  commandIndex = 0
): Promise<Uint8Array | undefined> {
  const tx = new Transaction()
  build(tx)
  tx.setSender(sender)
  const res = await client.core.simulateTransaction({
    transaction: tx,
    include: { commandResults: true },
  })
  return res.commandResults?.[commandIndex]?.returnValues?.[0]?.bcs
}

/** PRD §Matchmaking: entry requires PredictManager balance ≥ 5 dUSDC. */
export const MIN_BALANCE_FOR_QUEUE = 5_000_000n // 5 dUSDC, 6 decimals

// ─── 6-24 account model ─────────────────────────────────────────────────
//
// A player's funding account is a deterministic `account::AccountWrapper`
// shared object derived from `(AccountRegistry, owner)` — no event scan
// needed, just two devInspect reads (existence, then address), memoized
// in the same `predict_manager` Postgres table the deleted 4-16
// `findManagerFor` used to populate.

/**
 * Resolve the `AccountWrapper` address logically owned by `owner`.
 *
 * Fast path: a persistent Postgres cache (owner → wrapper address). The
 * wrapper address is deterministic and permanent once derived, so a hit
 * is authoritative and skips all RPC.
 *
 * Slow path (cache miss): devInspect `derived_wrapper_exists(registry,
 * owner)`. If false, the registry has no wrapper for this owner yet —
 * that's authoritative (no unbounded scan involved, unlike the legacy
 * 4-16 event walk this replaced). If true, devInspect
 * `derived_wrapper_address(registry, owner)` and memoize the result.
 *
 * RETURN CONTRACT — callers depend on this:
 *   - string  → found (derived and, since `exists` was true, live on-chain).
 *   - null    → AUTHORITATIVE "no wrapper yet": `derived_wrapper_exists`
 *               returned false.
 *   - throws  → a devInspect call could NOT be completed (RPC error).
 *               Callers MUST NOT treat this as "no wrapper" — that would
 *               let a transient RPC blip read as "player has no account"
 *               and risk the web bootstrap racing a duplicate setup.
 */
export async function deriveWrapperFor(
  client: SuiGrpcClient,
  owner: string
): Promise<string | null> {
  const cached = await getCachedManager(owner)
  if (cached) return cached

  // No try/catch: a devInspect rejection propagates so the caller can
  // tell "lookup failed" apart from "registry says no wrapper".
  const existsBytes = await devInspectReturn(client, owner, (tx) => {
    tx.moveCall({
      target: `${env.accountPackageId}::account_registry::derived_wrapper_exists`,
      arguments: [tx.object(env.accountRegistryId), tx.pure.address(owner)],
    })
  })
  if (!existsBytes) {
    throw new Error(
      `deriveWrapperFor(${owner}): derived_wrapper_exists returned no value`
    )
  }
  if (!bcs.bool().parse(existsBytes)) return null // authoritative — no wrapper yet

  const addrBytes = await devInspectReturn(client, owner, (tx) => {
    tx.moveCall({
      target: `${env.accountPackageId}::account_registry::derived_wrapper_address`,
      arguments: [tx.object(env.accountRegistryId), tx.pure.address(owner)],
    })
  })
  if (!addrBytes) {
    throw new Error(
      `deriveWrapperFor(${owner}): derived_wrapper_address returned no value`
    )
  }
  const wrapper = normalizeSuiObjectId(bcs.Address.parse(addrBytes))
  await cacheManager(owner, wrapper)
  return wrapper
}

/**
 * Read an AccountWrapper's dUSDC balance via devInspect — no signing /
 * gas required, but the sender address must be syntactically valid (we
 * pass the owner's address so the call looks natural in traces).
 *
 * Chains `account::load_account(wrapper)` → `account::balance<DUSDC>(<that>,
 * accumulatorRoot, clock)` in a single PTB (the second command consumes
 * the first's `&Account` result). Throws on any devInspect failure —
 * callers decide how to handle that (see `checkQueueBalanceGate`).
 */
export async function readAccountBalance(
  client: SuiGrpcClient,
  address: string,
  wrapper: string
): Promise<bigint> {
  const balanceBytes = await devInspectReturn(
    client,
    address,
    (tx) => {
      const account = tx.moveCall({
        target: `${env.accountPackageId}::account::load_account`,
        arguments: [tx.object(wrapper)],
      })
      tx.moveCall({
        target: `${env.accountPackageId}::account::balance`,
        typeArguments: [env.dusdcCoinType],
        arguments: [
          account,
          tx.object(env.accumulatorRootId),
          tx.object("0x6"),
        ],
      })
    },
    1 // the second command's return value (account::balance's u64)
  )
  if (!balanceBytes) {
    throw new Error(
      `readAccountBalance(${wrapper}): account::balance returned no value`
    )
  }
  return BigInt(bcs.u64().parse(balanceBytes))
}

export type BalanceGateResult =
  | { ok: true; wrapper: string; balance: bigint }
  | { ok: false; reason: "no_manager" }
  | {
      ok: false
      reason: "insufficient_balance"
      wrapper: string
      balance: bigint
    }
  | { ok: false; reason: "rpc_failed"; wrapper?: string }

export async function checkQueueBalanceGate(
  client: SuiGrpcClient,
  owner: string
): Promise<BalanceGateResult> {
  let wrapper: string | null
  try {
    wrapper = await deriveWrapperFor(client, owner)
  } catch (e) {
    // A failed lookup ≠ "no wrapper". Fail as retryable so the player is
    // told to try again, not (wrongly) that they have no funding account.
    log.warn(
      `checkQueueBalanceGate(${owner}): wrapper lookup failed: ${e instanceof Error ? e.message : String(e)}`
    )
    return { ok: false, reason: "rpc_failed" }
  }
  if (!wrapper) return { ok: false, reason: "no_manager" }
  let balance: bigint
  try {
    balance = await readAccountBalance(client, owner, wrapper)
  } catch (e) {
    log.warn(
      `checkQueueBalanceGate(${owner}): balance read failed: ${e instanceof Error ? e.message : String(e)}`
    )
    return { ok: false, reason: "rpc_failed", wrapper }
  }
  if (balance < MIN_BALANCE_FOR_QUEUE) {
    return { ok: false, reason: "insufficient_balance", wrapper, balance }
  }
  return { ok: true, wrapper, balance }
}
