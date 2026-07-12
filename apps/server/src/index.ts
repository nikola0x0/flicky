/**
 * Flicky backend entry — single Bun.serve process that hosts:
 *
 *   HTTP:
 *     GET  /health
 *     POST /deckmaster/generate
 *     GET  /deckmaster/reveal?hash=0x…
 *     GET  /manager?owner=0x…   (resolve a player's AccountWrapper id)
 *     GET  /sponsor             (sponsor address + network the client builds against)
 *     POST /sponsor   (address-balance sponsored gas, allowlisted)
 *
 *   WS:
 *     /ws             matchmaking queue + duel-room broadcasts
 *                     (see src/ws/protocol.ts for the message types)
 *
 *   Background:
 *     duel indexer    polls flicky events → broadcasts to subscribed rooms
 *     settle keeper   reveal + settle_card + redeem + finalize, gas-paid by
 *                     KEEPER_SECRET_KEY (or BOT_SECRET_KEY). Disable with
 *                     KEEPER_ENABLED=false.
 */
import { env } from "./env"
import { makeLogger } from "./log"
import { CORS_HEADERS, corsPreflight, json } from "./lib/http"
import { getSuiClient, decodeKeypair } from "./lib/sui"
import { handleDeckmasterRequest, knownHashCount } from "./deckmaster"
import { handleDocsRequest } from "./docs"
import { handleDuelsRequest } from "./duels-api"
import { handleLeaderboardRequest } from "./leaderboard-api"
import { handleManagerRequest } from "./manager-api"
import { handleOracleRequest } from "./oracle"
import { handleSponsorRequest } from "./sponsor"
import { websocketHandler } from "./ws/handlers"
import { newSocketState } from "./ws/matchmaking"
import { connectedAddressCount, queueStats, roomCount } from "./ws/matchmaking"
import { startChatPruneLoop } from "./ws/chat"
import { startMatchClock, stopMatchClock } from "./ws/match-clock"
import {
  oracleStreamStats,
  startOracleStream,
  stopOracleStream,
} from "./ws/oracle-stream"
import { DuelIndexer } from "./indexer"
import { Keeper } from "./keeper"
import { closeDb, listCursors, ready } from "./db"

const log = makeLogger("server")

async function safeListCursors(): Promise<unknown> {
  try {
    return (await listCursors()).map((c) => ({
      tracker: c.trackerId.split("::").pop(),
      cursor: c.cursor,
      ageMs: Date.now() - c.updatedAt,
    }))
  } catch (e) {
    // /health is read on demand and shouldn't 500 — but log so a broken
    // DB is visible in stderr, not silently empty in the response.
    log.warn(
      `listCursors failed: ${e instanceof Error ? e.message : String(e)}`
    )
    return { error: "listCursors failed" }
  }
}

const server = Bun.serve({
  port: env.port,

  async fetch(req, server) {
    const url = new URL(req.url)

    // /sponsor has its own (stricter) CORS — check BEFORE the wildcard
    // preflight so its ALLOWED_ORIGIN rules win.
    const sponsored = await handleSponsorRequest(req)
    if (sponsored) return sponsored

    if (req.method === "OPTIONS") return corsPreflight()

    if (url.pathname === "/health") {
      // Both reads hit Postgres — run them together and degrade
      // gracefully (null / error payload) so /health still answers even
      // if the DB is briefly unreachable.
      const [decks, cursors] = await Promise.all([
        knownHashCount().catch(() => null),
        safeListCursors(),
      ])
      return json({
        ok: true,
        port: env.port,
        network: env.network,
        flickyPackageId: env.flickyPackageId,
        decks,
        ws: {
          connectedAddresses: connectedAddressCount(),
          rooms: roomCount(),
          queues: queueStats(),
        },
        services: {
          sponsor: env.sponsorSecretKey
            ? "enabled"
            : "disabled (no SPONSOR_SECRET_KEY)",
          keeper: env.keeperEnabled
            ? env.keeperSecretKey
              ? "enabled"
              : "disabled (no KEEPER_SECRET_KEY)"
            : "disabled (KEEPER_ENABLED=false)",
          indexer:
            env.indexerEnabled && env.flickyPackageId ? "enabled" : "disabled",
        },
        cursors,
        oracleStream: oracleStreamStats(),
      })
    }

    if (url.pathname === "/ws") {
      const upgraded = server.upgrade(req, { data: newSocketState() })
      if (upgraded) return undefined as unknown as Response
      return new Response("upgrade failed", { status: 400 })
    }

    const deck = await handleDeckmasterRequest(req, url)
    if (deck) return deck

    const docs = await handleDocsRequest(req, url)
    if (docs) return docs

    const oracle = await handleOracleRequest(req, url)
    if (oracle) return oracle

    const duels = await handleDuelsRequest(req, url)
    if (duels) return duels

    const leaderboard = await handleLeaderboardRequest(req, url)
    if (leaderboard) return leaderboard

    const manager = await handleManagerRequest(req, url)
    if (manager) return manager

    return new Response("Go to /docs for documentation", {
      status: 200,
      headers: CORS_HEADERS,
    })
  },

  websocket: websocketHandler,
})

log.info(`listening on http://localhost:${server.port}`)
log.info(`  GET  /health`)
log.info(`  POST /deckmaster/generate`)
log.info(`  GET  /deckmaster/reveal?hash=0x...`)
log.info(`  GET  /sponsor`)
log.info(`  POST /sponsor`)
log.info(`  GET  /oracle/list?asset=BTC`)
log.info(`  GET  /oracle/{id}`)
log.info(`  GET  /duels/recent`)
log.info(`  GET  /duels/{id}`)
log.info(`  GET  /leaderboard`)
log.info(`  GET  /manager?owner=0x...`)
log.info(`  GET  /openapi.json`)
log.info(`  GET  /docs (Scalar UI)`)
log.info(`  WS   /ws`)
log.info(`Go to http://localhost:${server.port}/docs for documentation`)
if (!env.sponsorSecretKey) {
  log.warn(`sponsor disabled — set SPONSOR_SECRET_KEY in apps/server/.env`)
}
if (!env.flickyPackageId) {
  log.warn(
    `flicky package id not found — set FLICKY_PACKAGE_ID or publish via apps/contracts`
  )
}

// ─── Background services ────────────────────────────────────────────────────
//
// Boot in parallel after the fetch handler is live so a startup hiccup
// in either subsystem doesn't take down the HTTP/WS server.

// Create the Postgres schema up front so a bad DATABASE_URL surfaces in
// the logs at boot rather than on the first duel. Non-fatal: the HTTP/WS
// layer still answers (and /health reports the DB state) if this fails.
void ready()
  .then(() => log.info("postgres schema ready"))
  .catch((e) =>
    log.error(
      `postgres init failed: ${e instanceof Error ? e.message : String(e)}`
    )
  )

if (env.indexerEnabled && env.flickyPackageId) {
  const indexer = new DuelIndexer(getSuiClient(), env.flickyPackageId)
  void indexer.start()
} else if (!env.flickyPackageId) {
  log.warn("indexer disabled — no flicky packageId")
}

startMatchClock()
startOracleStream()
startChatPruneLoop()

if (env.keeperEnabled && env.keeperSecretKey && env.flickyPackageId) {
  try {
    const keypair = decodeKeypair(env.keeperSecretKey)
    const keeper = new Keeper(getSuiClient(), keypair, env.flickyPackageId)
    void keeper.start()
  } catch (e) {
    log.error(
      `keeper boot failed: ${e instanceof Error ? e.message : String(e)}`
    )
  }
} else if (env.keeperEnabled) {
  if (!env.keeperSecretKey) {
    log.warn("keeper disabled — set KEEPER_SECRET_KEY (or BOT_SECRET_KEY)")
  }
}

// ─── Shutdown ───────────────────────────────────────────────────────────────
//
// `bun --watch` sends SIGTERM on file change; pressing ^C sends SIGINT.
// Closing the DB explicitly flushes the WAL and releases the file lock so
// the next boot doesn't trip the disk-I/O smoke test on a stale handle.

async function shutdown(signal: string): Promise<void> {
  log.info(`received ${signal}, shutting down`)
  stopMatchClock()
  stopOracleStream()
  try {
    server.stop()
  } catch (e) {
    log.warn(
      `server.stop failed: ${e instanceof Error ? e.message : String(e)}`
    )
  }
  // Close the pool so in-flight queries drain and connections are
  // released cleanly before the process exits.
  await closeDb()
  process.exit(0)
}

process.on("SIGINT", () => void shutdown("SIGINT"))
process.on("SIGTERM", () => void shutdown("SIGTERM"))
