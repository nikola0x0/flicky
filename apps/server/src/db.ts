/**
 * Postgres layer (Bun.sql) — every async, backed by a single connection
 * pool created from `DATABASE_URL`. We use Bun's built-in `Bun.sql`
 * rather than an ORM or a third-party driver to keep the dep surface at
 * zero (the server still ships no runtime deps beyond @mysten/*).
 *
 * Tables (created on first use by `ensureSchema`):
 *   event_cursor   one row per (event-type tracker) with the last Sui
 *                  EventId we consumed. The indexer resumes from this.
 *   duel           mirror of recent duel state for /duels reads.
 *   chat_message   global chat backlog, auto-pruned.
 *   player_rating  ELO ratings + W/L/T counters.
 *   deck           deckmaster commit-reveal plaintext (was decks.json).
 *
 * Postgres replaces the old single-file bun:sqlite DB so the backend can
 * run as a normal stateless container on Railway (no volume) and, later,
 * fan out across workers — the schema was always written to be portable.
 *
 * Connection: the deployed service uses the private `DATABASE_URL`
 * (postgres.railway.internal); local dev / tests use the public proxy
 * URL. A missing URL throws at first query, not at import, so unit tests
 * that never touch the DB still load this module.
 */
import { SQL } from "bun"
import { env } from "./env"
import { makeLogger } from "./log"

const log = makeLogger("db")

let _sql: SQL | null = null
let _ready: Promise<void> | null = null

/** Lazily build the shared pool. Throws if DATABASE_URL is unset. */
export function getSql(): SQL {
  if (_sql) return _sql
  if (!env.databaseUrl) {
    throw new Error(
      "DATABASE_URL is not set — point it at the Railway Postgres " +
        "(set it to the private URL when deployed, the public proxy URL locally)",
    )
  }
  _sql = new SQL({ url: env.databaseUrl, max: env.dbPoolMax })
  return _sql
}

/**
 * Create every table + index if missing. Memoized so concurrent callers
 * share one round of DDL. Each exported function awaits this first, so
 * the schema is guaranteed present before the first read/write regardless
 * of which entry point runs first (indexer tick, WS handler, /health…).
 */
export function ready(): Promise<void> {
  if (_ready) return _ready
  _ready = ensureSchema().catch((e) => {
    // Reset so a transient failure (DB still booting) can be retried on
    // the next call rather than poisoning the singleton forever.
    _ready = null
    throw e
  })
  return _ready
}

async function ensureSchema(): Promise<void> {
  const sql = getSql()
  // event_cursor stored (tx_digest, event_seq) under JSON-RPC. The GraphQL
  // cursor is a single opaque string, so migrate the legacy shape once: drop
  // the old table if it still carries tx_digest, then (re)create with a
  // `cursor` column. Idempotent — the drop is skipped after the first boot.
  const legacyCursor = (await sql`
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'event_cursor' AND column_name = 'tx_digest'
    LIMIT 1
  `) as unknown[]
  if (legacyCursor.length > 0) {
    await sql`DROP TABLE event_cursor`
  }
  await sql`
    CREATE TABLE IF NOT EXISTS event_cursor (
      tracker_id TEXT PRIMARY KEY,
      cursor     TEXT   NOT NULL,
      updated_at BIGINT NOT NULL
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS duel (
      id              TEXT PRIMARY KEY,
      status          TEXT    NOT NULL,            -- PENDING | ACTIVE | COMPLETE
      stake_coin_type TEXT    NOT NULL,
      creator         TEXT    NOT NULL,
      challenger      TEXT    NOT NULL,
      cards_revealed  BOOLEAN NOT NULL DEFAULT FALSE,
      card_count      INTEGER NOT NULL,
      settled_count   INTEGER NOT NULL,
      -- Cumulative real-PnL fields per the contract; winner determined by
      -- (p0_payout + p1_premium) vs (p1_payout + p0_premium). Stored as
      -- TEXT because these are u64 values that can exceed 2^53.
      p0_payout       TEXT    NOT NULL DEFAULT '0',
      p0_premium      TEXT    NOT NULL DEFAULT '0',
      p1_payout       TEXT    NOT NULL DEFAULT '0',
      p1_premium      TEXT    NOT NULL DEFAULT '0',
      -- Authoritative duel result recorded live from DuelFinalized:
      -- 'p0' (creator), 'p1' (challenger), or 'tie'. NULL until finalized,
      -- or for rows finalized before this column existed (those fall back
      -- to the head-to-head net rule documented above).
      winner          TEXT,
      started_at_ms   BIGINT  NOT NULL DEFAULT 0,
      -- JSON blobs (kept as TEXT, mirroring the old SQLite layout — we
      -- never query inside them, only round-trip whole arrays).
      card_outcomes   TEXT    NOT NULL DEFAULT '[]',
      swipes          TEXT    NOT NULL DEFAULT '[]',
      cards           TEXT    NOT NULL DEFAULT '[]',
      last_updated_ms BIGINT  NOT NULL
    )
  `
  // Idempotent add for tables created before the winner column existed.
  await sql`ALTER TABLE duel ADD COLUMN IF NOT EXISTS winner TEXT`
  await sql`CREATE INDEX IF NOT EXISTS duel_status_updated
            ON duel (status, last_updated_ms DESC)`
  await sql`CREATE INDEX IF NOT EXISTS duel_creator
            ON duel (creator, last_updated_ms DESC)`
  await sql`
    CREATE TABLE IF NOT EXISTS chat_message (
      id           BIGSERIAL PRIMARY KEY,
      from_address TEXT   NOT NULL,
      text         TEXT   NOT NULL,
      timestamp_ms BIGINT NOT NULL
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS chat_message_ts
            ON chat_message (timestamp_ms DESC)`
  await sql`
    CREATE TABLE IF NOT EXISTS player_rating (
      address         TEXT PRIMARY KEY,
      rating          INTEGER NOT NULL,
      games_played    INTEGER NOT NULL,
      wins            INTEGER NOT NULL DEFAULT 0,
      losses          INTEGER NOT NULL DEFAULT 0,
      ties            INTEGER NOT NULL DEFAULT 0,
      last_updated_ms BIGINT  NOT NULL
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS player_rating_lb
            ON player_rating (rating DESC)`
  await sql`
    CREATE TABLE IF NOT EXISTS deck (
      hash_hex   TEXT PRIMARY KEY,   -- lowercased 0x… sha2-256 commitment
      cards      TEXT   NOT NULL,    -- JSON [{oracle_id, strike: string}]
      seed_hex   TEXT,
      created_at BIGINT NOT NULL
    )
  `
  // Owner → PredictManager id cache. The manager is a SHARED object with an
  // internal `owner` field, so it can't be found via getOwnedObjects —
  // discovery means an unbounded `PredictManagerCreated` event scan
  // (predict.ts::findManagerFor). We memoize the resolved id here: a
  // manager's owner never changes, so a hit is permanent and skips the scan.
  await sql`
    CREATE TABLE IF NOT EXISTS predict_manager (
      owner      TEXT PRIMARY KEY,
      manager_id TEXT   NOT NULL,
      cached_at  BIGINT NOT NULL
    )
  `
  log.info(`schema ready on ${redactUrl(env.databaseUrl ?? "")}`)
}

/** Strip credentials from a connection URL for safe logging. */
function redactUrl(url: string): string {
  return url.replace(/:\/\/([^:]+):([^@]+)@/, "://$1:****@")
}

export async function closeDb(): Promise<void> {
  if (_sql) {
    try {
      await _sql.end()
      log.info("closed pool")
    } catch (e) {
      log.warn(`close failed: ${describeError(e)}`)
    } finally {
      _sql = null
      _ready = null
    }
  }
}

function describeError(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as { code?: string }).code
    return code ? `${e.message} [${code}]` : e.message
  }
  return String(e)
}

// ─── Cursors ──────────────────────────────────────────────────────────────────

export async function loadCursor(trackerId: string): Promise<string | null> {
  await ready()
  const sql = getSql()
  try {
    const rows = (await sql`
      SELECT cursor FROM event_cursor WHERE tracker_id = ${trackerId}
    `) as Array<{ cursor: string }>
    return rows[0]?.cursor ?? null
  } catch (e) {
    log.error(`loadCursor(${trackerId}): ${describeError(e)}`)
    throw e
  }
}

export async function saveCursor(
  trackerId: string,
  cursor: string,
): Promise<void> {
  await ready()
  const sql = getSql()
  try {
    await sql`
      INSERT INTO event_cursor (tracker_id, cursor, updated_at)
      VALUES (${trackerId}, ${cursor}, ${Date.now()})
      ON CONFLICT (tracker_id) DO UPDATE SET
        cursor     = EXCLUDED.cursor,
        updated_at = EXCLUDED.updated_at
    `
  } catch (e) {
    log.error(`saveCursor(${trackerId}): ${describeError(e)}`)
    throw e
  }
}

export async function listCursors(): Promise<
  Array<{ trackerId: string; cursor: string; updatedAt: number }>
> {
  await ready()
  const sql = getSql()
  const rows = (await sql`
    SELECT tracker_id, cursor, updated_at FROM event_cursor
  `) as Array<{
    tracker_id: string
    cursor: string
    updated_at: number | string | bigint
  }>
  return rows.map((r) => ({
    trackerId: r.tracker_id,
    cursor: r.cursor,
    updatedAt: Number(r.updated_at),
  }))
}

// ─── Duel mirror ────────────────────────────────────────────────────────────

export interface CardOutcome {
  cardIdx: number
  settlementPrice: string
  /** Card strike copied for convenience so consumers can compute UP-won locally. */
  strike: string
  /** `settlementPrice > strike` — UP side won this card. */
  upWon: boolean
  /**
   * Per-player real PnL for this card: `pnl = (won ? quantity : 0) - premium`.
   * Signed decimal string (may start with '-'). null when the player
   * didn't swipe this card.
   */
  p0Pnl: string | null
  p1Pnl: string | null
  /** Snapshot of each player's swipe (or null if they didn't swipe). */
  p0Swipe: { isUp: boolean; quantity: string; premium: string } | null
  p1Swipe: { isUp: boolean; quantity: string; premium: string } | null
}

/** Which side won a finished duel: creator (p0), challenger (p1), or a tie. */
export type DuelWinner = "p0" | "p1" | "tie"

export interface DuelRow {
  id: string
  status: "PENDING" | "ACTIVE" | "COMPLETE"
  stakeCoinType: string
  creator: string
  challenger: string
  cardsRevealed: boolean
  cardCount: number
  settledCount: number
  /**
   * Authoritative duel result from the on-chain DuelFinalized event, or
   * null if not yet finalized / finalized before this was recorded.
   * Optional in the write type: `upsertDuel` never sets it (so a refresh
   * can't clobber it) — only `setDuelWinner` does.
   */
  winner?: DuelWinner | null
  /** Cumulative real-PnL fields. See contract `Duel.p{0,1}_payout/premium`. */
  p0Payout: string
  p0Premium: string
  p1Payout: string
  p1Premium: string
  /** Clock timestamp when the duel went ACTIVE (set in `join_duel`). 0 while PENDING. */
  startedAtMs: number
  cardOutcomes: CardOutcome[]
  swipes: PendingSwipe[]
  /**
   * Per-card metadata (oracle_id + strike) so a UI rendering this row
   * can subscribe to oracle ticks for mark-to-market PnL between
   * settlements. Empty until the indexer's first refreshDuel pass.
   */
  cards: Array<{ oracle_id: string; strike: string }>
  lastUpdatedMs: number
}

export interface PendingSwipe {
  cardIdx: number
  p0Swipe: { isUp: boolean; quantity: string; premium: string } | null
  p1Swipe: { isUp: boolean; quantity: string; premium: string } | null
}

export async function upsertDuel(d: Omit<DuelRow, "lastUpdatedMs">): Promise<void> {
  await ready()
  const sql = getSql()
  try {
    await sql`
      INSERT INTO duel (id, status, stake_coin_type, creator, challenger,
                        cards_revealed, card_count, settled_count,
                        p0_payout, p0_premium, p1_payout, p1_premium,
                        started_at_ms, card_outcomes, swipes, cards,
                        last_updated_ms)
      VALUES (${d.id}, ${d.status}, ${d.stakeCoinType}, ${d.creator},
              ${d.challenger}, ${d.cardsRevealed}, ${d.cardCount},
              ${d.settledCount}, ${d.p0Payout}, ${d.p0Premium},
              ${d.p1Payout}, ${d.p1Premium}, ${d.startedAtMs},
              ${JSON.stringify(d.cardOutcomes)}, ${JSON.stringify(d.swipes)},
              ${JSON.stringify(d.cards)}, ${Date.now()})
      ON CONFLICT (id) DO UPDATE SET
        status          = EXCLUDED.status,
        stake_coin_type = EXCLUDED.stake_coin_type,
        creator         = EXCLUDED.creator,
        challenger      = EXCLUDED.challenger,
        cards_revealed  = EXCLUDED.cards_revealed,
        card_count      = EXCLUDED.card_count,
        settled_count   = EXCLUDED.settled_count,
        p0_payout       = EXCLUDED.p0_payout,
        p0_premium      = EXCLUDED.p0_premium,
        p1_payout       = EXCLUDED.p1_payout,
        p1_premium      = EXCLUDED.p1_premium,
        started_at_ms   = EXCLUDED.started_at_ms,
        card_outcomes   = EXCLUDED.card_outcomes,
        swipes          = EXCLUDED.swipes,
        cards           = EXCLUDED.cards,
        last_updated_ms = EXCLUDED.last_updated_ms
    `
  } catch (e) {
    log.error(`upsertDuel(${d.id}): ${describeError(e)}`)
    throw e
  }
}

/**
 * Record the authoritative winner of a finished duel. Written separately
 * from `upsertDuel` so the indexer's per-tick refresh (which doesn't know
 * the winner) can't clobber it. No-op if the duel row isn't mirrored yet.
 */
export async function setDuelWinner(
  duelId: string,
  winner: DuelWinner,
): Promise<void> {
  await ready()
  const sql = getSql()
  try {
    await sql`UPDATE duel SET winner = ${winner} WHERE id = ${duelId}`
  } catch (e) {
    log.error(`setDuelWinner(${duelId}): ${describeError(e)}`)
  }
}

/**
 * Merge a freshly-emitted CardSettled outcome into the duel's
 * card_outcomes JSON array. Idempotent: if an outcome already exists
 * for this card_idx it's overwritten (later event wins). Runs in a
 * transaction with `SELECT … FOR UPDATE` so a concurrent indexer/keeper
 * write can't clobber the read-modify-write.
 */
export async function mergeCardOutcome(
  duelId: string,
  outcome: CardOutcome,
): Promise<void> {
  await ready()
  const sql = getSql()
  try {
    await sql.begin(async (tx) => {
      const rows = (await tx`
        SELECT card_outcomes FROM duel WHERE id = ${duelId} FOR UPDATE
      `) as Array<{ card_outcomes: string }>
      const row = rows[0]
      // If the duel hasn't been mirrored yet the next upsertDuel from the
      // indexer's refresh path will include this outcome via a re-read
      // from chain, so we just no-op here.
      if (!row) return
      let arr: CardOutcome[] = []
      try {
        arr = JSON.parse(row.card_outcomes) as CardOutcome[]
      } catch {
        arr = []
      }
      const i = arr.findIndex((o) => o.cardIdx === outcome.cardIdx)
      if (i >= 0) arr[i] = outcome
      else arr.push(outcome)
      arr.sort((a, b) => a.cardIdx - b.cardIdx)
      await tx`
        UPDATE duel SET card_outcomes = ${JSON.stringify(arr)},
                        last_updated_ms = ${Date.now()}
        WHERE id = ${duelId}
      `
    })
  } catch (e) {
    log.error(`mergeCardOutcome(${duelId}): ${describeError(e)}`)
    throw e
  }
}

interface DuelRowRaw {
  id: string
  status: string
  stake_coin_type: string
  creator: string
  challenger: string
  cards_revealed: boolean
  card_count: number
  settled_count: number
  p0_payout: string
  p0_premium: string
  p1_payout: string
  p1_premium: string
  winner: string | null
  started_at_ms: number | string | bigint
  card_outcomes: string
  swipes: string
  cards: string
  last_updated_ms: number | string | bigint
}

function rowToDuel(r: DuelRowRaw): DuelRow {
  let outcomes: CardOutcome[] = []
  try {
    outcomes = JSON.parse(r.card_outcomes ?? "[]") as CardOutcome[]
  } catch {
    outcomes = []
  }
  let swipes: PendingSwipe[] = []
  try {
    swipes = JSON.parse(r.swipes ?? "[]") as PendingSwipe[]
  } catch {
    swipes = []
  }
  let cards: DuelRow["cards"] = []
  try {
    cards = JSON.parse(r.cards ?? "[]") as DuelRow["cards"]
  } catch {
    cards = []
  }
  return {
    id: r.id,
    status: r.status as DuelRow["status"],
    stakeCoinType: r.stake_coin_type,
    creator: r.creator,
    challenger: r.challenger,
    cardsRevealed: Boolean(r.cards_revealed),
    cardCount: r.card_count,
    settledCount: r.settled_count,
    p0Payout: r.p0_payout,
    p0Premium: r.p0_premium,
    p1Payout: r.p1_payout,
    p1Premium: r.p1_premium,
    winner: (r.winner as DuelWinner | null) ?? null,
    startedAtMs: Number(r.started_at_ms),
    cardOutcomes: outcomes,
    swipes,
    cards,
    lastUpdatedMs: Number(r.last_updated_ms),
  }
}

export async function getDuel(id: string): Promise<DuelRow | null> {
  await ready()
  const sql = getSql()
  const rows = (await sql`SELECT * FROM duel WHERE id = ${id}`) as DuelRowRaw[]
  return rows[0] ? rowToDuel(rows[0]) : null
}

export async function listRecentDuels(
  limit: number,
  status?: DuelRow["status"],
  player?: string,
): Promise<DuelRow[]> {
  await ready()
  const sql = getSql()
  // Build the WHERE clause dynamically — both filters are optional and
  // composable. `player` matches either side (creator OR challenger).
  // `sql.unsafe` takes positional ($1…) params; values are still bound,
  // never interpolated, so this stays injection-safe.
  const where: string[] = []
  const params: Array<string | number> = []
  if (status) {
    params.push(status)
    where.push(`status = $${params.length}`)
  }
  if (player) {
    params.push(player, player)
    where.push(`(creator = $${params.length - 1} OR challenger = $${params.length})`)
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")} ` : ""
  params.push(limit)
  const query = `SELECT * FROM duel ${whereSql}ORDER BY last_updated_ms DESC LIMIT $${params.length}`
  const rows = (await sql.unsafe(query, params)) as DuelRowRaw[]
  return rows.map(rowToDuel)
}

export async function countDuels(): Promise<number> {
  await ready()
  const sql = getSql()
  const rows = (await sql`SELECT COUNT(*)::int AS c FROM duel`) as Array<{
    c: number
  }>
  return rows[0]?.c ?? 0
}

// ─── Chat ───────────────────────────────────────────────────────────────────

export interface ChatMessage {
  id: number
  fromAddress: string
  text: string
  timestampMs: number
}

export async function insertChatMessage(
  fromAddress: string,
  text: string,
): Promise<ChatMessage> {
  await ready()
  const sql = getSql()
  const now = Date.now()
  const rows = (await sql`
    INSERT INTO chat_message (from_address, text, timestamp_ms)
    VALUES (${fromAddress}, ${text}, ${now})
    RETURNING id
  `) as Array<{ id: number | string | bigint }>
  return { id: Number(rows[0]?.id ?? 0), fromAddress, text, timestampMs: now }
}

export async function recentChatMessages(limit: number): Promise<ChatMessage[]> {
  await ready()
  const sql = getSql()
  const rows = (await sql`
    SELECT id, from_address, text, timestamp_ms FROM chat_message
    ORDER BY id DESC LIMIT ${limit}
  `) as Array<{
    id: number | string | bigint
    from_address: string
    text: string
    timestamp_ms: number | string | bigint
  }>
  // Reverse so the caller can render in chronological order.
  return rows.reverse().map((r) => ({
    id: Number(r.id),
    fromAddress: r.from_address,
    text: r.text,
    timestampMs: Number(r.timestamp_ms),
  }))
}

/** Drop everything but the newest `keep` rows. Called periodically. */
export async function pruneChatMessages(keep: number): Promise<number> {
  await ready()
  const sql = getSql()
  const rows = (await sql`
    WITH deleted AS (
      DELETE FROM chat_message
      WHERE id NOT IN (
        SELECT id FROM chat_message ORDER BY id DESC LIMIT ${keep}
      )
      RETURNING id
    )
    SELECT COUNT(*)::int AS c FROM deleted
  `) as Array<{ c: number }>
  return rows[0]?.c ?? 0
}

// ─── Player ratings (MMR) ───────────────────────────────────────────────────

export interface PlayerRating {
  address: string
  rating: number
  gamesPlayed: number
  wins: number
  losses: number
  ties: number
  lastUpdatedMs: number
}

const DEFAULT_RATING = 1000

interface PlayerRatingRaw {
  address: string
  rating: number
  games_played: number
  wins: number
  losses: number
  ties: number
  last_updated_ms: number | string | bigint
}

function rowToRating(r: PlayerRatingRaw): PlayerRating {
  return {
    address: r.address,
    rating: r.rating,
    gamesPlayed: r.games_played,
    wins: r.wins,
    losses: r.losses,
    ties: r.ties,
    lastUpdatedMs: Number(r.last_updated_ms),
  }
}

export async function getPlayerRating(address: string): Promise<PlayerRating> {
  await ready()
  const sql = getSql()
  const rows = (await sql`
    SELECT address, rating, games_played, wins, losses, ties, last_updated_ms
    FROM player_rating WHERE address = ${address}
  `) as PlayerRatingRaw[]
  if (!rows[0]) {
    return {
      address,
      rating: DEFAULT_RATING,
      gamesPlayed: 0,
      wins: 0,
      losses: 0,
      ties: 0,
      lastUpdatedMs: 0,
    }
  }
  return rowToRating(rows[0])
}

export async function upsertPlayerRating(r: PlayerRating): Promise<void> {
  await ready()
  const sql = getSql()
  await sql`
    INSERT INTO player_rating
      (address, rating, games_played, wins, losses, ties, last_updated_ms)
    VALUES (${r.address}, ${r.rating}, ${r.gamesPlayed}, ${r.wins},
            ${r.losses}, ${r.ties}, ${r.lastUpdatedMs})
    ON CONFLICT (address) DO UPDATE SET
      rating          = EXCLUDED.rating,
      games_played    = EXCLUDED.games_played,
      wins            = EXCLUDED.wins,
      losses          = EXCLUDED.losses,
      ties            = EXCLUDED.ties,
      last_updated_ms = EXCLUDED.last_updated_ms
  `
}

export async function leaderboard(limit: number): Promise<PlayerRating[]> {
  await ready()
  const sql = getSql()
  const rows = (await sql`
    SELECT address, rating, games_played, wins, losses, ties, last_updated_ms
    FROM player_rating
    WHERE games_played > 0
    ORDER BY rating DESC LIMIT ${limit}
  `) as PlayerRatingRaw[]
  return rows.map(rowToRating)
}

/**
 * Wipe the entire player_rating table. Used by the ratings backfill,
 * which recomputes ELO from scratch by replaying COMPLETE duels — the
 * table must start empty so the replay isn't added on top of stale rows.
 */
export async function clearPlayerRatings(): Promise<number> {
  await ready()
  const sql = getSql()
  const rows = (await sql`
    WITH deleted AS (DELETE FROM player_rating RETURNING address)
    SELECT COUNT(*)::int AS c FROM deleted
  `) as Array<{ c: number }>
  return rows[0]?.c ?? 0
}

// ─── Deckmaster plaintext store (commit-reveal) ──────────────────────────────
//
// Was apps/server/.data/decks.json. Each row stores the revealed card
// vector (+ the seed used to derive the strikes) keyed by the lowercased
// "0x…" sha2-256 commitment. deckmaster.ts wraps these with its bigint
// (strike) (de)serialization.

export interface DeckStoreRow {
  /** JSON of [{ oracle_id, strike: string }]. */
  cardsJson: string
  seedHex: string | null
}

export async function upsertDeck(
  hashHex: string,
  cardsJson: string,
  seedHex: string | null,
): Promise<void> {
  await ready()
  const sql = getSql()
  await sql`
    INSERT INTO deck (hash_hex, cards, seed_hex, created_at)
    VALUES (${hashHex.toLowerCase()}, ${cardsJson}, ${seedHex}, ${Date.now()})
    ON CONFLICT (hash_hex) DO UPDATE SET
      cards    = EXCLUDED.cards,
      seed_hex = EXCLUDED.seed_hex
  `
}

export async function getDeck(hashHex: string): Promise<DeckStoreRow | null> {
  await ready()
  const sql = getSql()
  const rows = (await sql`
    SELECT cards, seed_hex FROM deck WHERE hash_hex = ${hashHex.toLowerCase()}
  `) as Array<{ cards: string; seed_hex: string | null }>
  const row = rows[0]
  return row ? { cardsJson: row.cards, seedHex: row.seed_hex } : null
}

export async function deleteDeck(hashHex: string): Promise<void> {
  await ready()
  const sql = getSql()
  await sql`DELETE FROM deck WHERE hash_hex = ${hashHex.toLowerCase()}`
}

export async function countDecks(): Promise<number> {
  await ready()
  const sql = getSql()
  const rows = (await sql`SELECT COUNT(*)::int AS c FROM deck`) as Array<{
    c: number
  }>
  return rows[0]?.c ?? 0
}

// ─── PredictManager cache ───────────────────────────────────────────────────

/**
 * Resolved manager id for `owner`, or null if we've never cached one.
 * A cache hit lets `findManagerFor` skip the on-chain event scan entirely.
 */
export async function getCachedManager(owner: string): Promise<string | null> {
  await ready()
  const sql = getSql()
  try {
    const rows = (await sql`
      SELECT manager_id FROM predict_manager WHERE owner = ${owner}
    `) as Array<{ manager_id: string }>
    return rows[0]?.manager_id ?? null
  } catch (e) {
    log.error(`getCachedManager(${owner}): ${describeError(e)}`)
    return null
  }
}

/**
 * Memoize `owner → managerId`. Upserts so a re-bootstrapped owner (one who
 * minted a fresh manager) overwrites the stale id on next discovery.
 */
export async function cacheManager(
  owner: string,
  managerId: string,
): Promise<void> {
  await ready()
  const sql = getSql()
  try {
    await sql`
      INSERT INTO predict_manager (owner, manager_id, cached_at)
      VALUES (${owner}, ${managerId}, ${Date.now()})
      ON CONFLICT (owner) DO UPDATE SET
        manager_id = EXCLUDED.manager_id,
        cached_at  = EXCLUDED.cached_at
    `
  } catch (e) {
    log.error(`cacheManager(${owner}): ${describeError(e)}`)
  }
}
