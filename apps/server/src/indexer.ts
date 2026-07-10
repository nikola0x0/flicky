/**
 * Duel event indexer — cursor-driven, persistent.
 *
 * One cursor per event-type tracker is stored in SQLite
 * (`event_cursor` table; see `./db.ts`). Each tick:
 *
 *   for each tracker:
 *     queryEvents({ cursor: stored, order: "ascending", limit })
 *     collect unique duel ids touched by this batch
 *     save nextCursor
 *     if hasNextPage: keep going on this tracker before sleeping
 *   refresh every touched duel once, broadcast `room_state` to subs
 *
 * First-boot behavior: when a tracker has no stored cursor, we seed it
 * with the latest event id (descending limit 1) so the indexer skips
 * historical replay. The keeper has its own sweep that picks up any
 * still-active duels missed by the indexer cold-start.
 *
 * Why polling (not subscribeEvent): public JSON-RPC endpoints on
 * testnet don't expose `subscribeEvent` reliably. Polling on the
 * cadence below is the canonical Sui pattern (see
 * MystenLabs/sui/examples/trading/api/indexer/event-indexer.ts).
 */
import type { SuiGrpcClient } from "@mysten/sui/grpc"
import { normalizeSuiObjectId } from "@mysten/sui/utils"
import { env } from "./env"
import { getGraphQLClient } from "./lib/sui"
import {
  getDuel,
  getMarketSettlement,
  getOrderPremium,
  loadCursor,
  saveCursor,
  saveMarketSettlement,
  saveOrderPremium,
  setDuelWinner,
  upsertDuel,
  type CardOutcome,
} from "./db"
import { makeLogger, shortId } from "./log"
import { applyDuelOutcome } from "./mmr"
import {
  broadcastRoom,
  sendToAddresses,
  takeMatchedPair,
} from "./ws/matchmaking"

const log = makeLogger("indexer")

// GraphQL replaces JSON-RPC queryEvents (gRPC has no filtered event
// pagination). `first`/`after` drains forward; `last: 1` seeds to head.
const EVENTS_QUERY = `query Ev($type: String!, $after: String, $first: Int, $last: Int) {
  events(filter: { type: $type }, after: $after, first: $first, last: $last) {
    pageInfo { hasNextPage endCursor }
    nodes { contents { json } }
  }
}`

type GraphQLEventsResult = {
  data?: {
    events?: {
      pageInfo?: { hasNextPage: boolean; endCursor: string | null }
      nodes?: Array<{ contents: { json: Record<string, unknown> } }>
    }
  }
}

function eventName(fullType: string): string {
  return fullType.split("::").pop() ?? fullType
}

function describeError(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as { code?: string }).code
    return code ? `${e.message} [${code}]` : e.message
  }
  return String(e)
}

const STATUS_MAP: Record<string, "PENDING" | "ACTIVE" | "COMPLETE"> = {
  "1": "PENDING",
  "2": "ACTIVE",
  "3": "COMPLETE",
}

interface DuelLite {
  id: string
  status: "PENDING" | "ACTIVE" | "COMPLETE"
  stakeCoinType: string
  creator: string
  challenger: string
  cardsRevealed: boolean
  cardCount: number
  settledCount: number
  /**
   * Revealed deck. Empty array until `DeckRevealed` lands on chain;
   * one entry per slot (5 once revealed). Each card carries the 6-24
   * `ExpiryMarket` id and the strike. Web UI uses these to render the
   * swipe deck and look up per-card market ticks.
   */
  cards: Array<{ expiry_market_id: string; strike: string }>
  p0Payout: bigint
  p0Premium: bigint
  p1Payout: bigint
  p1Premium: bigint
  startedAtMs: bigint
  cardOutcomes: CardOutcome[]
  /**
   * Per-card swipes (settled or not). Exposed alongside `cardOutcomes`
   * so the UI can render running PnL — premium paid so far + which
   * direction each player swiped — without waiting for settlement,
   * and so F5 hydrates the local view of "what have I swiped" from
   * the chain. One entry per card slot that has at least one swipe.
   */
  swipes: PendingSwipe[]
}

interface PendingSwipe {
  cardIdx: number
  p0Swipe: { isUp: boolean; quantity: string; orderId: string } | null
  p1Swipe: { isUp: boolean; quantity: string; orderId: string } | null
}

interface CardRaw {
  expiry_market_id?: string
  strike?: string
}

interface SwipeRaw {
  is_up?: boolean
  quantity?: string
  order_id?: string
}

type SwipeSnap = { isUp: boolean; quantity: string; orderId: string }

function parseSwipeRaw(raw: unknown): SwipeSnap | null {
  if (raw === null || raw === undefined) return null
  const s = raw as SwipeRaw
  if (s.is_up === undefined) return null
  return {
    isUp: !!s.is_up,
    quantity: String(s.quantity ?? "0"),
    orderId: String(s.order_id ?? "0"),
  }
}

/**
 * Compute per-card real PnL for a player. Mirrors the contract's
 * `finalize` scoring: `payout = (correct ? quantity : 0); pnl = payout - premium`.
 * Premium is looked up from the `order_premiums` mirror (populated by the
 * `OrderMinted` tracker) by `(expiryMarketId, swipe.orderId)` — best-effort:
 * missing entries (mirror hasn't caught up, or a free-tier swipe with
 * `orderId === "0"`) default to `0`. This is a live UI preview only; the
 * authoritative premium is keeper-fed into `settle_card` at settle time.
 * Signed decimal string. Returns null if the player didn't swipe.
 */
function computePnl(
  swipe: SwipeSnap | null,
  upWon: boolean,
  expiryMarketId: string,
  orderPremiums: Map<string, string>
): string | null {
  if (!swipe) return null
  const q = BigInt(swipe.quantity)
  const p = BigInt(
    orderPremiums.get(`${expiryMarketId}:${swipe.orderId}`) ?? "0"
  )
  const correct = swipe.isUp === upWon
  const payout = correct ? q : 0n
  const pnl = payout - p
  return pnl.toString()
}

export interface CardOutcomeInput {
  cards: Array<{ expiry_market_id: string; strike: string }>
  p0Swipes: Array<SwipeSnap | null>
  p1Swipes: Array<SwipeSnap | null>
  /**
   * Settled prices keyed by `expiry_market_id` (base-10 string). Only
   * contains markets that have settled — cards whose market isn't in the
   * map are omitted from the output.
   */
  expiryMarketSettlements: Map<string, string>
  /**
   * `net_premium` (base-10 string) keyed by `${expiry_market_id}:${order_id}`.
   * Missing entries are treated as `0` premium (see `computePnl`).
   */
  orderPremiums: Map<string, string>
}

/**
 * Project per-card outcomes deterministically. For each card whose
 * expiry market has settled, compute `upWon` (strict `>`, matching the
 * contract) and signed-decimal per-player PnL. Cards whose market hasn't
 * settled yet are omitted — the array grows as settlements roll in, even
 * before `settle_card` / `finalize` land. Pure / synchronous so it's
 * trivially testable.
 */
export function computeCardOutcomes(input: CardOutcomeInput): CardOutcome[] {
  const out: CardOutcome[] = []
  for (let i = 0; i < input.cards.length; i++) {
    const card = input.cards[i]
    const price = input.expiryMarketSettlements.get(card.expiry_market_id)
    if (price === undefined) continue
    const upWon = BigInt(price) > BigInt(card.strike)
    const p0Swipe = input.p0Swipes[i] ?? null
    const p1Swipe = input.p1Swipes[i] ?? null
    out.push({
      cardIdx: i,
      settlementPrice: price,
      strike: card.strike,
      upWon,
      p0Swipe,
      p1Swipe,
      p0Pnl: computePnl(
        p0Swipe,
        upWon,
        card.expiry_market_id,
        input.orderPremiums
      ),
      p1Pnl: computePnl(
        p1Swipe,
        upWon,
        card.expiry_market_id,
        input.orderPremiums
      ),
    })
  }
  return out
}

/**
 * Read settlement prices for a set of expiry markets from the
 * `market_settlements` Postgres mirror (populated by this indexer's own
 * `MarketSettled` tracker — see `drainMarketSettled`). Only markets with a
 * mirrored settlement end up in the returned map; callers treat "absent
 * key" as "not settled yet".
 *
 * Replaces the pre-6-24 on-chain `OracleSVI.settlement_price` read — 6-24
 * has no equivalent on-chain struct, so settlement only surfaces via the
 * `MarketSettled` event / the predict indexer's `/markets/{id}/state`.
 */
async function readExpiryMarketSettlements(
  expiryMarketIds: string[]
): Promise<Map<string, string>> {
  const unique = Array.from(new Set(expiryMarketIds.filter((x) => !!x)))
  if (unique.length === 0) return new Map()
  const out = new Map<string, string>()
  await Promise.all(
    unique.map(async (id) => {
      try {
        const row = await getMarketSettlement(id)
        if (row) out.set(id, row.settlementPrice)
      } catch (e) {
        log.warn(`readExpiryMarketSettlements(${id}): ${describeError(e)}`)
      }
    })
  )
  return out
}

/**
 * Read `net_premium` for every (expiryMarketId, orderId) pair referenced by
 * a duel's swipes, from the `order_premiums` Postgres mirror (populated by
 * this indexer's own `OrderMinted` tracker — see `drainOrderMinted`). Skips
 * `orderId === "0"` (free-tier swipes never mint, so there's no premium to
 * look up). Returned map is keyed `${expiryMarketId}:${orderId}` — see
 * `computePnl`.
 */
async function readOrderPremiumsForCards(
  cards: Array<{ expiry_market_id: string }>,
  p0Swipes: Array<SwipeSnap | null>,
  p1Swipes: Array<SwipeSnap | null>
): Promise<Map<string, string>> {
  const pairs = new Map<string, { expiryMarketId: string; orderId: string }>()
  for (let i = 0; i < cards.length; i++) {
    const expiryMarketId = cards[i].expiry_market_id
    for (const swipe of [p0Swipes[i], p1Swipes[i]]) {
      if (!swipe || swipe.orderId === "0") continue
      pairs.set(`${expiryMarketId}:${swipe.orderId}`, {
        expiryMarketId,
        orderId: swipe.orderId,
      })
    }
  }
  const out = new Map<string, string>()
  await Promise.all(
    Array.from(pairs.entries()).map(
      async ([key, { expiryMarketId, orderId }]) => {
        try {
          const premium = await getOrderPremium(expiryMarketId, orderId)
          if (premium !== null) out.set(key, premium)
        } catch (e) {
          log.warn(`readOrderPremiumsForCards(${key}): ${describeError(e)}`)
        }
      }
    )
  )
  return out
}

/**
 * Fetch a duel's on-chain state, project per-card outcomes, and return
 * the wire-ready `DuelLite`. Self-contained: reads the duel object, then
 * looks up each card's expiry-market settlement (+ each swipe's order
 * premium) from the Postgres mirrors this indexer maintains, then runs
 * the pure `computeCardOutcomes` projection. No `settlementPrice`
 * parameter — every card uses its OWN expiry market, which is the only
 * correct model for multi-market decks.
 *
 * Fallback: if per-card reads return nothing but the duel is already
 * COMPLETE on chain (e.g. we're mid-restart and the mirrors haven't
 * caught up), preserve whatever cardOutcomes the Postgres duel mirror
 * already computed so the per-card breakdown isn't blanked.
 */
async function fetchDuel(
  client: SuiGrpcClient,
  id: string
): Promise<DuelLite | null> {
  const obj = await client.core.getObject({
    objectId: id,
    include: { json: true },
  })
  const f = obj.object?.json as unknown as
    | {
        status: string
        creator: string
        challenger: string
        cards: CardRaw[]
        p0_payout?: string
        p0_premium?: string
        p1_payout?: string
        p1_premium?: string
        started_at_ms?: string
        p0_swipes?: unknown[]
        p1_swipes?: unknown[]
      }
    | undefined
  if (!f) return null
  const typeMatch = obj.object?.type?.match(/Duel<(.+)>$/)
  const cards = Array.isArray(f.cards) ? f.cards : []
  const status = STATUS_MAP[String(f.status)] ?? "PENDING"
  const p0SwipesRaw = f.p0_swipes ?? []
  const p1SwipesRaw = f.p1_swipes ?? []
  const swipes: PendingSwipe[] = []
  const swipeSlotCount = Math.max(
    p0SwipesRaw.length,
    p1SwipesRaw.length,
    cards.length
  )
  for (let i = 0; i < swipeSlotCount; i++) {
    const p0 = parseSwipeRaw(p0SwipesRaw[i])
    const p1 = parseSwipeRaw(p1SwipesRaw[i])
    if (p0 || p1) swipes.push({ cardIdx: i, p0Swipe: p0, p1Swipe: p1 })
  }
  const cardsLite = cards.map((c) => ({
    expiry_market_id: c.expiry_market_id
      ? normalizeSuiObjectId(c.expiry_market_id)
      : "",
    strike: c.strike ?? "0",
  }))
  // Bulk-read settlement price for every card's expiry market (mirror
  // populated by this indexer's own MarketSettled tracker) and the
  // net_premium for every minted order (mirror populated by the
  // OrderMinted tracker). Cards whose market isn't settled yet are simply
  // absent from the settlements map; the projection helper omits them.
  const p0SwipesParsed = p0SwipesRaw.map(parseSwipeRaw)
  const p1SwipesParsed = p1SwipesRaw.map(parseSwipeRaw)
  const expiryMarketSettlements =
    cardsLite.length > 0
      ? await readExpiryMarketSettlements(
          cardsLite.map((c) => c.expiry_market_id)
        )
      : new Map<string, string>()
  const orderPremiums =
    cardsLite.length > 0
      ? await readOrderPremiumsForCards(
          cardsLite,
          p0SwipesParsed,
          p1SwipesParsed
        )
      : new Map<string, string>()
  let cardOutcomes = computeCardOutcomes({
    cards: cardsLite,
    p0Swipes: p0SwipesParsed,
    p1Swipes: p1SwipesParsed,
    expiryMarketSettlements,
    orderPremiums,
  })
  // Restart / post-compaction fallback: if we got nothing fresh and the
  // duel is already COMPLETE, preserve mirror's outcomes.
  if (cardOutcomes.length === 0 && status === "COMPLETE") {
    try {
      cardOutcomes =
        (await getDuel(normalizeSuiObjectId(id)))?.cardOutcomes ?? []
    } catch {
      cardOutcomes = []
    }
  }
  return {
    id: normalizeSuiObjectId(id),
    status,
    stakeCoinType: typeMatch?.[1] ?? "0x2::sui::SUI",
    creator: f.creator,
    challenger: f.challenger,
    cardsRevealed: cards.length > 0,
    cardCount: cards.length,
    cards: cardsLite,
    settledCount: cardOutcomes.length,
    p0Payout: BigInt(f.p0_payout ?? "0"),
    p0Premium: BigInt(f.p0_premium ?? "0"),
    p1Payout: BigInt(f.p1_payout ?? "0"),
    p1Premium: BigInt(f.p1_premium ?? "0"),
    startedAtMs: BigInt(f.started_at_ms ?? "0"),
    cardOutcomes,
    swipes,
  }
}

export class DuelIndexer {
  private readonly client: SuiGrpcClient
  private readonly packageId: string
  private readonly eventTypes: string[]
  /**
   * DeepBook Predict package events, tracked independently of the flicky
   * duel trackers above — they aren't scoped to a `duel_id` (`touched` /
   * broadcast logic doesn't apply), just mirrored into small keyed
   * Postgres tables so `fetchDuel`'s per-card projection (and, in future,
   * the keeper) can read premium/settlement without re-deriving.
   */
  private readonly orderMintedType: string
  private readonly marketSettledType: string
  private readonly gql = getGraphQLClient()
  private stopped = false

  constructor(client: SuiGrpcClient, packageId: string) {
    this.client = client
    this.packageId = packageId
    this.eventTypes = [
      `${packageId}::duel::DuelCreated`,
      `${packageId}::duel::DuelJoined`,
      `${packageId}::duel::DeckRevealed`,
      `${packageId}::duel::SwipeRecorded`,
      // CardSettled fires once per `settle_card` call. Tracking it gives
      // WS subscribers a live "card N settled" push instead of waiting
      // for the eventual DuelFinalized event.
      `${packageId}::duel::CardSettled`,
      `${packageId}::duel::DuelFinalized`,
      // DuelRefunded / DuelForfeited terminate a duel without going
      // through `finalize`. Track so the DB mirror flips status to
      // COMPLETE and WS subscribers see the terminal state.
      `${packageId}::duel::DuelRefunded`,
      `${packageId}::duel::DuelForfeited`,
    ]
    this.orderMintedType = `${env.deepbookPredictPackageId}::order_events::OrderMinted`
    this.marketSettledType = `${env.deepbookPredictPackageId}::config_events::MarketSettled`
  }

  /**
   * First boot: skip historical replay by saving the latest event id as
   * the starting cursor. The keeper independently sweeps recent
   * DuelCreated events for backfill, so we don't lose live duels.
   */
  private async seedCursor(eventType: string): Promise<void> {
    if (await loadCursor(eventType)) return
    try {
      const res = (await this.gql.query({
        query: EVENTS_QUERY,
        variables: { type: eventType, after: null, first: null, last: 1 },
      })) as GraphQLEventsResult
      const end = res.data?.events?.pageInfo?.endCursor
      if (end) {
        await saveCursor(eventType, end)
        log.info(`seed ${eventName(eventType)} @ ${end.slice(0, 10)}…`)
      }
    } catch (e) {
      log.warn(`seed ${eventName(eventType)}: ${describeError(e)}`)
    }
  }

  /**
   * Drain one tracker until `hasNextPage` is false or we hit a soft cap.
   * Returns the unique set of duel ids touched while draining + the
   * `DuelFinalized` events seen this drain (used by `tick` to apply MMR).
   */
  private async drainTracker(
    eventType: string,
    touched: Set<string>,
    finalized: Array<{
      duelId: string
      p0: string | null
      p1: string | null
      winner: string
      settlementPrice: string | null
    }>
  ): Promise<void> {
    let cursor: string | null = await loadCursor(eventType)
    // Soft cap: at most 10 pages per tracker per tick. Prevents one
    // overflowing tracker from starving the others.
    for (let page = 0; page < 10; page++) {
      const res = (await this.gql.query({
        query: EVENTS_QUERY,
        variables: { type: eventType, after: cursor, first: 50, last: null },
      })) as GraphQLEventsResult
      const events = res.data?.events
      const nodes = events?.nodes ?? []
      if (nodes.length === 0) return
      for (const node of nodes) {
        const p = node.contents.json as Record<string, unknown> | undefined
        const id = p?.duel_id as string | undefined
        if (id) touched.add(normalizeSuiObjectId(id))
        // DuelCreated → look up the matched pair and push the duel id
        // to the challenger so they can immediately call join_duel
        // without waiting for an HTTP poll.
        if (eventType.endsWith("::DuelCreated") && p && id) {
          const duelId = normalizeSuiObjectId(id)
          const creator = p.creator as string | undefined
          if (creator) {
            const challengerAddr = takeMatchedPair(creator)
            if (challengerAddr) {
              sendToAddresses([challengerAddr], {
                type: "duel_assigned",
                duelId,
                creator,
              })
              log.info(
                `duel_assigned → ${shortId(challengerAddr)} duel=${shortId(duelId)}`
              )
            }
          }
        }
        // DuelFinalized carries `winner` + `primary_settlement_price`
        // (echo of card 0's settlement, as a proof anchor). We surface
        // the price + (winner, creator, challenger) so MMR can attribute
        // the result. creator/challenger aren't in the event — pull from
        // the mirror (written by DuelCreated). Per-card detail lives in
        // separate CardSettled events.
        if (eventType.endsWith("::DuelFinalized") && p && id) {
          const duelId = normalizeSuiObjectId(id)
          const winner = p.winner as string | undefined
          if (winner) {
            const settlementPrice =
              (p.primary_settlement_price as string | undefined) ?? null
            const row = await (async () => {
              try {
                return await getDuel(duelId)
              } catch {
                return null
              }
            })()
            finalized.push({
              duelId,
              p0: row?.creator ?? null,
              p1: row?.challenger ?? null,
              winner,
              settlementPrice,
            })
          }
        }
      }
      const end = events?.pageInfo?.endCursor
      if (end) {
        await saveCursor(eventType, end)
        cursor = end
      }
      if (!events?.pageInfo?.hasNextPage) return
    }
  }

  /**
   * Generic paginated drain for a tracker that isn't scoped to a duel id —
   * just hands each page's decoded event JSONs to `onPage` and advances /
   * persists the cursor. Shared by `drainOrderMinted` / `drainMarketSettled`
   * (the duel trackers keep their own `drainTracker` above since they carry
   * extra touched-duel / MMR-attribution semantics).
   */
  private async drainEvents(
    eventType: string,
    onPage: (nodes: Array<Record<string, unknown>>) => Promise<void>
  ): Promise<void> {
    let cursor: string | null = await loadCursor(eventType)
    for (let page = 0; page < 10; page++) {
      const res = (await this.gql.query({
        query: EVENTS_QUERY,
        variables: { type: eventType, after: cursor, first: 50, last: null },
      })) as GraphQLEventsResult
      const events = res.data?.events
      const nodes = events?.nodes ?? []
      if (nodes.length === 0) return
      const jsons = nodes
        .map((n) => n.contents.json)
        .filter((j): j is Record<string, unknown> => !!j)
      await onPage(jsons)
      const end = events?.pageInfo?.endCursor
      if (end) {
        await saveCursor(eventType, end)
        cursor = end
      }
      if (!events?.pageInfo?.hasNextPage) return
    }
  }

  /**
   * Mirror `deepbook_predict::order_events::OrderMinted` into
   * `order_premiums`, keyed `(expiry_market_id, order_id)` — feeds
   * `fetchDuel`'s live PnL preview (`readOrderPremiumsForCards`).
   */
  private async drainOrderMinted(): Promise<void> {
    await this.drainEvents(this.orderMintedType, async (nodes) => {
      for (const p of nodes) {
        const expiryMarketId = p.expiry_market_id as string | undefined
        const orderId = p.order_id as string | number | undefined
        const netPremium = p.net_premium as string | number | undefined
        if (
          !expiryMarketId ||
          orderId === undefined ||
          netPremium === undefined
        )
          continue
        try {
          await saveOrderPremium(
            normalizeSuiObjectId(expiryMarketId),
            String(orderId),
            String(netPremium)
          )
        } catch (e) {
          log.warn(`OrderMinted persist: ${describeError(e)}`)
        }
      }
    })
  }

  /**
   * Mirror `deepbook_predict::config_events::MarketSettled` into
   * `market_settlements`, keyed `expiry_market_id` — feeds `fetchDuel`'s
   * per-card settlement read (`readExpiryMarketSettlements`), replacing the
   * pre-6-24 on-chain `OracleSVI.settlement_price` read.
   */
  private async drainMarketSettled(): Promise<void> {
    await this.drainEvents(this.marketSettledType, async (nodes) => {
      for (const p of nodes) {
        const expiryMarketId = p.expiry_market_id as string | undefined
        const settlementPrice = p.settlement_price as
          | string
          | number
          | undefined
        const settledAtMs = p.settled_at_ms as string | number | undefined
        if (!expiryMarketId || settlementPrice === undefined) continue
        try {
          await saveMarketSettlement(
            normalizeSuiObjectId(expiryMarketId),
            String(settlementPrice),
            Number(settledAtMs ?? Date.now())
          )
        } catch (e) {
          log.warn(`MarketSettled persist: ${describeError(e)}`)
        }
      }
    })
  }

  async tick(): Promise<void> {
    const touched = new Set<string>()
    const finalized: Array<{
      duelId: string
      p0: string | null
      p1: string | null
      winner: string
      settlementPrice: string | null
    }> = []
    for (const t of this.eventTypes) {
      try {
        await this.drainTracker(t, touched, finalized)
      } catch (e) {
        // Per-tracker, per-error-class log. db.ts already logs the SQLite
        // detail; here we just attach which tracker was running so a
        // sustained failure points at the right call site.
        log.warn(`${eventName(t)}: ${describeError(e)}`)
      }
    }
    try {
      await this.drainOrderMinted()
    } catch (e) {
      log.warn(`OrderMinted: ${describeError(e)}`)
    }
    try {
      await this.drainMarketSettled()
    } catch (e) {
      log.warn(`MarketSettled: ${describeError(e)}`)
    }
    // refreshDuel now reads each card's expiry-market settlement from the
    // `market_settlements` mirror populated above, so we no longer need to
    // thread the DuelFinalized event's `settlement_price` through here. The
    // `finalized` array is still used below for MMR attribution.
    for (const duelId of touched) {
      try {
        await this.refreshDuel(duelId)
      } catch (e) {
        log.warn(`refresh ${shortId(duelId)}: ${describeError(e)}`)
      }
    }
    // Apply ELO updates after the mirror is refreshed so leaderboard
    // reflects the same `last_updated_ms` window.
    for (const f of finalized) {
      if (!f.p0 || !f.p1) continue // mirror missing players — skip MMR
      // DuelFinalized carries `winner` directly (or @0x0 for tie).
      const outcome: "p0_win" | "p1_win" | "tie" =
        f.winner ===
          "0x0000000000000000000000000000000000000000000000000000000000000000" ||
        f.winner === "0x0"
          ? "tie"
          : f.winner === f.p0
            ? "p0_win"
            : "p1_win"
      // Persist the authoritative result onto the duel mirror so read
      // surfaces (home card, history, leaderboard backfill) classify
      // win/loss the same way the MMR does — instead of each re-deriving
      // it from payouts and disagreeing on close duels.
      try {
        await setDuelWinner(
          f.duelId,
          outcome === "p0_win" ? "p0" : outcome === "p1_win" ? "p1" : "tie"
        )
      } catch (e) {
        log.warn(`setWinner ${shortId(f.duelId)}: ${describeError(e)}`)
      }
      try {
        await applyDuelOutcome(f.p0, f.p1, outcome)
      } catch (e) {
        log.warn(`mmr ${shortId(f.duelId)}: ${describeError(e)}`)
      }
    }
  }

  private async refreshDuel(duelId: string): Promise<void> {
    const d = await fetchDuel(this.client, duelId)
    if (!d) return
    // Mirror to SQLite so /duels endpoints can serve without re-hitting
    // chain. Best-effort: a DB failure shouldn't block the broadcast.
    try {
      await upsertDuel({
        id: d.id,
        status: d.status,
        stakeCoinType: d.stakeCoinType,
        creator: d.creator,
        challenger: d.challenger,
        cardsRevealed: d.cardsRevealed,
        cardCount: d.cardCount,
        settledCount: d.settledCount,
        p0Payout: d.p0Payout.toString(),
        p0Premium: d.p0Premium.toString(),
        p1Payout: d.p1Payout.toString(),
        p1Premium: d.p1Premium.toString(),
        startedAtMs: Number(d.startedAtMs),
        cardOutcomes: d.cardOutcomes,
        swipes: d.swipes,
        cards: d.cards,
      })
    } catch {
      // db.ts already logged the error with context.
    }
    broadcastRoom(duelId, {
      type: "room_state",
      duelId,
      status: d.status,
      cardsRevealed: d.cardsRevealed,
      cardCount: d.cardCount,
      cards: d.cards,
      settledCount: d.settledCount,
      p0Payout: d.p0Payout.toString(),
      p0Premium: d.p0Premium.toString(),
      p1Payout: d.p1Payout.toString(),
      p1Premium: d.p1Premium.toString(),
      startedAtMs: Number(d.startedAtMs),
      creator: d.creator,
      challenger: d.challenger,
      stakeCoinType: d.stakeCoinType,
      cardOutcomes: d.cardOutcomes,
      swipes: d.swipes,
    })
  }

  async start(): Promise<void> {
    for (const t of this.eventTypes) await this.seedCursor(t)
    await this.seedCursor(this.orderMintedType)
    await this.seedCursor(this.marketSettledType)
    log.info(
      `poll every ${env.indexerPollIntervalMs}ms across ${this.eventTypes.length + 2} trackers`
    )
    const loop = async () => {
      if (this.stopped) return
      try {
        await this.tick()
      } catch (e) {
        log.error(`tick: ${e instanceof Error ? e.message : String(e)}`)
      }
      setTimeout(loop, env.indexerPollIntervalMs)
    }
    void loop()
  }

  stop(): void {
    this.stopped = true
  }
}
