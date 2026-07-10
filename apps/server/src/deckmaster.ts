/**
 * AI Deckmaster — generates the 5-card binary-digital deck for each duel.
 *
 * 6-24 model (predict-testnet-6-24, no public on-chain quote):
 *   - Each duel deck = N cards, each pinned to a DIFFERENT DeepBook Predict
 *     `ExpiryMarket`, discovered from the **predict indexer** (`GET
 *     /markets`) rather than an on-chain event scan. Chosen markets are
 *     the nearest expiries strictly later than `now + headroomMs`, sorted
 *     ascending, capped at the requested horizon.
 *   - Strikes are placed in **price space**: read current BTC spot from
 *     the propbook indexer's Pyth feed, offset it by a difficulty-zone bps
 *     ladder (`allocateZones`), sign-balance the offsets across the deck
 *     (`allocateSignBalance`), and snap the result to the market's
 *     `admission_tick_size` grid. This replaces the old on-chain quote
 *     probe (`predict::get_trade_amounts`), which 6-24 doesn't expose
 *     publicly.
 *   - `env.deckStrikeMode` gates the strike algorithm: `"price_offset"`
 *     (this file, default) or `"svi_quote"` (an off-chain-SVI-informed
 *     picker — not implemented yet; `buildDeck` throws if selected).
 *
 * On-chain commit-reveal (unchanged from 4-16):
 *   - `commitDeck` returns `{ cards, hash }` where hash = sha2-256 of the
 *     BCS-serialized card vector that flicky::duel::reveal_deck expects.
 *     `Card` on chain is `{ expiry_market_id: ID, strike: u64 }` — kept
 *     here as `DeckCard.oracle_id` (the field predates the 6-24 rename;
 *     the value is now an `ExpiryMarket` id, not an `OracleSVI` id. Full
 *     field rename across server/ws/web is scoped to a later task so the
 *     wire contract — HTTP JSON keys, WS message shapes, on-chain BCS
 *     layout — doesn't shift mid-migration).
 *   - The plaintext is persisted to the Postgres `deck` table (see db.ts)
 *     so a server restart doesn't strand pending duels. The keeper or the
 *     player's tab calls `reveal_deck` after `join_duel` lands; we just
 *     serve the plaintext on demand.
 */
import { bcs } from "@mysten/sui/bcs"
import { normalizeSuiAddress, normalizeSuiObjectId } from "@mysten/sui/utils"
import { createHash } from "node:crypto"
import { countDecks, deleteDeck, getDeck, upsertDeck } from "./db"
import { env } from "./env"
import { makeLogger } from "./log"

const log = makeLogger("deckmaster")

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DeckCard {
  /** `ExpiryMarket` id (field name predates the 6-24 rename — see header). */
  oracle_id: string
  strike: bigint
}

export interface GeneratedDeck {
  cards: DeckCard[]
  hash: Uint8Array
  hashHex: string
}

// ─── BCS shape that matches flicky::duel::Card on chain ─────────────────────

const CardBcs = bcs.struct("Card", {
  oracle_id: bcs.Address,
  strike: bcs.u64(),
})
const DeckBcs = bcs.vector(CardBcs)

// ─── Market discovery (predict indexer) ──────────────────────────────────────

/** Raw row shape from `GET {predictIndexerUrl}/markets` (confirmed live
 *  2026-07-10). The indexer returns every `market_created` event ever
 *  emitted (including expired/historical markets) — callers MUST filter
 *  by `propbook_underlying_id`, `kind`, and `expiry`. */
export interface MarketRow {
  expiry_market_id: string
  propbook_underlying_id: number
  expiry: number
  tick_size: string
  admission_tick_size: string
  kind: string
}

/** Normalized, chain-agnostic view of a live `ExpiryMarket` — the input
 *  to `buildDeck`. */
export interface MarketSnapshot {
  expiryMarketId: string
  /** Expiry, ms since epoch. */
  expiry: number
  /** Base tick unit (raw strike = tick × tickSize), 1e9-fixed USD. */
  tickSize: bigint
  /** Coarser grid mint-admissible strikes must land on (a multiple of `tickSize`). */
  admissionTickSize: bigint
}

/**
 * Fetch the `count` nearest live BTC `ExpiryMarket`s from the predict
 * indexer, i.e. those whose expiry clears `now + minHeadroomMs` but falls
 * within `now + maxHorizonMs`. Sorted soonest-first. De-dupes by
 * `expiry_market_id` (the indexer can return more than one `market_created`
 * row per market on event re-emit — keeps the first).
 */
export async function findDeckMarkets(
  count = 5,
  maxHorizonMs = env.deckCardMaxHorizonMs,
  minHeadroomMs = env.deckCardMinHeadroomMs,
): Promise<MarketSnapshot[]> {
  const res = await fetch(`${env.predictIndexerUrl}/markets`)
  if (!res.ok) throw new Error(`predict indexer /markets ${res.status}`)
  const rows = (await res.json()) as MarketRow[]
  const now = Date.now()
  const seen = new Set<string>()
  const out: MarketSnapshot[] = []
  for (const r of rows) {
    if (r.propbook_underlying_id !== 1 || r.kind !== "market_created") continue
    const id = normalizeSuiObjectId(r.expiry_market_id)
    if (seen.has(id)) continue
    seen.add(id)
    const expiry = Number(r.expiry)
    if (expiry <= now + minHeadroomMs || expiry > now + maxHorizonMs) continue
    out.push({
      expiryMarketId: id,
      expiry,
      tickSize: BigInt(r.tick_size),
      admissionTickSize: BigInt(r.admission_tick_size),
    })
  }
  out.sort((a, b) => a.expiry - b.expiry)
  return out.slice(0, count)
}

/**
 * Current BTC spot from the propbook indexer's Pyth feed, in the same
 * 1e9-fixed USD unit as `MarketSnapshot.tickSize` (confirmed live
 * 2026-07-10: `/oracles/{pythFeedId}/pyth/latest` → `normalized_spot`,
 * e.g. `"63837582739850"` == $63,837.58273985).
 */
export async function readBtcSpot(): Promise<bigint> {
  const res = await fetch(
    `${env.propbookIndexerUrl}/oracles/${env.pythFeedId}/pyth/latest`,
  )
  if (!res.ok) throw new Error(`propbook /pyth/latest ${res.status}`)
  const j = (await res.json()) as { normalized_spot: string }
  return BigInt(j.normalized_spot)
}

/**
 * Snap a raw (1e9-fixed) strike price to the nearest `admissionTickSize`
 * multiple, then express it as a tick index (`snapped / tickSize`) — the
 * unit `predict::expiry_market::mint_exact_quantity`'s `lower_tick` /
 * `higher_tick` args expect. `admissionTickSize` must be an integer
 * multiple of `tickSize` (true for every live 6-24 market), so the
 * division is always exact.
 */
export function snapToAdmissionTick(
  rawStrike: bigint,
  tickSize: bigint,
  admissionTickSize: bigint,
): bigint {
  if (tickSize <= 0n) {
    throw new Error("snapToAdmissionTick: tickSize must be > 0")
  }
  const r = rawStrike < 0n ? 0n : rawStrike
  if (admissionTickSize <= 0n) return r / tickSize
  const half = admissionTickSize / 2n
  const snappedRaw = ((r + half) / admissionTickSize) * admissionTickSize
  return snappedRaw / tickSize
}

// ─── Seeded PRG (deck-level shape derivation) ────────────────────────────────

/** Stable seed derivation — 32 bytes from sha256(sender || asset || tier || timestamp || nonce). */
export function deriveSeed(input: {
  sender?: string
  asset: string
  tier?: string
  timestampMs: number
  nonceHex?: string
}): Uint8Array {
  const h = createHash("sha256")
  if (input.sender) h.update(input.sender)
  h.update("|")
  h.update(input.asset)
  h.update("|")
  if (input.tier) h.update(input.tier)
  h.update("|")
  h.update(String(input.timestampMs))
  h.update("|")
  if (input.nonceHex) h.update(input.nonceHex)
  return new Uint8Array(h.digest())
}

/**
 * Tiny seeded PRG — sha256 in counter mode. Deterministic given the seed
 * so anyone with `seed` can recompute the exact strike sequence. Not a
 * CSPRNG for unbounded streams, but sufficient for picking a handful of
 * ints from small pools.
 */
function* prgStream(seed: Uint8Array): Generator<number, never> {
  let counter = 0
  while (true) {
    const h = createHash("sha256")
    h.update(seed)
    h.update(Buffer.from(String(counter)))
    const out = h.digest()
    for (let i = 0; i < out.length; i++) yield out[i]
    counter++
  }
}

/** Fisher-Yates shuffle of `arr` using bytes from `stream`. Pure, returns new array. */
function shuffle<T>(arr: readonly T[], stream: Generator<number, never>): T[] {
  const out = arr.slice()
  for (let i = out.length - 1; i > 0; i--) {
    // Reject-sample to avoid modulo bias.
    const cap = 256 - (256 % (i + 1))
    let j: number
    for (;;) {
      const b = stream.next().value
      if (b < cap) {
        j = b % (i + 1)
        break
      }
    }
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

// ─── Sign balance + difficulty zones ─────────────────────────────────────────

/**
 * Sign bias for a card's strike offset:
 *   * `+1` — steer the strike ABOVE spot (DOWN-favoring — settlement
 *           likely below strike, UP swipe is the risky high-reward play).
 *   * `-1` — steer the strike BELOW spot (UP-favoring — swipe UP is the
 *           safe play, DOWN is the long-shot).
 *
 * Used by `buildDeck` to force a balanced sign distribution across the
 * whole deck so a single duel never ships as all-UP-favoring (boring:
 * same swipe pattern wins everything).
 */
export type SignBias = -1 | 1

/**
 * Allocate sign bias across `deckSize` cards so a deck is never skewed
 * all to one side:
 *   * Even N → exactly N/2 UP-favoring + N/2 DOWN-favoring.
 *   * Odd  N → (N+1)/2 of one sign + (N-1)/2 of the other; PRG picks
 *              which sign gets the extra card.
 * Card order PRG-shuffled so the "side" sequence varies per duel.
 */
export function allocateSignBalance(
  deckSize: number,
  prgStream: Generator<number, never>,
): SignBias[] {
  if (deckSize <= 0) return []
  const half = Math.floor(deckSize / 2)
  const extra = deckSize - 2 * half // 0 (even) or 1 (odd)
  // Coin-flip from PRG: high half of byte = +1 extra, low half = -1 extra.
  const upCount = extra ? half + (prgStream.next().value < 128 ? 1 : 0) : half
  const downCount = deckSize - upCount
  const out: SignBias[] = []
  for (let i = 0; i < upCount; i++) out.push(+1)
  for (let i = 0; i < downCount; i++) out.push(-1)
  return shuffle(out, prgStream)
}

/**
 * Difficulty zone for one card, expressed as strike distance from spot:
 *   close — smallest offset (coin-flip, hardest call)
 *   mid   — moderate offset (a lean, readable but contestable)
 *   edge  — widest offset (long-shot vs gimme)
 */
export type Zone = "close" | "mid" | "edge"

/**
 * Per-deck zone allocation — the difficulty mix:
 *   5 → 2 close + 2 mid + 1 edge   (the PRD's 2/2/1)
 *   4 → 1 close + 2 mid + 1 edge
 *   3 → 1 close + 1 mid + 1 edge
 *   2 → 1 close + 1 mid; 1 → close; >5 → repeat the 5-card pattern.
 * PRG-shuffled so card position never reveals difficulty.
 */
const ZONE_PATTERN: readonly Zone[] = [
  "close",
  "close",
  "mid",
  "mid",
  "edge",
] as const

export function allocateZones(
  deckSize: number,
  prgStream: Generator<number, never>,
): Zone[] {
  if (deckSize <= 0) return []
  const base: Record<number, readonly Zone[]> = {
    1: ["close"],
    2: ["close", "mid"],
    3: ["close", "mid", "edge"],
    4: ["close", "mid", "mid", "edge"],
    5: ZONE_PATTERN,
  }
  const zones =
    deckSize <= 5
      ? base[deckSize].slice()
      : Array.from(
          { length: deckSize },
          (_, i) => ZONE_PATTERN[i % ZONE_PATTERN.length],
        )
  return shuffle(zones, prgStream)
}

// ─── Deck construction (price-space strikes) ─────────────────────────────────

/** Open-upper-bound sentinel tick — `(1 << 30) - 1`, per the 6-24 tick grid. */
export const POS_INF_TICK = (1n << 30n) - 1n

/** Strike-offset ladder, bps of spot, by difficulty zone. Close = smallest
 *  offset (near-spot coin flip), edge = widest (long-shot/gimme). Small and
 *  fixed for now — an SVI-informed ladder is the `svi_quote` mode's job. */
const ZONE_OFFSET_BPS: Record<Zone, number> = {
  close: 50,
  mid: 150,
  edge: 300,
}

/** One deck card in price space — the shape `buildDeck` returns. Not the
 *  on-chain-committed shape (see `DeckCard`/`commitDeck`): `lowerTick` /
 *  `higherTick` / `isUpFavored` are swipe-PTB-building hints, not part of
 *  the hashed commitment (the player's own `is_up` choice at swipe time
 *  determines which of these actually gets minted). */
export interface DeckCardOut {
  expiryMarketId: string
  /** Raw strike price (tick × tickSize), 1e9-fixed USD. */
  strike: bigint
  lowerTick: bigint
  higherTick: bigint
  /** Whether this card's strike sits below spot (swiping UP is the safer play). */
  isUpFavored: boolean
}

/**
 * Build a price-space deck: one card per market, strike = spot ± a
 * zone-scaled bps offset, sign-balanced across the deck, snapped to each
 * market's admission grid.
 *
 * Guards `env.deckStrikeMode === "svi_quote"` — that mode (an off-chain
 * SVI-informed picker) isn't implemented yet.
 */
export function buildDeck(
  markets: MarketSnapshot[],
  spot: bigint,
  seed: Uint8Array,
): DeckCardOut[] {
  if (env.deckStrikeMode === "svi_quote") {
    throw new Error("svi_quote strike mode not implemented yet")
  }
  const stream = prgStream(seed)
  const signs = allocateSignBalance(markets.length, stream)
  const zones = allocateZones(markets.length, stream)
  return markets.map((m, i) => {
    const sign = signs[i]
    const offsetBps = BigInt(ZONE_OFFSET_BPS[zones[i]])
    const offset = (spot * offsetBps) / 10_000n
    const rawStrike = sign > 0 ? spot + offset : spot - offset
    const strikeTick = snapToAdmissionTick(
      rawStrike,
      m.tickSize,
      m.admissionTickSize,
    )
    const isUpFavored = sign < 0
    return {
      expiryMarketId: normalizeSuiAddress(m.expiryMarketId),
      strike: strikeTick * m.tickSize,
      lowerTick: isUpFavored ? strikeTick : 0n,
      higherTick: isUpFavored ? POS_INF_TICK : strikeTick,
      isUpFavored,
    }
  })
}

/**
 * Convert a price-space deck (`buildDeck`'s output) to the on-chain
 * commitment shape and compute its hash: sha2-256 of the BCS-serialized
 * `Card` vector `flicky::duel::reveal_deck` expects.
 */
export function commitDeck(cards: DeckCardOut[]): GeneratedDeck {
  const stored: DeckCard[] = cards.map((c) => ({
    oracle_id: c.expiryMarketId,
    strike: c.strike,
  }))
  const bytes = DeckBcs.serialize(
    stored.map((c) => ({ oracle_id: c.oracle_id, strike: c.strike.toString() })),
  ).toBytes()
  const hash = new Uint8Array(createHash("sha256").update(bytes).digest())
  return { cards: stored, hash, hashHex: hashToHex(hash) }
}

export function hashToHex(hash: Uint8Array): string {
  return (
    "0x" +
    Array.from(hash)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  )
}

// ─── Deck sizing ────────────────────────────────────────────────────────────

/**
 * Resolve a deck-size band from the request body.
 * - Explicit `deckSize` collapses the band to [n, n] — preserves the old
 *   strict behavior (503 unless exactly n markets are live).
 * - Otherwise default to [3, 5]. Both bounds are clamped to the contract's
 *   [MIN_DECK_SIZE, MAX_DECK_SIZE] = [1, 20], and `min` is capped at `max`.
 */
export function resolveDeckBounds(body: {
  deckSize?: number
  minDeckSize?: number
  maxDeckSize?: number
}): { min: number; max: number } {
  const clamp = (n: number) => Math.max(1, Math.min(20, Math.floor(n)))
  if (body.deckSize != null) {
    const n = clamp(body.deckSize)
    return { min: n, max: n }
  }
  const max = clamp(body.maxDeckSize ?? 5)
  const min = Math.min(clamp(body.minDeckSize ?? 3), max)
  return { min, max }
}

/**
 * Greedy sizing: build the largest deck supply allows, capped at `max`.
 * `ok` is false when fewer than `min` markets are live — the only failure
 * case (surfaces as a 503). `deckSize` is meaningful only when `ok`.
 */
export function decideDeckSize(
  liveCount: number,
  bounds: { min: number; max: number },
): { ok: boolean; deckSize: number } {
  return {
    ok: liveCount >= bounds.min,
    deckSize: Math.min(liveCount, bounds.max),
  }
}

// ─── Plaintext persistence (Postgres `deck` table) ───────────────────────────
//
// Was apps/server/.data/decks.json — now one row per commitment (keyed by
// the lowercased "0x…" sha2-256 hash) so the store survives restarts with
// no mounted volume and is shared across any future server replicas. Each
// entry holds the revealed cards plus the seed used to derive their
// strikes; `seedHex` is optional for back-compat with decks generated
// before the deterministic-seed change.

export interface StoreEntry {
  cards: DeckCard[]
  seedHex?: string
}

/** Cards serialize to JSON with strikes as decimal strings (u64 > 2^53). */
function serializeCards(cards: DeckCard[]): string {
  return JSON.stringify(
    cards.map((c) => ({ oracle_id: c.oracle_id, strike: c.strike.toString() })),
  )
}

function deserializeCards(json: string): DeckCard[] {
  const arr = JSON.parse(json) as Array<{ oracle_id: string; strike: string }>
  return arr.map((c) => ({ oracle_id: c.oracle_id, strike: BigInt(c.strike) }))
}

export async function rememberDeck(
  hash: Uint8Array,
  cards: DeckCard[],
  seed?: Uint8Array,
): Promise<string> {
  const hex = hashToHex(hash)
  await upsertDeck(hex, serializeCards(cards), seed ? hashToHex(seed) : null)
  return hex
}

export async function fetchDeck(
  hashHex: string,
): Promise<DeckCard[] | undefined> {
  const row = await getDeck(hashHex)
  return row ? deserializeCards(row.cardsJson) : undefined
}

export async function fetchDeckEntry(
  hashHex: string,
): Promise<StoreEntry | undefined> {
  const row = await getDeck(hashHex)
  if (!row) return undefined
  return {
    cards: deserializeCards(row.cardsJson),
    seedHex: row.seedHex ?? undefined,
  }
}

export async function forgetDeck(hashHex: string): Promise<void> {
  await deleteDeck(hashHex)
}

export async function knownHashCount(): Promise<number> {
  return countDecks()
}

// ─── HTTP routes ────────────────────────────────────────────────────────────

import { json } from "./lib/http"
import { clientIp, consume } from "./ratelimit"

export async function handleDeckmasterRequest(
  req: Request,
  url: URL,
): Promise<Response | null> {
  if (url.pathname === "/deckmaster/generate" && req.method === "POST") {
    const gate = consume("deckmaster:generate", clientIp(req, null))
    if (!gate.ok) {
      return json({ error: "rate limited", retryMs: gate.retryMs }, 429)
    }
    const body = (await req.json().catch(() => null)) as
      | {
          sender?: string
          tier?: string
          deckSize?: number
          minDeckSize?: number
          maxDeckSize?: number
        }
      | null
    const sender = body?.sender
    const tier = body?.tier
    // Deck size adapts to live market supply within a band (default [3, 5],
    // clamped to the contract's [1, 20]). An explicit `deckSize` collapses
    // the band for back-compat.
    const bounds = resolveDeckBounds(body ?? {})
    try {
      const markets = await findDeckMarkets(bounds.max)
      const decision = decideDeckSize(markets.length, bounds)
      if (!decision.ok) {
        return json(
          {
            error: "not enough live markets",
            detail: `found ${markets.length} live BTC ExpiryMarkets settling within ${env.deckCardMaxHorizonMs / 60_000}min, need ≥${bounds.min}; retry shortly`,
          },
          503,
        )
      }
      const chosen = markets.slice(0, decision.deckSize)
      const spot = await readBtcSpot()
      // Derive a deterministic seed for this generation. The seed is
      // saved alongside the plaintext so anyone with (seed, market list)
      // can recompute the exact strike sequence and verify the deck
      // wasn't biased by the picker.
      const nonceHex = hashToHex(crypto.getRandomValues(new Uint8Array(16)))
      const seed = deriveSeed({
        sender,
        asset: "BTC",
        tier,
        timestampMs: Date.now(),
        nonceHex,
      })
      const outCards = buildDeck(chosen, spot, seed)
      const deck = commitDeck(outCards)
      await rememberDeck(deck.hash, deck.cards, seed)
      return json({
        cards: outCards.map((c, i) => ({
          oracle_id: c.expiryMarketId,
          strike: c.strike.toString(),
          expiry: chosen[i].expiry.toString(),
        })),
        hash: deck.hashHex,
        seed: hashToHex(seed),
        deckSize: decision.deckSize,
        liveOracleCount: markets.length,
      })
    } catch (e) {
      log.error(`generate failed: ${e instanceof Error ? e.message : String(e)}`)
      return json(
        { error: "deckmaster failed", detail: e instanceof Error ? e.message : String(e) },
        500,
      )
    }
  }

  if (url.pathname === "/deckmaster/reveal" && req.method === "GET") {
    const hash = url.searchParams.get("hash")
    if (!hash) return json({ error: "hash param required" }, 400)
    const entry = await fetchDeckEntry(hash)
    if (!entry) return json({ error: "unknown hash" }, 404)
    return json({
      cards: entry.cards.map((c) => ({
        oracle_id: c.oracle_id,
        strike: c.strike.toString(),
      })),
      hash: hash.toLowerCase(),
      seed: entry.seedHex ?? null,
    })
  }

  return null
}
