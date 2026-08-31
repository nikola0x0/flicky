/**
 * Centralized env loading. Touch this file when adding a new var so the
 * defaults / required-at-boot rules live in one place.
 *
 * Convention: vars used by HTTP/WS at boot are required at startup;
 * vars used only by the settle keeper (signer keys, package ids) fail
 * lazily when that subsystem actually tries to run.
 *
 * Chain-scoped values (package ids, shared objects, oracle feeds, indexer
 * URLs, signer keys) live in `./network-env`, which resolves them per
 * network. `env` spreads the DEFAULT network's slice so the many existing
 * `env.accountRegistryId`-style call sites keep working unchanged; code that
 * must serve a specific network calls `networkEnv(net)` directly.
 */
import { networkEnv, isNetwork, type Network } from "./network-env"

export type { Network }

/** The network everything defaults to when a request doesn't say otherwise. */
const defaultNetwork: Network = (() => {
  const raw = process.env.SUI_NETWORK ?? "testnet"
  if (!isNetwork(raw)) {
    throw new Error(
      `Bad SUI_NETWORK "${raw}" — want mainnet | testnet | devnet | localnet.`
    )
  }
  return raw
})()

/**
 * Networks this process will serve, from `SUI_NETWORKS` (comma-separated).
 * Defaults to just the default network, so adding mainnet is an explicit
 * opt-in on the deploy rather than something that switches on by accident.
 * The default network is always included.
 */
function loadEnabledNetworks(): Network[] {
  const raw = process.env.SUI_NETWORKS
  if (!raw) return [defaultNetwork]
  const parsed = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  for (const n of parsed) {
    if (!isNetwork(n)) {
      throw new Error(
        `Bad SUI_NETWORKS entry "${n}" — want mainnet | testnet | devnet | localnet.`
      )
    }
  }
  const nets = parsed.filter(isNetwork)
  return nets.includes(defaultNetwork) ? nets : [defaultNetwork, ...nets]
}

/** A Season prize tier: ranks `rankStart..rankEnd` (inclusive, 1-based) each pay `amount`. */
export interface PrizeTier {
  rankStart: number
  rankEnd: number
  amount: number
}

// Season 0 default split: 1st 4 / 2nd 2 / 3rd 1 / 4th–9th 0.5 each (rank 10
// wins nothing). Pool total is DERIVED from this (sum over tiers) so the
// headline number and the per-rank breakdown can never drift:
// 4 + 2 + 1 + 0.5×6 = 10 SUI exactly.
const DEFAULT_PRIZE_SPLIT: PrizeTier[] = [
  { rankStart: 1, rankEnd: 1, amount: 4 },
  { rankStart: 2, rankEnd: 2, amount: 2 },
  { rankStart: 3, rankEnd: 3, amount: 1 },
  { rankStart: 4, rankEnd: 9, amount: 0.5 },
]

/**
 * Parse `SEASON_PRIZE_SPLIT` ("start:end:amount,start:end:amount,…") into prize
 * tiers, or fall back to {@link DEFAULT_PRIZE_SPLIT}. A malformed override throws
 * at boot rather than silently mis-displaying prizes.
 */
function loadSeasonPrizeSplit(): PrizeTier[] {
  const raw = process.env.SEASON_PRIZE_SPLIT
  if (!raw) return DEFAULT_PRIZE_SPLIT
  return raw.split(",").map((seg) => {
    const [rankStart, rankEnd, amount] = seg.split(":").map(Number)
    if (![rankStart, rankEnd, amount].every(Number.isFinite)) {
      throw new Error(
        `Bad SEASON_PRIZE_SPLIT segment "${seg}" — want start:end:amount (e.g. 1:1:200,4:10:25).`
      )
    }
    return { rankStart, rankEnd, amount }
  })
}

/**
 * Parse a bigint env var. `.env.example` documents optional vars as
 * `NAME=` (empty); Bun's dotenv loads that as `""`, and `BigInt("")`
 * is `0n`. Using `??` alone therefore turns "leave the default" into
 * a 0-MIST sponsor cap that 403s every transaction.
 */
export function parseEnvBigInt(
  raw: string | undefined,
  fallback: bigint | number
): bigint {
  const trimmed = raw?.trim()
  if (!trimmed) return BigInt(fallback)
  return BigInt(trimmed)
}

export const env = {
  port: Number(process.env.PORT ?? 3001),

  // Chain-scoped config for the DEFAULT network (SUI_NETWORK, default
  // testnet). Supplies `network` itself plus flickyPackageId,
  // deepbookPredictPackageId, accountRegistryId, predictIndexerUrl,
  // keeperSecretKey, sponsorSecretKey, … — see ./network-env.ts. Code that
  // must serve a specific network calls `networkEnv(net)` instead.
  ...networkEnv(defaultNetwork),

  // Every network this process serves. Adding mainnet is an explicit opt-in
  // on the deploy (SUI_NETWORKS=testnet,mainnet), never implicit.
  enabledNetworks: loadEnabledNetworks(),

  predictSettlementMode: (Bun.env.PREDICT_SETTLEMENT_MODE === "onchain"
    ? "onchain"
    : "keeper") as "keeper" | "onchain",
  deckStrikeMode: (Bun.env.DECK_STRIKE_MODE === "svi_quote"
    ? "svi_quote"
    : "price_offset") as "price_offset" | "svi_quote",

  // Max age of an on-chain Pyth price before we refuse to use it. Spot feeds
  // a deck's strikes and (for pyth-sourced cards) the settlement price, so a
  // stale read must fail loudly rather than settle a card against a price
  // from an hour ago. 2 min is generous — the feed ticks every few seconds.
  pythMaxStalenessMs: Number(process.env.PYTH_MAX_STALENESS_MS ?? 120_000),

  // Predict revival watch (src/predict-watch.ts). Polls for the newest
  // MarketCreated event and logs PREDICT_REVIVED the moment markets start
  // flowing again. 6-24 went dark 2026-08-17 and nobody noticed for 12 days
  // because nothing watched the upstream the whole game depends on.
  predictWatchEnabled: process.env.PREDICT_WATCH_ENABLED !== "false",
  predictWatchIntervalMs: Number(
    process.env.PREDICT_WATCH_INTERVAL_MS ?? 15 * 60 * 1000
  ),

  // Where a deck's cards come from. See src/card-source.ts.
  //
  //   "predict" — DeepBook Predict ExpiryMarkets (the original source; the
  //               only one the STAKED tier can use, since a staked swipe
  //               mints a real position against a market).
  //   "pyth"    — cards synthesized against the Pyth BTC feed, settled by
  //               the keeper from that same feed. Free tier only.
  //   "auto"    — prefer Predict, fall back to Pyth when Predict discovery
  //               comes up empty.
  //
  // Default is "predict" — today's exact behavior. "auto"/"pyth" are opt-in
  // and currently NOT usable: the pyth source has no live price to read.
  // DeepBook's on-chain pyth_feed mirror is Mysten-pushed and went stale
  // 2026-08-05, and Pyth's own Hermes API requires a key (401 on both the
  // stable and beta channels). Until a price source is chosen, leaving this
  // on "auto" would turn one clear "no live markets" error into a confusing
  // two-stage failure ending in a staleness message that hides the real
  // cause. See docs/superpowers/plans/2026-08-30-predict-independence.md.
  deckSource: ((): "predict" | "pyth" | "auto" => {
    const raw = process.env.DECK_SOURCE ?? "predict"
    if (raw === "predict" || raw === "pyth" || raw === "auto") return raw
    throw new Error(`Bad DECK_SOURCE "${raw}" — want predict | pyth | auto.`)
  })(),

  // Deckmaster: minimum headroom each card's oracle must clear at the
  // moment of duel creation. PRD says >10 min. On testnet the upstream
  // BTC oracle cron creates a new oracle every 15 min with a 1h45m
  // lifetime, so requiring 30 min of headroom yields a steady-state
  // count of exactly 4 eligible oracles — one short of the 5-card deck
  // and matchmaking deadlocks. 10 min consistently exposes 5 oracles.
  // Cards with very short TTL may have their PRG-chosen strike rejected
  // by `pricing_config::quote_spread_from_fair_price` (probability
  // rounds to 0/1 → EFairPriceAlreadySettled); `buildAndProbeDeck`
  // already falls back to ATM on probe failure so the deck still
  // generates — just with less difficulty variety on tight-TTL cards.
  deckCardMinHeadroomMs: Number(
    process.env.DECK_CARD_MIN_HEADROOM_MS ?? 10 * 60 * 1000
  ),
  // Upper expiry bound for deck oracles: the max acceptable time-to-settle
  // for a duel. A card can only settle once its oracle expires, and
  // `finalize` needs ALL cards settled, so oracles expiring beyond this
  // would hold the game open too long. 3h cleanly admits the ~15-min
  // cadence oracles (≤1h45m lifetime) plus any other soon-settling oracle,
  // while excluding multi-day oracles.
  deckCardMaxHorizonMs: Number(
    process.env.DECK_CARD_MAX_HORIZON_MS ?? 3 * 60 * 60 * 1000
  ),
  // Deckmaster quote band: a card's implied probability (its UP ask from
  // `predict::get_trade_amounts`) must stay inside [min, max]. Keeps decks
  // free of near-certain 90/10 cards — the protocol's own ask bounds
  // (1%/99%) are far looser than what makes a fun prediction.
  deckQuoteMinProb: Number(process.env.DECK_QUOTE_MIN_PROB ?? 0.2),
  deckQuoteMaxProb: Number(process.env.DECK_QUOTE_MAX_PROB ?? 0.8),
  // Deck-gen mint-admissibility probe (see mint-probe.ts). 6-24 markets gate
  // each mint on a volatile per-market LP cash reserve (expiry_cash::
  // assert_backing, EInsufficientCash) that the indexer exposes no field for,
  // so before building a deck we devInspect a representative ATM mint on each
  // candidate market and drop the ones that currently reject it. Runs once at
  // deck creation, off the hot swipe path. Set `DECK_PROBE_MINTABLE=false` to
  // disable (deck then uses the raw headroom-filtered market set).
  deckProbeMintable: (process.env.DECK_PROBE_MINTABLE ?? "true") !== "false",
  // ─── Tiered deck selection (staggered settle drama, ≤~15-min duel) ────────
  // When enabled, deck-gen uses `selectTieredMarkets` instead of the flat
  // `findDeckMarkets` horizon picker: it composes the deck from the 6-24
  // cadence's short (3′) + mid (15′) market tiers so cards settle at
  // staggered times while the whole duel finishes in ≤~15 min. See
  // deckmaster.ts + docs/oracle-selection.md. OPT-IN (default off) so
  // merging to main is a no-op until the Railway vars below are set — prod
  // currently runs the flat picker with DECK_CARD_MIN_HEADROOM_MS=300000.
  deckTierEnabled: (process.env.DECK_TIER_ENABLED ?? "false") !== "false",
  // How many markets of each tier to compose the deck from. `buildDeck`
  // round-robins `deckSize` cards across whatever the selector returns, so
  // these are targets, not hard requirements (2 short + 3 mid = 5 markets).
  deckShortCount: Number(process.env.DECK_SHORT_COUNT ?? 2),
  deckMidCount: Number(process.env.DECK_MID_COUNT ?? 3),
  // Max deck size for the tiered path: take up to this many DISTINCT markets
  // (soonest-first, one card each). We never pad/duplicate a market to hit a
  // fixed size — that would repeat the same question + settle time. So the
  // card count floats between 2 (the min gate in matchmaking) and this cap.
  deckTierSize: Number(process.env.DECK_TIER_SIZE ?? 4),
  // Per-tier TTL floor at selection time — the market must live at least this
  // long to be swipeable. Cards are ordered soonest-expiry-first and swiped
  // in that order, so a market only needs to outlast the moment IT is reached
  // (reveal latency + its swipe-order position), not the full 5-min window.
  // Short: ~90s (covers create+join+reveal + the first swipe). Mid: 2 min —
  // NOT 5.5 min: the old floor assumed the pre-per-card-deadline model where
  // any card could be swiped at t=5min; now mids are ordered after shorts and
  // swiped early, so 2 min is safe AND admits the ~4-min-TTL mid rung that
  // 5.5 min wrongly filtered — giving ~4 distinct markets instead of 3.
  deckShortTtlFloorMs: Number(process.env.DECK_SHORT_TTL_FLOOR_MS ?? 90_000),
  deckMidTtlFloorMs: Number(process.env.DECK_MID_TTL_FLOOR_MS ?? 120_000),
  // Per-card swipe-deadline buffer the UI subtracts from a card's market
  // expiry (card deadline = expiry − buffer). Must cover zkLogin sign +
  // sponsor round-trip + build + execute (longest measured ~12s); 20s is
  // generous. Also consumed by the check:cadence diagnostic. The web reads
  // its own copy from config.ts — keep the two in sync.
  deckTxBufferMs: Number(process.env.DECK_TX_BUFFER_MS ?? 20_000),

  // Postgres (Bun.sql). All persistence — indexer cursors, the duel
  // mirror, chat, player ratings, and the deckmaster plaintext store —
  // lives here. On Railway the deployed service reads the private
  // `DATABASE_URL` (postgres.railway.internal); local dev / tests point
  // at the public proxy URL. No default: a missing URL fails fast at
  // first query so a misconfigured deploy doesn't silently lose data.
  databaseUrl: process.env.DATABASE_URL,
  // Connection-pool ceiling for Bun.sql. Railway's starter Postgres caps
  // at a modest max_connections; 10 leaves headroom for psql / migrations.
  dbPoolMax: Number(process.env.DB_POOL_MAX ?? 10),

  // Sponsored gas (address-balance sponsor). SPONSOR_SECRET_KEY is a bech32
  // suiprivkey1… key whose address holds SUI in its on-chain address balance
  // (fund once via src/scripts/fund-sponsor.ts). Unset → POST /sponsor 503s
  // and the web client falls back to wallet-paid gas.
  // Max gas (MIST) the sponsor will cover per transaction — a defensive cap
  // enforced by the `gasBudget` validator (default 0.1 SUI).
  sponsorMaxGasBudget: parseEnvBigInt(
    process.env.SPONSOR_MAX_GAS_BUDGET,
    100_000_000n
  ),
  // Sponsor address-balance monitor. Sponsored gas is paid from the sponsor
  // key's on-chain address balance (empty gas payment), which drains with use
  // and, when empty, makes every POST /sponsor fail with an opaque "Invalid
  // withdraw reservation" — a silent outage. The monitor polls the balance and
  // WARNs below the threshold so it can be topped up (fund:sponsor) first.
  // Default warn floor 0.5 SUI; check every 5 min.
  sponsorMinBalanceWarnMist: parseEnvBigInt(
    process.env.SPONSOR_MIN_BALANCE_WARN_MIST,
    500_000_000n
  ),
  sponsorBalanceCheckIntervalMs: Number(
    process.env.SPONSOR_BALANCE_CHECK_INTERVAL_MS ?? 5 * 60 * 1000
  ),
  allowedOrigin: process.env.ALLOWED_ORIGIN, // unset/"" → *

  // Matchmaking: sync-only PvP. No bot-fill — Practice Mode covers
  // solo-vs-bot through a separate WS message.

  // Peer-left grace before we emit `peer_forfeit`. The on-chain forfeit
  // itself isn't implemented (would need a Move entry function); this is
  // a signal layer the UI can use to offer "claim forfeit" affordances.
  peerForfeitGraceMs: Number(process.env.PEER_FORFEIT_GRACE_MS ?? 30_000),

  // Chat (global room).
  chatHistoryLimit: Number(process.env.CHAT_HISTORY_LIMIT ?? 50),
  chatRetainCount: Number(process.env.CHAT_RETAIN_COUNT ?? 1000),
  chatPruneIntervalMs: Number(
    process.env.CHAT_PRUNE_INTERVAL_MS ?? 60 * 60 * 1000
  ),

  // Match clock + live oracle tick streaming.
  matchTickIntervalMs: Number(process.env.MATCH_TICK_INTERVAL_MS ?? 1_000),
  oracleTickIntervalMs: Number(process.env.ORACLE_TICK_INTERVAL_MS ?? 2_000),

  // MMR.
  mmrInitialRating: Number(process.env.MMR_INITIAL_RATING ?? 1000),
  mmrKFactor: Number(process.env.MMR_K_FACTOR ?? 32),
  mmrMatchWindowInitial: Number(process.env.MMR_MATCH_WINDOW_INITIAL ?? 200),
  mmrMatchWindowExpandPerSec: Number(
    process.env.MMR_MATCH_WINDOW_EXPAND_PER_SEC ?? 20
  ),

  // Season 0 leaderboard prizes (DISPLAY-ONLY — payout is manual ops at
  // season end, no escrow contract). Every field is env-override-able so the
  // pool/split/end-date can change without a redeploy. The pool total is
  // derived from `seasonPrizeSplit` (see season.ts), never a separate number.
  seasonId: process.env.SEASON_ID ?? "season-1",
  seasonName: process.env.SEASON_NAME ?? "Season 1",
  // ISO instant the season ends; the web renders a live countdown to it.
  seasonEndsAt: process.env.SEASON_ENDS_AT ?? "2026-07-31T23:59:59Z",
  seasonPrizeCurrency: process.env.SEASON_PRIZE_CURRENCY ?? "SUI",
  seasonPrizeSplit: loadSeasonPrizeSplit(),
  // Min completed STAKED duels a player needs to be prize-ELIGIBLE (a cheap
  // sybil / free-duel-farming guard — prizes are real SUI, so a winner must
  // have staked real dUSDC at least once). This does NOT gate leaderboard
  // ENTRY: any player with ≥1 completed duel of any tier is ranked. Set to 0
  // to drop the gate entirely (every ranked player becomes prize-eligible).
  seasonMinStakedDuels: Number(process.env.SEASON_MIN_STAKED_DUELS ?? 1),
  seasonEligibilityNote:
    process.env.SEASON_ELIGIBILITY_NOTE ?? "Final prizes at team discretion.",
  // NOTE: the on-chain prize escrow ids (seasonPackageId / seasonPoolId /
  // seasonAdminCapId) are chain-scoped and now live in ./network-env.ts —
  // they arrive here via the spread above.

  // Keeper (background settle/redeem/finalize).
  keeperPollIntervalMs: Number(process.env.KEEPER_POLL_INTERVAL_MS ?? 10_000),
  keeperEnabled: process.env.KEEPER_ENABLED !== "false",

  // Duel indexer (event poller → WS room broadcast).
  indexerPollIntervalMs: Number(process.env.INDEXER_POLL_INTERVAL_MS ?? 3_000),
  indexerEnabled: process.env.INDEXER_ENABLED !== "false",
} as const

export type Env = typeof env
