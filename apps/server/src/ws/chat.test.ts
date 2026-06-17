/**
 * Chat / reactions unit tests. Run against a throwaway Postgres via
 * TEST_DATABASE_URL (see test-preload.ts); skip when none is configured.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import type { ServerWebSocket } from "bun"
import * as db from "../db"
import { HAS_TEST_DB, resetTables } from "../test-db"
import * as chatModule from "./chat"
import * as matchmakingModule from "./matchmaking"

type FakeWs = ServerWebSocket<import("./matchmaking").SocketState> & { _sent: string[] }

function makeWs(): FakeWs {
  const sent: string[] = []
  return {
    data: matchmakingModule.newSocketState(),
    send(msg: string): number {
      sent.push(msg)
      return msg.length
    },
    _sent: sent,
  } as unknown as FakeWs
}

describe.skipIf(!HAS_TEST_DB)("chat", () => {
  beforeEach(async () => {
    await resetTables()
    matchmakingModule.__resetForTests()
  })

  afterAll(async () => {
    await db.closeDb()
  })

  describe("handleChatSend", () => {
    test("rejects messages from anonymous sockets", async () => {
      const ws = makeWs()
      await chatModule.handleChatSend(ws, "hi")
      const last = JSON.parse(ws._sent.at(-1)!) as { type: string; code: string }
      expect(last.type).toBe("error")
      expect(last.code).toBe("no_address")
    })

    test("rejects empty / non-string text", async () => {
      const ws = makeWs()
      matchmakingModule.registerAddress(ws, "0xa")
      await chatModule.handleChatSend(ws, "")
      const last1 = JSON.parse(ws._sent.at(-1)!) as { code: string }
      expect(last1.code).toBe("bad_chat_text")
      await chatModule.handleChatSend(ws, 42 as unknown as string)
      const last2 = JSON.parse(ws._sent.at(-1)!) as { code: string }
      expect(last2.code).toBe("bad_chat_text")
    })

    test("trims + caps at 256 chars + persists + broadcasts to ALL sockets", async () => {
      const a = makeWs()
      const b = makeWs()
      matchmakingModule.registerAddress(a, "0xa")
      matchmakingModule.registerAddress(b, "0xb")

      const longText = " ".repeat(50) + "x".repeat(400) + " ".repeat(50)
      await chatModule.handleChatSend(a, longText)

      // Persisted in the DB
      const rows = await db.recentChatMessages(10)
      expect(rows).toHaveLength(1)
      expect(rows[0].text.length).toBeLessThanOrEqual(256)
      expect(rows[0].fromAddress).toBe("0xa")

      // Broadcast to BOTH sockets (global chat)
      const aLast = JSON.parse(a._sent.at(-1)!) as { type: string; from: string }
      const bLast = JSON.parse(b._sent.at(-1)!) as { type: string; from: string }
      expect(aLast.type).toBe("chat_message")
      expect(bLast.type).toBe("chat_message")
      expect(aLast.from).toBe("0xa")
    })
  })

  describe("sendChatHistory", () => {
    test("delivers last N messages on hello", async () => {
      const a = makeWs()
      matchmakingModule.registerAddress(a, "0xa")
      await chatModule.handleChatSend(a, "first")
      await chatModule.handleChatSend(a, "second")

      const b = makeWs()
      matchmakingModule.registerAddress(b, "0xb")
      await chatModule.sendChatHistory(b)
      const hist = JSON.parse(b._sent.at(-1)!) as {
        type: string
        messages: Array<{ text: string }>
      }
      expect(hist.type).toBe("chat_history")
      expect(hist.messages.map((m) => m.text)).toEqual(["first", "second"])
    })
  })

  describe("handleChatReact — filters to creator + challenger (PRD §Social)", () => {
    const DUEL_ID = "0xduel1234567890abcdef"

    async function seedDuel(creator: string, challenger: string) {
      await db.upsertDuel({
        id: DUEL_ID,
        status: "ACTIVE",
        stakeCoinType: "0x2::sui::SUI",
        creator,
        challenger,
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
    }

    test("reaction reaches creator + challenger, NOT spectator", async () => {
      const creator = makeWs()
      const challenger = makeWs()
      const spectator = makeWs()
      matchmakingModule.registerAddress(creator, "0xcreator")
      matchmakingModule.registerAddress(challenger, "0xchallenger")
      matchmakingModule.registerAddress(spectator, "0xspec")
      // All three are room subs (spectator should still NOT receive the
      // reaction because the filter is by player addresses, not room).
      matchmakingModule.subscribeRoom(creator, DUEL_ID)
      matchmakingModule.subscribeRoom(challenger, DUEL_ID)
      matchmakingModule.subscribeRoom(spectator, DUEL_ID)

      await seedDuel("0xcreator", "0xchallenger")
      // Clear ack messages from hello/subscribe
      creator._sent.length = 0
      challenger._sent.length = 0
      spectator._sent.length = 0

      await chatModule.handleChatReact(creator, DUEL_ID, "🔥")
      const creatorMsgs = creator._sent.map((s) => JSON.parse(s))
      const challengerMsgs = challenger._sent.map((s) => JSON.parse(s))
      const spectatorMsgs = spectator._sent.map((s) => JSON.parse(s))
      expect(creatorMsgs.some((m) => m.type === "chat_reaction")).toBe(true)
      expect(challengerMsgs.some((m) => m.type === "chat_reaction")).toBe(true)
      expect(spectatorMsgs.some((m) => m.type === "chat_reaction")).toBe(false)
    })

    test("falls back to room broadcast if duel not in mirror yet", async () => {
      const subA = makeWs()
      const subB = makeWs()
      matchmakingModule.registerAddress(subA, "0xa")
      matchmakingModule.registerAddress(subB, "0xb")
      matchmakingModule.subscribeRoom(subA, DUEL_ID)
      matchmakingModule.subscribeRoom(subB, DUEL_ID)
      // No seedDuel() — mirror miss → fall back to room broadcast.
      subA._sent.length = 0
      subB._sent.length = 0
      await chatModule.handleChatReact(subA, DUEL_ID, "🎯")
      expect(JSON.parse(subA._sent.at(-1)!).type).toBe("chat_reaction")
      expect(JSON.parse(subB._sent.at(-1)!).type).toBe("chat_reaction")
    })

    test("rejects bad duelId / emoji", async () => {
      const ws = makeWs()
      matchmakingModule.registerAddress(ws, "0xa")
      await chatModule.handleChatReact(ws, "notahex", "🔥")
      expect(JSON.parse(ws._sent.at(-1)!).code).toBe("bad_duel_id")
      await chatModule.handleChatReact(ws, DUEL_ID, "")
      expect(JSON.parse(ws._sent.at(-1)!).code).toBe("bad_emoji")
      await chatModule.handleChatReact(ws, DUEL_ID, "a".repeat(100))
      expect(JSON.parse(ws._sent.at(-1)!).code).toBe("bad_emoji")
    })
  })
})
