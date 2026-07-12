/**
 * End-to-end WebSocket test — spins up Bun.serve in-process with the
 * real handler stack and drives clients through the e2e flow:
 *   hello → chat_history → chat_send broadcast →
 *   queue_join (balance gate rejects, no chain set up) →
 *   practice_start rejected (no oracles, since we point at non-existent network) →
 *   room_subscribe + chat_react (player-only filter via mirror).
 *
 * No network: indexer + keeper + match-clock + oracle-stream are all
 * disabled via env. Sponsor stays disabled (no SPONSOR_SECRET_KEY). The
 * test focuses on the WS protocol surface that doesn't require the
 * Sui RPC to be reachable.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

// Disable everything that talks to chain BEFORE importing the server
// module — env.ts captures these at module-load time.
process.env.PORT = "0" // ask Bun.serve for any free port
process.env.KEEPER_ENABLED = "false"
process.env.INDEXER_ENABLED = "false"
// Avoid log noise; runtime can still emit warnings.
process.env.MATCH_TICK_INTERVAL_MS = "999999"
process.env.ORACLE_TICK_INTERVAL_MS = "999999"

// Import dynamically so env mutations above land before module init.
let serverModule: { server: { port: number | undefined; stop: () => void } }
// We'll grab the Bun.serve instance via a small bootstrap because
// `index.ts` doesn't export the server. Inline the minimal subset:
import { handleDeckmasterRequest } from "./deckmaster"
import { handleDocsRequest } from "./docs"
import { handleDuelsRequest } from "./duels-api"
import { handleLeaderboardRequest } from "./leaderboard-api"
import { handleOracleRequest } from "./oracle"
import { handleSponsorRequest } from "./sponsor"
import { CORS_HEADERS, corsPreflight, json } from "./lib/http"
import { websocketHandler } from "./ws/handlers"
import { newSocketState } from "./ws/matchmaking"
import { closeDb, upsertDuel } from "./db"
import { HAS_TEST_DB, resetTables } from "./test-db"

let server: ReturnType<typeof Bun.serve> | null = null
let baseUrl = ""

beforeAll(async () => {
  if (HAS_TEST_DB) await resetTables()
  server = Bun.serve({
    port: 0,
    async fetch(req, srv) {
      const url = new URL(req.url)
      const sponsored = await handleSponsorRequest(req)
      if (sponsored) return sponsored
      if (req.method === "OPTIONS") return corsPreflight()
      if (url.pathname === "/health") return json({ ok: true })
      if (url.pathname === "/ws") {
        const upgraded = srv.upgrade(req, { data: newSocketState() })
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
      return new Response("flicky e2e", { status: 200, headers: CORS_HEADERS })
    },
    websocket: websocketHandler,
  })
  baseUrl = `ws://localhost:${server.port}/ws`
  serverModule = { server: { port: server.port, stop: () => server!.stop() } }
  // Silence the "unused variable" lint warning while still keeping
  // a clear handle to the server module for debugging.
  void serverModule
})

afterAll(async () => {
  server?.stop()
  await closeDb()
})

// ─── tiny WS client helper ──────────────────────────────────────────────────

interface RecvOpts {
  /** Wait until we see a message whose `type` matches, then return it. */
  type: string
  /** Timeout in ms. */
  timeoutMs?: number
}

class WSClient {
  readonly ws: WebSocket
  readonly received: unknown[] = []
  private waiters: Array<{
    type: string
    resolve: (m: unknown) => void
    timer: ReturnType<typeof setTimeout>
  }> = []

  constructor(url: string) {
    this.ws = new WebSocket(url)
    this.ws.addEventListener("message", (e) => {
      const msg = JSON.parse(typeof e.data === "string" ? e.data : "")
      this.received.push(msg)
      const idx = this.waiters.findIndex(
        (w) => (msg as { type: string }).type === w.type
      )
      if (idx >= 0) {
        const w = this.waiters.splice(idx, 1)[0]
        clearTimeout(w.timer)
        w.resolve(msg)
      }
    })
  }

  async open(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return
    await new Promise<void>((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve(), { once: true })
      this.ws.addEventListener("error", () => reject(new Error("ws error")), {
        once: true,
      })
    })
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg))
  }

  waitFor<T = unknown>({ type, timeoutMs = 2000 }: RecvOpts): Promise<T> {
    // First check already-received.
    const existing = this.received.find(
      (m) => (m as { type: string }).type === type
    )
    if (existing) return Promise.resolve(existing as T)
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.type === type)
        if (i >= 0) this.waiters.splice(i, 1)
        reject(
          new Error(
            `timeout waiting for "${type}"; got: ${this.received.map((r) => (r as { type: string }).type).join(", ")}`
          )
        )
      }, timeoutMs)
      this.waiters.push({ type, resolve: (m) => resolve(m as T), timer })
    })
  }

  close(): void {
    this.ws.close()
  }
}

function flushTick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 10))
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_TEST_DB)("WS end-to-end", () => {
  test("hello → ack + chat_history", async () => {
    const c = new WSClient(baseUrl)
    await c.open()
    c.send({ type: "hello", address: "0xalice" })
    const hello = await c.waitFor<{ type: string; address: string }>({
      type: "hello",
    })
    expect(hello.address).toBe("0xalice")
    const hist = await c.waitFor<{ type: string; messages: unknown[] }>({
      type: "chat_history",
    })
    expect(Array.isArray(hist.messages)).toBe(true)
    c.close()
  })

  test("global chat: one client's chat_send reaches every connected client", async () => {
    const a = new WSClient(baseUrl)
    const b = new WSClient(baseUrl)
    await Promise.all([a.open(), b.open()])
    a.send({ type: "hello", address: "0xa" })
    b.send({ type: "hello", address: "0xb" })
    await a.waitFor({ type: "chat_history" })
    await b.waitFor({ type: "chat_history" })
    a.send({ type: "chat_send", text: "from-alice" })
    const seenByA = await a.waitFor<{
      type: string
      from: string
      text: string
    }>({
      type: "chat_message",
      timeoutMs: 2000,
    })
    const seenByB = await b.waitFor<{
      type: string
      from: string
      text: string
    }>({
      type: "chat_message",
      timeoutMs: 2000,
    })
    expect(seenByA.text).toBe("from-alice")
    expect(seenByB.from).toBe("0xa")
    a.close()
    b.close()
  })

  test("ping → pong", async () => {
    const c = new WSClient(baseUrl)
    await c.open()
    c.send({ type: "hello", address: "0xpinger" })
    await c.waitFor({ type: "hello" })
    c.send({ type: "ping" })
    const pong = await c.waitFor<{ type: string }>({ type: "pong" })
    expect(pong.type).toBe("pong")
    c.close()
  })

  test("queue_join {tier: 'practice'} rejected with practice_no_queue", async () => {
    const c = new WSClient(baseUrl)
    await c.open()
    c.send({ type: "hello", address: "0xpracticeuser" })
    await c.waitFor({ type: "hello" })
    c.send({ type: "queue_join", tier: "practice" })
    const err = await c.waitFor<{
      type: string
      code: string
      message: string
    }>({
      type: "error",
    })
    expect(err.code).toBe("practice_no_queue")
    expect(err.message).toContain("practice_start")
    c.close()
  })

  test("emoji reaction filters to creator + challenger via duel mirror", async () => {
    // Seed a duel into the mirror so the chat handler knows who the
    // two players are. (Indexer is disabled, so we write directly.)
    const DUEL_ID = "0xduel0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e"
    await upsertDuel({
      id: DUEL_ID,
      status: "ACTIVE",
      stakeCoinType: "0x2::sui::SUI",
      creator: "0xcreator-e2e",
      challenger: "0xchallenger-e2e",
      cardsRevealed: true,
      cardCount: 5,
      settledCount: 0,
      p0Payout: "0",
      p0Premium: "0",
      p1Payout: "0",
      p1Premium: "0",
      startedAtMs: 0,
      cardOutcomes: [],
      swipes: [],
      cards: [],
    })

    const creator = new WSClient(baseUrl)
    const challenger = new WSClient(baseUrl)
    const spectator = new WSClient(baseUrl)
    await Promise.all([creator.open(), challenger.open(), spectator.open()])
    creator.send({ type: "hello", address: "0xcreator-e2e" })
    challenger.send({ type: "hello", address: "0xchallenger-e2e" })
    spectator.send({ type: "hello", address: "0xspec-e2e" })
    await Promise.all([
      creator.waitFor({ type: "chat_history" }),
      challenger.waitFor({ type: "chat_history" }),
      spectator.waitFor({ type: "chat_history" }),
    ])
    creator.send({ type: "room_subscribe", duelId: DUEL_ID })
    challenger.send({ type: "room_subscribe", duelId: DUEL_ID })
    spectator.send({ type: "room_subscribe", duelId: DUEL_ID })
    await flushTick()

    creator.send({ type: "chat_react", duelId: DUEL_ID, emoji: "🔥" })

    // Both players should receive the reaction.
    const creatorReact = await creator.waitFor<{ type: string; emoji: string }>(
      {
        type: "chat_reaction",
        timeoutMs: 2000,
      }
    )
    const challengerReact = await challenger.waitFor<{
      type: string
      emoji: string
    }>({
      type: "chat_reaction",
      timeoutMs: 2000,
    })
    expect(creatorReact.emoji).toBe("🔥")
    expect(challengerReact.emoji).toBe("🔥")

    // Spectator should NOT have received it. Allow time for the
    // broadcast to have happened (so a late arrival doesn't sneak in).
    await flushTick()
    await flushTick()
    const spectatorReacts = spectator.received.filter(
      (m) => (m as { type: string }).type === "chat_reaction"
    )
    expect(spectatorReacts).toHaveLength(0)

    creator.close()
    challenger.close()
    spectator.close()
  })

  test("oracle_subscribe / unsubscribe is idempotent and accepted", async () => {
    const c = new WSClient(baseUrl)
    await c.open()
    c.send({ type: "hello", address: "0xoraclesub" })
    await c.waitFor({ type: "hello" })
    // Subscribe + unsubscribe should not produce an error message.
    c.send({ type: "oracle_subscribe", marketIds: ["0xabc"] })
    c.send({ type: "oracle_unsubscribe", marketIds: ["0xabc"] })
    await flushTick()
    await flushTick()
    const errors = c.received.filter(
      (m) => (m as { type: string }).type === "error"
    )
    expect(errors).toHaveLength(0)
    c.close()
  })

  test("bad message types produce structured errors", async () => {
    const c = new WSClient(baseUrl)
    await c.open()
    c.send({ type: "totally-unknown" })
    const err = await c.waitFor<{ type: string; code: string }>({
      type: "error",
    })
    expect(err.code).toBe("unknown_type")
    c.close()
  })

  test("hello with bad address → bad_address error", async () => {
    const c = new WSClient(baseUrl)
    await c.open()
    c.send({ type: "hello", address: "no-prefix" })
    const err = await c.waitFor<{ type: string; code: string }>({
      type: "error",
    })
    expect(err.code).toBe("bad_address")
    c.close()
  })
})
