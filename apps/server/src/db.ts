/**
 * SQLite layer (bun:sqlite) — opened lazily at first use, single file
 * under `apps/server/.data/flicky.db` by default. We use bun:sqlite
 * directly rather than an ORM to keep the dep surface zero — Bun ships
 * with it built-in.
 *
 * Tables:
 *   event_cursor   one row per (event-type tracker) with the last
 *                  Sui EventId we successfully consumed. The indexer
 *                  resumes from this on next tick / restart.
 *
 * WAL mode is enabled so the keeper / indexer running in the same
 * process don't block each other on writes (and so an ungraceful exit
 * doesn't corrupt the file). The DB is single-writer by design — fine
 * for one Bun process; if we ever want to fan out across workers,
 * switch to Postgres (the schema is portable).
 */
import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { env } from "./env"
import { makeLogger } from "./log"

const log = makeLogger("db")

let _db: Database | null = null

export function getDb(): Database {
  if (_db) return _db
  try {
    mkdirSync(dirname(env.dbPath), { recursive: true })
    _db = new Database(env.dbPath, { create: true })
    _db.exec("PRAGMA journal_mode = WAL")
    _db.exec("PRAGMA synchronous = NORMAL")
    _db.exec("PRAGMA busy_timeout = 2000")
    _db.exec(`
      CREATE TABLE IF NOT EXISTS event_cursor (
        tracker_id TEXT PRIMARY KEY,
        tx_digest  TEXT NOT NULL,
        event_seq  TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
    _db.exec(`
      CREATE TABLE IF NOT EXISTS duel (
        id              TEXT PRIMARY KEY,
        status          TEXT NOT NULL,           -- PENDING | ACTIVE | COMPLETE
        stake_coin_type TEXT NOT NULL,
        creator         TEXT NOT NULL,
        challenger      TEXT NOT NULL,
        cards_revealed  INTEGER NOT NULL,        -- 0 / 1
        card_count      INTEGER NOT NULL,
        settled_count   INTEGER NOT NULL,
        -- Cumulative real-PnL fields per the new contract:
        --   winner determined by (p0_payout + p1_premium) vs (p1_payout + p0_premium).
        p0_payout       TEXT NOT NULL DEFAULT '0',
        p0_premium      TEXT NOT NULL DEFAULT '0',
        p1_payout       TEXT NOT NULL DEFAULT '0',
        p1_premium      TEXT NOT NULL DEFAULT '0',
        started_at_ms   INTEGER NOT NULL DEFAULT 0,
        -- JSON array of per-card outcomes (one entry per settled card,
        -- written incrementally by the indexer on CardSettled events).
        card_outcomes   TEXT NOT NULL DEFAULT '[]',
        last_updated_ms INTEGER NOT NULL
      )
    `)
    // Backfill schema for older DB files. ALTER fails silently if the
    // column already exists, which is the success case here.
    for (const stmt of [
      `ALTER TABLE duel ADD COLUMN card_outcomes TEXT NOT NULL DEFAULT '[]'`,
      `ALTER TABLE duel ADD COLUMN p0_payout TEXT NOT NULL DEFAULT '0'`,
      `ALTER TABLE duel ADD COLUMN p0_premium TEXT NOT NULL DEFAULT '0'`,
      `ALTER TABLE duel ADD COLUMN p1_payout TEXT NOT NULL DEFAULT '0'`,
      `ALTER TABLE duel ADD COLUMN p1_premium TEXT NOT NULL DEFAULT '0'`,
      `ALTER TABLE duel ADD COLUMN started_at_ms INTEGER NOT NULL DEFAULT 0`,
    ]) {
      try {
        _db.exec(stmt)
      } catch {
        /* already present */
      }
    }
    _db.exec(`CREATE INDEX IF NOT EXISTS duel_status_updated
              ON duel (status, last_updated_ms DESC)`)
    _db.exec(`CREATE INDEX IF NOT EXISTS duel_creator
              ON duel (creator, last_updated_ms DESC)`)
    _db.exec(`
      CREATE TABLE IF NOT EXISTS chat_message (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        from_address TEXT NOT NULL,
        text         TEXT NOT NULL,
        timestamp_ms INTEGER NOT NULL
      )
    `)
    _db.exec(`CREATE INDEX IF NOT EXISTS chat_message_ts
              ON chat_message (timestamp_ms DESC)`)
    _db.exec(`
      CREATE TABLE IF NOT EXISTS player_rating (
        address         TEXT PRIMARY KEY,
        rating          INTEGER NOT NULL,
        games_played    INTEGER NOT NULL,
        wins            INTEGER NOT NULL DEFAULT 0,
        losses          INTEGER NOT NULL DEFAULT 0,
        ties            INTEGER NOT NULL DEFAULT 0,
        last_updated_ms INTEGER NOT NULL
      )
    `)
    _db.exec(`CREATE INDEX IF NOT EXISTS player_rating_lb
              ON player_rating (rating DESC)`)
    smokeTest(_db)
    log.info(`opened ${env.dbPath} (WAL)`)
    return _db
  } catch (e) {
    const msg = describeError(e)
    log.error(`failed to open ${env.dbPath}: ${msg}`)
    log.error(
      `hint: if you ran 'bun --hot', a stale process may still hold the file. ` +
        `Check with 'lsof ${env.dbPath}' and kill the PID, then 'rm ${env.dbPath}-shm ${env.dbPath}-wal'.`,
    )
    throw e
  }
}

/**
 * Write + read a sentinel so a broken DB fails at boot, not in the
 * middle of an indexer tick. Common causes the smoke test catches:
 * file locked by another process, deleted out from under us, disk full,
 * permission changed.
 */
function smokeTest(db: Database): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS _smoketest (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  )
  // Fixed key — every boot overwrites the same row, so this table never
  // grows past one entry regardless of how many times we restart.
  const key = "boot"
  const value = `${process.pid}@${Date.now()}`
  db.query(
    `INSERT INTO _smoketest (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value)
  const row = db
    .query<{ value: string }, [string]>(
      "SELECT value FROM _smoketest WHERE key = ?",
    )
    .get(key)
  if (row?.value !== value) {
    throw new Error("smoke test mismatch: write succeeded but read returned wrong value")
  }
}

export function closeDb(): void {
  if (_db) {
    try {
      _db.close()
      log.info(`closed ${env.dbPath}`)
    } catch (e) {
      log.warn(`close failed: ${describeError(e)}`)
    } finally {
      _db = null
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

export interface EventCursor {
  txDigest: string
  eventSeq: string
}

export function loadCursor(trackerId: string): EventCursor | null {
  try {
    const row = getDb()
      .query<
        { tx_digest: string; event_seq: string },
        [string]
      >("SELECT tx_digest, event_seq FROM event_cursor WHERE tracker_id = ?")
      .get(trackerId)
    if (!row) return null
    return { txDigest: row.tx_digest, eventSeq: row.event_seq }
  } catch (e) {
    log.error(`loadCursor(${trackerId}): ${describeError(e)}`)
    throw e
  }
}

export function saveCursor(trackerId: string, cursor: EventCursor): void {
  try {
    getDb()
      .query(
        `INSERT INTO event_cursor (tracker_id, tx_digest, event_seq, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(tracker_id) DO UPDATE SET
           tx_digest = excluded.tx_digest,
           event_seq = excluded.event_seq,
           updated_at = excluded.updated_at`,
      )
      .run(trackerId, cursor.txDigest, cursor.eventSeq, Date.now())
  } catch (e) {
    log.error(`saveCursor(${trackerId}): ${describeError(e)}`)
    throw e
  }
}

// ─── Duel mirror ────────────────────────────────────────────────────────────

export interface CardOutcome {
  cardIdx: number
  settlementPrice: string
  /** Card strike copied for convenience so consumers can compute UP-won locally. */
  strike: string
  /** `settlementPrice > strike` — UP side won this card. */
  upWon: boolean
}

export interface DuelRow {
  id: string
  status: "PENDING" | "ACTIVE" | "COMPLETE"
  stakeCoinType: string
  creator: string
  challenger: string
  cardsRevealed: boolean
  cardCount: number
  settledCount: number
  /** Cumulative real-PnL fields. See contract `Duel.p{0,1}_payout/premium`. */
  p0Payout: string
  p0Premium: string
  p1Payout: string
  p1Premium: string
  /** Clock timestamp when the duel went ACTIVE (set in `join_duel`). 0 while PENDING. */
  startedAtMs: number
  cardOutcomes: CardOutcome[]
  lastUpdatedMs: number
}

export function upsertDuel(d: Omit<DuelRow, "lastUpdatedMs">): void {
  try {
    getDb()
      .query(
        `INSERT INTO duel (id, status, stake_coin_type, creator, challenger,
                           cards_revealed, card_count, settled_count,
                           p0_payout, p0_premium, p1_payout, p1_premium,
                           started_at_ms, card_outcomes, last_updated_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status          = excluded.status,
           stake_coin_type = excluded.stake_coin_type,
           creator         = excluded.creator,
           challenger      = excluded.challenger,
           cards_revealed  = excluded.cards_revealed,
           card_count      = excluded.card_count,
           settled_count   = excluded.settled_count,
           p0_payout       = excluded.p0_payout,
           p0_premium      = excluded.p0_premium,
           p1_payout       = excluded.p1_payout,
           p1_premium      = excluded.p1_premium,
           started_at_ms   = excluded.started_at_ms,
           card_outcomes   = excluded.card_outcomes,
           last_updated_ms = excluded.last_updated_ms`,
      )
      .run(
        d.id,
        d.status,
        d.stakeCoinType,
        d.creator,
        d.challenger,
        d.cardsRevealed ? 1 : 0,
        d.cardCount,
        d.settledCount,
        d.p0Payout,
        d.p0Premium,
        d.p1Payout,
        d.p1Premium,
        d.startedAtMs,
        JSON.stringify(d.cardOutcomes),
        Date.now(),
      )
  } catch (e) {
    log.error(`upsertDuel(${d.id}): ${describeError(e)}`)
    throw e
  }
}

/**
 * Merge a freshly-emitted CardSettled outcome into the duel's
 * card_outcomes JSON array. Idempotent: if an outcome already exists
 * for this card_idx it's overwritten (later event wins).
 */
export function mergeCardOutcome(duelId: string, outcome: CardOutcome): void {
  try {
    const row = getDb()
      .query<{ card_outcomes: string }, [string]>(
        "SELECT card_outcomes FROM duel WHERE id = ?",
      )
      .get(duelId)
    let arr: CardOutcome[] = []
    if (row) {
      try {
        arr = JSON.parse(row.card_outcomes) as CardOutcome[]
      } catch {
        arr = []
      }
    }
    const i = arr.findIndex((o) => o.cardIdx === outcome.cardIdx)
    if (i >= 0) arr[i] = outcome
    else arr.push(outcome)
    arr.sort((a, b) => a.cardIdx - b.cardIdx)
    if (row) {
      getDb()
        .query<unknown, [string, number, string]>(
          "UPDATE duel SET card_outcomes = ?, last_updated_ms = ? WHERE id = ?",
        )
        .run(JSON.stringify(arr), Date.now(), duelId)
    }
    // If `row` is null the duel hasn't been mirrored yet — the next
    // `upsertDuel` from the indexer's refresh path will include this
    // outcome via a re-read from chain, so we just no-op here.
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
  cards_revealed: number
  card_count: number
  settled_count: number
  p0_payout: string
  p0_premium: string
  p1_payout: string
  p1_premium: string
  started_at_ms: number
  card_outcomes: string
  last_updated_ms: number
}

function rowToDuel(r: DuelRowRaw): DuelRow {
  let outcomes: CardOutcome[] = []
  try {
    outcomes = JSON.parse(r.card_outcomes ?? "[]") as CardOutcome[]
  } catch {
    outcomes = []
  }
  return {
    id: r.id,
    status: r.status as DuelRow["status"],
    stakeCoinType: r.stake_coin_type,
    creator: r.creator,
    challenger: r.challenger,
    cardsRevealed: r.cards_revealed === 1,
    cardCount: r.card_count,
    settledCount: r.settled_count,
    p0Payout: r.p0_payout,
    p0Premium: r.p0_premium,
    p1Payout: r.p1_payout,
    p1Premium: r.p1_premium,
    startedAtMs: r.started_at_ms,
    cardOutcomes: outcomes,
    lastUpdatedMs: r.last_updated_ms,
  }
}

export function getDuel(id: string): DuelRow | null {
  const row = getDb()
    .query<DuelRowRaw, [string]>("SELECT * FROM duel WHERE id = ?")
    .get(id)
  return row ? rowToDuel(row) : null
}

export function listRecentDuels(
  limit: number,
  status?: DuelRow["status"],
): DuelRow[] {
  const rows = status
    ? getDb()
        .query<DuelRowRaw, [string, number]>(
          "SELECT * FROM duel WHERE status = ? ORDER BY last_updated_ms DESC LIMIT ?",
        )
        .all(status, limit)
    : getDb()
        .query<DuelRowRaw, [number]>(
          "SELECT * FROM duel ORDER BY last_updated_ms DESC LIMIT ?",
        )
        .all(limit)
  return rows.map(rowToDuel)
}

export function countDuels(): number {
  return (
    getDb()
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM duel")
      .get()?.c ?? 0
  )
}

// ─── Chat ───────────────────────────────────────────────────────────────────

export interface ChatMessage {
  id: number
  fromAddress: string
  text: string
  timestampMs: number
}

export function insertChatMessage(fromAddress: string, text: string): ChatMessage {
  const now = Date.now()
  const res = getDb()
    .query<{ id: number }, [string, string, number]>(
      `INSERT INTO chat_message (from_address, text, timestamp_ms)
       VALUES (?, ?, ?) RETURNING id`,
    )
    .get(fromAddress, text, now)
  return { id: res?.id ?? 0, fromAddress, text, timestampMs: now }
}

export function recentChatMessages(limit: number): ChatMessage[] {
  const rows = getDb()
    .query<
      { id: number; from_address: string; text: string; timestamp_ms: number },
      [number]
    >(
      `SELECT id, from_address, text, timestamp_ms FROM chat_message
       ORDER BY id DESC LIMIT ?`,
    )
    .all(limit)
  // Reverse so the caller can render in chronological order.
  return rows.reverse().map((r) => ({
    id: r.id,
    fromAddress: r.from_address,
    text: r.text,
    timestampMs: r.timestamp_ms,
  }))
}

/** Drop everything but the newest `keep` rows. Called periodically. */
export function pruneChatMessages(keep: number): number {
  const res = getDb()
    .query<{ changes: number }, [number]>(
      `DELETE FROM chat_message
       WHERE id NOT IN (
         SELECT id FROM chat_message ORDER BY id DESC LIMIT ?
       )`,
    )
    .run(keep)
  return res.changes
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

export function getPlayerRating(address: string): PlayerRating {
  const row = getDb()
    .query<
      {
        address: string
        rating: number
        games_played: number
        wins: number
        losses: number
        ties: number
        last_updated_ms: number
      },
      [string]
    >(
      `SELECT address, rating, games_played, wins, losses, ties, last_updated_ms
       FROM player_rating WHERE address = ?`,
    )
    .get(address)
  if (!row) {
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
  return {
    address: row.address,
    rating: row.rating,
    gamesPlayed: row.games_played,
    wins: row.wins,
    losses: row.losses,
    ties: row.ties,
    lastUpdatedMs: row.last_updated_ms,
  }
}

export function upsertPlayerRating(r: PlayerRating): void {
  getDb()
    .query(
      `INSERT INTO player_rating
         (address, rating, games_played, wins, losses, ties, last_updated_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(address) DO UPDATE SET
         rating = excluded.rating,
         games_played = excluded.games_played,
         wins = excluded.wins,
         losses = excluded.losses,
         ties = excluded.ties,
         last_updated_ms = excluded.last_updated_ms`,
    )
    .run(
      r.address,
      r.rating,
      r.gamesPlayed,
      r.wins,
      r.losses,
      r.ties,
      r.lastUpdatedMs,
    )
}

export function leaderboard(limit: number): PlayerRating[] {
  const rows = getDb()
    .query<
      {
        address: string
        rating: number
        games_played: number
        wins: number
        losses: number
        ties: number
        last_updated_ms: number
      },
      [number]
    >(
      `SELECT address, rating, games_played, wins, losses, ties, last_updated_ms
       FROM player_rating
       WHERE games_played > 0
       ORDER BY rating DESC LIMIT ?`,
    )
    .all(limit)
  return rows.map((r) => ({
    address: r.address,
    rating: r.rating,
    gamesPlayed: r.games_played,
    wins: r.wins,
    losses: r.losses,
    ties: r.ties,
    lastUpdatedMs: r.last_updated_ms,
  }))
}

// ─── Cursors (existing) ─────────────────────────────────────────────────────

export function listCursors(): Array<EventCursor & { trackerId: string; updatedAt: number }> {
  return getDb()
    .query<
      { tracker_id: string; tx_digest: string; event_seq: string; updated_at: number },
      []
    >("SELECT tracker_id, tx_digest, event_seq, updated_at FROM event_cursor")
    .all()
    .map((r) => ({
      trackerId: r.tracker_id,
      txDigest: r.tx_digest,
      eventSeq: r.event_seq,
      updatedAt: r.updated_at,
    }))
}
