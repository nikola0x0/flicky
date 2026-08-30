/**
 * Event-sourced market discovery, verified against REAL historical data.
 *
 * `src/fixtures/predict-markets.json` is the last 50 `config_events::
 * MarketCreated` events actually emitted by DeepBook Predict 6-24 on testnet
 * (2026-08-17T20:16Z–21:15Z), captured verbatim from Sui GraphQL and mapped
 * through exactly the transform `drainMarketCreated` → `predict_market` →
 * `indexedMarketRows` performs.
 *
 * That makes this the acceptance test for "discovery works without the HTTP
 * indexer": if the selectors pick sensible decks out of these rows with a
 * frozen clock, the pipeline works the moment markets exist again — no live
 * Predict required to prove it.
 */
import { describe, expect, test } from "bun:test"
import {
  classifyTier,
  selectMarketRows,
  selectTieredMarkets,
  type MarketRow,
} from "./deckmaster"
import fixture from "./fixtures/predict-markets.json"

const ROWS = fixture as MarketRow[]

// Inside the real window: markets are still being created, plenty unexpired.
const NOW = Date.parse("2026-08-17T20:20:00Z")

describe("fixture sanity", () => {
  test("is real 6-24 data with both cadence tiers present", () => {
    expect(ROWS.length).toBe(50)
    for (const r of ROWS) {
      expect(r.propbook_underlying_id).toBe(1) // BTC
      expect(r.kind).toBe("market_created")
      expect(r.expiry_market_id).toStartWith("0x")
      expect(BigInt(r.tick_size)).toBeGreaterThan(0n)
    }
    const tiers = new Set(
      ROWS.map((r) =>
        classifyTier(
          r.checkpoint_timestamp_ms === undefined
            ? undefined
            : r.expiry - r.checkpoint_timestamp_ms
        )
      )
    )
    // The 6-24 cadence emitted ~2-min and ~14-min markets.
    expect(tiers.has("short")).toBe(true)
    expect(tiers.has("mid")).toBe(true)
  })
})

describe("selectMarketRows (flat picker) over real events", () => {
  test("returns live, headroom-clearing markets soonest-first", () => {
    const got = selectMarketRows(ROWS, {
      now: NOW,
      minHeadroomMs: 60_000,
      maxHorizonMs: 3 * 60 * 60 * 1000,
      count: 5,
    })
    expect(got.length).toBeGreaterThan(0)
    expect(got.length).toBeLessThanOrEqual(5)
    for (const m of got) expect(m.expiry).toBeGreaterThan(NOW + 60_000)
    expect(got.map((m) => m.expiry)).toEqual(
      [...got.map((m) => m.expiry)].sort((a, b) => a - b)
    )
    // De-duped by market id.
    const ids = got.map((m) => m.expiryMarketId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("excludes markets already expired at the frozen clock", () => {
    const got = selectMarketRows(ROWS, {
      now: NOW,
      minHeadroomMs: 0,
      maxHorizonMs: 3 * 60 * 60 * 1000,
      count: 50,
    })
    const expired = ROWS.filter((r) => r.expiry <= NOW)
    expect(expired.length).toBeGreaterThan(0) // fixture really does span the boundary
    for (const m of got) expect(m.expiry).toBeGreaterThan(NOW)
  })

  test("returns nothing once the whole window is in the past", () => {
    const after = Date.parse("2026-08-18T00:00:00Z")
    expect(
      selectMarketRows(ROWS, {
        now: after,
        minHeadroomMs: 0,
        maxHorizonMs: 3 * 60 * 60 * 1000,
        count: 5,
      })
    ).toEqual([])
  })

  test("tick sizes survive the round-trip as bigints", () => {
    const got = selectMarketRows(ROWS, {
      now: NOW,
      minHeadroomMs: 0,
      maxHorizonMs: 3 * 60 * 60 * 1000,
      count: 3,
    })
    for (const m of got) {
      expect(typeof m.tickSize).toBe("bigint")
      expect(m.admissionTickSize % m.tickSize).toBe(0n)
    }
  })
})

describe("selectTieredMarkets over real events", () => {
  test("composes a deck from both cadence tiers, short-first", () => {
    const got = selectTieredMarkets(ROWS, {
      now: NOW,
      shortCount: 2,
      midCount: 3,
      shortTtlFloorMs: 90_000,
      midTtlFloorMs: 120_000,
      maxHorizonMs: 3 * 60 * 60 * 1000,
    })
    expect(got.length).toBeGreaterThanOrEqual(2)
    expect(got.map((m) => m.expiry)).toEqual(
      [...got.map((m) => m.expiry)].sort((a, b) => a - b)
    )
    const ids = got.map((m) => m.expiryMarketId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("empties out after the window, so the caller falls back", () => {
    const after = Date.parse("2026-08-18T00:00:00Z")
    expect(
      selectTieredMarkets(ROWS, {
        now: after,
        shortCount: 2,
        midCount: 3,
        shortTtlFloorMs: 90_000,
        midTtlFloorMs: 120_000,
        maxHorizonMs: 3 * 60 * 60 * 1000,
      })
    ).toEqual([])
  })
})
