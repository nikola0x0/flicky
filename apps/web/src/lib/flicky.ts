/**
 * Web-side helpers for the flicky duel flow. Thin wrappers around generated
 * codegen bindings + JSON parsers for shared-object reads.
 *
 * Every duel card pins a DeepBook Predict (6-24) `ExpiryMarket` directly
 * (`Card.expiry_market_id`) — there's no FlickyOracle or OracleSVI path.
 * Staked swipes (`expiry_market::mint_exact_quantity` + `record_swipe` in
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
import { buildStakedSwipeTx, DEEPBOOK, resolveWrapper } from "./deepbook"
import { getGraphQLClient } from "./graphql"

const { packageId } = CONFIG

// === Types ===

// Sub-shapes of DuelState. Kept as named internal aliases for readability;
// reachable externally via the structural shape of `DuelState` itself.
type DuelStatus = "PENDING" | "ACTIVE" | "COMPLETE"

interface DuelCard {
  /** The 6-24 `ExpiryMarket` this card is bet on. */
  expiryMarketId: string
  strike: bigint
}

interface DuelSwipe {
  isUp: boolean
  /** Contracts minted (= `expiry_market::mint_exact_quantity` quantity). */
  quantity: bigint
  /**
   * The `order_id` returned by `mint_exact_quantity`, chained from the mint
   * command in the same player-signed PTB. `0` for free-tier swipes (no
   * mint). Premium/p_swiped are no longer snapshotted here — 6-24 exposes
   * no public on-chain quote; premium is keeper-fed at settle time.
   */
  orderId: bigint
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
  /** The 6-24 `ExpiryMarket` this card is bet on. */
  expiryMarketId: string
  strike: bigint
}

/**
 * BCS schema matching the on-chain `flicky::duel::Card` layout
 * (`expiry_market_id: ID, strike: u64`). The vector serialization +
 * sha2-256 here must reproduce what `bcs::to_bytes(&cards)` +
 * `hash::sha2_256` produce in Move — see
 * `apps/contracts/sources/duel.move::reveal_deck`.
 */
const CardBcs = bcs.struct("Card", {
  expiry_market_id: bcs.Address,
  strike: bcs.u64(),
})
const DeckBcs = bcs.vector(CardBcs)

function serializeDeck(cards: DeckCard[]): Uint8Array {
  return DeckBcs.serialize(
    cards.map((c) => ({
      expiry_market_id: normalizeSuiAddress(c.expiryMarketId),
      strike: c.strike.toString(),
    }))
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
  deckSize: number = DEFAULT_DECK_SIZE
): Transaction {
  if (deckHash.length !== 32)
    throw new Error("deck hash must be 32 bytes (sha-256)")

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
    })
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
  stakeCoinType: string = CONFIG.stakeType
): Transaction {
  // The deck can be any size the contract allows ([1, 20]); the reveal must
  // carry exactly the committed cards (the contract re-hashes and compares).
  if (cards.length < 1 || cards.length > 20) {
    throw new Error(`deck must have 1–20 cards, got ${cards.length}`)
  }
  const tx = new Transaction()

  const cardArgs = cards.map((c) =>
    tx.add(
      duelGen.newCard({
        package: packageId,
        arguments: [c.expiryMarketId, c.strike],
      })
    )
  )
  tx.add(
    duelGen.revealDeck({
      package: packageId,
      arguments: [
        duelId,
        tx.makeMoveVec({
          type: `${packageId}::duel::Card`,
          elements: cardArgs,
        }),
      ],
      typeArguments: [stakeCoinType],
    })
  )
  return tx
}

/**
 * Source the duel stake from the player's AccountWrapper dUSDC balance via
 * `account::withdraw_funds` (which RETURNS the coin — it is not
 * auto-transferred), so the withdrawn coin flows straight into the duel as
 * the stake. This is the SAME funding pool the swipe-mint premiums draw
 * from: players deposit dUSDC once into their account, and both the side-pot
 * stake and the per-swipe mint premiums come out of it. That keeps the
 * zkLogin wallet dUSDC-free (CLAUDE.md "wallet only ever holds dUSDC" is
 * satisfied because nothing is ever sourced from the wallet here) and means
 * a player who funded only their account can still create/join.
 *
 * Mirrors `buildWithdrawDusdcTx` in `lib/deepbook.ts` minus the final
 * transfer-to-wallet step.
 */
function takeStakeFromAccount(
  tx: Transaction,
  wrapperId: string,
  coinType: string,
  amount: bigint
) {
  const auth = tx.moveCall({
    target: `${DEEPBOOK.accountPackageId}::account::generate_auth`,
  })
  const coin = tx.moveCall({
    target: `${DEEPBOOK.accountPackageId}::account::withdraw_funds`,
    typeArguments: [coinType],
    arguments: [
      tx.object(wrapperId),
      auth,
      tx.pure.u64(amount),
      tx.object(DEEPBOOK.accumulatorRootId),
      tx.object(CONFIG.CLOCK_ID),
    ],
  })
  return coin
}

/**
 * Resolve the player's funding account (AccountWrapper) or throw a clear,
 * actionable error. Both the stake (via `takeStakeFromAccount`) and the
 * queue balance gate key off this account, so a missing wrapper means the
 * player hasn't onboarded yet.
 */
async function requireWrapper(owner: string): Promise<string> {
  const wrapperId = await resolveWrapper(owner)
  if (!wrapperId) {
    throw new Error(
      "no funding account yet — deposit dUSDC to set up your account first"
    )
  }
  return wrapperId
}

/**
 * Staked-tier create: the stake is withdrawn from the player's dUSDC
 * AccountWrapper (see `takeStakeFromAccount`) rather than their wallet, so
 * the account is the single funding source for both stake and mint
 * premiums. PRD §Staked tier.
 *
 * `_client` is unused (the stake no longer scans wallet coins) but kept in
 * the signature so existing call sites don't need to change.
 */
export async function buildCreateDuelDusdcTx(
  _client: SuiClient,
  owner: string,
  deckHash: Uint8Array,
  stakeAmount: bigint,
  stakeCoinType: string,
  deckSize: number = DEFAULT_DECK_SIZE
): Promise<Transaction> {
  if (deckHash.length !== 32)
    throw new Error("deck hash must be 32 bytes (sha-256)")
  const tx = new Transaction()
  const wrapperId = await requireWrapper(owner)
  const stake = takeStakeFromAccount(tx, wrapperId, stakeCoinType, stakeAmount)
  tx.add(
    duelGen.createDuel({
      package: packageId,
      arguments: [
        stake,
        tx.pure.vector("u8", Array.from(deckHash)),
        BigInt(deckSize),
      ],
      typeArguments: [stakeCoinType],
    })
  )
  return tx
}

/** Staked-tier join — same account-funded stake as buildCreateDuelDusdcTx. */
export async function buildJoinDuelDusdcTx(
  _client: SuiClient,
  owner: string,
  duelId: string,
  stakeAmount: bigint,
  stakeCoinType: string
): Promise<Transaction> {
  const tx = new Transaction()
  const wrapperId = await requireWrapper(owner)
  const stake = takeStakeFromAccount(tx, wrapperId, stakeCoinType, stakeAmount)
  tx.add(
    duelGen.joinDuel({
      package: packageId,
      arguments: [duelId, stake],
      typeArguments: [stakeCoinType],
    })
  )
  return tx
}

/** Challenger joins an existing PENDING duel, matching the creator's stake. */
export function buildJoinDuelTx(
  duelId: string,
  stakeAmount: bigint,
  stakeCoinType: string = CONFIG.stakeType
): Transaction {
  const tx = new Transaction()
  const [stake] = tx.splitCoins(tx.gas, [tx.pure.u64(stakeAmount)])

  tx.add(
    duelGen.joinDuel({
      package: packageId,
      // Clock arg is auto-injected by codegen.
      arguments: [duelId, stake],
      typeArguments: [stakeCoinType],
    })
  )
  return tx
}

/** Mirrors `REFUND_TIMEOUT_MS` in duel.move — ACTIVE refunds open after 1h. */
export const REFUND_TIMEOUT_MS = 3_600_000

/**
 * Which `refund_duel` path (if any) the viewer can take on a duel, mirroring
 * the contract's gates (`duel.move::refund_duel`) so the UI only offers the
 * call when it would succeed:
 *   - "cancel" — PENDING, viewer is the creator (no timeout).
 *   - "refund" — ACTIVE, viewer is a player, >1h since start, and at least
 *     one player hasn't completed the deck (both-done duels must `finalize`).
 */
export function refundEligibility(
  duel: {
    status: string
    creator: string
    challenger: string
    cardCount: number
    startedAtMs: number
    swipes: Array<{ p0Swipe: unknown | null; p1Swipe: unknown | null }>
  },
  viewer: string,
  nowMs: number = Date.now()
): "cancel" | "refund" | null {
  if (duel.status === "PENDING") {
    return viewer === duel.creator ? "cancel" : null
  }
  if (duel.status !== "ACTIVE") return null
  if (viewer !== duel.creator && viewer !== duel.challenger) return null
  if (!duel.startedAtMs || nowMs <= duel.startedAtMs + REFUND_TIMEOUT_MS)
    return null
  const p0Done =
    duel.cardCount > 0 &&
    duel.swipes.filter((s) => s.p0Swipe != null).length >= duel.cardCount
  const p1Done =
    duel.cardCount > 0 &&
    duel.swipes.filter((s) => s.p1Swipe != null).length >= duel.cardCount
  return p0Done && p1Done ? null : "refund"
}

/**
 * Refund a stuck duel (`duel::refund_duel`) — creator-cancel for PENDING,
 * either player after the 1h timeout for ACTIVE. Player-signed + sponsored
 * like every other duel call; the Clock arg is auto-injected by codegen.
 */
export function buildRefundDuelTx(
  duelId: string,
  stakeCoinType: string = CONFIG.stakeType
): Transaction {
  const tx = new Transaction()
  tx.add(
    duelGen.refundDuel({
      package: packageId,
      arguments: [duelId],
      typeArguments: [stakeCoinType],
    })
  )
  return tx
}

/**
 * Record a single swipe on the next card in the player's sequence.
 *
 * Staked-tier swipes require a genuine 6-24 mint backing them — this
 * delegates to `buildStakedSwipeTx` in `lib/deepbook.ts`, which bundles
 * `expiry_market::mint_exact_quantity` + `duel::record_swipe` (chaining
 * the mint's `order_id`) in one player-signed, sponsored PTB. Free-tier
 * swipes skip the mint entirely and call `record_swipe_free`, which
 * normalizes quantity to `PROB_SCALE` and `order_id` to `0` on-chain.
 */
export function buildSwipeTx(
  args:
    | {
        tier: "staked"
        duelId: string
        wrapperId: string
        marketId: string
        strike: bigint
        tickSize: bigint
        cardIdx: number
        isUp: boolean
        quantity: bigint
        /** The Duel's escrow coin type — must match on-chain `Duel<T>`. */
        stakeCoinType: string
      }
    | {
        tier: "free"
        duelId: string
        cardIdx: number
        isUp: boolean
        stakeCoinType?: string
      }
): Transaction {
  if (args.tier === "staked") {
    return buildStakedSwipeTx({
      duelId: args.duelId,
      wrapperId: args.wrapperId,
      marketId: args.marketId,
      strike: args.strike,
      tickSize: args.tickSize,
      cardIdx: args.cardIdx,
      isUp: args.isUp,
      quantity: args.quantity,
      stakeCoinType: args.stakeCoinType,
    })
  }
  const tx = new Transaction()
  tx.add(
    duelGen.recordSwipeFree({
      package: packageId,
      // Clock arg is auto-injected by codegen.
      arguments: [args.duelId, args.cardIdx, args.isUp],
      typeArguments: [args.stakeCoinType ?? CONFIG.stakeType],
    })
  )
  return tx
}

// === Reads ===

interface RawSwipe {
  is_up: boolean
  quantity: string
  order_id: string
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
  cards: Array<{ expiry_market_id: string; strike: string }>
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
    orderId: BigInt(raw.order_id),
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
    expiryMarketId: normalizeSuiObjectId(c.expiry_market_id),
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
  duelId: string
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
  digest: string
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
  limit = 50
): Promise<string[]> {
  const res = (await getGraphQLClient().query({
    query: RECENT_EVENTS_QUERY,
    variables: { type: `${packageId}::duel::DuelCreated`, last: limit },
  })) as RecentEventsResult<{ duel_id: string }>
  return (res.data?.events?.nodes ?? [])
    .map((n) => normalizeSuiObjectId(n.contents.json.duel_id))
    .reverse()
}

// === Strike-grid helper ===
//
// `fetchOracleSvi`/`findLatestOracleSvi` (4-16-era `OracleSVI` discovery)
// were removed here: 6-24 cards pin an `ExpiryMarket` (`expiry_market_id`),
// not an `OracleSVI`, and `CONFIG.fallbackOracleSviId` no longer exists
// (dropped when config moved to 6-24 ids). Market discovery is
// indexer-driven now — see `fetchMarketTickSize` in `lib/deepbook.ts` and
// `fetchOracleList`/`useOracle` in `App.tsx`.

/**
 * Strike-grid for an expiry market without reading DeepBook's pricing
 * config: derive 5 strikes around the last known reference price
 * (settlement when settled, otherwise forward) at the percentages in
 * `pcts`.
 */
export function oracleStrikes(
  ref: bigint,
  pcts: readonly bigint[] = [95n, 98n, 100n, 102n, 105n] as const
): bigint[] {
  return pcts.map((pct) => (ref * pct) / 100n)
}
