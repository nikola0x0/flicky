/**
 * Live oracle tick streaming — PRD §Match anatomy: "the UI streams live
 * oracle ticks, current marks ... until each card's expiry."
 *
 * Clients explicitly opt in by sending `oracle_subscribe { oracleIds }`.
 * The server tracks `oracleId → Set<ws>` and, every
 * `ORACLE_TICK_INTERVAL_MS`, batch-reads every currently-subscribed
 * oracle via `multiGetObjects` and broadcasts the latest spot/forward.
 *
 * Once an oracle settles (`settled === true` once, then on subsequent
 * ticks too — we keep streaming the settled view briefly so the UI can
 * paint the final mark), clients can `oracle_unsubscribe` to stop
 * receiving updates. Auto-unsubscribe happens on socket close.
 */
import type { ServerWebSocket } from "bun"
import { normalizeSuiObjectId } from "@mysten/sui/utils"
import { env } from "../env"
import { getSuiClient } from "../lib/sui"
import { makeLogger } from "../log"
import { _sendInternal, type SocketState } from "./matchmaking"

const log = makeLogger("oracle-stream")

type AnyWs = ServerWebSocket<SocketState>

const oracleSubscribers = new Map<string, Set<AnyWs>>()
let _interval: ReturnType<typeof setInterval> | null = null

export function subscribeOracles(ws: AnyWs, oracleIds: unknown): void {
  if (!Array.isArray(oracleIds)) {
    _sendInternal(ws, {
      type: "error",
      code: "bad_oracle_ids",
      message: "oracleIds must be a string array",
    })
    return
  }
  for (const idRaw of oracleIds) {
    if (typeof idRaw !== "string" || !idRaw.startsWith("0x")) continue
    const id = normalizeSuiObjectId(idRaw)
    let bucket = oracleSubscribers.get(id)
    if (!bucket) {
      bucket = new Set()
      oracleSubscribers.set(id, bucket)
    }
    bucket.add(ws)
    ws.data.subscribedOracles.add(id)
  }
}

export function unsubscribeOracles(ws: AnyWs, oracleIds: unknown): void {
  if (!Array.isArray(oracleIds)) return
  for (const idRaw of oracleIds) {
    if (typeof idRaw !== "string") continue
    const id = normalizeSuiObjectId(idRaw)
    cleanupOne(ws, id)
  }
}

export function onSocketCloseOracleStream(ws: AnyWs): void {
  for (const id of ws.data.subscribedOracles) cleanupOne(ws, id)
  ws.data.subscribedOracles.clear()
}

function cleanupOne(ws: AnyWs, oracleId: string): void {
  const bucket = oracleSubscribers.get(oracleId)
  if (!bucket) return
  bucket.delete(ws)
  if (bucket.size === 0) oracleSubscribers.delete(oracleId)
  ws.data.subscribedOracles.delete(oracleId)
}

export function startOracleStream(): void {
  if (_interval) return
  log.info(`tick every ${env.oracleTickIntervalMs}ms`)
  _interval = setInterval(() => {
    tick().catch((e) => log.warn(`tick: ${e instanceof Error ? e.message : String(e)}`))
  }, env.oracleTickIntervalMs)
}

export function stopOracleStream(): void {
  if (_interval) {
    clearInterval(_interval)
    _interval = null
  }
}

async function tick(): Promise<void> {
  const ids = Array.from(oracleSubscribers.keys())
  if (ids.length === 0) return
  const client = getSuiClient()
  const objs = await client.multiGetObjects({
    ids,
    options: { showContent: true },
  })
  const now = Date.now()
  for (const obj of objs) {
    if (obj.data?.content?.dataType !== "moveObject") continue
    const id = normalizeSuiObjectId(obj.data.objectId)
    const f = obj.data.content.fields as {
      expiry: string
      settlement_price: unknown
      prices: { fields: { spot: string; forward: string } }
    }
    const settled =
      f.settlement_price !== null && f.settlement_price !== undefined &&
      (typeof f.settlement_price === "string" ||
        (typeof f.settlement_price === "object" &&
          ((f.settlement_price as { fields?: { vec?: unknown[] } }).fields?.vec ?? [])
            .length > 0))
    const bucket = oracleSubscribers.get(id)
    if (!bucket || bucket.size === 0) continue
    const msg = JSON.stringify({
      type: "oracle_tick",
      oracleId: id,
      spot: f.prices.fields.spot,
      forward: f.prices.fields.forward,
      expiry: f.expiry,
      settled,
      timestampMs: now,
    })
    for (const ws of bucket) {
      try {
        ws.send(msg)
      } catch {
        // close handler will clean up
      }
    }
  }
  log.info(`pushed ticks for ${ids.length} oracle(s) to ${countSockets()} socket(s)`)
}

function countSockets(): number {
  let n = 0
  for (const s of oracleSubscribers.values()) n += s.size
  return n
}

export function oracleStreamStats(): { oracles: number; sockets: number } {
  return { oracles: oracleSubscribers.size, sockets: countSockets() }
}
