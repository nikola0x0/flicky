/**
 * Web-side helpers for the flicky duel flow. Thin wrappers around generated
 * codegen bindings + JSON parsers for shared-object reads.
 *
 * Every duel references a DeepBook `OracleSVI` directly — there's no
 * FlickyOracle path anymore. Staked swipes (predict::mint + record_swipe in
 * one PTB) live in `./deepbook.ts`.
 */
import { Transaction } from "@mysten/sui/transactions"
import type { SuiJsonRpcClient, SuiObjectResponse } from "@mysten/sui/jsonRpc"
import { bcs } from "@mysten/sui/bcs"
import { normalizeSuiObjectId, normalizeSuiAddress } from "@mysten/sui/utils"

type SuiClient = SuiJsonRpcClient

import * as duelGen from "@/sui/gen/flicky/duel"
import { CONFIG } from "./config"
import { DEEPBOOK } from "./deepbook"

const { packageId, deepbookPredictPackageId } = CONFIG

// === Types ===

// Sub-shapes of DuelState. Kept as named internal aliases for readability;
// reachable externally via the structural shape of `DuelState` itself.
type DuelStatus = "PENDING" | "ACTIVE" | "COMPLETE"

interface DuelCard {
  oracleId: string
  strike: bigint
}

interface DuelSwipe {
  isUp: boolean
  pSwiped: bigint
  decideTimeMs: bigint
}

export interface DuelState {
  id: string
  /** Coin type used for this duel's stake — e.g. "0x2::sui::SUI" or dUSDC. */
  stakeCoinType: string
  status: DuelStatus
  creator: string
  challenger: string
  /** sha2-256 commitment over the deck, "0x"-prefixed lowercase hex.
   *  Used to fetch plaintext from `/deckmaster/reveal?hash=…` for the
   *  client-side reveal fallback. */
  deckHashHex: string
  cards: DuelCard[]
  p0Stake: bigint
  p1Stake: bigint
  p0Score: bigint
  p1Score: bigint
  p0NextCardIdx: bigint
  p1NextCardIdx: bigint
  settledCount: bigint
  startedAtMs: bigint
  /** Baseline for the NEXT swipe's decide-time clock — last swipe time
   *  for that player, or `startedAtMs` if no swipes yet. */
  p0LastSwipeOrStartMs: bigint
  p1LastSwipeOrStartMs: bigint
  p0Swipes: (DuelSwipe | null)[]
  p1Swipes: (DuelSwipe | null)[]
  cardSettlements: (bigint | null)[]
}

const STATUS_MAP: Record<string, DuelStatus> = {
  "1": "PENDING",
  "2": "ACTIVE",
  "3": "COMPLETE",
}

// === Deck commit-reveal helpers ===

export interface DeckCard {
  oracleId: string
  strike: bigint
}

/**
 * BCS schema matching the on-chain `flicky::duel::Card` layout
 * (`oracle_id: ID, strike: u64`). The vector serialization + sha2-256
 * here must reproduce what `bcs::to_bytes(&cards)` + `hash::sha2_256`
 * produce in Move — see `apps/contracts/sources/duel.move::reveal_deck`.
 */
const CardBcs = bcs.struct("Card", {
  oracle_id: bcs.Address,
  strike: bcs.u64(),
})
const DeckBcs = bcs.vector(CardBcs)

function serializeDeck(cards: DeckCard[]): Uint8Array {
  return DeckBcs.serialize(
    cards.map((c) => ({
      oracle_id: normalizeSuiAddress(c.oracleId),
      strike: c.strike.toString(),
    })),
  ).toBytes()
}

/** SHA-256 of the BCS-encoded deck. Used as `deck_hash` in create_duel. */
export async function computeDeckHash(cards: DeckCard[]): Promise<Uint8Array> {
  const bytes = serializeDeck(cards)
  // Wrap into a fresh ArrayBuffer so TS doesn't complain about the
  // SharedArrayBuffer-vs-ArrayBuffer type widening on Uint8Array.
  const buf = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buf).set(bytes)
  const digest = await crypto.subtle.digest("SHA-256", buf)
  return new Uint8Array(digest)
}

// === PTB builders ===
//
// The free-tier flow uses gas-paid SUI as stake. The staked-tier flow uses
// dUSDC from a PredictManager and additionally bundles a `predict::mint`
// call per swipe — see `./deepbook.ts` for that.

/**
 * Create a duel by committing the deck's sha2-256 hash. The plaintext
 * stays off-chain until `buildRevealDeckTx` runs after the challenger
 * joins. Anti-front-run guarantee.
 */
export function buildCreateDuelTx(
  deckHash: Uint8Array,
  stakeAmount: bigint,
  stakeCoinType: string = CONFIG.stakeType,
): Transaction {
  if (deckHash.length !== 32) throw new Error("deck hash must be 32 bytes (sha-256)")

  const tx = new Transaction()
  const [stake] = tx.splitCoins(tx.gas, [tx.pure.u64(stakeAmount)])

  tx.add(
    duelGen.createDuel({
      package: packageId,
      arguments: [stake, tx.pure.vector("u8", Array.from(deckHash))],
      typeArguments: [stakeCoinType],
    }),
  )
  return tx
}

/**
 * Reveal the previously-committed deck. Permissionless — any address can
 * call. Contract verifies sha2_256(bcs(cards)) == duel.deck_hash.
 */
export function buildRevealDeckTx(
  duelId: string,
  cards: DeckCard[],
  stakeCoinType: string = CONFIG.stakeType,
): Transaction {
  if (cards.length !== 5) throw new Error("must reveal exactly 5 cards")
  const tx = new Transaction()

  const cardArgs = cards.map((c) =>
    tx.add(
      duelGen.newCard({
        package: packageId,
        arguments: [c.oracleId, c.strike],
      }),
    ),
  )
  tx.add(
    duelGen.revealDeck({
      package: packageId,
      arguments: [
        duelId,
        tx.makeMoveVec({ type: `${packageId}::duel::Card`, elements: cardArgs }),
      ],
      typeArguments: [stakeCoinType],
    }),
  )
  return tx
}

/**
 * Source `amount` of `coinType` from the owner's coin objects: merge them
 * all into the first coin then split off `amount`. Used for create / join
 * paths when the stake isn't SUI (we can't `splitCoins(tx.gas)` for a
 * non-gas coin).
 */
async function takeCoinFromOwner(
  client: SuiClient,
  tx: Transaction,
  owner: string,
  coinType: string,
  amount: bigint,
) {
  const coins = await client.getCoins({ owner, coinType })
  if (coins.data.length === 0) {
    throw new Error(`no ${coinType} coins in wallet ${owner}`)
  }
  const [primary, ...rest] = coins.data.map((c) => tx.object(c.coinObjectId))
  if (rest.length > 0) tx.mergeCoins(primary, rest)
  const [taken] = tx.splitCoins(primary, [tx.pure.u64(amount)])
  return taken
}

/**
 * Staked-tier create: same as `buildCreateDuelTx` but the stake is
 * sourced from the owner's `stakeCoinType` coin objects (e.g. dUSDC)
 * instead of split off `tx.gas`. PRD §Staked tier.
 */
export async function buildCreateDuelDusdcTx(
  client: SuiClient,
  owner: string,
  deckHash: Uint8Array,
  stakeAmount: bigint,
  stakeCoinType: string,
): Promise<Transaction> {
  if (deckHash.length !== 32) throw new Error("deck hash must be 32 bytes (sha-256)")
  const tx = new Transaction()
  const stake = await takeCoinFromOwner(client, tx, owner, stakeCoinType, stakeAmount)
  tx.add(
    duelGen.createDuel({
      package: packageId,
      arguments: [stake, tx.pure.vector("u8", Array.from(deckHash))],
      typeArguments: [stakeCoinType],
    }),
  )
  return tx
}

/** Staked-tier join — same difference as buildCreateDuelDusdcTx. */
export async function buildJoinDuelDusdcTx(
  client: SuiClient,
  owner: string,
  duelId: string,
  stakeAmount: bigint,
  stakeCoinType: string,
): Promise<Transaction> {
  const tx = new Transaction()
  const stake = await takeCoinFromOwner(client, tx, owner, stakeCoinType, stakeAmount)
  tx.add(
    duelGen.joinDuel({
      package: packageId,
      arguments: [duelId, stake],
      typeArguments: [stakeCoinType],
    }),
  )
  return tx
}

/** Challenger joins an existing PENDING duel, matching the creator's stake. */
export function buildJoinDuelTx(
  duelId: string,
  stakeAmount: bigint,
  stakeCoinType: string = CONFIG.stakeType,
): Transaction {
  const tx = new Transaction()
  const [stake] = tx.splitCoins(tx.gas, [tx.pure.u64(stakeAmount)])

  tx.add(
    duelGen.joinDuel({
      package: packageId,
      // Clock arg is auto-injected by codegen.
      arguments: [duelId, stake],
      typeArguments: [stakeCoinType],
    }),
  )
  return tx
}

/**
 * Record a single swipe on the next card in the player's sequence.
 *
 * The new contract requires the player to already hold a Predict
 * position at `manager` for the (oracle, strike, is_up) combination —
 * `record_swipe` verifies `position(manager, key) >= quantity`. In
 * practice this is wired by `buildStakedSwipeTx` in `lib/deepbook.ts`
 * which bundles `predict::mint` + `duel::record_swipe` in one PTB. This
 * standalone helper is for tests / scripts that want just the swipe
 * step against a manager that already has the position.
 */
export function buildSwipeTx(args: {
  duelId: string
  managerId: string
  oracleId: string
  cardIdx: number
  isUp: boolean
  quantity: bigint
  stakeCoinType?: string
}): Transaction {
  const tx = new Transaction()
  // Contract snapshots premium + p_swiped on-chain via get_trade_amounts,
  // so we pass the Predict shared object + oracle + quantity (no premium).
  tx.add(
    duelGen.recordSwipe({
      package: packageId,
      arguments: [
        args.duelId,
        args.managerId,
        DEEPBOOK.predictObject,
        args.oracleId,
        args.cardIdx,
        args.isUp,
        args.quantity,
      ],
      typeArguments: [args.stakeCoinType ?? CONFIG.stakeType],
    }),
  )
  return tx
}

/**
 * Finalize a duel in a single PTB. The contract scores all 5 cards
 * one-shot — there is no per-card settle step. `finalize_multi` validates
 * each card against its own oracle's settlement_price and reads both
 * players' PredictManagers for anti-replay, so all 5 oracles must be
 * settled and both managers resolved before calling.
 */
export function buildFinalizeTx(
  duelId: string,
  cards: DuelCard[],
  p0Manager: string,
  p1Manager: string,
  stakeCoinType: string = CONFIG.stakeType,
): Transaction {
  if (cards.length !== 5) throw new Error("expected 5 cards to finalize")
  const tx = new Transaction()
  tx.add(
    duelGen.finalizeMulti({
      package: packageId,
      arguments: [
        duelId,
        p0Manager,
        p1Manager,
        cards[0].oracleId,
        cards[1].oracleId,
        cards[2].oracleId,
        cards[3].oracleId,
        cards[4].oracleId,
      ],
      typeArguments: [stakeCoinType],
    }),
  )
  return tx
}

// === Reads ===

interface MoveFieldWrapper<T> {
  type: string
  fields: T
}

interface RawDuelFields {
  id: { id: string }
  status: string | number
  deck_hash: number[] | string
  cards: Array<MoveFieldWrapper<{ oracle_id: string; strike: string }>>
  creator: string
  challenger: string
  p0_stake: MoveFieldWrapper<{ value: string }> | string
  p1_stake: MoveFieldWrapper<{ value: string }> | string
  p0_score: string
  p1_score: string
  p0_next_card_idx: string
  p1_next_card_idx: string
  p0_last_swipe_or_start_ms: string
  p1_last_swipe_or_start_ms: string
  settled_count: string
  started_at_ms: string
  // Sui's JSON-RPC unwraps `Option<T>`: `Some(x)` ⇒ x, `None` ⇒ null.
  card_settlements: Array<string | null>
  p0_swipes: Array<RawSwipe | null>
  p1_swipes: Array<RawSwipe | null>
}

interface RawSwipe {
  type?: string
  fields: { is_up: boolean; p_swiped: string; decide_time_ms: string }
}

function balanceValue(b: MoveFieldWrapper<{ value: string }> | string): bigint {
  if (typeof b === "string") return BigInt(b)
  return BigInt(b.fields.value)
}

function parseSwipe(raw: RawSwipe | null): DuelSwipe | null {
  if (raw === null) return null
  const f = raw.fields
  return {
    isUp: f.is_up,
    pSwiped: BigInt(f.p_swiped),
    decideTimeMs: BigInt(f.decide_time_ms),
  }
}

export function parseDuel(obj: SuiObjectResponse): DuelState {
  if (obj.data?.content?.dataType !== "moveObject") {
    throw new Error("not a Move object")
  }
  const fields = obj.data.content.fields as unknown as RawDuelFields
  const cards = fields.cards.map((c) => ({
    oracleId: normalizeSuiObjectId(c.fields.oracle_id),
    strike: BigInt(c.fields.strike),
  }))
  // Extract the duel's stake coin type from the object type string.
  // e.g. "0xpkg::duel::Duel<0x2::sui::SUI>"  →  "0x2::sui::SUI"
  const typeMatch = obj.data.type?.match(/Duel<(.+)>$/)
  const stakeCoinType = typeMatch?.[1] ?? CONFIG.stakeType
  // Sui RPC returns vector<u8> either as number[] or a hex string.
  const deckHashHex =
    typeof fields.deck_hash === "string"
      ? fields.deck_hash.toLowerCase().startsWith("0x")
        ? fields.deck_hash.toLowerCase()
        : "0x" + fields.deck_hash.toLowerCase()
      : "0x" +
        fields.deck_hash.map((b) => b.toString(16).padStart(2, "0")).join("")
  return {
    id: normalizeSuiObjectId(fields.id.id),
    stakeCoinType,
    status: STATUS_MAP[String(fields.status)] ?? "PENDING",
    creator: fields.creator,
    challenger: fields.challenger,
    deckHashHex,
    cards,
    p0Stake: balanceValue(fields.p0_stake),
    p1Stake: balanceValue(fields.p1_stake),
    p0Score: BigInt(fields.p0_score),
    p1Score: BigInt(fields.p1_score),
    p0NextCardIdx: BigInt(fields.p0_next_card_idx),
    p1NextCardIdx: BigInt(fields.p1_next_card_idx),
    settledCount: BigInt(fields.settled_count),
    startedAtMs: BigInt(fields.started_at_ms),
    p0LastSwipeOrStartMs: BigInt(fields.p0_last_swipe_or_start_ms),
    p1LastSwipeOrStartMs: BigInt(fields.p1_last_swipe_or_start_ms),
    p0Swipes: fields.p0_swipes.map(parseSwipe),
    p1Swipes: fields.p1_swipes.map(parseSwipe),
    cardSettlements: fields.card_settlements.map((s) =>
      s === null ? null : BigInt(s),
    ),
  }
}

export async function fetchDuel(
  client: SuiClient,
  duelId: string,
): Promise<DuelState> {
  const obj = await client.getObject({
    id: duelId,
    options: { showContent: true, showType: true },
  })
  return parseDuel(obj)
}

/**
 * Resolve the Duel object id from a `create_duel` transaction digest.
 *
 * The sponsored-gas path returns only `{ digest }` — `objectChanges` is
 * NOT in that response. Callers that need the new Duel's id must wait
 * for the tx to be indexed and re-fetch it with `showObjectChanges`.
 *
 * Returns null if the tx didn't produce a Duel object (e.g. it failed,
 * was on a different package, or the indexer hasn't caught up despite
 * `waitForTransaction`). Callers should treat null as a retryable
 * lookup state, not a hard failure.
 */
export async function resolveCreatedDuelId(
  client: SuiClient,
  digest: string,
): Promise<string | null> {
  await client.waitForTransaction({ digest })
  const tx = await client.getTransactionBlock({
    digest,
    options: { showObjectChanges: true },
  })
  const changes = tx.objectChanges ?? []
  for (const c of changes) {
    if (c.type !== "created") continue
    // objectType examples:
    //   "0xpkg::duel::Duel<0xcoin::TYPE>" (paid)
    //   "0xpkg::duel::Duel" (rare; free variant)
    if (!c.objectType.includes("::duel::Duel")) continue
    return normalizeSuiObjectId(c.objectId)
  }
  return null
}

/**
 * Discover all duels by querying DuelCreated events. Filters for the
 * configured package + stake type and returns most-recent-first.
 */
export async function listDuelIds(
  client: SuiClient,
  limit = 50,
): Promise<string[]> {
  const events = await client.queryEvents({
    query: { MoveEventType: `${packageId}::duel::DuelCreated` },
    limit,
    order: "descending",
  })
  return events.data.map((e) => {
    const parsed = e.parsedJson as { duel_id: string }
    return normalizeSuiObjectId(parsed.duel_id)
  })
}

// === DeepBook OracleSVI reads + discovery ===

export interface OracleSviInfo {
  id: string
  spot: bigint
  forward: bigint
  expiry: bigint
  isActive: boolean
  settlementPrice: bigint | null
}

/**
 * Read state for a DeepBook `OracleSVI` — flat `prices` struct +
 * `settlement_price: Option<u64>` at the top level.
 */
export async function fetchOracleSvi(
  client: SuiClient,
  oracleId: string,
): Promise<OracleSviInfo> {
  const obj = await client.getObject({
    id: oracleId,
    options: { showContent: true },
  })
  if (obj.data?.content?.dataType !== "moveObject") {
    throw new Error("OracleSVI not found")
  }
  const f = obj.data.content.fields as {
    prices: { fields: { spot: string; forward: string } }
    expiry: string
    active: boolean
    settlement_price: { fields: { vec: string[] } } | string | null
  }
  let settlementPrice: bigint | null = null
  if (f.settlement_price && typeof f.settlement_price === "object") {
    const vec = f.settlement_price.fields?.vec ?? []
    if (vec.length > 0) settlementPrice = BigInt(vec[0])
  } else if (typeof f.settlement_price === "string") {
    settlementPrice = BigInt(f.settlement_price)
  }
  return {
    id: normalizeSuiObjectId(oracleId),
    spot: BigInt(f.prices.fields.spot),
    forward: BigInt(f.prices.fields.forward),
    expiry: BigInt(f.expiry),
    isActive: !!f.active,
    settlementPrice,
  }
}

/**
 * Minimum expiry headroom we require when picking an oracle, in ms.
 * Must cover the full swipe phase (up to 60 s) plus a margin for join
 * latency and clock drift, otherwise `record_swipe` would abort with
 * `EOracleNotLive`.
 */
const ORACLE_MIN_HEADROOM_MS = 90_000n

/**
 * Pick the BTC `OracleSVI` with the **shortest viable expiry** from
 * DeepBook's live pool.
 *
 * Why shortest, not newest:
 *
 * DeepBook testnet runs a rolling pool of multiple oracles at once with
 * expiries spread across quarter-hour boundaries (`:15, :30, :45, :00`)
 * AND longer-dated tiers (~1–5 h out). DeepBook publishes the long-dated
 * oracles *after* the near-dated ones, so "newest by OracleCreated event"
 * is biased toward the longest-dated oracle in the pool. A duel pinned
 * to that one only settles when DeepBook's settlement_price for that far
 * expiry is published — could be 4 h+ later.
 *
 * For PvP flow we want duels to settle ASAP after swipes lock, so prefer
 * the closest expiry that still has enough headroom for the swipe phase.
 * `ORACLE_MIN_HEADROOM_MS` is the floor.
 *
 * Candidate selection:
 *   1. Read the 30 most recent `registry::OracleCreated` events.
 *   2. Multi-get the oracle objects in batch.
 *   3. Keep ones that are ACTIVE + priced (spot/forward > 0) + not
 *      settled + `expiry - now >= ORACLE_MIN_HEADROOM_MS`.
 *   4. Return the one with the SMALLEST `expiry`.
 *   5. Fall back to `CONFIG.fallbackOracleSviId` if none qualify.
 *
 * See `docs/oracle-selection.md` for the full rationale, live testnet
 * observations, and tuning guide.
 */
export async function findLatestOracleSvi(
  client: SuiClient,
  asset = "BTC",
): Promise<string> {
  try {
    const evts = await client.queryEvents({
      query: {
        MoveEventType: `${deepbookPredictPackageId}::registry::OracleCreated`,
      },
      limit: 30,
      order: "descending",
    })
    const candidates: string[] = []
    for (const e of evts.data) {
      const p = e.parsedJson as { oracle_id: string; underlying_asset: string }
      if (p.underlying_asset === asset) {
        candidates.push(normalizeSuiObjectId(p.oracle_id))
      }
    }
    if (candidates.length > 0) {
      const top = candidates.slice(0, 10)
      const objs = await client.multiGetObjects({
        ids: top,
        options: { showContent: true },
      })
      const nowMs = BigInt(Date.now())
      let best: { id: string; expiry: bigint } | null = null
      for (let i = 0; i < objs.length; i++) {
        const obj = objs[i]
        if (obj.data?.content?.dataType !== "moveObject") continue
        const f = obj.data.content.fields as {
          active?: boolean
          expiry?: string
          prices?: { fields?: { spot?: string; forward?: string } }
          settlement_price?: unknown
        }
        const settled =
          (typeof f.settlement_price === "string" && f.settlement_price !== "0") ||
          (typeof f.settlement_price === "object" &&
            f.settlement_price !== null &&
            // Some Sui RPC variants wrap Option in { fields: { vec: [...] } }
            ((f.settlement_price as { fields?: { vec?: string[] } }).fields?.vec
              ?.length ?? 0) > 0)
        const spot = BigInt(f.prices?.fields?.spot ?? "0")
        const forward = BigInt(f.prices?.fields?.forward ?? "0")
        const expiry = BigInt(f.expiry ?? "0")
        if (settled || !f.active || spot === 0n || forward === 0n) continue
        if (expiry - nowMs < ORACLE_MIN_HEADROOM_MS) continue
        if (best === null || expiry < best.expiry) {
          best = { id: top[i], expiry }
        }
      }
      if (best) return best.id
    }
  } catch {
    // fall through
  }
  return CONFIG.fallbackOracleSviId
}

/**
 * Strike-grid for an OracleSVI without reading DeepBook's `oracle_config`:
 * derive 5 strikes around the last known reference price (settlement when
 * settled, otherwise forward) at the percentages in `pcts`.
 */
export function oracleStrikes(
  ref: bigint,
  pcts: readonly bigint[] = [95n, 98n, 100n, 102n, 105n] as const,
): bigint[] {
  return pcts.map((pct) => (ref * pct) / 100n)
}
