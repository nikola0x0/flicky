/**
 * Where a deck's cards come from.
 *
 * Historically the deck was welded to DeepBook Predict: discovery hit the
 * Predict indexer's `/markets`, and each card was a bet on one live
 * `ExpiryMarket`. That made a third-party service a single point of failure
 * for the whole game — and on 2026-08-17 it failed totally. Predict's 6-24
 * testnet stopped creating markets, its read API was torn down, and both
 * tiers were unplayable for ~12 days.
 *
 * This module puts a seam between "what are the cards" and "run a duel", so
 * the engine has a second way to produce a deck. It is deliberately NOT a
 * second game: both sources emit the same `DeckCardOut[]`, and everything
 * downstream (commit-reveal, swipe, lockup, settle, finalize) is one code
 * path — the "two tiers share one engine" invariant in CLAUDE.md.
 *
 * Two sources:
 *
 *   - `predict` — live `ExpiryMarket`s. The ONLY source the staked tier can
 *     use, because a staked swipe mints a real position against a market.
 *   - `pyth` — cards synthesized against the Pyth BTC feed at settle times
 *     we pick, settled by the keeper from that same feed. Free tier only.
 *     Needs no Predict deployment and no Move change: `settle_card_free`
 *     takes a keeper-supplied price, and `preflight_settle` only computes
 *     `settlement_price > card.strike` — it never reads a market object.
 *
 * `auto` prefers Predict and falls back to Pyth when Predict discovery comes
 * up empty. That is the setting that keeps free duels running through an
 * upstream outage.
 */
import {
  buildDeck,
  decideDeckSize,
  findDeckMarkets,
  findTieredDeckMarkets,
  readBtcSpot,
  resolveDeckBounds,
  type DeckCardOut,
  type MarketSnapshot,
} from "./deckmaster"
import { buildProbedDeck, filterMintableMarkets } from "./mint-probe"
import { env } from "./env"
import { makeLogger } from "./log"

const log = makeLogger("cards")

export type DeckSourceName = "predict" | "pyth"

/**
 * A built deck, plus the per-card settle times the keeper needs.
 *
 * `settleAtMs[i]` pairs with `cards[i]`. It exists because a card's settle
 * time is NOT on chain — `Card` is `(expiry_market_id, strike)` only. For a
 * Predict card the time is recoverable from the market's expiry; for a Pyth
 * card there is no market to ask, so the server is the only place that knows
 * it. Persisted alongside the deck plaintext (see `rememberDeck`).
 */
export interface BuiltDeck {
  cards: DeckCardOut[]
  settleAtMs: number[]
  source: DeckSourceName
}

export interface BuildDeckInput {
  seed: Uint8Array
  /** Duel tier. `staked` forbids the pyth source — see module docstring. */
  tier: string
  nowMs: number
}

export interface CardSource {
  readonly name: DeckSourceName
  build(input: BuildDeckInput): Promise<BuiltDeck>
}

/** Thrown when a source has nothing to build from, so `auto` can fall through. */
export class NoCardsAvailableError extends Error {
  constructor(
    readonly source: DeckSourceName,
    message: string
  ) {
    super(message)
    this.name = "NoCardsAvailableError"
  }
}

// ─── Predict source (unchanged behavior) ────────────────────────────────────

const DECK_GEN_ATTEMPTS = 4
const DECK_GEN_RETRY_MS = 2_000

/**
 * DeepBook Predict `ExpiryMarket` cards.
 *
 * This is the pre-existing deck-gen loop lifted out of `ws/matchmaking.ts`
 * verbatim — tiered selection with a flat fallback, spot read, mint-probe
 * filtering, round-robin card distribution. Behavior is intentionally
 * identical; the only addition is reporting each card's settle time.
 */
export const predictCardSource: CardSource = {
  name: "predict",

  async build({ seed, nowMs }: BuildDeckInput): Promise<BuiltDeck> {
    let markets: MarketSnapshot[] = []
    let spot = 0n
    let decision = decideDeckSize(0, resolveDeckBounds({}))
    let usedTiered = false
    let enough = false

    for (let attempt = 1; attempt <= DECK_GEN_ATTEMPTS; attempt++) {
      // Tiered selection (2 short + 3 mid, short-first) when enabled —
      // staggered settle times, ≤~15-min duel. Falls back to the flat
      // horizon picker if no safe short/mid markets are live so matchmaking
      // never dead-ends.
      let rawMarkets: MarketSnapshot[] = []
      usedTiered = false
      if (env.deckTierEnabled) {
        rawMarkets = await findTieredDeckMarkets()
        usedTiered = rawMarkets.length > 0
        if (!usedTiered) {
          log.info(
            "tiered selection empty — falling back to flat findDeckMarkets"
          )
        }
      }
      if (rawMarkets.length === 0) rawMarkets = await findDeckMarkets(5)
      spot = await readBtcSpot()
      // Drop markets whose mint currently aborts on the volatile per-market
      // LP backing gate (EInsufficientCash) — otherwise cards round-robined
      // onto a momentarily-dead market abort at swipe time. See mint-probe.ts.
      markets = await filterMintableMarkets(rawMarkets, spot)
      decision = decideDeckSize(markets.length, resolveDeckBounds({}))
      // Tiered wants >= 2 DISTINCT markets (min 2 cards, no padding — we never
      // duplicate a market to hit a fixed size, which would repeat the same
      // question/settle time). The flat fallback keeps the >= 1 floor.
      enough = usedTiered ? markets.length >= 2 : decision.ok
      if (enough) break
      if (attempt < DECK_GEN_ATTEMPTS) {
        log.info(
          `deck-gen attempt ${attempt}/${DECK_GEN_ATTEMPTS}: ${markets.length} mintable market(s) — retrying in ${DECK_GEN_RETRY_MS}ms`
        )
        await new Promise((r) => setTimeout(r, DECK_GEN_RETRY_MS))
      }
    }

    if (!enough) {
      throw new NoCardsAvailableError(
        "predict",
        `no live BTC ExpiryMarkets after ${DECK_GEN_ATTEMPTS} tries ` +
          `(found ${markets.length} mintable)`
      )
    }

    // Tiered decks take up to `deckTierSize` DISTINCT markets, soonest-first
    // (one card each) — never padding to hit a fixed size, so every card is a
    // different market + settle time. The flat fallback keeps its round-robin.
    const deckMarkets = usedTiered
      ? markets.slice(0, env.deckTierSize)
      : markets
    const deckSize = usedTiered ? deckMarkets.length : decision.deckSize
    const cards = await buildProbedDeck(
      deckMarkets,
      spot,
      seed,
      deckSize,
      nowMs
    )

    // A card's settle time is its market's expiry. `buildDeck` distributes
    // cards round-robin across `deckMarkets`, so map back by market id rather
    // than assuming index alignment.
    const expiryById = new Map(
      deckMarkets.map((m) => [m.expiryMarketId, m.expiry])
    )
    const settleAtMs = cards.map(
      (c) => expiryById.get(c.expiryMarketId) ?? nowMs
    )

    return { cards, settleAtMs, source: "predict" }
  },
}

// ─── Pyth source ────────────────────────────────────────────────────────────

/**
 * Settle times for a Pyth deck, ms after generation. Mirrors the tiered
 * Predict shape (a couple of quick cards then progressively later ones) so
 * pacing and the staggered-settle drama are unchanged — but here WE choose
 * the times instead of inheriting a market's expiry, so they're exact.
 *
 * Kept inside the ~15-min duel envelope the tiered Predict path targets.
 */
export const PYTH_SETTLE_OFFSETS_MS = [
  2 * 60_000,
  4 * 60_000,
  7 * 60_000,
  11 * 60_000,
  15 * 60_000,
] as const

/**
 * Synthetic tick grid for Pyth cards.
 *
 * Predict cards snap their strike to a market's `admissionTickSize` because
 * the mint aborts off-grid. A Pyth card is never minted, so there is no grid
 * to respect — a tick size of 1 means "no snapping", and strikes land exactly
 * where the placement logic put them.
 */
const PYTH_TICK_SIZE = 1n

/**
 * Cards priced off the Pyth BTC feed, settling at times we choose.
 *
 * All cards share one `expiryMarketId`: the Pyth feed object id. That is a
 * real on-chain `ID`, it is stable, and it makes `CardSettled` events
 * self-describing about where their price came from — better than inventing a
 * fake id. `buildDeck` already guarantees cards on the same market get
 * distinct strikes, which is exactly the constraint that matters (a duplicate
 * `(market, strike)` pair would be an identical commitment).
 *
 * Free tier only: a staked swipe mints against a real market, and there isn't
 * one here.
 */
/**
 * The pure half of the pyth source: given a spot price, lay out the deck.
 *
 * Split from `build` so the card layout can be tested without a price feed —
 * acquiring spot is a separate concern with its own failure modes, and
 * conflating them is how you end up with a test that passes because it
 * stubbed the thing that was actually broken.
 */
export function buildPythDeck(
  spot: bigint,
  seed: Uint8Array,
  nowMs: number
): BuiltDeck {
  if (spot <= 0n) {
    throw new NoCardsAvailableError("pyth", "BTC spot must be positive")
  }
  const bounds = resolveDeckBounds({})
  const deckSize = Math.min(bounds.max, PYTH_SETTLE_OFFSETS_MS.length)
  const settleAtMs = PYTH_SETTLE_OFFSETS_MS.slice(0, deckSize).map(
    (off) => nowMs + off
  )
  // One synthetic "market" per card, all sharing the feed id, each carrying
  // its own settle time so the shared strike-placement logic sees the same
  // shape it does for Predict.
  const markets: MarketSnapshot[] = settleAtMs.map((expiry) => ({
    expiryMarketId: env.pythFeedId,
    expiry,
    tickSize: PYTH_TICK_SIZE,
    admissionTickSize: PYTH_TICK_SIZE,
  }))
  const cards = buildDeck(markets, spot, seed, deckSize, nowMs)
  return { cards, settleAtMs, source: "pyth" }
}

export const pythCardSource: CardSource = {
  name: "pyth",

  async build({ seed, tier, nowMs }: BuildDeckInput): Promise<BuiltDeck> {
    if (tier === "staked") {
      throw new NoCardsAvailableError(
        "pyth",
        "the staked tier mints a real Predict position, which needs a live " +
          "ExpiryMarket — pyth cards are free-tier only"
      )
    }
    // Throws on a stale / unreadable price rather than laying out a deck
    // around a number nobody should trust. See ./pyth.ts.
    const spot = await readBtcSpot()
    return buildPythDeck(spot, seed, nowMs)
  },
}

// ─── Resolution ─────────────────────────────────────────────────────────────

/**
 * Build a deck from the configured source.
 *
 * `auto` tries Predict and falls back to Pyth only when Predict has nothing
 * to offer (`NoCardsAvailableError`). A genuine fault — a thrown parse error,
 * a bad config — propagates instead of being silently papered over with a
 * different kind of deck.
 *
 * The staked tier never falls back: `pythCardSource` refuses it outright, so
 * a staked duel fails loudly rather than quietly becoming unmintable.
 */
export async function buildDeckFromSource(
  input: BuildDeckInput
): Promise<BuiltDeck> {
  const mode = env.deckSource

  if (mode === "pyth") return pythCardSource.build(input)
  if (mode === "predict") return predictCardSource.build(input)

  try {
    return await predictCardSource.build(input)
  } catch (e) {
    if (!(e instanceof NoCardsAvailableError)) throw e
    log.warn(
      `predict source unavailable (${e.message}) — falling back to pyth cards`
    )
    return pythCardSource.build(input)
  }
}
