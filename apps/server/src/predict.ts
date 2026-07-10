/**
 * DeepBook Predict reads — used by the WS balance gate (before queueing)
 * and the settle keeper (when redeeming positions).
 *
 * 6-24 model (current): a player's funding account is a deterministic
 * `account::AccountWrapper` derived from `(AccountRegistry, owner)` — see
 * `deriveWrapperFor`/`readAccountBalance` below. No event scan needed.
 *
 * 4-16 model (legacy, kept ONLY for `keeper.ts`'s not-yet-migrated
 * settle path — see progress.md Plan 2 Task 5): `PredictManager` was a
 * shared object with an internal `owner: address` field, discovered by
 * walking `PredictManagerCreated` events newest-first. Under the 6-24
 * package this event type is never emitted, so `findManagerFor` now
 * always scans an empty stream and returns null — harmless, but dead
 * weight to be deleted once `keeper.ts` moves to the account model.
 */
import type { SuiGrpcClient } from "@mysten/sui/grpc"
import { Transaction } from "@mysten/sui/transactions"
import { bcs } from "@mysten/sui/bcs"
import { normalizeSuiObjectId } from "@mysten/sui/utils"
import { env } from "./env"
import { makeLogger } from "./log"
import { getCachedManager, cacheManager } from "./db"
import { getGraphQLClient } from "./lib/sui"

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
  commandIndex = 0,
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

// Descending event scan via GraphQL (gRPC has no filtered event pagination).
// `last: 50` + `before: startCursor` walks newest-first, page by page.
const MANAGER_SCAN_QUERY = `query Scan($type: String!, $before: String) {
  events(filter: { type: $type }, last: 50, before: $before) {
    pageInfo { hasPreviousPage startCursor }
    nodes { contents { json } }
  }
}`
type ScanResult = {
  data?: {
    events?: {
      pageInfo?: { hasPreviousPage: boolean; startCursor: string | null }
      nodes?: Array<{ contents: { json: { manager_id: string; owner: string } } }>
    }
  }
}

// Safety backstop for the event scan: a manager's `PredictManagerCreated`
// event lives at a fixed depth, but testnet churn (duplicate managers per
// owner) keeps pushing it deeper. We scan until found or the stream is
// exhausted; this cap only guards against a misbehaving RPC that never
// reports `hasNextPage: false`. 5000 events ≈ the full testnet history.
const MAX_MANAGER_SCAN_PAGES = 100

/** PRD §Matchmaking: entry requires PredictManager balance ≥ 5 dUSDC. */
export const MIN_BALANCE_FOR_QUEUE = 5_000_000n // 5 dUSDC, 6 decimals

/**
 * @deprecated 6-24 legacy path, kept only for `keeper.ts` until Plan 2
 * Task 5 migrates its settle flow to the account model. Do not call this
 * from new code — use `deriveWrapperFor` instead. Shares the
 * `predict_manager` owner-cache table with `deriveWrapperFor`; that's safe
 * today only because this function's write path is now unreachable (the
 * 6-24 package never emits `PredictManagerCreated`, so the scan below
 * always exhausts to `null` and never calls `cacheManager`) — a READ-side
 * cache hit here could still return a wrapper address cached by
 * `deriveWrapperFor`, but every caller of this legacy path (`keeper.ts`)
 * already builds PTBs against the pre-6-24 `duel::settle_card` /
 * `predict::redeem_permissionless` ABI, which is itself stale against the
 * current `duel.move` and would fail regardless of which id is passed in.
 *
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
  _client: SuiGrpcClient,
  owner: string,
): Promise<string | null> {
  const cached = await getCachedManager(owner)
  if (cached) return cached
  let before: string | null = null
  // No try/catch: a query rejection propagates so the caller can tell
  // "scan failed" apart from "scanned everything, found none".
  for (let page = 0; page < MAX_MANAGER_SCAN_PAGES; page++) {
    const res = (await getGraphQLClient().query({
      query: MANAGER_SCAN_QUERY,
      variables: {
        type: `${env.deepbookPredictPackageId}::predict_manager::PredictManagerCreated`,
        before,
      },
    })) as ScanResult
    const ev = res.data?.events
    for (const node of ev?.nodes ?? []) {
      const p = node.contents.json
      if (p.owner === owner) {
        const id = normalizeSuiObjectId(p.manager_id)
        await cacheManager(owner, id)
        return id
      }
    }
    if (!ev?.pageInfo?.hasPreviousPage) return null // exhausted — authoritative
    before = ev.pageInfo.startCursor
  }
  // Ran out of page budget before reaching the end — the scan is INCOMPLETE,
  // not exhausted. Never seen at current volume (~10 pages), but we must not
  // pretend "none found".
  throw new Error(
    `findManagerFor(${owner}): scan hit ${MAX_MANAGER_SCAN_PAGES}-page cap without exhausting the event stream`,
  )
}

// ─── 6-24 account model ─────────────────────────────────────────────────
//
// A player's funding account is a deterministic `account::AccountWrapper`
// shared object derived from `(AccountRegistry, owner)` — no scan needed,
// just two devInspect reads (existence, then address), memoized the same
// way `findManagerFor` memoized manager ids.

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
 * event walk). If true, devInspect `derived_wrapper_address(registry,
 * owner)` and memoize the result.
 *
 * RETURN CONTRACT — callers depend on this (mirrors the legacy
 * `findManagerFor` contract above):
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
  owner: string,
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
    throw new Error(`deriveWrapperFor(${owner}): derived_wrapper_exists returned no value`)
  }
  if (!bcs.bool().parse(existsBytes)) return null // authoritative — no wrapper yet

  const addrBytes = await devInspectReturn(client, owner, (tx) => {
    tx.moveCall({
      target: `${env.accountPackageId}::account_registry::derived_wrapper_address`,
      arguments: [tx.object(env.accountRegistryId), tx.pure.address(owner)],
    })
  })
  if (!addrBytes) {
    throw new Error(`deriveWrapperFor(${owner}): derived_wrapper_address returned no value`)
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
  wrapper: string,
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
        arguments: [account, tx.object(env.accumulatorRootId), tx.object("0x6")],
      })
    },
    1, // the second command's return value (account::balance's u64)
  )
  if (!balanceBytes) {
    throw new Error(`readAccountBalance(${wrapper}): account::balance returned no value`)
  }
  return BigInt(bcs.u64().parse(balanceBytes))
}

export type BalanceGateResult =
  | { ok: true; wrapper: string; balance: bigint }
  | { ok: false; reason: "no_manager" }
  | { ok: false; reason: "insufficient_balance"; wrapper: string; balance: bigint }
  | { ok: false; reason: "rpc_failed"; wrapper?: string }

export async function checkQueueBalanceGate(
  client: SuiGrpcClient,
  owner: string,
): Promise<BalanceGateResult> {
  let wrapper: string | null
  try {
    wrapper = await deriveWrapperFor(client, owner)
  } catch (e) {
    // A failed lookup ≠ "no wrapper". Fail as retryable so the player is
    // told to try again, not (wrongly) that they have no funding account.
    log.warn(
      `checkQueueBalanceGate(${owner}): wrapper lookup failed: ${e instanceof Error ? e.message : String(e)}`,
    )
    return { ok: false, reason: "rpc_failed" }
  }
  if (!wrapper) return { ok: false, reason: "no_manager" }
  let balance: bigint
  try {
    balance = await readAccountBalance(client, owner, wrapper)
  } catch (e) {
    log.warn(
      `checkQueueBalanceGate(${owner}): balance read failed: ${e instanceof Error ? e.message : String(e)}`,
    )
    return { ok: false, reason: "rpc_failed", wrapper }
  }
  if (balance < MIN_BALANCE_FOR_QUEUE) {
    return { ok: false, reason: "insufficient_balance", wrapper, balance }
  }
  return { ok: true, wrapper, balance }
}
