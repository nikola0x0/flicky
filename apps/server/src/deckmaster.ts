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
 * State lives in-memory (`Map<hashHex, plaintext>`). Restart the server
 * and pending duels lose their plaintext → they have to be revealed by
 * the creator's tab instead. For production we'd persist to disk/db.
 */
import { bcs } from "@mysten/sui/bcs"
import { normalizeSuiAddress } from "@mysten/sui/utils"
import { createHash } from "node:crypto"

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
 * In-memory store keyed by hash hex. The keeper (or any reveal path)
 * fetches plaintext by hash via GET /deckmaster/reveal?hash=0x...
 */
const store = new Map<string, DeckCard[]>()

export function rememberDeck(hash: Uint8Array, cards: DeckCard[]): string {
  const hex = hashToHex(hash)
  store.set(hex, cards)
  return hex
}

export function fetchDeck(hashHex: string): DeckCard[] | undefined {
  return store.get(hashHex.toLowerCase())
}

export function forgetDeck(hashHex: string): void {
  store.delete(hashHex.toLowerCase())
}

export function knownHashCount(): number {
  return store.size
}
