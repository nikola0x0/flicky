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
import {
  getDuel,
  loadCursor,
  saveCursor,
  setDuelWinner,
  upsertDuel,
  type CardOutcome,
  type EventCursor,
} from "./db"
import { makeLogger, shortId } from "./log"
import { applyDuelOutcome } from "./mmr"
import {
  broadcastRoom,
  sendToAddresses,
  takeMatchedPair,
} from "./ws/matchmaking"

const log = makeLogger("indexer")

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
   * one entry per slot (5 once revealed). Each card carries the
   * DeepBook `OracleSVI` id and the strike. Web UI uses these to
   * render the swipe deck and look up per-card oracle ticks.
   */
  cards: Array<{ oracle_id: string; strike: string }>
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
  p0Swipe: { isUp: boolean; quantity: string; premium: string } | null
  p1Swipe: { isUp: boolean; quantity: string; premium: string } | null
}

interface CardRaw {
  fields?: { oracle_id?: string; strike?: string }
}

interface SwipeRaw {
  fields?: { is_up?: boolean; quantity?: string; premium?: string }
}

function parseSwipeRaw(raw: unknown): { isUp: boolean; quantity: string; premium: string } | null {
  if (raw === null || raw === undefined) return null
  const s = raw as SwipeRaw
  if (!s.fields || s.fields.is_up === undefined) return null
  return {
    isUp: !!s.fields.is_up,
    quantity: String(s.fields.quantity ?? "0"),
    premium: String(s.fields.premium ?? "0"),
  }
}

/**
 * Compute per-card real PnL for a player. Mirrors the contract's
 * `finalize` scoring: `payout = (correct ? quantity : 0); pnl = payout - premium`.
 * Signed decimal string. Returns null if the player didn't swipe.
 */
function computePnl(
  swipe: { isUp: boolean; quantity: string; premium: string } | null,
  upWon: boolean,
): string | null {
  if (!swipe) return null
  const q = BigInt(swipe.quantity)
  const p = BigInt(swipe.premium)
  const correct = swipe.isUp === upWon
  const payout = correct ? q : 0n
  const pnl = payout - p
  return pnl.toString()
}

export interface CardOutcomeInput {
  cards: Array<{ oracle_id: string; strike: string }>
  p0Swipes: Array<
    { isUp: boolean; quantity: string; premium: string } | null
  >
  p1Swipes: Array<
    { isUp: boolean; quantity: string; premium: string } | null
  >
  /**
   * Settled prices keyed by oracle id (base-10 string). Only contains
   * oracles whose `settlement_price.is_some()` — cards whose oracle
   * isn't in the map are omitted from the output.
   */
  oracleSettlements: Map<string, string>
}

/**
 * Project per-card outcomes deterministically. For each card whose
 * oracle has settled, compute `upWon` (strict `>`, matching the
 * contract) and signed-decimal per-player PnL. Cards whose oracle
 * hasn't settled yet are omitted — the array grows as settlements
 * roll in, even before `settle_card` / `finalize` land. Pure / synchronous so
 * it's trivially testable.
 */
export function computeCardOutcomes(input: CardOutcomeInput): CardOutcome[] {
  const out: CardOutcome[] = []
  for (let i = 0; i < input.cards.length; i++) {
    const card = input.cards[i]
    const price = input.oracleSettlements.get(card.oracle_id)
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
      p0Pnl: computePnl(p0Swipe, upWon),
      p1Pnl: computePnl(p1Swipe, upWon),
    })
  }
  return out
}

/**
 * Read `settlement_price` for each oracle id passed in. Only entries
 * whose price is `Some` end up in the returned map — callers can treat
 * "absent key" as "not settled yet".
 *
 * `OracleSVI.settlement_price` is `Option<u64>`. Sui RPC encodes
 * `Some(x)` as `{ fields: { vec: [x] } }` and `None` as either a missing
 * key or `{ fields: { vec: [] } }`. We accept both shapes (and a bare
 * string in case a future RPC version unwraps it) defensively.
 */
async function readOracleSettlements(
  client: SuiGrpcClient,
  oracleIds: string[],
): Promise<Map<string, string>> {
  const unique = Array.from(new Set(oracleIds.filter((x) => !!x)))
  if (unique.length === 0) return new Map()
  const objs = await client.multiGetObjects({
    ids: unique,
    options: { showContent: true },
  })
  const out = new Map<string, string>()
  for (const o of objs) {
    if (o.data?.content?.dataType !== "moveObject") continue
    const oid = o.data.objectId
    if (!oid) continue
    const fields = o.data.content.fields as {
      settlement_price?:
        | { fields?: { vec?: string[] } }
        | string
        | null
    }
    const sp = fields.settlement_price
    let price: string | undefined
    if (typeof sp === "string") {
      price = sp
    } else if (sp && typeof sp === "object") {
      const vec = sp.fields?.vec ?? []
      if (vec.length > 0) price = vec[0]
    }
    if (price !== undefined) out.set(normalizeSuiObjectId(oid), price)
  }
  return out
}

/**
 * Fetch a duel's on-chain state, project per-card outcomes, and return
 * the wire-ready `DuelLite`. Self-contained: reads the duel object,
 * then bulk-reads each card's `OracleSVI` for `settlement_price`, then
 * runs the pure `computeCardOutcomes` projection. No `settlementPrice`
 * parameter — every card uses its OWN oracle, which is the only correct
 * model for multi-oracle decks.
 *
 * Fallback: if per-card reads return nothing but the duel is already
 * COMPLETE on chain (e.g. oracles were compacted post-settle, or we're
 * mid-restart), preserve whatever cardOutcomes the SQLite mirror
 * already computed so the per-card breakdown isn't blanked.
 */
async function fetchDuel(
  client: SuiGrpcClient,
  id: string,
): Promise<DuelLite | null> {
  const obj = await client.getObject({
    id,
    options: { showContent: true, showType: true },
  })
  if (obj.data?.content?.dataType !== "moveObject") return null
  const f = obj.data.content.fields as unknown as {
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
  const typeMatch = obj.data.type?.match(/Duel<(.+)>$/)
  const cards = Array.isArray(f.cards) ? f.cards : []
  const status = STATUS_MAP[String(f.status)] ?? "PENDING"
  const p0SwipesRaw = f.p0_swipes ?? []
  const p1SwipesRaw = f.p1_swipes ?? []
  const swipes: PendingSwipe[] = []
  const swipeSlotCount = Math.max(
    p0SwipesRaw.length,
    p1SwipesRaw.length,
    cards.length,
  )
  for (let i = 0; i < swipeSlotCount; i++) {
    const p0 = parseSwipeRaw(p0SwipesRaw[i])
    const p1 = parseSwipeRaw(p1SwipesRaw[i])
    if (p0 || p1) swipes.push({ cardIdx: i, p0Swipe: p0, p1Swipe: p1 })
  }
  const cardsLite = cards.map((c) => ({
    oracle_id: c.fields?.oracle_id
      ? normalizeSuiObjectId(c.fields.oracle_id)
      : "",
    strike: c.fields?.strike ?? "0",
  }))
  // Bulk-read settlement_price for every card's oracle. Cards whose
  // oracle isn't settled yet are simply absent from the map; the
  // projection helper omits them.
  const oracleSettlements =
    cardsLite.length > 0
      ? await readOracleSettlements(
          client,
          cardsLite.map((c) => c.oracle_id),
        )
      : new Map<string, string>()
  const p0SwipesParsed = p0SwipesRaw.map(parseSwipeRaw)
  const p1SwipesParsed = p1SwipesRaw.map(parseSwipeRaw)
  let cardOutcomes = computeCardOutcomes({
    cards: cardsLite,
    p0Swipes: p0SwipesParsed,
    p1Swipes: p1SwipesParsed,
    oracleSettlements,
  })
  // Restart / post-compaction fallback: if we got nothing fresh and the
  // duel is already COMPLETE, preserve mirror's outcomes.
  if (cardOutcomes.length === 0 && status === "COMPLETE") {
    try {
      cardOutcomes = (await getDuel(normalizeSuiObjectId(id)))?.cardOutcomes ?? []
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
  }

  /**
   * First boot: skip historical replay by saving the latest event id as
   * the starting cursor. The keeper independently sweeps recent
   * DuelCreated events for backfill, so we don't lose live duels.
   */
  private async seedCursor(eventType: string): Promise<void> {
    if (await loadCursor(eventType)) return
    try {
      const head = await this.client.queryEvents({
        query: { MoveEventType: eventType },
        limit: 1,
        order: "descending",
      })
      const e = head.data[0]
      if (e) {
        await saveCursor(eventType, { txDigest: e.id.txDigest, eventSeq: e.id.eventSeq })
        log.info(`seed ${eventName(eventType)} @ ${shortId(e.id.txDigest)}/${e.id.eventSeq}`)
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
    }>,
  ): Promise<void> {
    let cursor: EventCursor | null = await loadCursor(eventType)
    // Soft cap: at most 10 pages per tracker per tick. Prevents one
    // overflowing tracker from starving the others.
    for (let page = 0; page < 10; page++) {
      const res = await this.client.queryEvents({
        query: { MoveEventType: eventType },
        cursor,
        order: "ascending",
        limit: 50,
      })
      if (res.data.length === 0) return
      for (const e of res.data) {
        const p = e.parsedJson as Record<string, unknown> | undefined
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
                `duel_assigned → ${shortId(challengerAddr)} duel=${shortId(duelId)}`,
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
      if (res.nextCursor) {
        const next: EventCursor = {
          txDigest: res.nextCursor.txDigest,
          eventSeq: res.nextCursor.eventSeq,
        }
        await saveCursor(eventType, next)
        cursor = next
      }
      if (!res.hasNextPage) return
    }
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
    // refreshDuel now self-reads each card's oracle for
    // settlement_price, so we no longer need to thread the
    // DuelFinalized event's `settlement_price` through here. The
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
        f.winner === "0x0000000000000000000000000000000000000000000000000000000000000000" ||
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
          outcome === "p0_win" ? "p0" : outcome === "p1_win" ? "p1" : "tie",
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
    log.info(`poll every ${env.indexerPollIntervalMs}ms across ${this.eventTypes.length} trackers`)
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
