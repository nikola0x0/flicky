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
  loadCursor,
  mergeCardOutcome,
  saveCursor,
  upsertDuel,
  type CardOutcome,
  type EventCursor,
} from "./db"
import { makeLogger, shortId } from "./log"
import { applyDuelOutcome } from "./mmr"
import { broadcastRoom } from "./ws/matchmaking"

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
  p0Score: bigint
  p1Score: bigint
  cardOutcomes: CardOutcome[]
}

async function fetchDuel(client: SuiClient, id: string): Promise<DuelLite | null> {
  const obj = await client.getObject({
    id,
    options: { showContent: true, showType: true },
  })
  if (obj.data?.content?.dataType !== "moveObject") return null
  const f = obj.data.content.fields as {
    status: string
    creator: string
    challenger: string
    cards: unknown[]
    card_settlements: Array<string | null>
    p0_score: string
    p1_score: string
    // Per-card scoring fields emitted by the contract on settle_card.
    // The shape varies between contract revisions; older versions may
    // omit per-card score vectors and only emit them via events.
    p0_card_scores?: string[]
    p1_card_scores?: string[]
  }
  const typeMatch = obj.data.type?.match(/Duel<(.+)>$/)
  const cards = Array.isArray(f.cards) ? f.cards : []
  // Reconstruct per-card outcomes from the on-chain object. Each entry
  // exists only for settled cards (card_settlements[i] != null).
  const cardOutcomes: CardOutcome[] = []
  const settlements = f.card_settlements ?? []
  for (let i = 0; i < settlements.length; i++) {
    const s = settlements[i]
    if (s === null || s === undefined) continue
    cardOutcomes.push({
      cardIdx: i,
      settlementPrice: String(s),
      p0CardScore: String(f.p0_card_scores?.[i] ?? "0"),
      p1CardScore: String(f.p1_card_scores?.[i] ?? "0"),
    })
  }
  return {
    id: normalizeSuiObjectId(id),
    status: STATUS_MAP[String(f.status)] ?? "PENDING",
    stakeCoinType: typeMatch?.[1] ?? "0x2::sui::SUI",
    creator: f.creator,
    challenger: f.challenger,
    cardsRevealed: cards.length > 0,
    cardCount: cards.length,
    settledCount: settlements.filter((s) => s !== null).length,
    p0Score: BigInt(f.p0_score ?? "0"),
    p1Score: BigInt(f.p1_score ?? "0"),
    cardOutcomes,
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
    finalized: Array<{ duelId: string; p0: string; p1: string; p0Score: bigint; p1Score: bigint }>,
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
        // CardSettled carries per-card outcome data — write it to the
        // mirror immediately so /duels/{id} reflects it without waiting
        // for the next refresh. The subsequent refreshDuel still runs
        // and re-reads from chain, overwriting these with authoritative
        // values (which should match).
        if (eventType.endsWith("::CardSettled") && p && id) {
          const duelId = normalizeSuiObjectId(id)
          const cardIdxRaw = p.card_idx as string | number | undefined
          const settlementPrice = p.settlement_price as string | undefined
          const p0CardScore = p.p0_card_score as string | undefined
          const p1CardScore = p.p1_card_score as string | undefined
          if (
            cardIdxRaw !== undefined &&
            settlementPrice !== undefined &&
            p0CardScore !== undefined &&
            p1CardScore !== undefined
          ) {
            try {
              mergeCardOutcome(duelId, {
                cardIdx: Number(cardIdxRaw),
                settlementPrice,
                p0CardScore,
                p1CardScore,
              })
            } catch {
              // db error logged inside db.ts
            }
          }
        }
        // DuelFinalized carries the scores + (creator, challenger) we
        // need for MMR. Surface it to the caller.
        if (eventType.endsWith("::DuelFinalized") && p) {
          const duelId = id ? normalizeSuiObjectId(id) : null
          const p0 = (p.creator ?? p.p0) as string | undefined
          const p1 = (p.challenger ?? p.p1) as string | undefined
          const p0Score = p.p0_score as string | undefined
          const p1Score = p.p1_score as string | undefined
          if (duelId && p0 && p1 && p0Score !== undefined && p1Score !== undefined) {
            finalized.push({
              duelId,
              p0,
              p1,
              p0Score: BigInt(p0Score),
              p1Score: BigInt(p1Score),
            })
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
    const finalized: Array<{ duelId: string; p0: string; p1: string; p0Score: bigint; p1Score: bigint }> = []
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
      const outcome =
        f.p0Score > f.p1Score ? "p0_win" : f.p1Score > f.p0Score ? "p1_win" : "tie"
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
        p0Score: d.p0Score.toString(),
        p1Score: d.p1Score.toString(),
        cardOutcomes: d.cardOutcomes,
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
      p0Score: d.p0Score.toString(),
      p1Score: d.p1Score.toString(),
      creator: d.creator,
      challenger: d.challenger,
      stakeCoinType: d.stakeCoinType,
      cardOutcomes: d.cardOutcomes,
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
