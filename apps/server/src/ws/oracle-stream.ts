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

interface SviParams {
  a: string
  b: string
  rho: string
  m: string
  sigma: string
}

/**
 * Best-effort SVI extraction. DeepBook's `OracleSVI` exposes the
 * 5-tuple `(a, b, rho, m, sigma)` in 1e9 fixed point under one of two
 * shapes depending on Move struct layout: either flat fields on the
 * oracle, or nested under `svi` / `block_scholes_svi`. We try both.
 * Returns null when the layout doesn't carry SVI.
 */
function parseSvi(fields: Record<string, unknown>): SviParams | null {
  const candidates = [fields.svi, fields.block_scholes_svi, fields]
  for (const c of candidates) {
    if (!c || typeof c !== "object") continue
    const f = (c as { fields?: Record<string, unknown> }).fields ?? (c as Record<string, unknown>)
    const { a, b, rho, m, sigma } = f as Record<string, unknown>
    if (
      typeof a === "string" && typeof b === "string" && typeof rho === "string" &&
      typeof m === "string" && typeof sigma === "string"
    ) {
      return { a, b, rho, m, sigma }
    }
  }
  return null
}

async function tick(): Promise<void> {
  const ids = Array.from(oracleSubscribers.keys())
  if (ids.length === 0) return
  const client = getSuiClient()
  const res = await client.core.getObjects({
    objectIds: ids,
    include: { json: true },
  })
  const now = Date.now()
  for (const obj of res.objects) {
    if (obj instanceof Error || !obj.json) continue
    const id = normalizeSuiObjectId(obj.objectId)
    const f = obj.json as {
      expiry: string
      settlement_price: unknown
      prices: { spot: string; forward: string }
    }
    const settled =
      f.settlement_price !== null && f.settlement_price !== undefined &&
      (typeof f.settlement_price === "string" ||
        (typeof f.settlement_price === "object" &&
          ((f.settlement_price as { fields?: { vec?: unknown[] } }).fields?.vec ?? [])
            .length > 0))
    const svi = parseSvi(obj.json as Record<string, unknown>)
    const bucket = oracleSubscribers.get(id)
    if (!bucket || bucket.size === 0) continue
    const tickMsg: Record<string, unknown> = {
      type: "oracle_tick",
      oracleId: id,
      spot: f.prices.spot,
      forward: f.prices.forward,
      expiry: f.expiry,
      settled,
      timestampMs: now,
    }
    if (svi) tickMsg.svi = svi
    const wire = JSON.stringify(tickMsg)
    for (const ws of bucket) {
      try {
        ws.send(wire)
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
