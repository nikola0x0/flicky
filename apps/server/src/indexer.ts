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
import type { SuiClient } from "@mysten/sui/client"
import { normalizeSuiObjectId } from "@mysten/sui/utils"
import { env } from "./env"
import {
  getDuel,
  loadCursor,
  mergeCardOutcome,
  saveCursor,
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
 * settle_card math: `payout = (correct ? quantity : 0); pnl = payout - premium`.
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

/**
 * Card settlements come back as either `string` (Some price), `null`
 * (None), or `{ fields: { vec: [price] } }` depending on how the Sui
 * RPC serialised the Move `Option<u64>`. `parseSettlement` normalises
 * all three.
 */
type SettlementRaw = string | null | { fields?: { vec?: unknown[] } }

function parseSettlement(s: unknown): string | null {
  if (s === null || s === undefined) return null
  if (typeof s === "string") return s
  if (typeof s === "object") {
    const vec = (s as { fields?: { vec?: unknown[] } }).fields?.vec
    if (Array.isArray(vec) && vec.length > 0) return String(vec[0])
  }
  return null
}

async function fetchDuel(client: SuiClient, id: string): Promise<DuelLite | null> {
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
    card_settlements: SettlementRaw[]
    p0_payout?: string
    p0_premium?: string
    p1_payout?: string
    p1_premium?: string
    started_at_ms?: string
    settled_count?: string
    p0_swipes?: unknown[]
    p1_swipes?: unknown[]
  }
  const typeMatch = obj.data.type?.match(/Duel<(.+)>$/)
  const cards = Array.isArray(f.cards) ? f.cards : []
  // Reconstruct per-card outcomes from the on-chain object. Cards in
  // the new contract carry `{oracle_id, strike}`; combined with the
  // settlement_price and each player's swipe (quantity + premium) we
  // can compute UP-won + real per-card PnL server-side so the UI
  // doesn't have to.
  const cardOutcomes: CardOutcome[] = []
  const settlements = f.card_settlements ?? []
  const p0SwipesRaw = f.p0_swipes ?? []
  const p1SwipesRaw = f.p1_swipes ?? []
  // All per-card swipes (settled or not). Powers running-PnL display
  // and F5 hydration in the panel. Settled cards still appear here
  // alongside the matching `cardOutcomes` entry — clients can join
  // by cardIdx.
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
  for (let i = 0; i < settlements.length; i++) {
    const price = parseSettlement(settlements[i])
    if (price === null) continue
    const strike = cards[i]?.fields?.strike ?? "0"
    const upWon = BigInt(price) > BigInt(strike)
    const p0Swipe = parseSwipeRaw(p0SwipesRaw[i])
    const p1Swipe = parseSwipeRaw(p1SwipesRaw[i])
    cardOutcomes.push({
      cardIdx: i,
      settlementPrice: price,
      strike,
      upWon,
      p0Swipe,
      p1Swipe,
      p0Pnl: computePnl(p0Swipe, upWon),
      p1Pnl: computePnl(p1Swipe, upWon),
    })
  }
  const settledCount =
    f.settled_count !== undefined
      ? Number(f.settled_count)
      : settlements.filter((s) => parseSettlement(s) !== null).length
  return {
    id: normalizeSuiObjectId(id),
    status: STATUS_MAP[String(f.status)] ?? "PENDING",
    stakeCoinType: typeMatch?.[1] ?? "0x2::sui::SUI",
    creator: f.creator,
    challenger: f.challenger,
    cardsRevealed: cards.length > 0,
    cardCount: cards.length,
    settledCount,
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
  private readonly client: SuiClient
  private readonly packageId: string
  private readonly eventTypes: string[]
  private stopped = false

  constructor(client: SuiClient, packageId: string) {
    this.client = client
    this.packageId = packageId
    this.eventTypes = [
      `${packageId}::duel::DuelCreated`,
      `${packageId}::duel::DuelJoined`,
      `${packageId}::duel::DeckRevealed`,
      `${packageId}::duel::SwipeRecorded`,
      `${packageId}::duel::CardSettled`,
      `${packageId}::duel::DuelFinalized`,
    ]
  }

  /**
   * First boot: skip historical replay by saving the latest event id as
   * the starting cursor. The keeper independently sweeps recent
   * DuelCreated events for backfill, so we don't lose live duels.
   */
  private async seedCursor(eventType: string): Promise<void> {
    if (loadCursor(eventType)) return
    try {
      const head = await this.client.queryEvents({
        query: { MoveEventType: eventType },
        limit: 1,
        order: "descending",
      })
      const e = head.data[0]
      if (e) {
        saveCursor(eventType, { txDigest: e.id.txDigest, eventSeq: e.id.eventSeq })
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
    finalized: Array<{ duelId: string; p0: string; p1: string; winner: string }>,
  ): Promise<void> {
    let cursor: EventCursor | null = loadCursor(eventType)
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
        // CardSettled (new contract) emits just `settlement_price` —
        // per-card scores are no longer in the event. We still mirror
        // the outcome eagerly using the strike from the duel's mirror
        // row; if the row isn't present yet, the next refreshDuel pass
        // backfills via on-chain read.
        if (eventType.endsWith("::CardSettled") && p && id) {
          const duelId = normalizeSuiObjectId(id)
          const cardIdxRaw = p.card_idx as string | number | undefined
          const settlementPrice = p.settlement_price as string | undefined
          if (cardIdxRaw !== undefined && settlementPrice !== undefined) {
            // The strike isn't in the event; we'll let refreshDuel
            // overwrite this entry with the authoritative strike. For
            // now write a partial outcome (strike=0, upWon=false) so
            // `settled_count` aligns with mirrored entries.
            try {
              mergeCardOutcome(duelId, {
                cardIdx: Number(cardIdxRaw),
                settlementPrice,
                strike: "0",
                upWon: false,
                p0Pnl: null,
                p1Pnl: null,
                p0Swipe: null,
                p1Swipe: null,
              })
            } catch {
              // db error logged inside db.ts
            }
          }
        }
        // DuelFinalized — new shape is { duel_id, winner, payout_to_p0, payout_to_p1 }.
        // We surface (winner, creator, challenger) so MMR can attribute
        // outcomes. `creator` + `challenger` aren't in the event; pull
        // from the mirror.
        if (eventType.endsWith("::DuelFinalized") && p && id) {
          const duelId = normalizeSuiObjectId(id)
          const winner = p.winner as string | undefined
          if (winner) {
            // Look up creator + challenger from the indexer mirror — by
            // the time DuelFinalized fires they're guaranteed to be in
            // the row (DuelCreated wrote them).
            const row = (() => {
              try {
                return getDuel(duelId)
              } catch {
                return null
              }
            })()
            if (row && row.creator && row.challenger) {
              finalized.push({
                duelId,
                p0: row.creator,
                p1: row.challenger,
                winner,
              })
            }
          }
        }
      }
      if (res.nextCursor) {
        const next: EventCursor = {
          txDigest: res.nextCursor.txDigest,
          eventSeq: res.nextCursor.eventSeq,
        }
        saveCursor(eventType, next)
        cursor = next
      }
      if (!res.hasNextPage) return
    }
  }

  async tick(): Promise<void> {
    const touched = new Set<string>()
    const finalized: Array<{ duelId: string; p0: string; p1: string; winner: string }> = []
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
      // DuelFinalized now carries `winner` directly (or @0x0 for tie).
      const outcome: "p0_win" | "p1_win" | "tie" =
        f.winner === "0x0000000000000000000000000000000000000000000000000000000000000000" ||
        f.winner === "0x0"
          ? "tie"
          : f.winner === f.p0
            ? "p0_win"
            : "p1_win"
      try {
        applyDuelOutcome(f.p0, f.p1, outcome)
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
      upsertDuel({
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
    log.info(`db=${env.dbPath}`)
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
