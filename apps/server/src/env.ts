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

  // DeepBook Predict (testnet defaults).
  deepbookPredictPackageId:
    process.env.DEEPBOOK_PREDICT_PACKAGE_ID ??
    "0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138",
  deepbookPredictObjectId:
    process.env.DEEPBOOK_PREDICT_OBJECT_ID ??
    "0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a",
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
  // moment of duel creation. PRD says >10 min, but on testnet that short
  // a TTL makes BTC options near-degenerate (a 5% strike offset is
  // 30+ sigmas, so SVI rounds the binary probability to exactly 0 or 1
  // and `pricing_config::quote_spread_from_fair_price` aborts with
  // EFairPriceAlreadySettled). 30 min keeps strikes inside the
  // (0, 1) probability range for the bucket widths we use.
  deckCardMinHeadroomMs: Number(
    process.env.DECK_CARD_MIN_HEADROOM_MS ?? 30 * 60 * 1000,
  ),
  deckmasterStorePath:
    process.env.DECKMASTER_STORE_PATH ??
    resolve(import.meta.dir, "../.data/decks.json"),

  // SQLite — single file, shared by indexer cursor + any future
  // mirror tables. Override per environment via FLICKY_DB_PATH.
  dbPath:
    process.env.FLICKY_DB_PATH ??
    resolve(import.meta.dir, "../.data/flicky.db"),

  // Sponsored gas (Enoki).
  enokiPrivateKey: process.env.ENOKI_PRIVATE_KEY,
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
  chatPruneIntervalMs: Number(process.env.CHAT_PRUNE_INTERVAL_MS ?? 60 * 60 * 1000),

  // Match clock + live oracle tick streaming.
  matchTickIntervalMs: Number(process.env.MATCH_TICK_INTERVAL_MS ?? 1_000),
  oracleTickIntervalMs: Number(process.env.ORACLE_TICK_INTERVAL_MS ?? 2_000),

  // MMR.
  mmrInitialRating: Number(process.env.MMR_INITIAL_RATING ?? 1000),
  mmrKFactor: Number(process.env.MMR_K_FACTOR ?? 32),
  mmrMatchWindowInitial: Number(process.env.MMR_MATCH_WINDOW_INITIAL ?? 200),
  mmrMatchWindowExpandPerSec: Number(process.env.MMR_MATCH_WINDOW_EXPAND_PER_SEC ?? 20),

  // Keeper (background settle/redeem/finalize).
  keeperSecretKey: process.env.KEEPER_SECRET_KEY ?? process.env.BOT_SECRET_KEY,
  keeperPollIntervalMs: Number(process.env.KEEPER_POLL_INTERVAL_MS ?? 10_000),
  keeperEnabled: process.env.KEEPER_ENABLED !== "false",

  // Duel indexer (event poller → WS room broadcast).
  indexerPollIntervalMs: Number(process.env.INDEXER_POLL_INTERVAL_MS ?? 3_000),
  indexerEnabled: process.env.INDEXER_ENABLED !== "false",
} as const

export type Env = typeof env
