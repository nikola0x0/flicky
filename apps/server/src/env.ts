/**
 * Centralized env loading. Touch this file when adding a new var so the
 * defaults / required-at-boot rules live in one place.
 *
 * Convention: vars used by HTTP/WS at boot are required at startup;
 * vars used only by the settle keeper (signer keys, package ids) fail
 * lazily when that subsystem actually tries to run.
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

export type Network = "mainnet" | "testnet" | "devnet" | "localnet"

interface DeployedJson {
  network?: string
  packageId: string | null
}

function loadFlickyPackageId(): string | null {
  const override = process.env.FLICKY_PACKAGE_ID
  if (override) return override
  try {
    const path = resolve(import.meta.dir, "../../contracts/deployed.json")
    const deployed = JSON.parse(readFileSync(path, "utf-8")) as DeployedJson
    return deployed.packageId ?? null
  } catch {
    return null
  }
}

export const env = {
  port: Number(process.env.PORT ?? 3001),

  network: (process.env.SUI_NETWORK ?? "testnet") as Network,
  rpcUrl: process.env.SUI_RPC_URL,

  // Flicky package (from deployed.json unless overridden).
  flickyPackageId: loadFlickyPackageId(),

  // DeepBook Predict (testnet defaults — 6-24).
  deepbookPredictPackageId:
    process.env.DEEPBOOK_PREDICT_PACKAGE_ID ??
    "0xdb3ef5a5129920e59c9b2ae25a77eddb48acd0e1c6307b97073f0e076016446e",
  deepbookPredictObjectId:
    process.env.DEEPBOOK_PREDICT_OBJECT_ID ??
    "0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a",
  protocolConfigId:
    process.env.PROTOCOL_CONFIG_ID ??
    "0x2325224629b4bd96d1f1d7ee937e07f8a06f861018a130bbb26db09cb0394cb6",
  poolVaultId:
    process.env.POOL_VAULT_ID ??
    "0xfde98c636eb8a7aba59c3a238cfee6b576b7118d1e5ffa2952876c4b270a3a2a",
  predictRegistryId:
    process.env.PREDICT_REGISTRY_ID ??
    "0x54afbf245caf42466cedb5756ed7816f34f544afdfa13579a862eccf3afa21ca",
  accountPackageId:
    process.env.ACCOUNT_PACKAGE_ID ??
    "0xb9389eac8d59170ffd1427c1a66e5c8306263464fcc6615e825c1f5b3e15da3b",
  accountRegistryId:
    process.env.ACCOUNT_REGISTRY_ID ??
    "0x3c54d5b8b6bca376fc289121838ad02f8a5b3843242b9ad7e8f8245720e685a2",
  propbookPackageId:
    process.env.PROPBOOK_PACKAGE_ID ??
    "0x8eb2adde1c91f8b7c9ba5e9b0a32bfb804510c342939c5f77458fd8143f9755b",
  oracleRegistryId:
    process.env.ORACLE_REGISTRY_ID ??
    "0xf3deaff68cbd081a35ec21653af6f671d2ad5f012f3b4d817d81752843374136",
  pythFeedId:
    process.env.BTC_PYTH_FEED_ID ??
    "0xc78d7de16217d46d21b92ae475da799448be30b71a758dc6d7bb3ac2f1c35afb",
  bsSpotFeedId:
    process.env.BTC_BS_SPOT_FEED_ID ??
    "0xcdc5fa7364e60fd2504aa96f65b707dc0734e507a919b1a7d7d63164fd67b745",
  bsForwardFeedId:
    process.env.BTC_BS_FWD_FEED_ID ??
    "0xe72c734ea8d8dcbc9183d9d8f96f51aaa1fb5034d5ed33ac60d67d261e15b48a",
  bsSviFeedId:
    process.env.BTC_BS_SVI_FEED_ID ??
    "0xdc2f8270676bd05fb28491e8d4a41a495722fda7a454926dd66dbba256a21c69",
  accumulatorRootId: process.env.ACCUMULATOR_ROOT_ID ?? "0xacc",
  predictIndexerUrl:
    process.env.PREDICT_INDEXER_URL ??
    "https://predict-server-beta.testnet.mystenlabs.com",
  propbookIndexerUrl:
    process.env.PROPBOOK_INDEXER_URL ??
    "https://propbook.api.testnet.mystenlabs.com",
  predictSettlementMode: (Bun.env.PREDICT_SETTLEMENT_MODE === "onchain"
    ? "onchain"
    : "keeper") as "keeper" | "onchain",
  deckStrikeMode: (Bun.env.DECK_STRIKE_MODE === "svi_quote"
    ? "svi_quote"
    : "price_offset") as "price_offset" | "svi_quote",
  dusdcCoinType:
    process.env.DUSDC_COIN_TYPE ??
    "0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC",

  // SUI ↔ dUSDC AMM swap module (separate package from flicky duel —
  // published from apps/contracts/swap/). Sponsor allowlists the two
  // player-facing AMM functions (swap_x_for_y / swap_y_for_x); the
  // pool / liquidity admin functions are NOT sponsored.
  swapPackageId:
    process.env.SWAP_PACKAGE_ID ??
    "0x51ea0f29321f3c25f8b2f530ecd3ed3dec569d954c8832d318de7e203653a936",

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
  // Optional override for the AccountWrapper the probe mints against. Defaults
  // to the sponsor/keeper key's own (deterministic) wrapper — devInspect never
  // charges it, so it only needs to exist and hold a little dUSDC.
  probeWrapperId: process.env.PROBE_WRAPPER_ID,
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
  sponsorSecretKey: process.env.SPONSOR_SECRET_KEY,
  // Max gas (MIST) the sponsor will cover per transaction — a defensive cap
  // enforced by the `gasBudget` validator (default 0.1 SUI).
  sponsorMaxGasBudget: BigInt(process.env.SPONSOR_MAX_GAS_BUDGET ?? 100_000_000),
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

  // Keeper (background settle/redeem/finalize).
  keeperSecretKey: process.env.KEEPER_SECRET_KEY ?? process.env.BOT_SECRET_KEY,
  keeperPollIntervalMs: Number(process.env.KEEPER_POLL_INTERVAL_MS ?? 10_000),
  keeperEnabled: process.env.KEEPER_ENABLED !== "false",

  // Duel indexer (event poller → WS room broadcast).
  indexerPollIntervalMs: Number(process.env.INDEXER_POLL_INTERVAL_MS ?? 3_000),
  indexerEnabled: process.env.INDEXER_ENABLED !== "false",
} as const

export type Env = typeof env
