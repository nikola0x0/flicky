/**
 * Web-side helpers for the flicky duel flow. Thin wrappers around generated
 * codegen bindings + JSON parsers for shared-object reads.
 *
 * Every duel references a DeepBook `OracleSVI` directly — there's no
 * FlickyOracle path anymore. Staked swipes (predict::mint + record_swipe in
 * one PTB) live in `./deepbook.ts`.
 */
import { Transaction } from "@mysten/sui/transactions"
import type { ClientWithCoreApi } from "@mysten/sui/client"
import { bcs } from "@mysten/sui/bcs"
import {
  normalizeSuiObjectId,
  normalizeSuiAddress,
  fromBase64,
} from "@mysten/sui/utils"

type SuiClient = ClientWithCoreApi

import * as duelGen from "@/sui/gen/flicky/duel"
import { CONFIG } from "./config"
import { DEEPBOOK } from "./deepbook"
import { getGraphQLClient } from "./graphql"

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
  /** dUSDC micro-units the player committed (= predict::mint quantity). */
  quantity: bigint
  /** dUSDC micro-units the player paid as premium (snapshotted on-chain
   *  inside the swipe PTB via `get_trade_amounts`). */
  premium: bigint
  /** Probability of the swiped direction at swipe time, scaled by 1e9. */
  pSwiped: bigint
}

export interface DuelState {
  id: string
  /** Coin type used for this duel's stake — e.g. "0x2::sui::SUI" or dUSDC. */
  stakeCoinType: string
  status: DuelStatus
  /** 1 = STAKED, 2 = FREE. */
  tier: number
  creator: string
  challenger: string
  /** sha2-256 commitment over the deck, "0x"-prefixed lowercase hex.
   *  Used to fetch plaintext from `/deckmaster/reveal?hash=…` for the
   *  client-side reveal fallback. */
  deckHashHex: string
  /** Number of cards in this deck. Chosen at create-time, [1, 20]. */
  deckSize: bigint
  cards: DuelCard[]
  p0Stake: bigint
  p1Stake: bigint
  /** Aggregated PnL fields written incrementally by `settle_card`. Net
   *  score for player N = `pNPayout - pNPremium`. Both are zero until the
   *  first card settles. */
  p0Payout: bigint
  p0Premium: bigint
  p1Payout: bigint
  p1Premium: bigint
  p0NextCardIdx: bigint
  p1NextCardIdx: bigint
  /** Number of cards that have been `settle_card`-ed on chain. Once it
   *  equals `deckSize`, `finalize` can run (no oracle args). */
  settledCount: bigint
  startedAtMs: bigint
  p0Swipes: (DuelSwipe | null)[]
  p1Swipes: (DuelSwipe | null)[]
  /** Length == deckSize. `cardsSettled[i] === true` ⇔ `settle_card(i)`
   *  has landed; `cardSettlementPrices[i]` is the oracle's price at that
   *  settle (0 when unsettled). */
  cardsSettled: boolean[]
  cardSettlementPrices: bigint[]
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
  deckSize: number = DEFAULT_DECK_SIZE,
): Transaction {
  if (deckHash.length !== 32) throw new Error("deck hash must be 32 bytes (sha-256)")

  const tx = new Transaction()
  const [stake] = tx.splitCoins(tx.gas, [tx.pure.u64(stakeAmount)])

  tx.add(
    duelGen.createDuel({
      package: packageId,
      arguments: [
        stake,
        tx.pure.vector("u8", Array.from(deckHash)),
        BigInt(deckSize),
      ],
      typeArguments: [stakeCoinType],
    }),
  )
  return tx
}

/**
 * Default cards per duel. Matches the contract's `DEFAULT_DECK_SIZE`
 * constant and the playground's E2E expectations. Variable deck sizes
 * (1–20) are supported by `create_duel(stake, deck_hash, deck_size)`.
 */
export const DEFAULT_DECK_SIZE = 5

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
  const coins = await client.core.listCoins({ owner, coinType })
  if (coins.objects.length === 0) {
    throw new Error(`no ${coinType} coins in wallet ${owner}`)
  }
  const [primary, ...rest] = coins.objects.map((c) => tx.object(c.objectId))
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
  deckSize: number = DEFAULT_DECK_SIZE,
): Promise<Transaction> {
  if (deckHash.length !== 32) throw new Error("deck hash must be 32 bytes (sha-256)")
  const tx = new Transaction()
  const stake = await takeCoinFromOwner(client, tx, owner, stakeCoinType, stakeAmount)
  tx.add(
    duelGen.createDuel({
      package: packageId,
      arguments: [
        stake,
        tx.pure.vector("u8", Array.from(deckHash)),
        BigInt(deckSize),
      ],
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
 * Finalize a duel in a single PTB. Two-phase: one `settle_card(card_idx,
 * &oracle)` per card scores it against its OWN oracle's `settlement_price`
 * (and reads both PredictManagers for anti-replay), then `finalize`
 * compares the accumulated per-player PnL and pays the pot. The caller
 * must ensure every card's oracle has published `settlement_price` —
 * otherwise the matching `settle_card` aborts `EOracleNotLive`.
 */
export function buildFinalizeTx(
  duelId: string,
  cards: DuelCard[],
  p0Manager: string,
  p1Manager: string,
  stakeCoinType: string = CONFIG.stakeType,
): Transaction {
  if (cards.length === 0) throw new Error("deck has no cards to finalize")
  const tx = new Transaction()
  cards.forEach((card, idx) => {
    tx.add(
      duelGen.settleCard({
        package: packageId,
        arguments: [duelId, p0Manager, p1Manager, card.oracleId, BigInt(idx)],
        typeArguments: [stakeCoinType],
      }),
    )
  })
  tx.add(
    duelGen.finalize({
      package: packageId,
      arguments: [duelId],
      typeArguments: [stakeCoinType],
    }),
  )
  return tx
}

// === Reads ===

interface RawSwipe {
  is_up: boolean
  quantity: string
  premium: string
  p_swiped: string
}

// Flat gRPC json shape of `flicky::duel::Duel`, as returned by
// `client.core.getObject({ objectId, include: { json: true } })`. Unlike
// JSON-RPC, gRPC does NOT nest Move structs under `.fields`: `id` is a bare
// string, `cards`/swipes are flat objects, `Balance` collapses to a bare
// string, `Option<Swipe>` is the swipe or null, and `vector<u8>`
// (deck_hash) is base64.
interface RawDuelFields {
  id: string
  status: string | number
  tier: string | number
  deck_size: string
  deck_hash: number[] | string
  cards: Array<{ oracle_id: string; strike: string }>
  creator: string
  challenger: string
  p0_stake: string | { value: string }
  p1_stake: string | { value: string }
  cards_settled: boolean[]
  card_settlement_prices: string[]
  settled_count: string
  p0_payout: string
  p0_premium: string
  p1_payout: string
  p1_premium: string
  p0_next_card_idx: string
  p1_next_card_idx: string
  started_at_ms: string
  p0_swipes: Array<RawSwipe | null>
  p1_swipes: Array<RawSwipe | null>
}

function balanceValue(b: string | { value: string }): bigint {
  return typeof b === "string" ? BigInt(b) : BigInt(b.value)
}

function parseSwipe(raw: RawSwipe | null): DuelSwipe | null {
  if (raw === null) return null
  return {
    isUp: raw.is_up,
    quantity: BigInt(raw.quantity),
    premium: BigInt(raw.premium),
    pSwiped: BigInt(raw.p_swiped),
  }
}

/** Render a gRPC vector<u8> (base64) or JSON-RPC number[]/hex to 0x-hex. */
function deckHashToHex(bytes: number[] | string): string {
  let arr: number[] | Uint8Array
  if (typeof bytes === "string") {
    if (bytes.toLowerCase().startsWith("0x")) return bytes.toLowerCase()
    arr = fromBase64(bytes) // gRPC encodes vector<u8> as base64
  } else {
    arr = bytes
  }
  return (
    "0x" +
    Array.from(arr)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  )
}

/**
 * Parse a Duel from its flat gRPC json + object type string, as returned by
 * `client.core.getObject({ objectId, include: { json: true } })`
 * (`obj.object.json`, `obj.object.type`).
 */
export function parseDuel(json: unknown, objectType?: string): DuelState {
  if (!json || typeof json !== "object") {
    throw new Error("not a Move object")
  }
  const fields = json as RawDuelFields
  const cards = fields.cards.map((c) => ({
    oracleId: normalizeSuiObjectId(c.oracle_id),
    strike: BigInt(c.strike),
  }))
  // Extract the duel's stake coin type from the object type string.
  // e.g. "0xpkg::duel::Duel<0x2::sui::SUI>"  →  "0x2::sui::SUI"
  const typeMatch = objectType?.match(/Duel<(.+)>$/)
  const stakeCoinType = typeMatch?.[1] ?? CONFIG.stakeType
  return {
    id: normalizeSuiObjectId(fields.id),
    stakeCoinType,
    status: STATUS_MAP[String(fields.status)] ?? "PENDING",
    tier: Number(fields.tier),
    creator: fields.creator,
    challenger: fields.challenger,
    deckHashHex: deckHashToHex(fields.deck_hash),
    deckSize: BigInt(fields.deck_size),
    cards,
    p0Stake: balanceValue(fields.p0_stake),
    p1Stake: balanceValue(fields.p1_stake),
    p0Payout: BigInt(fields.p0_payout),
    p0Premium: BigInt(fields.p0_premium),
    p1Payout: BigInt(fields.p1_payout),
    p1Premium: BigInt(fields.p1_premium),
    p0NextCardIdx: BigInt(fields.p0_next_card_idx),
    p1NextCardIdx: BigInt(fields.p1_next_card_idx),
    settledCount: BigInt(fields.settled_count),
    startedAtMs: BigInt(fields.started_at_ms),
    p0Swipes: fields.p0_swipes.map(parseSwipe),
    p1Swipes: fields.p1_swipes.map(parseSwipe),
    cardsSettled: fields.cards_settled.map((b) => !!b),
    cardSettlementPrices: fields.card_settlement_prices.map((s) => BigInt(s)),
  }
}

export async function fetchDuel(
  client: SuiClient,
  duelId: string,
): Promise<DuelState> {
  const obj = await client.core.getObject({
    objectId: duelId,
    include: { json: true },
  })
  return parseDuel(obj.object.json, obj.object.type)
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
  const res = await client.core.waitForTransaction({
    digest,
    include: { effects: true, objectTypes: true },
  })
  const tx = res.Transaction
  const types = tx?.objectTypes ?? {}
  for (const c of tx?.effects?.changedObjects ?? []) {
    if (c.idOperation !== "Created") continue
    // objectType examples:
    //   "0xpkg::duel::Duel<0xcoin::TYPE>" (paid)
    //   "0xpkg::duel::Duel" (rare; free variant)
    const t = types[c.objectId]
    if (t && t.includes("::duel::Duel")) return normalizeSuiObjectId(c.objectId)
  }
  return null
}

// GraphQL `last: N` returns the N most-recent events of a type, in ascending
// order — callers reverse when they want newest-first. (gRPC has no filtered
// event API, so event reads go through GraphQL.)
const RECENT_EVENTS_QUERY = `query Recent($type: String!, $last: Int!) {
  events(filter: { type: $type }, last: $last) {
    nodes { contents { json } }
  }
}`
type RecentEventsResult<T> = {
  data?: { events?: { nodes?: Array<{ contents: { json: T } }> } }
}

/**
 * Discover all duels by querying DuelCreated events. Filters for the
 * configured package + stake type and returns most-recent-first.
 */
export async function listDuelIds(
  _client: SuiClient,
  limit = 50,
): Promise<string[]> {
  const res = (await getGraphQLClient().query({
    query: RECENT_EVENTS_QUERY,
    variables: { type: `${packageId}::duel::DuelCreated`, last: limit },
  })) as RecentEventsResult<{ duel_id: string }>
  return (res.data?.events?.nodes ?? [])
    .map((n) => normalizeSuiObjectId(n.contents.json.duel_id))
    .reverse()
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
  const obj = await client.core.getObject({
    objectId: oracleId,
    include: { json: true },
  })
  const json = obj.object.json
  if (!json || typeof json !== "object") {
    throw new Error("OracleSVI not found")
  }
  const f = json as {
    prices: { spot: string; forward: string }
    expiry: string
    active: boolean
    // gRPC unwraps `Option<u64>`: Some ⇒ bare string, None ⇒ null. Older
    // JSON-RPC-style `{ fields: { vec: [...] } }` handled defensively.
    settlement_price: string | { fields?: { vec?: string[] } } | null
  }
  let settlementPrice: bigint | null = null
  const sp = f.settlement_price
  if (typeof sp === "string") {
    settlementPrice = BigInt(sp)
  } else if (sp && typeof sp === "object") {
    const vec = sp.fields?.vec ?? []
    if (vec.length > 0) settlementPrice = BigInt(vec[0])
  }
  return {
    id: normalizeSuiObjectId(oracleId),
    spot: BigInt(f.prices.spot),
    forward: BigInt(f.prices.forward),
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
    const res = (await getGraphQLClient().query({
      query: RECENT_EVENTS_QUERY,
      variables: {
        type: `${deepbookPredictPackageId}::registry::OracleCreated`,
        last: 30,
      },
    })) as RecentEventsResult<{ oracle_id: string; underlying_asset: string }>
    const candidates: string[] = []
    // GraphQL returns ascending; reverse to consider newest-created first.
    for (const n of (res.data?.events?.nodes ?? []).reverse()) {
      const p = n.contents.json
      if (p.underlying_asset === asset) {
        candidates.push(normalizeSuiObjectId(p.oracle_id))
      }
    }
    if (candidates.length > 0) {
      const top = candidates.slice(0, 10)
      const objs = await client.core.getObjects({
        objectIds: top,
        include: { json: true },
      })
      const nowMs = BigInt(Date.now())
      let best: { id: string; expiry: bigint } | null = null
      for (const obj of objs.objects) {
        if (obj instanceof Error || !obj.json) continue
        const f = obj.json as {
          active?: boolean
          expiry?: string
          prices?: { spot?: string; forward?: string }
          settlement_price?: string | { fields?: { vec?: string[] } } | null
        }
        const sp = f.settlement_price
        const settled =
          (typeof sp === "string" && sp !== "0") ||
          (!!sp &&
            typeof sp === "object" &&
            // Defensive: older JSON-RPC-style Option wrap { fields: { vec } }.
            (sp.fields?.vec?.length ?? 0) > 0)
        const spot = BigInt(f.prices?.spot ?? "0")
        const forward = BigInt(f.prices?.forward ?? "0")
        const expiry = BigInt(f.expiry ?? "0")
        if (settled || !f.active || spot === 0n || forward === 0n) continue
        if (expiry - nowMs < ORACLE_MIN_HEADROOM_MS) continue
        if (best === null || expiry < best.expiry) {
          best = { id: obj.objectId, expiry }
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
