/**
 * Live oracle tick streaming — PRD §Match anatomy: "the UI streams live
 * oracle ticks, current marks ... until each card's expiry."
 *
 * Clients explicitly opt in by sending `oracle_subscribe { marketIds }`
 * (6-24: subscription ids are `ExpiryMarket` ids, not the pre-6-24
 * `OracleSVI` ids — renamed on the wire in Plan 2 Task 6). The server
 * tracks `expiryMarketId → Set<ws>` and, every `ORACLE_TICK_INTERVAL_MS`,
 * fetches each currently-subscribed market's state from the predict
 * indexer (`fetchMarketState`, shared with `oracle.ts`) and broadcasts the
 * latest spot + settlement.
 *
 * Once a market settles (`settlementPrice` goes non-null), clients can
 * `oracle_unsubscribe` to stop receiving updates. Auto-unsubscribe happens
 * on socket close.
 */
import type { ServerWebSocket } from "bun"
import { normalizeSuiObjectId } from "@mysten/sui/utils"
import { env } from "../env"
import { makeLogger } from "../log"
import { fetchMarketState } from "../oracle"
import { _sendInternal, type SocketState } from "./matchmaking"

const log = makeLogger("oracle-stream")

type AnyWs = ServerWebSocket<SocketState>

const marketSubscribers = new Map<string, Set<AnyWs>>()
let _interval: ReturnType<typeof setInterval> | null = null

export function subscribeOracles(ws: AnyWs, marketIds: unknown): void {
  if (!Array.isArray(marketIds)) {
    _sendInternal(ws, {
      type: "error",
      code: "bad_market_ids",
      message: "marketIds must be a string array",
    })
    return
  }
  for (const idRaw of marketIds) {
    if (typeof idRaw !== "string" || !idRaw.startsWith("0x")) continue
    const id = normalizeSuiObjectId(idRaw)
    let bucket = marketSubscribers.get(id)
    if (!bucket) {
      bucket = new Set()
      marketSubscribers.set(id, bucket)
    }
    bucket.add(ws)
    ws.data.subscribedOracles.add(id)
  }
}

export function unsubscribeOracles(ws: AnyWs, marketIds: unknown): void {
  if (!Array.isArray(marketIds)) return
  for (const idRaw of marketIds) {
    if (typeof idRaw !== "string") continue
    const id = normalizeSuiObjectId(idRaw)
    cleanupOne(ws, id)
  }
}

export function onSocketCloseOracleStream(ws: AnyWs): void {
  for (const id of ws.data.subscribedOracles) cleanupOne(ws, id)
  ws.data.subscribedOracles.clear()
}

function cleanupOne(ws: AnyWs, expiryMarketId: string): void {
  const bucket = marketSubscribers.get(expiryMarketId)
  if (!bucket) return
  bucket.delete(ws)
  if (bucket.size === 0) marketSubscribers.delete(expiryMarketId)
  ws.data.subscribedOracles.delete(expiryMarketId)
}

export function startOracleStream(): void {
  if (_interval) return
  log.info(`tick every ${env.oracleTickIntervalMs}ms`)
  _interval = setInterval(() => {
    tick().catch((e) =>
      log.warn(`tick: ${e instanceof Error ? e.message : String(e)}`)
    )
  }, env.oracleTickIntervalMs)
}

export function stopOracleStream(): void {
  if (_interval) {
    clearInterval(_interval)
    _interval = null
  }
}

async function tick(): Promise<void> {
  const ids = Array.from(marketSubscribers.keys())
  if (ids.length === 0) return
  const now = Date.now()
  let pushed = 0
  await Promise.all(
    ids.map(async (id) => {
      const bucket = marketSubscribers.get(id)
      if (!bucket || bucket.size === 0) return
      let state
      try {
        state = await fetchMarketState(id)
      } catch (e) {
        log.warn(`tick(${id}): ${e instanceof Error ? e.message : String(e)}`)
        return
      }
      if (!state) return
      const settlementPrice = state.settlement?.settlement_price ?? null
      const tickMsg = {
        type: "oracle_tick",
        expiryMarketId: id,
        spot: state.oracle_prices?.spot ?? "0",
        expiry: String(state.market?.expiry ?? "0"),
        settlementPrice,
        timestampMs: now,
      }
      const wire = JSON.stringify(tickMsg)
      for (const ws of bucket) {
        try {
          ws.send(wire)
        } catch {
          // close handler will clean up
        }
      }
      pushed++
    })
  )
  log.info(
    `pushed ticks for ${pushed}/${ids.length} market(s) to ${countSockets()} socket(s)`
  )
}

function countSockets(): number {
  let n = 0
  for (const s of marketSubscribers.values()) n += s.size
  return n
}

export function oracleStreamStats(): { oracles: number; sockets: number } {
  return { oracles: marketSubscribers.size, sockets: countSockets() }
}
