/**
 * Read + write helpers for flicky::oracle and flicky::duel. Mirrors the
 * server-side lib in shape but uses dapp-kit's signing surface.
 */
import { Transaction } from "@mysten/sui/transactions"
import type { SuiClient, SuiObjectResponse } from "@mysten/sui/client"
import { SUI_CLOCK_OBJECT_ID, normalizeSuiObjectId } from "@mysten/sui/utils"
import { bcs } from "@mysten/sui/bcs"
import { CONFIG } from "./config"

const { packageId, deepbookPredictPackageId } = CONFIG

/** Set of oracle IDs whose cards must use the DeepBook variant PTBs. */
const DEEPBOOK_ORACLE_IDS = new Set<string>([CONFIG.fallbackDeepbookOracleId])

/** Treat any oracle id matching a known DeepBook OracleSVI as DeepBook-backed. */
export function isDeepbookOracle(oracleId: string): boolean {
  return DEEPBOOK_ORACLE_IDS.has(normalizeSuiObjectId(oracleId))
}

export function registerDeepbookOracle(id: string): void {
  DEEPBOOK_ORACLE_IDS.add(normalizeSuiObjectId(id))
}

export type DuelStatus = "PENDING" | "ACTIVE" | "COMPLETE"

export interface DuelCard {
  oracleId: string
  strike: bigint
}

export interface DuelSwipe {
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
  p0Swipes: (DuelSwipe | null)[]
  p1Swipes: (DuelSwipe | null)[]
  cardSettlements: (bigint | null)[]
}

const STATUS_MAP: Record<string, DuelStatus> = {
  "1": "PENDING",
  "2": "ACTIVE",
  "3": "COMPLETE",
}

// === PTB builders ===
//
// Coin source: each builder either pulls the stake from the gas wallet
// (`tx.gas`) for SUI duels, or from a player's PredictManager via
// `predict_manager::withdraw<T>` for dUSDC duels. When `managerSource` is
// provided we always use the manager path; the manager is owner-gated, so
// the PTB must be signed by the manager owner.

interface ManagerSource {
  /** PredictManager owned by the caller. */
  managerId: string
  /** DeepBook Predict package — owner of `predict_manager::withdraw`. */
  predictPackage: string
}

function takeStakeCoin(
  tx: Transaction,
  amount: bigint,
  stakeCoinType: string,
  source: ManagerSource | null,
) {
  if (source) {
    return tx.moveCall({
      target: `${source.predictPackage}::predict_manager::withdraw`,
      typeArguments: [stakeCoinType],
      arguments: [tx.object(source.managerId), tx.pure.u64(amount)],
    })
  }
  const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(amount)])
  return coin
}

export function buildCreateDuelTx(
  oracleId: string,
  strikes: bigint[],
  stakeAmount: bigint,
  stakeCoinType: string,
  source: ManagerSource | null = null,
): Transaction {
  if (strikes.length !== 5) throw new Error("must be 5 strikes")
  const tx = new Transaction()
  const stake = takeStakeCoin(tx, stakeAmount, stakeCoinType, source)
  const cards = strikes.map((strike) =>
    tx.moveCall({
      target: `${packageId}::duel::new_card`,
      arguments: [tx.object(oracleId), tx.pure.u64(strike)],
    }),
  )
  tx.moveCall({
    target: `${packageId}::duel::create_duel`,
    typeArguments: [stakeCoinType],
    arguments: [
      stake,
      tx.makeMoveVec({ type: `${packageId}::duel::Card`, elements: cards }),
    ],
  })
  return tx
}

export function buildJoinDuelTx(
  duelId: string,
  stakeAmount: bigint,
  stakeCoinType: string,
  source: ManagerSource | null = null,
): Transaction {
  const tx = new Transaction()
  const stake = takeStakeCoin(tx, stakeAmount, stakeCoinType, source)
  tx.moveCall({
    target: `${packageId}::duel::join_duel`,
    typeArguments: [stakeCoinType],
    arguments: [tx.object(duelId), stake, tx.object(SUI_CLOCK_OBJECT_ID)],
  })
  return tx
}

export function buildSwipeTx(
  duelId: string,
  oracleId: string,
  cardIdx: number,
  isUp: boolean,
  stakeCoinType: string,
): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: `${packageId}::duel::record_swipe`,
    typeArguments: [stakeCoinType],
    arguments: [
      tx.object(duelId),
      tx.object(oracleId),
      tx.pure.u64(BigInt(cardIdx)),
      tx.pure.bool(isUp),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  })
  return tx
}

export function buildSettleAndFinalizeTx(
  duelId: string,
  oracleId: string,
  stakeCoinType: string,
): Transaction {
  const tx = new Transaction()
  for (let i = 0; i < 5; i++) {
    tx.moveCall({
      target: `${packageId}::duel::settle_card`,
      typeArguments: [stakeCoinType],
      arguments: [tx.object(duelId), tx.object(oracleId), tx.pure.u64(BigInt(i))],
    })
  }
  tx.moveCall({
    target: `${packageId}::duel::finalize`,
    typeArguments: [stakeCoinType],
    arguments: [tx.object(duelId)],
  })
  return tx
}

// === DeepBook-backed variants ===
//
// Same lifecycle (create → swipe × 5 → settle → finalize) but each Move call
// targets the *_deepbook entrypoint, which reads spot/forward/settlement_price
// from DeepBook's real on-chain `OracleSVI`. The strikes still live on the
// Card; flicky::duel doesn't care which oracle implementation backs them.

export function buildCreateDuelDeepbookTx(
  oracleId: string,
  strikes: bigint[],
  stakeAmount: bigint,
  stakeCoinType: string,
  source: ManagerSource | null = null,
): Transaction {
  if (strikes.length !== 5) throw new Error("must be 5 strikes")
  const tx = new Transaction()
  const stake = takeStakeCoin(tx, stakeAmount, stakeCoinType, source)
  const cards = strikes.map((strike) =>
    tx.moveCall({
      target: `${packageId}::duel::new_card_deepbook`,
      arguments: [tx.object(oracleId), tx.pure.u64(strike)],
    }),
  )
  tx.moveCall({
    target: `${packageId}::duel::create_duel`,
    typeArguments: [stakeCoinType],
    arguments: [
      stake,
      tx.makeMoveVec({ type: `${packageId}::duel::Card`, elements: cards }),
    ],
  })
  return tx
}

export function buildSwipeDeepbookTx(
  duelId: string,
  oracleId: string,
  cardIdx: number,
  isUp: boolean,
  stakeCoinType: string,
): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: `${packageId}::duel::record_swipe_deepbook`,
    typeArguments: [stakeCoinType],
    arguments: [
      tx.object(duelId),
      tx.object(oracleId),
      tx.pure.u64(BigInt(cardIdx)),
      tx.pure.bool(isUp),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  })
  return tx
}

export function buildSettleAndFinalizeDeepbookTx(
  duelId: string,
  oracleId: string,
  stakeCoinType: string,
): Transaction {
  const tx = new Transaction()
  for (let i = 0; i < 5; i++) {
    tx.moveCall({
      target: `${packageId}::duel::settle_card_deepbook`,
      typeArguments: [stakeCoinType],
      arguments: [tx.object(duelId), tx.object(oracleId), tx.pure.u64(BigInt(i))],
    })
  }
  tx.moveCall({
    target: `${packageId}::duel::finalize`,
    typeArguments: [stakeCoinType],
    arguments: [tx.object(duelId)],
  })
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
  const stakeCoinType = typeMatch?.[1] ?? "0x2::sui::SUI"
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
export async function listDuelIds(client: SuiClient, limit = 50): Promise<string[]> {
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

export async function impliedProbabilityUp(
  client: SuiClient,
  oracleId: string,
  strike: bigint,
): Promise<bigint> {
  const tx = new Transaction()
  tx.moveCall({
    target: `${packageId}::oracle::implied_probability_up`,
    arguments: [
      tx.object(oracleId),
      tx.pure.u64(strike),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  })
  const res = await client.devInspectTransactionBlock({
    sender: "0x0000000000000000000000000000000000000000000000000000000000000000",
    transactionBlock: tx,
  })
  const ret = res.results?.[0]?.returnValues?.[0]
  if (!ret) throw new Error("no return value")
  return BigInt(bcs.U64.parse(Uint8Array.from(ret[0])))
}

export async function fetchOracleSpot(
  client: SuiClient,
  oracleId: string,
): Promise<{ spot: bigint; expiry: bigint; isSettled: boolean }> {
  const obj = await client.getObject({
    id: oracleId,
    options: { showContent: true },
  })
  if (obj.data?.content?.dataType !== "moveObject") {
    throw new Error("oracle not a Move object")
  }
  const fields = obj.data.content.fields as Record<string, unknown>
  const price = (fields.price as { fields: { spot: string } }).fields
  return {
    spot: BigInt(price.spot),
    expiry: BigInt(String(fields.expiry)),
    isSettled: fields.settlement !== null,
  }
}

/**
 * Read state for a DeepBook `OracleSVI` (`deepbook_predict::oracle`). The
 * field layout differs from FlickyOracle: `prices` is a flat struct and
 * `settlement_price` is an `Option<u64>` at the top level.
 */
export async function fetchDeepbookOracle(
  client: SuiClient,
  oracleId: string,
): Promise<{
  id: string
  spot: bigint
  forward: bigint
  expiry: bigint
  isActive: boolean
  settlementPrice: bigint | null
}> {
  const obj = await client.getObject({
    id: oracleId,
    options: { showContent: true },
  })
  if (obj.data?.content?.dataType !== "moveObject") {
    throw new Error("DeepBook oracle not found")
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
 * Returns the configured fallback if event query fails. Registers the
 * resolved id with `isDeepbookOracle()` so swipe dispatch routes correctly.
 */
export async function findLatestDeepbookOracle(client: SuiClient): Promise<string> {
  try {
    const evts = await client.queryEvents({
      query: {
        MoveEventType: `${deepbookPredictPackageId}::registry::OracleCreated`,
      },
      limit: 5,
      order: "descending",
    })
    for (const e of evts.data) {
      const p = e.parsedJson as { oracle_id: string; underlying_asset: string }
      if (p.underlying_asset === "BTC") {
        const id = normalizeSuiObjectId(p.oracle_id)
        registerDeepbookOracle(id)
        return id
      }
    }
  } catch {
    // fall through
  }
  return CONFIG.fallbackDeepbookOracleId
}

/**
 * Strike-grid for a DeepBook oracle. DeepBook's `OracleSVI` doesn't expose a
 * tick grid via public fns, so we derive 5 strikes around the last known
 * reference price (settlement when settled, otherwise forward).
 */
export function deepbookStrikes(ref: bigint): bigint[] {
  const pcts = [95n, 98n, 100n, 102n, 105n]
  return pcts.map((pct) => (ref * pct) / 100n)
}

/**
 * Per-asset oracle state used by the lobby. Latest ACTIVE oracle per asset
 * is what new duels should reference.
 */
export interface FlickyOracleInfo {
  id: string
  asset: string
  expiry: bigint
  isSettled: boolean
  spot: bigint
}

/**
 * Discover the freshest (most-TTL-remaining) ACTIVE FlickyOracle per asset
 * by reading `OracleCreated` events from the flicky package, then resolving
 * each candidate's current state.
 *
 * Replaces hardcoded `CONFIG.oracles[asset]`: the rotation-keeper daemon
 * creates new oracles on its own schedule, and the lobby should always pick
 * up the latest one without a config update.
 */
export async function discoverActiveFlickyOracles(
  client: SuiClient,
): Promise<Record<string, FlickyOracleInfo | null>> {
  const out: Record<string, FlickyOracleInfo | null> = {
    BTC: null,
    ETH: null,
    SOL: null,
    SUI: null,
  }
  const evts = await client.queryEvents({
    query: { MoveEventType: `${CONFIG.packageId}::oracle::OracleCreated` },
    limit: 50,
    order: "descending",
  })
  // Group event candidates per asset, then resolve state for each. We only
  // need the freshest unsettled, unexpired oracle per asset; everything
  // older is read by existing duels via their pinned card.oracleId.
  const candidates: Array<{ id: string; asset: string; expiry: number }> = []
  const now = Date.now()
  const seenAssets = new Set<string>()
  for (const e of evts.data) {
    const p = e.parsedJson as { oracle_id: string; asset: string; expiry: string }
    if (!(p.asset in out)) continue
    const expiry = Number(p.expiry)
    if (expiry <= now) continue
    // Take only the first (freshest) per asset for now; we'll verify state
    // below and fall back to the next if the first turns out settled.
    if (seenAssets.has(p.asset)) continue
    seenAssets.add(p.asset)
    candidates.push({ id: normalizeSuiObjectId(p.oracle_id), asset: p.asset, expiry })
  }
  if (candidates.length === 0) return out

  const objs = await client.multiGetObjects({
    ids: candidates.map((c) => c.id),
    options: { showContent: true },
  })
  for (let i = 0; i < candidates.length; i++) {
    const obj = objs[i]
    if (obj.data?.content?.dataType !== "moveObject") continue
    const f = obj.data.content.fields as {
      settlement: unknown
      price: { fields: { spot: string } }
    }
    if (f.settlement !== null) continue
    out[candidates[i].asset] = {
      id: candidates[i].id,
      asset: candidates[i].asset,
      expiry: BigInt(candidates[i].expiry),
      isSettled: false,
      spot: BigInt(f.price.fields.spot),
    }
  }
  return out
}

// === Strike-grid helpers ===

/**
 * Build 5 strikes spaced around spot at percentile targets, snapped to the
 * oracle's tick grid.
 */
export async function buildDefaultStrikes(
  client: SuiClient,
  oracleId: string,
): Promise<bigint[]> {
  const obj = await client.getObject({ id: oracleId, options: { showContent: true } })
  if (obj.data?.content?.dataType !== "moveObject") {
    throw new Error("oracle not a Move object")
  }
  const f = obj.data.content.fields as Record<string, unknown>
  const minStrike = BigInt(String(f.min_strike))
  const tickSize = BigInt(String(f.tick_size))
  const spot = BigInt((f.price as { fields: { spot: string } }).fields.spot)

  const pcts = [90n, 95n, 100n, 105n, 110n]
  return pcts.map((pct) => {
    const raw = (spot * pct) / 100n
    const stepsFromMin = (raw - minStrike) / tickSize
    return minStrike + stepsFromMin * tickSize
  })
}
