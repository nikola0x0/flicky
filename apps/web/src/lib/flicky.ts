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

/** Record a single swipe on the next card in the player's sequence. */
export function buildSwipeTx(
  duelId: string,
  oracleId: string,
  cardIdx: number,
  isUp: boolean,
  stakeCoinType: string = CONFIG.stakeType,
): Transaction {
  const tx = new Transaction()
  tx.add(
    duelGen.recordSwipe({
      package: packageId,
      arguments: [duelId, oracleId, cardIdx, isUp],
      typeArguments: [stakeCoinType],
    }),
  )
  return tx
}

/** Settle all 5 cards + finalize payout in a single PTB. */
export function buildSettleAndFinalizeTx(
  duelId: string,
  oracleId: string,
  stakeCoinType: string = CONFIG.stakeType,
): Transaction {
  const tx = new Transaction()
  for (let i = 0; i < 5; i++) {
    tx.add(
      duelGen.settleCard({
        package: packageId,
        arguments: [duelId, oracleId, i],
        typeArguments: [stakeCoinType],
      }),
    )
  }
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

interface MoveFieldWrapper<T> {
  type: string
  fields: T
}

interface RawDuelFields {
  id: { id: string }
  status: string | number
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
  return {
    id: normalizeSuiObjectId(fields.id.id),
    stakeCoinType,
    status: STATUS_MAP[String(fields.status)] ?? "PENDING",
    creator: fields.creator,
    challenger: fields.challenger,
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
 * Find the most recent BTC `OracleSVI` published by DeepBook on testnet.
 * Returns the configured fallback if event query fails.
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
      limit: 20,
      order: "descending",
    })
    for (const e of evts.data) {
      const p = e.parsedJson as { oracle_id: string; underlying_asset: string }
      if (p.underlying_asset === asset) {
        return normalizeSuiObjectId(p.oracle_id)
      }
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
