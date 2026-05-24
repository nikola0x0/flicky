import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { ServerWebSocket } from "bun"
import {
  __resetForTests,
  broadcastRoom,
  connectedAddressCount,
  joinQueue,
  leaveQueue,
  newSocketState,
  onSocketClose,
  queueStats,
  registerAddress,
  roomCount,
  subscribeRoom,
  type SocketState,
  unsubscribeRoom,
} from "./matchmaking"

type FakeWs = ServerWebSocket<SocketState> & { _sent: string[] }

function makeWs(): FakeWs {
  const sent: string[] = []
  const ws = {
    data: newSocketState(),
    send(msg: string): number {
      sent.push(msg)
      return msg.length
    },
    _sent: sent,
  } as unknown as FakeWs
  return ws
}

function lastMsg(ws: FakeWs): unknown {
  if (ws._sent.length === 0) throw new Error("no messages sent")
  return JSON.parse(ws._sent[ws._sent.length - 1])
}

function allMsgs(ws: FakeWs): unknown[] {
  return ws._sent.map((s) => JSON.parse(s))
}

beforeEach(() => {
  __resetForTests()
})

afterEach(() => {
  __resetForTests()
})

describe("registerAddress", () => {
  test("binds the address to the socket and sends `hello` ack", () => {
    const ws = makeWs()
    registerAddress(ws, "0xalice")
    expect(ws.data.address).toBe("0xalice")
    expect(lastMsg(ws)).toEqual({ type: "hello", address: "0xalice" })
    expect(connectedAddressCount()).toBe(1)
  })

  test("multiple sockets per address are tracked", () => {
    const a = makeWs()
    const b = makeWs()
    registerAddress(a, "0xalice")
    registerAddress(b, "0xalice")
    expect(connectedAddressCount()).toBe(1) // 1 distinct address
  })
})

describe("joinQueue", () => {
  test("rejects when socket has no address", () => {
    const ws = makeWs()
    joinQueue(ws, "casual")
    expect(lastMsg(ws)).toMatchObject({ type: "error", code: "no_address" })
    expect(queueStats().casual).toBe(0)
  })

  test("rejects practice tier (solo-vs-bot, not queued)", () => {
    const ws = makeWs()
    registerAddress(ws, "0xalice")
    joinQueue(ws, "practice")
    expect(lastMsg(ws)).toMatchObject({ type: "error", code: "practice_no_queue" })
  })

  test("a single waiting socket gets queue_status with size 1", () => {
    const ws = makeWs()
    registerAddress(ws, "0xalice")
    joinQueue(ws, "casual")
    expect(lastMsg(ws)).toMatchObject({ type: "queue_status", tier: "casual", size: 1 })
    expect(queueStats().casual).toBe(1)
  })

  test("two sockets in same tier are paired immediately", () => {
    const alice = makeWs()
    const bob = makeWs()
    registerAddress(alice, "0xalice")
    registerAddress(bob, "0xbob")
    joinQueue(alice, "casual")
    joinQueue(bob, "casual")
    // Both removed from queue once matched.
    expect(queueStats().casual).toBe(0)
    // Both received match_found.
    const aMsgs = allMsgs(alice)
    const bMsgs = allMsgs(bob)
    expect(aMsgs.at(-1)).toMatchObject({
      type: "match_found",
      tier: "casual",
      role: "creator",
      opponent: "0xbob",
    })
    expect(bMsgs.at(-1)).toMatchObject({
      type: "match_found",
      tier: "casual",
      role: "challenger",
      opponent: "0xalice",
    })
  })

  test("two sockets in DIFFERENT tiers do not pair", () => {
    const alice = makeWs()
    const bob = makeWs()
    registerAddress(alice, "0xalice")
    registerAddress(bob, "0xbob")
    joinQueue(alice, "casual")
    joinQueue(bob, "standard")
    expect(queueStats().casual).toBe(1)
    expect(queueStats().standard).toBe(1)
  })

  test("same address joining twice in a row does not pair with itself", () => {
    const ws = makeWs()
    registerAddress(ws, "0xalice")
    joinQueue(ws, "casual")
    joinQueue(ws, "casual") // idempotent re-queue
    expect(queueStats().casual).toBe(1) // still alone
  })
})

describe("leaveQueue", () => {
  test("removes the socket from its tier queue + emits queue_left", () => {
    const ws = makeWs()
    registerAddress(ws, "0xalice")
    joinQueue(ws, "casual")
    expect(queueStats().casual).toBe(1)
    leaveQueue(ws)
    expect(queueStats().casual).toBe(0)
    expect(lastMsg(ws)).toEqual({ type: "queue_left" })
  })

  test("is a no-op when not queued", () => {
    const ws = makeWs()
    registerAddress(ws, "0xalice")
    // calling leaveQueue without joining should not throw / not emit
    leaveQueue(ws)
    expect(allMsgs(ws)).toEqual([{ type: "hello", address: "0xalice" }])
  })
})

describe("rooms", () => {
  test("broadcastRoom hits every subscribed socket", () => {
    const a = makeWs()
    const b = makeWs()
    subscribeRoom(a, "0xduel1")
    subscribeRoom(b, "0xduel1")
    broadcastRoom("0xduel1", { type: "pong" })
    expect(lastMsg(a)).toEqual({ type: "pong" })
    expect(lastMsg(b)).toEqual({ type: "pong" })
    expect(roomCount()).toBe(1)
  })

  test("broadcastRoom to an empty room is a no-op", () => {
    expect(() => broadcastRoom("0xnoroom", { type: "pong" })).not.toThrow()
  })

  test("unsubscribeRoom removes the socket from the room", () => {
    const ws = makeWs()
    subscribeRoom(ws, "0xduel1")
    unsubscribeRoom(ws, "0xduel1")
    expect(roomCount()).toBe(0)
    // Subsequent broadcast no-ops, no message sent.
    broadcastRoom("0xduel1", { type: "pong" })
    expect(ws._sent).toHaveLength(0)
  })

  test("onSocketClose cleans up queue + room subscriptions", () => {
    const ws = makeWs()
    registerAddress(ws, "0xalice")
    joinQueue(ws, "casual")
    subscribeRoom(ws, "0xduel1")
    subscribeRoom(ws, "0xduel2")
    expect(queueStats().casual).toBe(1)
    expect(roomCount()).toBe(2)
    onSocketClose(ws)
    expect(queueStats().casual).toBe(0)
    expect(roomCount()).toBe(0)
    expect(connectedAddressCount()).toBe(0)
  })
})

describe("sync-only queue (no bot-fill — Practice Mode is the only bot path)", () => {
  test("a lone socket waits indefinitely with no auto-match", async () => {
    const ws = makeWs()
    registerAddress(ws, "0xalice")
    joinQueue(ws, "casual")
    // Wait longer than the OLD bot-fill window would have fired — no extra
    // messages should arrive.
    await new Promise((r) => setTimeout(r, 100))
    const msgs = allMsgs(ws)
    expect(msgs).toHaveLength(2) // hello + queue_status
    expect(queueStats().casual).toBe(1)
  })

  test("match_found has no bot-related fields, never pairs with a bot opponent", () => {
    const a = makeWs()
    const b = makeWs()
    registerAddress(a, "0xa")
    registerAddress(b, "0xb")
    joinQueue(a, "casual")
    joinQueue(b, "casual")
    const ack = lastMsg(a) as Record<string, unknown>
    expect(ack.type).toBe("match_found")
    expect(ack.opponent).not.toBe("bot")
    expect("botFillInMs" in ack).toBe(false)
    expect(["creator", "challenger"]).toContain(ack.role as string) // not "bot_target"
  })

  test("practice tier never enters the queue — directs to practice_start instead", () => {
    const ws = makeWs()
    registerAddress(ws, "0xalice")
    joinQueue(ws, "practice")
    const err = lastMsg(ws) as Record<string, unknown>
    expect(err.type).toBe("error")
    expect(err.code).toBe("practice_no_queue")
    // Make sure the directive points at the WS message, not a queue tier
    expect(String(err.message)).toContain("practice_start")
    // And no slot in any queue gets taken
    for (const v of Object.values(queueStats())) expect(v).toBe(0)
  })

  test("two lone sockets after 200ms still receive no extra messages (no bot timer)", async () => {
    const a = makeWs()
    const b = makeWs()
    registerAddress(a, "0xa")
    registerAddress(b, "0xb")
    // Both queue in DIFFERENT tiers so they don't pair each other.
    joinQueue(a, "casual")
    joinQueue(b, "standard")
    await new Promise((r) => setTimeout(r, 200))
    // Each should have hello + queue_status only — no match_found from a bot.
    expect(allMsgs(a)).toHaveLength(2)
    expect(allMsgs(b)).toHaveLength(2)
  })
})
