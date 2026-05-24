/**
 * AI Deckmaster — generates the 5-card binary-digital deck for each duel.
 *
 * PRD model (locked):
 *   - Each duel deck = 5 cards, each pinned to a DIFFERENT DeepBook
 *     Predict OracleSVI. The chosen 5 oracles are the nearest resolutions
 *     strictly later than `now + 10 min`, sorted by expiry ascending.
 *   - For each chosen oracle, we read its forward price and pick a strike
 *     offset (placeholder difficulty model: ±2%, ±5%, ATM — upgrade to an
 *     SVI-informed 2/2/1 split later; the commit-reveal scaffolding does
 *     not care which strikes get committed, only that the hash matches).
 *
 * On-chain commit-reveal:
 *   - `buildDeck` returns `{ cards, hash }` where hash = sha2-256 of the
 *     BCS-serialized card vector that flicky::duel::reveal_deck expects.
 *   - The plaintext is persisted to `.data/decks.json` so a server
 *     restart doesn't strand pending duels. The keeper or the player's
 *     tab calls `reveal_deck` after `join_duel` lands; we just serve the
 *     plaintext on demand.
 */
import { bcs } from "@mysten/sui/bcs"
import { normalizeSuiAddress, normalizeSuiObjectId } from "@mysten/sui/utils"
import type { SuiClient } from "@mysten/sui/client"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { env } from "./env"
import { makeLogger } from "./log"

const log = makeLogger("deckmaster")

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DeckCard {
  oracle_id: string
  strike: bigint
}

export interface GeneratedDeck {
  cards: DeckCard[]
  hash: Uint8Array
  hashHex: string
}

export interface OracleSnapshot {
  id: string
  expiry: bigint
  spot: bigint
  forward: bigint
}

// ─── BCS shape that matches flicky::duel::Card on chain ─────────────────────

const CardBcs = bcs.struct("Card", {
  oracle_id: bcs.Address,
  strike: bcs.u64(),
})
const DeckBcs = bcs.vector(CardBcs)

// ─── Oracle discovery ───────────────────────────────────────────────────────

/**
 * Fetch the 5 nearest live BTC OracleSVI objects whose expiry is
 * strictly more than `now + DECK_CARD_MIN_HEADROOM_MS` (default 10 min).
 *
 * Strategy:
 *   1. Walk recent `registry::OracleCreated` events for BTC.
 *   2. Resolve each to its OracleSVI object, filter by
 *      (active && !settled && expiry > now + 10 min).
 *   3. Sort by expiry ascending, take 5.
 *
 * Returns an empty array if fewer than 5 eligible oracles exist; callers
 * decide whether to retry or surface a 503 to the client.
 */
export async function findDeckOracles(
  client: SuiClient,
  asset = "BTC",
  count = 5,
): Promise<OracleSnapshot[]> {
  const pkg = env.deepbookPredictPackageId
  const now = Date.now()
  const minExpiry = BigInt(now) + BigInt(env.deckCardMinHeadroomMs)

  const evts = await client.queryEvents({
    query: { MoveEventType: `${pkg}::registry::OracleCreated` },
    limit: 30,
    order: "descending",
  })

  const candidates: string[] = []
  for (const e of evts.data) {
    const p = e.parsedJson as { oracle_id: string; underlying_asset: string }
    if (p.underlying_asset !== asset) continue
    candidates.push(normalizeSuiObjectId(p.oracle_id))
    if (candidates.length >= 20) break
  }
  if (candidates.length === 0) return []

  const objs = await client.multiGetObjects({
    ids: candidates,
    options: { showContent: true },
  })

  const eligible: OracleSnapshot[] = []
  for (const obj of objs) {
    if (obj.data?.content?.dataType !== "moveObject") continue
    const f = obj.data.content.fields as {
      active: boolean
      expiry: string
      settlement_price: unknown
      prices: { fields: { spot: string; forward: string } }
    }
    if (!f.active) continue
    if (isSettlementSet(f.settlement_price)) continue
    const expiry = BigInt(f.expiry)
    if (expiry <= minExpiry) continue
    const spot = BigInt(f.prices.fields.spot)
    const forward = BigInt(f.prices.fields.forward)
    if (spot === 0n || forward === 0n) continue
    eligible.push({
      id: normalizeSuiObjectId(obj.data.objectId),
      expiry,
      spot,
      forward,
    })
  }

  eligible.sort((a, b) => (a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1 : 0))
  return eligible.slice(0, count)
}

function isSettlementSet(v: unknown): boolean {
  if (v === null || v === undefined) return false
  if (typeof v === "string") return true
  if (typeof v === "object") {
    const vec = (v as { fields?: { vec?: unknown[] } }).fields?.vec
    return Array.isArray(vec) && vec.length > 0
  }
  return false
}

// ─── Deck construction (seeded PRG + 2/2/1 difficulty mix) ──────────────────
//
// PRD §AI Deckmaster: "the generator chooses strike + side per card to
// balance difficulty (mix of close-to-money hard calls and deep-OTM
// gimmes/traps)." We implement this as a fixed 2/2/1 allocation across
// three difficulty buckets — strike-offset relative to the oracle's
// forward is the proxy for difficulty (close ≈ ~50% implied → coin
// flip → hardest, far OTM ≈ ~5-15% implied → near-gimme).
//
// Buckets are PRG-ordered across the 5 oracles, and PRG also picks
// which pct inside each bucket. The seed is deterministic — anyone
// with `seed` can recompute the exact deck.

/** Difficulty buckets — strike pct of forward. */
const STRIKE_BUCKETS = {
  /** Hard calls — close-to-money. */
  close: [98n, 99n, 100n, 101n, 102n] as const,
  /** Mid-difficulty — moderate offset. */
  mid: [95n, 96n, 97n, 103n, 104n, 105n] as const,
  /** Easy / gimmes / traps — deep-OTM. */
  otm: [85n, 88n, 90n, 110n, 112n, 115n] as const,
} as const

type Difficulty = keyof typeof STRIKE_BUCKETS

/**
 * 2 close + 2 mid + 1 otm per deck. The order across the 5 oracles is
 * PRG-shuffled so card index N isn't always the same difficulty.
 */
const DIFFICULTY_ALLOCATION: readonly Difficulty[] = [
  "close",
  "close",
  "mid",
  "mid",
  "otm",
] as const

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
 * CSPRNG for unbounded streams, but sufficient for picking 5 ints from
 * small pools.
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

/** Pick one element from `pool` via PRG (reject-sample). */
function pickFromPool<T>(pool: readonly T[], stream: Generator<number, never>): T {
  const cap = 256 - (256 % pool.length)
  for (;;) {
    const b = stream.next().value
    if (b < cap) return pool[b % pool.length]
  }
}

export function buildDeckFromOracles(
  oracles: OracleSnapshot[],
  seed: Uint8Array,
): GeneratedDeck {
  if (oracles.length < 5) {
    throw new Error(
      `need 5 oracles, got ${oracles.length}; widen the window or wait for the next 15-min cron`,
    )
  }
  const stream = prgStream(seed)
  // Step 1: shuffle the 2/2/1 difficulty allocation across the 5 oracles.
  const difficulties = shuffle(DIFFICULTY_ALLOCATION, stream)
  // Step 2: for each oracle, draw a pct from the chosen bucket.
  const cards: DeckCard[] = oracles.slice(0, 5).map((o, i) => {
    const bucket = STRIKE_BUCKETS[difficulties[i]]
    const pct = pickFromPool(bucket, stream)
    return {
      oracle_id: normalizeSuiAddress(o.id),
      strike: (o.forward * pct) / 100n,
    }
  })
  const bytes = DeckBcs.serialize(
    cards.map((c) => ({ oracle_id: c.oracle_id, strike: c.strike.toString() })),
  ).toBytes()
  const hash = new Uint8Array(createHash("sha256").update(bytes).digest())
  return { cards, hash, hashHex: hashToHex(hash) }
}

/**
 * Returns the strike pct (relative to forward) for `strike`. Useful for
 * tests + debug ("which bucket did this strike come from").
 */
export function strikePctOf(forward: bigint, strike: bigint): bigint {
  return (strike * 100n) / forward
}

/** Returns which difficulty bucket a pct falls into, or null if out-of-range. */
export function difficultyOfPct(pct: bigint): Difficulty | null {
  if ((STRIKE_BUCKETS.close as readonly bigint[]).includes(pct)) return "close"
  if ((STRIKE_BUCKETS.mid as readonly bigint[]).includes(pct)) return "mid"
  if ((STRIKE_BUCKETS.otm as readonly bigint[]).includes(pct)) return "otm"
  return null
}

export function hashToHex(hash: Uint8Array): string {
  return (
    "0x" +
    Array.from(hash)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  )
}

// ─── Plaintext persistence ──────────────────────────────────────────────────
//
// Each entry stores the cards plus the seed used to derive their strikes.
// `seed` is optional for backwards-compat with stores from before the
// deterministic-seed change (those decks were generated from the fixed
// STRIKE_PCTS array and have no seed).

interface StoreEntry {
  cards: DeckCard[]
  seedHex?: string
}

const store: Map<string, StoreEntry> = loadStore()

function loadStore(): Map<string, StoreEntry> {
  const path = env.deckmasterStorePath
  if (!existsSync(path)) return new Map()
  try {
    const raw = readFileSync(path, "utf-8")
    const obj = JSON.parse(raw) as Record<
      string,
      | Array<{ oracle_id: string; strike: string }>
      | { cards: Array<{ oracle_id: string; strike: string }>; seedHex?: string }
    >
    const m = new Map<string, StoreEntry>()
    for (const [hex, entry] of Object.entries(obj)) {
      // Legacy: bare cards array. New: { cards, seedHex }.
      const cardsRaw = Array.isArray(entry) ? entry : entry.cards
      const seedHex = Array.isArray(entry) ? undefined : entry.seedHex
      m.set(hex.toLowerCase(), {
        cards: cardsRaw.map((c) => ({
          oracle_id: c.oracle_id,
          strike: BigInt(c.strike),
        })),
        seedHex,
      })
    }
    return m
  } catch (e) {
    log.warn(
      `failed to load ${path}: ${e instanceof Error ? e.message : String(e)}`,
    )
    return new Map()
  }
}

function persistStore(): void {
  const obj: Record<string, { cards: Array<{ oracle_id: string; strike: string }>; seedHex?: string }> = {}
  for (const [hex, entry] of store.entries()) {
    obj[hex] = {
      cards: entry.cards.map((c) => ({
        oracle_id: c.oracle_id,
        strike: c.strike.toString(),
      })),
      seedHex: entry.seedHex,
    }
  }
  try {
    mkdirSync(dirname(env.deckmasterStorePath), { recursive: true })
    writeFileSync(env.deckmasterStorePath, JSON.stringify(obj, null, 2), "utf-8")
  } catch (e) {
    log.warn(
      `failed to persist ${env.deckmasterStorePath}: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
}

export function rememberDeck(
  hash: Uint8Array,
  cards: DeckCard[],
  seed?: Uint8Array,
): string {
  const hex = hashToHex(hash)
  store.set(hex, { cards, seedHex: seed ? hashToHex(seed) : undefined })
  persistStore()
  return hex
}

export function fetchDeck(hashHex: string): DeckCard[] | undefined {
  return store.get(hashHex.toLowerCase())?.cards
}

export function fetchDeckEntry(hashHex: string): StoreEntry | undefined {
  return store.get(hashHex.toLowerCase())
}

export function forgetDeck(hashHex: string): void {
  if (store.delete(hashHex.toLowerCase())) persistStore()
}

export function knownHashCount(): number {
  return store.size
}

// ─── HTTP routes ────────────────────────────────────────────────────────────

import { json } from "./lib/http"
import { getSuiClient } from "./lib/sui"
import { clientIp, consume } from "./ratelimit"

export async function handleDeckmasterRequest(
  req: Request,
  url: URL,
): Promise<Response | null> {
  if (url.pathname === "/deckmaster/generate" && req.method === "POST") {
    const gate = consume("deckmaster:generate", clientIp(req, null))
    if (!gate.ok) {
      return json(
        { error: "rate limited", retryMs: gate.retryMs },
        429,
      )
    }
    const body = (await req.json().catch(() => null)) as
      | { asset?: string; sender?: string; tier?: string }
      | null
    const asset = body?.asset ?? "BTC"
    const sender = body?.sender
    const tier = body?.tier
    const client = getSuiClient()
    try {
      const oracles = await findDeckOracles(client, asset, 5)
      if (oracles.length < 5) {
        return json(
          {
            error: "not enough live oracles",
            detail: `found ${oracles.length} eligible ${asset} oracles >${env.deckCardMinHeadroomMs / 60_000} min out; retry in a few minutes`,
          },
          503,
        )
      }
      // Derive a deterministic seed for this generation. The seed is
      // saved alongside the plaintext so anyone with (seed, oracle list)
      // can recompute the exact strike sequence and verify the deck
      // wasn't biased by the picker.
      const nonceHex = hashToHex(crypto.getRandomValues(new Uint8Array(16)))
      const seed = deriveSeed({
        sender,
        asset,
        tier,
        timestampMs: Date.now(),
        nonceHex,
      })
      const deck = buildDeckFromOracles(oracles, seed)
      rememberDeck(deck.hash, deck.cards, seed)
      return json({
        cards: deck.cards.map((c, i) => ({
          oracle_id: c.oracle_id,
          strike: c.strike.toString(),
          expiry: oracles[i].expiry.toString(),
        })),
        hash: deck.hashHex,
        seed: hashToHex(seed),
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
    const entry = fetchDeckEntry(hash)
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
