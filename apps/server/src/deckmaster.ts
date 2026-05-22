/**
 * AI Deckmaster — generates the 5-card binary-digital deck for each duel
 * and remembers the plaintext so the keeper can reveal on chain after the
 * challenger joins.
 *
 * Current strategy (Phase 1): take the oracle's reference price and pick
 * 5 strikes at percentage offsets `[95%, 98%, 100%, 102%, 105%]`. PRD
 * §AI Deckmaster wants "live SVI surface + 2 close, 2 mid, 1 deep-OTM";
 * upgrade after this slice — the commit-reveal scaffolding doesn't care
 * which strikes get committed, only that the hash matches.
 *
 * State is persisted to `apps/server/.data/decks.json` so a server
 * restart doesn't strand pending duels. The keeper or the player's tab
 * still has to actually call `reveal_deck` on chain — this just keeps
 * the plaintext lookup alive across restarts.
 */
import { bcs } from "@mysten/sui/bcs"
import { normalizeSuiAddress } from "@mysten/sui/utils"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { dirname, resolve } from "node:path"

export interface DeckCard {
  oracle_id: string
  strike: bigint
}

export interface GeneratedDeck {
  cards: DeckCard[]
  hash: Uint8Array
}

const CardBcs = bcs.struct("Card", {
  oracle_id: bcs.Address,
  strike: bcs.u64(),
})
const DeckBcs = bcs.vector(CardBcs)

/** Default percentile offsets around the reference price. */
const STRIKE_PCTS = [95n, 98n, 100n, 102n, 105n] as const

export function buildDeck(oracleId: string, reference: bigint): GeneratedDeck {
  const cards: DeckCard[] = STRIKE_PCTS.map((pct) => ({
    oracle_id: normalizeSuiAddress(oracleId),
    strike: (reference * pct) / 100n,
  }))
  const bytes = DeckBcs.serialize(
    cards.map((c) => ({ oracle_id: c.oracle_id, strike: c.strike.toString() })),
  ).toBytes()
  // node:crypto handles Uint8Array directly; node ≥ 20 sets returnType to Buffer.
  const hash = new Uint8Array(createHash("sha256").update(bytes).digest())
  return { cards, hash }
}

export function hashToHex(hash: Uint8Array): string {
  return (
    "0x" +
    Array.from(hash)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  )
}

/**
 * Store keyed by hash hex. Backed by `apps/server/.data/decks.json` so
 * pending duels survive a server restart. The keeper (or any reveal
 * path) fetches plaintext by hash via GET /deckmaster/reveal?hash=0x...
 */
const STORE_PATH = resolve(
  process.env.DECKMASTER_STORE_PATH ??
    new URL("../.data/decks.json", import.meta.url).pathname,
)

const store: Map<string, DeckCard[]> = loadStore()

function loadStore(): Map<string, DeckCard[]> {
  if (!existsSync(STORE_PATH)) return new Map()
  try {
    const raw = readFileSync(STORE_PATH, "utf-8")
    const obj = JSON.parse(raw) as Record<
      string,
      Array<{ oracle_id: string; strike: string }>
    >
    const m = new Map<string, DeckCard[]>()
    for (const [hex, cards] of Object.entries(obj)) {
      m.set(
        hex.toLowerCase(),
        cards.map((c) => ({ oracle_id: c.oracle_id, strike: BigInt(c.strike) })),
      )
    }
    return m
  } catch (e) {
    console.warn(
      `[deckmaster] failed to load ${STORE_PATH}: ${e instanceof Error ? e.message : String(e)}`,
    )
    return new Map()
  }
}

function persistStore(): void {
  const obj: Record<string, Array<{ oracle_id: string; strike: string }>> = {}
  for (const [hex, cards] of store.entries()) {
    obj[hex] = cards.map((c) => ({ oracle_id: c.oracle_id, strike: c.strike.toString() }))
  }
  try {
    mkdirSync(dirname(STORE_PATH), { recursive: true })
    writeFileSync(STORE_PATH, JSON.stringify(obj, null, 2), "utf-8")
  } catch (e) {
    console.warn(
      `[deckmaster] failed to persist ${STORE_PATH}: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
}

export function rememberDeck(hash: Uint8Array, cards: DeckCard[]): string {
  const hex = hashToHex(hash)
  store.set(hex, cards)
  persistStore()
  return hex
}

export function fetchDeck(hashHex: string): DeckCard[] | undefined {
  return store.get(hashHex.toLowerCase())
}

export function forgetDeck(hashHex: string): void {
  if (store.delete(hashHex.toLowerCase())) persistStore()
}

export function knownHashCount(): number {
  return store.size
}
