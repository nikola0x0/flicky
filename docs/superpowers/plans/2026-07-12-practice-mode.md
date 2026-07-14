# Practice Mode (vs Bot) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/game/practice` mode where the player swipes a synthetic 5-card deck against a bot, watches live Pyth BTC price resolve each card over a 45-second lockup, and gets a Victory/Defeat result — no matchmaking, no stakes, no on-chain transactions.

**Architecture:** The server's existing `practice_start` → `practice_session` scaffold is rewritten to generate synthetic cards (strikes placed around the live Pyth spot with the same digital-BS model as real deck-gen, at 15–45s horizons) and a new market-less `spot_tick` stream is added. The client runs the whole match locally via a `usePracticeSession` hook that synthesizes a `RoomState`-shaped object, so the existing charts and card ledger render unmodified. The presentational swipe UI is extracted from `active-duel.tsx` into a shared `SwipeScreen` component; PvP keeps its PTB signing exactly where it is.

**Tech Stack:** Bun (server + tests), React 19 + Vite + Tailwind v4 (web), visx charts, `react-router`, WebSocket relay.

**Spec:** `docs/superpowers/specs/2026-07-12-practice-mode-design.md`

## Global Constraints

- Always use `bun` (≥ 1.3), never npm/pnpm/yarn.
- Prettier: no semicolons, double quotes, 2-space indent, trailing comma `es5`, width 80. Do NOT run repo-wide `bun format` (large pre-existing drift) — scope with `bunx prettier --write <files>`.
- TypeScript `strict: true`; server is ESM run via `bun --hot`, prefer `Bun.*` APIs.
- Practice must never build/sign a PTB, call the sponsor, read the Predict manager, run a balance preflight, or write to DB/leaderboard/MMR.
- The web and server `protocol.ts` files are mirrors — every wire change lands in BOTH `apps/server/src/ws/protocol.ts` and `apps/web/src/lib/protocol.ts`, byte-identical.
- PvP behavior must not change: the `SwipeScreen` extraction is a pure refactor of `active-duel.tsx`.
- Server tests: `cd apps/server && bun test <file>`. Web has no test runner — verify with `bun typecheck` + `bun lint` + manual browser run.
- Commit after every task (message style: `feat(server): …` / `feat(web): …` / `refactor(web): …`).

---

### Task 1: Server — synthetic practice deck (`buildPracticeDeck`)

**Files:**
- Modify: `apps/server/src/deckmaster.ts` (append after `buildSviDeck`, ~line 545)
- Test: `apps/server/src/deckmaster.test.ts`

**Interfaces:**
- Consumes: private helpers already in `deckmaster.ts` — `prgStream`, `allocateSignBalance`, `allocateZones`, `sviRawStrike`, `ZONE_TARGET_PROB` (that's why this function lives in `deckmaster.ts`, not `practice.ts`).
- Produces (used by Task 3):
  - `PRACTICE_EXPIRY_OFFSETS_MS: readonly [15000, 22500, 30000, 37500, 45000]`
  - `interface PracticeCard { strike: bigint; expiryOffsetMs: number; pUp: number }`
  - `buildPracticeDeck(spot: bigint, seed: Uint8Array, deckSize?: number): PracticeCard[]`

- [ ] **Step 1: Write the failing tests**

Append to `apps/server/src/deckmaster.test.ts` (the file already defines `SEED_A`, `SEED_B`; extend the import from `./deckmaster` with `buildPracticeDeck`, `PRACTICE_EXPIRY_OFFSETS_MS`):

```ts
describe("buildPracticeDeck", () => {
  const SPOT = 67_000_000_000_000n // $67k, 1e9-fixed

  test("returns 5 cards with the staggered expiry offsets, in order", () => {
    const cards = buildPracticeDeck(SPOT, SEED_A)
    expect(cards.length).toBe(5)
    expect(cards.map((c) => c.expiryOffsetMs)).toEqual([
      ...PRACTICE_EXPIRY_OFFSETS_MS,
    ])
  })

  test("strikes sit on the correct side of spot for their pUp", () => {
    // pUp > 0.5 → UP favored → strike below spot; pUp < 0.5 → above.
    for (const c of buildPracticeDeck(SPOT, SEED_A)) {
      expect(c.pUp).not.toBe(0.5)
      if (c.pUp > 0.5) expect(c.strike < SPOT).toBe(true)
      else expect(c.strike > SPOT).toBe(true)
    }
  })

  test("strikes are near-ATM (0 < |offset| < 20 bps) at 15-45s horizons", () => {
    for (const c of buildPracticeDeck(SPOT, SEED_A)) {
      const diff = c.strike > SPOT ? c.strike - SPOT : SPOT - c.strike
      expect(diff > 0n).toBe(true)
      expect(Number((diff * 10_000n) / SPOT)).toBeLessThan(20)
    }
  })

  test("pUp values come from the zone ladder, sign-balanced 2/3 or 3/2", () => {
    const cards = buildPracticeDeck(SPOT, SEED_A)
    const favored = cards.map((c) => Math.max(c.pUp, 1 - c.pUp))
    for (const p of favored) expect([0.56, 0.61, 0.63]).toContain(p)
    const upFavored = cards.filter((c) => c.pUp > 0.5).length
    expect(upFavored === 2 || upFavored === 3).toBe(true)
  })

  test("deterministic per seed, varies across seeds", () => {
    expect(buildPracticeDeck(SPOT, SEED_A)).toEqual(
      buildPracticeDeck(SPOT, SEED_A)
    )
    expect(buildPracticeDeck(SPOT, SEED_A)).not.toEqual(
      buildPracticeDeck(SPOT, SEED_B)
    )
  })

  test("rejects non-positive spot", () => {
    expect(() => buildPracticeDeck(0n, SEED_A)).toThrow()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/server && bun test deckmaster.test.ts`
Expected: FAIL — `buildPracticeDeck` / `PRACTICE_EXPIRY_OFFSETS_MS` not exported.

- [ ] **Step 3: Implement `buildPracticeDeck`**

Append to `apps/server/src/deckmaster.ts` directly after `buildSviDeck` (before the `buildDeck` doc comment at ~line 546):

```ts
// ─── Practice deck (synthetic — no markets, no commit-reveal) ────────────────

/** Per-card settle times for a practice match, ms after lockup start
 *  (lockup = the moment the player swipes their 5th card). Staggered so the
 *  45s watch phase pays off card-by-card instead of all at once. */
export const PRACTICE_EXPIRY_OFFSETS_MS = [
  15_000, 22_500, 30_000, 37_500, 45_000,
] as const

export interface PracticeCard {
  /** Strike price, 1e9-fixed USD — same scale as `readBtcSpot`. */
  strike: bigint
  /** Settle time relative to lockup start; the client anchors the clock. */
  expiryOffsetMs: number
  /** Digital-BS win-probability of UP at gen time. Doubles as the scoring
   *  `p_swiped` (practice has no Predict SVI to snapshot): a swipe UP scores
   *  against `pUp`, DOWN against `1 - pUp`. */
  pUp: number
}

/**
 * Synthetic practice deck. Same placement machinery as `buildSviDeck`
 * (PRG-shuffled sign balance + difficulty zones, `ZONE_TARGET_PROB`
 * probability ladder, digital-BS inversion via `sviRawStrike`) but with
 * time-to-expiry = each card's short `PRACTICE_EXPIRY_OFFSETS_MS` — so
 * strikes land close enough to spot (single-digit bps) that the live Pyth
 * feed genuinely crosses them during the 45s lockup. No market snapping, no
 * dedup, no mint probing: nothing on-chain ever sees these strikes.
 *
 * Strikes are anchored at gen-time spot; the player may swipe for a while
 * before lockup, drifting the true probabilities. Acceptable for practice —
 * outcomes stay live-price-driven either way.
 */
export function buildPracticeDeck(
  spot: bigint,
  seed: Uint8Array,
  deckSize = PRACTICE_EXPIRY_OFFSETS_MS.length
): PracticeCard[] {
  if (spot <= 0n) {
    throw new Error("buildPracticeDeck: spot must be positive")
  }
  const stream = prgStream(seed)
  const signs = allocateSignBalance(deckSize, stream)
  const zones = allocateZones(deckSize, stream)
  return Array.from({ length: deckSize }, (_, i) => {
    const expiryOffsetMs =
      PRACTICE_EXPIRY_OFFSETS_MS[
        Math.min(i, PRACTICE_EXPIRY_OFFSETS_MS.length - 1)
      ]
    const targetP = ZONE_TARGET_PROB[zones[i]]
    // T = the card's offset (as if lockup started now): expiry=offset, now=0.
    const strike = sviRawStrike(spot, signs[i], targetP, expiryOffsetMs, 0)
    return {
      strike,
      expiryOffsetMs,
      pUp: signs[i] < 0 ? targetP : 1 - targetP,
    }
  })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/server && bun test deckmaster.test.ts`
Expected: PASS (all new + all pre-existing deckmaster tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/deckmaster.ts apps/server/src/deckmaster.test.ts
git commit -m "feat(server): synthetic practice deck gen (buildPracticeDeck)"
```

---

### Task 2: Wire protocol — new `practice_session` shape, `spot_subscribe`/`spot_unsubscribe`, `spot_tick`

**Files:**
- Modify: `apps/server/src/ws/protocol.ts`
- Modify: `apps/web/src/lib/protocol.ts` (identical edits — the files are mirrors)
- Test: `apps/server/src/ws/protocol.test.ts`

**Interfaces:**
- Produces (used by Tasks 3, 4, 7):
  - `ClientMsg` gains `{ type: "spot_subscribe" }` and `{ type: "spot_unsubscribe" }`
  - `ServerMsg`'s `practice_session` becomes `{ type: "practice_session"; cards: Array<{ strike: string; expiryOffsetMs: number; pUp: number }>; botSwipes: boolean[] }`
  - `ServerMsg` gains `{ type: "spot_tick"; spot: string; timestampMs: number }`

- [ ] **Step 1: Write the failing tests**

Append to `apps/server/src/ws/protocol.test.ts` inside the `parseClientMsg` describe block:

```ts
  test("parses spot_subscribe / spot_unsubscribe (no args)", () => {
    expect(parseClientMsg(JSON.stringify({ type: "spot_subscribe" }))?.type).toBe(
      "spot_subscribe"
    )
    expect(
      parseClientMsg(JSON.stringify({ type: "spot_unsubscribe" }))?.type
    ).toBe("spot_unsubscribe")
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/server && bun test ws/protocol.test.ts`
Expected: FAIL — TypeScript rejects `"spot_subscribe"` as a `ClientMsg` type (compile error), or the `toBe` comparison fails.

- [ ] **Step 3: Edit both protocol files identically**

In `apps/server/src/ws/protocol.ts` AND `apps/web/src/lib/protocol.ts`:

(a) In `ClientMsg`, after the `oracle_unsubscribe` line, add:

```ts
  | { type: "spot_subscribe" }
  | { type: "spot_unsubscribe" }
```

(b) Replace the `practice_session` member of `ServerMsg`:

```ts
  | {
      /**
       * Practice deck — synthetic cards, no on-chain markets. `strike` is
       * 1e9-fixed (same scale as `oracle_tick.spot`); `expiryOffsetMs` is
       * relative to lockup start (the client anchors the clock when the
       * 5th swipe lands); `pUp` is the design win-probability of UP and
       * doubles as the scoring `p_swiped` (UP → pUp, DOWN → 1 − pUp).
       */
      type: "practice_session"
      cards: Array<{ strike: string; expiryOffsetMs: number; pUp: number }>
      botSwipes: boolean[]
    }
```

(c) In `ServerMsg`, after the `oracle_tick` member, add:

```ts
  | {
      /**
       * Market-less live Pyth BTC spot for practice mode — same source,
       * cadence, and 1e9 scale as `oracle_tick.spot`, but requires no
       * `ExpiryMarket` id. Sent only to sockets that `spot_subscribe`d.
       */
      type: "spot_tick"
      spot: string
      timestampMs: number
    }
```

- [ ] **Step 4: Run tests + typecheck both workspaces**

Run: `cd apps/server && bun test ws/protocol.test.ts && cd ../.. && bun typecheck`
Expected: protocol tests PASS. Typecheck FAILS in exactly one place: `apps/server/src/ws/practice.ts` no longer matches the new `practice_session` shape — that is Task 3's job. If the failure list shows anything else, fix it before moving on. (If typecheck config makes this blocking, it is acceptable to do Task 3 Step 3 before committing Tasks 2+3 together — note it in the commit message.)

- [ ] **Step 5: Commit (or fold into Task 3's commit if typecheck blocks)**

```bash
git add apps/server/src/ws/protocol.ts apps/server/src/ws/protocol.test.ts apps/web/src/lib/protocol.ts
git commit -m "feat(protocol): practice_session synthetic cards + spot_tick stream messages"
```

---

### Task 3: Server — rewrite `practice.ts` to send the synthetic deck

**Files:**
- Modify: `apps/server/src/ws/practice.ts` (full rewrite of the generation path)
- Test: `apps/server/src/e2e-ws.test.ts` (behavioral check via the real handler stack)

**Interfaces:**
- Consumes: `buildPracticeDeck`, `PRACTICE_EXPIRY_OFFSETS_MS` (Task 1), `deriveSeed`, `hashToHex`, `readBtcSpot` (existing), new `practice_session` shape (Task 2).
- Produces: `handlePracticeStart(ws)` — same export, new payload. Error paths unchanged: `no_address`, `practice_failed`.

- [ ] **Step 1: Write the failing e2e test**

The e2e harness (`apps/server/src/e2e-ws.test.ts`) runs the real handler stack against a non-existent network, so `readBtcSpot()` rejects → `practice_failed`. That asserts the new code path reaches spot-fetch (and no longer dies earlier hunting DeepBook markets with `no_oracles`). Append inside the existing `describe` that has the WS client helpers (mirror the style of the `queue_join {tier: 'practice'}` test at ~line 222):

```ts
  test("practice_start fails gracefully with practice_failed (no network)", async () => {
    const c = await connect()
    c.send({ type: "hello", address: "0xpracticeuser2" })
    await c.next("hello")
    c.send({ type: "practice_start" })
    const err = await c.next("error")
    expect(err.code).toBe("practice_failed")
    c.close()
  })
```

Adapt `connect()` / `c.next()` names to the actual helpers in that file (read the neighboring tests first — the harness has its own client utility; use exactly what the `queue_join` practice test uses).

- [ ] **Step 2: Run to verify current behavior fails the assertion**

Run: `cd apps/server && bun test e2e-ws.test.ts`
Expected: the new test FAILS — today's handler emits `no_oracles` (market discovery fails first), not `practice_failed`.

- [ ] **Step 3: Rewrite `apps/server/src/ws/practice.ts`**

Replace the file's imports and body of `handlePracticeStart` (keep the `no_address` guard and the catch block exactly as they are):

```ts
/**
 * Practice Mode handler — solo vs. bot, no chain commit, no queue.
 *
 * PRD §Game modes: "Practice is a single-player on-ramp — it shares the
 * swipe UI but does not enter matchmaking or touch the chain."
 *
 * Server returns a SYNTHETIC 5-card deck — no DeepBook markets, no
 * commit-reveal. Strikes are placed around the live Pyth BTC spot with the
 * same digital-BS model as real deck-gen (`buildPracticeDeck`), but at
 * 15–45s horizons so the price genuinely crosses them during the client's
 * 45s lockup. Plus 5 pre-decided bot swipes (random 50/50).
 *
 * Once the deck is sent, the client owns the rest: swiping, the bot
 * reveal, the lockup clock, per-card settlement against the `spot_tick`
 * stream, and the result. Nothing touches the chain or the DB.
 */
import type { ServerWebSocket } from "bun"
import { buildPracticeDeck, deriveSeed, hashToHex, readBtcSpot } from "../deckmaster"
import { makeLogger, shortId } from "../log"
import type { SocketState } from "./matchmaking"
import { _sendInternal } from "./matchmaking"

const log = makeLogger("practice")

export async function handlePracticeStart(
  ws: ServerWebSocket<SocketState>
): Promise<void> {
  if (!ws.data.address) {
    _sendInternal(ws, {
      type: "error",
      code: "no_address",
      message: "send `hello` with your address first",
    })
    return
  }
  try {
    const spot = await readBtcSpot()
    const nonceHex = hashToHex(crypto.getRandomValues(new Uint8Array(16)))
    const seed = deriveSeed({
      sender: ws.data.address,
      asset: "BTC",
      timestampMs: Date.now(),
      nonceHex,
    })
    const cards = buildPracticeDeck(spot, seed)
    const botSwipes = cards.map(() => Math.random() > 0.5)
    log.info(
      `practice for ${shortId(ws.data.address)} — ${cards.length} synthetic cards @ spot ${spot}`
    )
    _sendInternal(ws, {
      type: "practice_session",
      cards: cards.map((c) => ({
        strike: c.strike.toString(),
        expiryOffsetMs: c.expiryOffsetMs,
        pUp: c.pUp,
      })),
      botSwipes,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log.warn(`practice failed for ${shortId(ws.data.address)}: ${msg}`)
    _sendInternal(ws, {
      type: "error",
      code: "practice_failed",
      message: msg,
    })
  }
}
```

Note the removed imports (`commitDeck`, `decideDeckSize`, `findDeckMarkets`, `resolveDeckBounds`, `buildProbedDeck`, `filterMintableMarkets`) — delete them; `bun lint` will catch leftovers.

- [ ] **Step 4: Run tests + typecheck**

Run: `cd apps/server && bun test e2e-ws.test.ts deckmaster.test.ts ws/protocol.test.ts && cd ../.. && bun typecheck`
Expected: PASS, typecheck clean (Task 2's pending failure resolves here).

- [ ] **Step 5: Update the stale header comment in `e2e-ws.test.ts`**

Line ~6 says `practice_start rejected (no oracles, …)` — change that phrase to `practice_start rejected (practice_failed, spot fetch unreachable)`.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/ws/practice.ts apps/server/src/e2e-ws.test.ts
git commit -m "feat(server): practice_start returns synthetic 45s deck from live Pyth spot"
```

---

### Task 4: Server — `spot_tick` stream (oracle-stream + handlers + ratelimit)

**Files:**
- Modify: `apps/server/src/ws/oracle-stream.ts`
- Modify: `apps/server/src/ws/handlers.ts`
- Modify: `apps/server/src/ratelimit.ts`
- Test: `apps/server/src/e2e-ws.test.ts`

**Interfaces:**
- Produces: `subscribeSpot(ws)`, `unsubscribeSpot(ws)` exported from `oracle-stream.ts`; `spot_tick` broadcasts on the existing `env.oracleTickIntervalMs` interval; cleanup on socket close.

- [ ] **Step 1: Write the failing e2e test**

Append to `e2e-ws.test.ts` (same client-helper style as Task 3):

```ts
  test("spot_subscribe / spot_unsubscribe are accepted silently", async () => {
    const c = await connect()
    c.send({ type: "hello", address: "0xspotwatcher" })
    await c.next("hello")
    c.send({ type: "spot_subscribe" })
    c.send({ type: "spot_unsubscribe" })
    // No error should come back; ping/pong proves the socket is healthy
    // and both messages were dispatched (not "unknown_type").
    c.send({ type: "ping" })
    const pong = await c.next("pong")
    expect(pong.type).toBe("pong")
    c.close()
  })
```

(The tick interval is disabled in the harness via `ORACLE_TICK_INTERVAL_MS=999999`, so no `spot_tick` is expected — this validates dispatch, not the broadcast. The broadcast is exercised in Task 9's live run.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/server && bun test e2e-ws.test.ts`
Expected: FAIL — the handler answers `spot_subscribe` with `error { code: "unknown_type" }`, so `c.next("pong")` sees an error first (or times out, depending on the helper).

- [ ] **Step 3: Implement in `oracle-stream.ts`**

(a) Below `const marketSubscribers = …` add:

```ts
// Market-less spot watchers (practice mode) — they get `spot_tick` (live
// Pyth BTC spot only) instead of per-market `oracle_tick`.
const spotSubscribers = new Set<AnyWs>()
```

(b) After `unsubscribeOracles` add:

```ts
export function subscribeSpot(ws: AnyWs): void {
  spotSubscribers.add(ws)
}

export function unsubscribeSpot(ws: AnyWs): void {
  spotSubscribers.delete(ws)
}
```

(c) In `onSocketCloseOracleStream`, add as the first line:

```ts
  spotSubscribers.delete(ws)
```

(d) In `tick()`, replace the early return:

```ts
  const ids = Array.from(marketSubscribers.keys())
  if (ids.length === 0 && spotSubscribers.size === 0) return
```

and after `const spot = lastBtcSpot ?? "0"` insert the spot broadcast:

```ts
  // Market-less spot tick for practice sessions.
  if (spotSubscribers.size > 0) {
    const wire = JSON.stringify({ type: "spot_tick", spot, timestampMs: now })
    for (const ws of spotSubscribers) {
      try {
        ws.send(wire)
      } catch {
        // close handler will clean up
      }
    }
  }
```

(e) In `oracleStreamStats()` / `countSockets()` no change required (practice sockets aren't market subscribers). Leave as is.

- [ ] **Step 4: Route the messages in `handlers.ts`**

Import `subscribeSpot, unsubscribeSpot` alongside the existing oracle-stream imports, then add cases after `oracle_unsubscribe`:

```ts
      case "spot_subscribe": {
        const rl = consume("ws:spot_subscribe", ws.data.address ?? "anon")
        if (!rl.ok) {
          send(ws, {
            type: "error",
            code: "rate_limited",
            message: `slow down; retry in ${rl.retryMs}ms`,
            detail: { retryMs: rl.retryMs },
          })
          return
        }
        subscribeSpot(ws)
        return
      }
      case "spot_unsubscribe": {
        unsubscribeSpot(ws)
        return
      }
```

- [ ] **Step 5: Register the rate limit in `ratelimit.ts`**

After the `ws:queue_join` line:

```ts
registerLimit("ws:spot_subscribe", { capacity: 4, refillPerSec: 1 / 2 })
```

- [ ] **Step 6: Run tests + typecheck**

Run: `cd apps/server && bun test && cd ../.. && bun typecheck`
Expected: all server tests PASS, typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/ws/oracle-stream.ts apps/server/src/ws/handlers.ts apps/server/src/ratelimit.ts apps/server/src/e2e-ws.test.ts
git commit -m "feat(server): market-less spot_tick stream for practice mode"
```

---

### Task 5: Web — extract shared `SwipeScreen` from `active-duel.tsx` (pure refactor)

**Files:**
- Create: `apps/web/src/lib/room-state.ts`
- Create: `apps/web/src/components/swipe-screen.tsx`
- Modify: `apps/web/src/routes/game/active-duel.tsx`

**Interfaces:**
- Produces (used by Tasks 7–8):
  - `lib/room-state.ts`: `interface RoomState` (moved verbatim from `active-duel.tsx:137-167`), `type WireSwipe = { isUp: boolean; quantity: string; orderId: string }`, `toSwipeLite(swipe: WireSwipe | null): SwipeLite | null` (moved from `active-duel.tsx:177-181`).
  - `components/swipe-screen.tsx`: `SwipeScreen` (props below), `CardLedger` (exported for the practice result screen), `fmtUsd(v: string | bigint): string` (exported for practice tiles).

```ts
export function SwipeScreen(props: {
  roomState: RoomState
  cardIdx: number
  ticks: Record<string, { spot: string; expiry: string }>
  myAddress: string
  /** Defaults to the other side of the duel (creator vs challenger). */
  opponentAddress?: string
  /** Locks the deck (PvP: swipe window expired). */
  disabled?: boolean
  /** Status line while `onSwipe` is in flight. Default "minting position…" */
  busyLabel?: string
  /** Overrides the "settles in …" countdown line (practice pre-lock). */
  settleLabel?: string
  /** Commit a swipe. THROW to reset the drag and show the error message. */
  onSwipe: (isUp: boolean) => Promise<void>
  /** Rendered when cardIdx runs past the deck (PvP: settling handoff). */
  deckExhausted?: ReactNode
}): ReactNode
```

This is a **move refactor** — PvP behavior must be identical afterward.

- [ ] **Step 1: Create `apps/web/src/lib/room-state.ts`**

```ts
import type { SwipeLite } from "@/lib/pnl"

/**
 * Mirror of `room_state` from the server. Kept loose so consumers don't
 * pull the full ServerMsg discriminated-union narrowing inline. Practice
 * mode synthesizes this same shape locally (see use-practice-session.ts)
 * so the charts/ledger render identically in both modes.
 */
export interface RoomState {
  duelId: string
  status: "PENDING" | "ACTIVE" | "COMPLETE"
  cardsRevealed: boolean
  cardCount: number
  cards: Array<{ expiry_market_id: string; strike: string }>
  settledCount: number
  p0Payout: string
  p0Premium: string
  p1Payout: string
  p1Premium: string
  startedAtMs: number
  creator: string
  challenger: string
  stakeCoinType: string
  cardOutcomes: Array<{
    cardIdx: number
    settlementPrice: string
    strike: string
    upWon: boolean
    p0Pnl: string | null
    p1Pnl: string | null
    p0Swipe: WireSwipe | null
    p1Swipe: WireSwipe | null
  }>
  swipes: Array<{
    cardIdx: number
    p0Swipe: WireSwipe | null
    p1Swipe: WireSwipe | null
  }>
}

export type WireSwipe = { isUp: boolean; quantity: string; orderId: string }

/**
 * Narrows a wire swipe (which carries `orderId`) down to the `SwipeLite`
 * shape `pnl.ts`'s helpers need.
 */
export function toSwipeLite(swipe: WireSwipe | null): SwipeLite | null {
  return swipe ? { isUp: swipe.isUp, quantity: swipe.quantity } : null
}
```

- [ ] **Step 2: Create `apps/web/src/components/swipe-screen.tsx`**

Move these blocks out of `active-duel.tsx` VERBATIM (current line refs): `fmtUsd` (52-54), `fmtCountdown` (59-67), `DRAG_COMMIT_FRACTION`/`DRAG_MAX_ROTATE_DEG` (70-71), `IDLE_ART`/`ART_YES`/`ART_NO` (76-83), `PhaseSwiping` (575-1031), `ChartChip` (1035-1059), `ChartModal` (1061-1123), `CardLedger` (1125-1209). File header + imports:

```tsx
/**
 * The shared swipe surface — the drag-to-swipe TCG card, chart chips/modals,
 * and the per-card ledger. Extracted from active-duel.tsx so PvP and
 * Practice share one engine (CLAUDE.md: gate the money flow, keep the
 * engine). This component is purely presentational + drag mechanics:
 * committing a swipe is delegated to `onSwipe` (PvP: build/sign the staked
 * swipe PTB; Practice: record locally). It never touches the chain.
 */
import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react"
import { createPortal } from "react-dom"
import { SWIPE_QUANTITY } from "@/lib/funding"
import { fmtDusdc } from "@/lib/deepbook"
import { liveCardPnl, fmtPnlPct, upProbability } from "@/lib/pnl"
import { toSwipeLite, type RoomState } from "@/lib/room-state"
import { StreamingPnlChart } from "@/components/streaming-pnl-chart"
import { BtcSpotChart } from "@/components/btc-spot-chart"
```

Then apply exactly these changes to the moved code:

(a) Export the two helpers practice reuses:
```ts
export function fmtUsd(v: string | bigint): string { … }   // was module-private
export function CardLedger({ … }) { … }                    // was module-private
```

(b) Rename `PhaseSwiping` → `SwipeScreen` with the new props (replacing `duelId`, `managerId`, `tickSizes`, `myAddress`, `isWindowExpired`, `sign`, `onSwipeDone`):

```tsx
export function SwipeScreen({
  roomState,
  cardIdx,
  ticks,
  myAddress,
  opponentAddress,
  disabled = false,
  busyLabel = "minting position…",
  settleLabel,
  onSwipe,
  deckExhausted = null,
}: {
  roomState: RoomState
  cardIdx: number
  ticks: Record<string, { spot: string; expiry: string }>
  myAddress: string
  opponentAddress?: string
  disabled?: boolean
  busyLabel?: string
  settleLabel?: string
  onSwipe: (isUp: boolean) => Promise<void>
  deckExhausted?: ReactNode
}) {
```

(c) Replace the whole `doSwipe` body (the PTB/preflight logic moves to PvP's wrapper in Step 3):

```tsx
  const doSwipe = async (isUp: boolean) => {
    if (disabled) return
    setBusy(true)
    setError(null)
    try {
      await onSwipe(isUp)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setDrag({ x: 0, active: false, flying: null })
    } finally {
      setBusy(false)
    }
  }
```

(d) Replace every remaining `isWindowExpired` with `disabled` (one in `onPointerDown`'s guard).

(e) Opponent derivation becomes:

```tsx
  const myIsP0 = myAddress.toLowerCase() === roomState.creator.toLowerCase()
  const opponent =
    opponentAddress ?? (myIsP0 ? roomState.challenger : roomState.creator)
```

(f) `chartDuel` uses `roomState.duelId` instead of the removed `duelId` prop:

```tsx
  const chartDuel = {
    id: roomState.duelId,
    settledCount: roomState.settledCount,
    cards: roomState.cards,
    swipes: roomState.swipes,
    cardOutcomes: roomState.cardOutcomes,
  }
```

(g) The deck-exhausted early return becomes:

```tsx
  if (cardIdx >= roomState.cards.length) {
    return <>{deckExhausted}</>
  }
```

(h) The settle-countdown line supports the override. Replace the `{countdown && (…)}` block in the quote box with:

```tsx
            {(settleLabel || countdown) && (
              <p
                className={`mt-1.5 flex items-center gap-1.5 font-pixel text-sm tracking-[0.2em] uppercase tabular-nums ${
                  settleLabel ? "text-cyan-300" : countdownColor
                }`}
              >
                <img
                  src="/icons/clock.png"
                  alt=""
                  aria-hidden
                  className="size-3.5 [image-rendering:pixelated]"
                />
                {settleLabel ??
                  (remainingMs !== null && remainingMs <= 0
                    ? "settling…"
                    : `settles in ${countdown}`)}
              </p>
            )}
```

(i) The busy hint line becomes:

```tsx
      <p className="pt-2 text-center font-pixel text-[11px] tracking-[0.25em] text-white/40 uppercase">
        {busy ? busyLabel : "swipe → yes · ← no"}
      </p>
```

(j) Delete the now-unused `tickSize` const and the `expiry`-undefined guard's dependence on tick size: the loading guard becomes `if (!card) return (…Loading card…)` — but keep requiring a tick before enabling odds/countdown (they already null-guard). Where the old code early-returned on `!expiry`, keep it ONLY when `settleLabel` is absent:

```tsx
  if (!card || (!settleLabel && !expiry)) {
    return (
      <p className="text-base text-white/55">Loading card {cardIdx + 1}…</p>
    )
  }
```

- [ ] **Step 3: Rewire `active-duel.tsx`**

(a) Delete the moved blocks (helpers, constants, `PhaseSwiping`, `ChartChip`, `ChartModal`, `CardLedger`) and the local `RoomState` interface + `toSwipeLite`. Add imports:

```tsx
import { SwipeScreen, CardLedger } from "@/components/swipe-screen"
import { toSwipeLite, type RoomState } from "@/lib/room-state"
```

Keep `export type { RoomState }` OUT — instead update any other importer: run
`grep -rn 'from "@/routes/game/active-duel"' apps/web/src` and point every `RoomState` import at `@/lib/room-state` (the `ActiveDuel` component import stays).

Remove now-unused imports from active-duel.tsx (`createPortal`, `ReactPointerEvent`, `ReactNode`, `upProbability`, `liveCardPnl`, `SwipeLite`, `StreamingPnlChart`, `BtcSpotChart` — whichever `bun lint`/`tsc` flags; `fmtPnlPct` is still used by `PhaseComplete`, `fmtDusdc` + `fetchAccountState` + `SWIPE_QUANTITY` stay for the swipe wrapper, `Link` stays for `SettlingHandoff`).

(b) Inside `ActiveDuel`, add the PvP swipe wrapper (place it after the `windowFrac` computation, before `return`). This is the old `doSwipe` body minus drag/busy/error presentation — failures are thrown for `SwipeScreen` to render:

```tsx
  // PvP swipe: pre-flight the account balance, build + sign the staked-swipe
  // PTB, translate opaque on-chain aborts, then advance the deck. Drag/busy/
  // error presentation lives in SwipeScreen; throwing here resets the card.
  const pvpSwipe = async (isUp: boolean) => {
    if (phase.kind !== "SWIPING" || !roomState || !account) return
    const { duelId, cardIdx } = phase
    const card = roomState.cards[cardIdx]
    const tickSize = card ? tickSizes[card.expiry_market_id] : undefined
    if (!card || !tickSize) {
      throw new Error("market tick size not loaded yet — try again in a moment")
    }
    try {
      // Pre-flight the account balance: each swipe's mint premium is
      // withdrawn from the AccountWrapper, and if it can't cover it the tx
      // aborts on-chain with an opaque `account::withdraw_balance` code.
      // Catch it here and prompt a top-up instead of burning a sponsored tx.
      const { balance } = await fetchAccountState(account.address)
      if (balance < MIN_ACCOUNT_PER_SWIPE) {
        throw new Error(
          `Account balance low (${fmtDusdc(balance)}). Each swipe needs about ${fmtDusdc(
            MIN_ACCOUNT_PER_SWIPE
          )} of dUSDC in your account for the mint premium — top up your account, then swipe again.`
        )
      }
      const tx = buildStakedSwipeTx({
        duelId,
        wrapperId: managerId,
        marketId: card.expiry_market_id,
        strike: BigInt(card.strike),
        tickSize,
        cardIdx,
        isUp,
        quantity: SWIPE_QUANTITY,
        stakeCoinType: roomState.stakeCoinType,
      })
      await sign.mutateAsync({ transaction: tx })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const insufficient =
        /withdraw_balance|EInsufficient|abort code: 1\b/.test(msg)
      const longShotUnavailable =
        /assert_mint_admission|ENetPremiumBelowMinimum|abort code: 4\b/.test(msg)
      throw new Error(
        insufficient
          ? "Your account ran out of dUSDC for this swipe's mint premium — top up your account and swipe again."
          : longShotUnavailable
            ? "That long-shot side is too unlikely to place on this market — swipe the other way (the favored call)."
            : msg
      )
    }
    setPhase((p) =>
      p.kind === "SWIPING"
        ? { kind: "SWIPING", duelId: p.duelId, cardIdx: p.cardIdx + 1 }
        : p
    )
  }
```

(c) Replace the SWIPING render branch:

```tsx
      {phase.kind === "SWIPING" && roomState && account && (
        <SwipeScreen
          roomState={roomState}
          cardIdx={phase.cardIdx}
          ticks={ticks}
          myAddress={account.address}
          disabled={isWindowExpired}
          onSwipe={pvpSwipe}
          deckExhausted={<SettlingHandoff duelId={phase.duelId} />}
        />
      )}
```

- [ ] **Step 4: Typecheck + lint + PvP smoke test**

Run: `bun typecheck && bun lint`
Expected: clean. `packages/ui` lint note from CLAUDE.md doesn't apply (files live in apps/web).
Then run `bun dev` and load `/game/pvp` in the browser: the standby screen must render and (if a resumable duel exists) the swipe card must still drag. This is a refactor — anything visually different is a bug.

- [ ] **Step 5: Format + commit**

```bash
bunx prettier --write apps/web/src/components/swipe-screen.tsx apps/web/src/lib/room-state.ts apps/web/src/routes/game/active-duel.tsx
git add apps/web/src/components/swipe-screen.tsx apps/web/src/lib/room-state.ts apps/web/src/routes/game/active-duel.tsx
git commit -m "refactor(web): extract shared SwipeScreen + RoomState from active-duel"
```

(If Step 3's grep touched other importers, add those files too.)

---

### Task 6: Web — strike lines on `BtcSpotChart`

**Files:**
- Modify: `apps/web/src/components/btc-spot-chart.tsx`

**Interfaces:**
- Produces (used by Task 8):

```ts
export interface StrikeLine {
  /** Strike in USD (already de-scaled from 1e9). */
  price: number
  label: string
  color: string
}
// New optional prop:
//   strikeLines?: StrikeLine[]
```

- [ ] **Step 1: Add the prop and domain handling**

(a) Add the exported interface above the component and extend the props:

```tsx
export interface StrikeLine {
  /** Strike in USD (already de-scaled from 1e9). */
  price: number
  label: string
  color: string
}

export function BtcSpotChart({
  ticks,
  cards,
  strikeLines,
}: {
  ticks: Record<string, Tick>
  cards: Array<{ expiry_market_id: string }>
  /** Horizontal strike guides (practice lockup drama). Omitted in PvP. */
  strikeLines?: StrikeLine[]
}) {
```

(b) In the `{ xDomain, yDomain }` useMemo, after computing `lo`/`hi` from samples and before the `!isFinite` check, fold the strikes into the visible band (practice strikes sit within bps of spot, so this cannot squash the line):

```ts
    for (const s of strikeLines ?? []) {
      if (s.price < lo) lo = s.price
      if (s.price > hi) hi = s.price
    }
```

and add `strikeLines` to the useMemo dependency array: `[samples, strikeLines]`.

- [ ] **Step 2: Render the lines**

Inside `<Group left={ml} top={mt}>`, immediately after the y-grid `{yTicks.map(…)}` block and before `{hasData && (…)}`:

```tsx
          {/* strike guides — the prices the pending cards settle against */}
          {(strikeLines ?? []).map((s, i) => {
            const y = yScale(s.price)
            if (!isFinite(y) || y < 0 || y > ih) return null
            return (
              <g key={`strike-${i}`}>
                <line
                  x1={0}
                  x2={iw}
                  y1={y}
                  y2={y}
                  stroke={s.color}
                  strokeOpacity={0.8}
                  strokeDasharray="5 3"
                  strokeWidth={1}
                />
                <text
                  x={3}
                  y={y - 3}
                  fill={s.color}
                  fontSize="9"
                  opacity={0.95}
                >
                  {s.label}
                </text>
              </g>
            )
          })}
```

- [ ] **Step 3: Verify + commit**

Run: `bun typecheck && bun lint`
Expected: clean (prop is optional — PvP call sites unchanged).

```bash
bunx prettier --write apps/web/src/components/btc-spot-chart.tsx
git add apps/web/src/components/btc-spot-chart.tsx
git commit -m "feat(web): optional strike guide lines on BtcSpotChart"
```

---

### Task 7: Web — `usePracticeSession` hook

**Files:**
- Create: `apps/web/src/hooks/use-practice-session.ts`

**Interfaces:**
- Consumes: `spot_tick` / `practice_session` / `spot_subscribe` / `spot_unsubscribe` (Task 2), `RoomState` (Task 5), `SWIPE_QUANTITY` from `@/lib/funding`, socket trio from `useFlickySocket`.
- Produces (used by Task 8):

```ts
export const BOT_ADDRESS: string
export const BOT_NAME: string
export interface PracticeCard { strike: string; expiryOffsetMs: number; pUp: number }
export type PracticePhase =
  | { kind: "INTRO" } | { kind: "STARTING" }
  | { kind: "SWIPING"; cardIdx: number }
  | { kind: "LOCKUP"; lockupStartMs: number; lockupEndMs: number }
  | { kind: "RESULT" } | { kind: "ERROR"; message: string }
export interface PracticeResult {
  yourPnl: bigint; botPnl: bigint
  yourPoints: number; botPoints: number
  youWon: boolean; tied: boolean
}
export function usePracticeSession(args: {
  address: string | undefined
  send: (msg: ClientMsg) => void
  onMessage: (h: (msg: ServerMsg) => void) => Unsubscribe
}): {
  phase: PracticePhase
  cards: PracticeCard[]           // [] until session arrives
  roomState: RoomState | null     // synthetic — feeds SwipeScreen/charts/ledger
  ticks: Record<string, { spot: string; expiry: string }>
  botRevealed: boolean[]
  result: PracticeResult | null   // non-null in RESULT phase
  start: () => void
  swipe: (isUp: boolean) => void
  reset: () => void
}
```

- [ ] **Step 1: Write the hook** (full file):

```ts
/**
 * Practice-session driver — the client-side "server" for practice mode.
 *
 * The real server only hands us a synthetic deck + pre-decided bot swipes
 * (`practice_session`) and a market-less live spot stream (`spot_tick`).
 * This hook owns everything a duel room would: the phase machine
 * (INTRO → STARTING → SWIPING → LOCKUP → RESULT), local swipe recording,
 * the bot's staggered reveal, per-card settlement against live spot at
 * each card's expiry offset, and the final score.
 *
 * It synthesizes a `RoomState`-shaped object (market ids `practice-0…4`,
 * challenger = BOT_ADDRESS) so SwipeScreen, the charts, and CardLedger
 * render exactly as they do in PvP. Nothing here touches the chain.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ClientMsg, ServerMsg } from "@/lib/protocol"
import type { Unsubscribe } from "@/hooks/use-flicky-socket"
import type { RoomState } from "@/lib/room-state"
import { SWIPE_QUANTITY } from "@/lib/funding"

/** Sentinel opponent address — drives PlayerAvatar's deterministic gradient
 *  and fills the p1 slot of the synthetic RoomState. */
export const BOT_ADDRESS =
  "0x0000000000000000000000000000000000000000000000000000000000000b07"
export const BOT_NAME = "flicky-bot"

const BOT_REVEAL_MIN_MS = 1_000
const BOT_REVEAL_MAX_MS = 3_000
/** Speed bonus fully decays after this long deliberating on one card. */
const SPEED_BONUS_WINDOW_MS = 10_000
/** The bot "decided" in 1–3s — fixed middling speed bonus for its points. */
const BOT_SPEED_MULT = 1.25
/** If no fresh tick lands this long after a card's expiry, settle with the
 *  latest spot rather than stalling the reveal. */
const SETTLE_GRACE_MS = 6_000
/** Pause after the last card flips before the result screen. */
const RESULT_DELAY_MS = 1_400
const START_TIMEOUT_MS = 10_000

export interface PracticeCard {
  strike: string
  expiryOffsetMs: number
  pUp: number
}

export type PracticePhase =
  | { kind: "INTRO" }
  | { kind: "STARTING" }
  | { kind: "SWIPING"; cardIdx: number }
  | { kind: "LOCKUP"; lockupStartMs: number; lockupEndMs: number }
  | { kind: "RESULT" }
  | { kind: "ERROR"; message: string }

export interface PracticeResult {
  yourPnl: bigint
  botPnl: bigint
  yourPoints: number
  botPoints: number
  youWon: boolean
  tied: boolean
}

interface PlayerSwipe {
  isUp: boolean
  pSwiped: number
  timeOnCardMs: number
}

interface CardOutcome {
  cardIdx: number
  settlementPrice: string
  upWon: boolean
}

interface Session {
  id: string
  cards: PracticeCard[]
  botSwipes: boolean[]
}

export function usePracticeSession({
  address,
  send,
  onMessage,
}: {
  address: string | undefined
  send: (msg: ClientMsg) => void
  onMessage: (h: (msg: ServerMsg) => void) => Unsubscribe
}) {
  const [phase, setPhase] = useState<PracticePhase>({ kind: "INTRO" })
  const [session, setSession] = useState<Session | null>(null)
  const [playerSwipes, setPlayerSwipes] = useState<(PlayerSwipe | null)[]>([])
  const [botRevealed, setBotRevealed] = useState<boolean[]>([])
  const [outcomes, setOutcomes] = useState<CardOutcome[]>([])
  const [lastTick, setLastTick] = useState<{
    spot: string
    receivedAtMs: number
  } | null>(null)
  const [startedAtMs, setStartedAtMs] = useState(0)

  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const lastTickRef = useRef(lastTick)
  lastTickRef.current = lastTick
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([])
  const cardShownAtRef = useRef(0)

  const clearTimers = useCallback(() => {
    for (const t of timersRef.current) clearTimeout(t)
    timersRef.current = []
  }, [])

  const start = useCallback(() => {
    if (!address) return
    clearTimers()
    setSession(null)
    setPlayerSwipes([])
    setBotRevealed([])
    setOutcomes([])
    setLastTick(null)
    setPhase({ kind: "STARTING" })
    send({ type: "spot_subscribe" })
    send({ type: "practice_start" })
  }, [address, send, clearTimers])

  const reset = useCallback(() => {
    clearTimers()
    send({ type: "spot_unsubscribe" })
    setSession(null)
    setPlayerSwipes([])
    setBotRevealed([])
    setOutcomes([])
    setLastTick(null)
    setPhase({ kind: "INTRO" })
  }, [send, clearTimers])

  // Unmount: stop the spot stream and any pending bot reveals.
  useEffect(() => {
    return () => {
      clearTimers()
      send({ type: "spot_unsubscribe" })
    }
  }, [send, clearTimers])

  // Give up if the session never arrives (server down / rate-limited).
  useEffect(() => {
    if (phase.kind !== "STARTING") return
    const t = setTimeout(
      () =>
        setPhase({
          kind: "ERROR",
          message:
            "the server didn't answer — check your connection and retry",
        }),
      START_TIMEOUT_MS
    )
    return () => clearTimeout(t)
  }, [phase])

  // WS intake: the deck, the spot stream, and practice errors.
  useEffect(() => {
    return onMessage((msg: ServerMsg) => {
      if (msg.type === "practice_session") {
        if (phaseRef.current.kind !== "STARTING") return
        setSession({
          id: `practice-${Date.now()}`,
          cards: msg.cards,
          botSwipes: msg.botSwipes,
        })
        setPlayerSwipes(Array(msg.cards.length).fill(null))
        setBotRevealed(Array(msg.cards.length).fill(false))
        setStartedAtMs(Date.now())
        cardShownAtRef.current = Date.now()
        setPhase({ kind: "SWIPING", cardIdx: 0 })
      } else if (msg.type === "spot_tick") {
        // Clock-skew-proof: compare card due-times against our own receipt
        // time, not the server's timestampMs.
        setLastTick({ spot: msg.spot, receivedAtMs: Date.now() })
      } else if (
        msg.type === "error" &&
        msg.code === "practice_failed" &&
        phaseRef.current.kind === "STARTING"
      ) {
        setPhase({ kind: "ERROR", message: msg.message })
      }
    })
  }, [onMessage])

  const swipe = useCallback(
    (isUp: boolean) => {
      const p = phaseRef.current
      if (p.kind !== "SWIPING" || !session) return
      const i = p.cardIdx
      const now = Date.now()
      const card = session.cards[i]
      setPlayerSwipes((prev) => {
        const next = [...prev]
        next[i] = {
          isUp,
          pSwiped: isUp ? card.pUp : 1 - card.pUp,
          timeOnCardMs: now - cardShownAtRef.current,
        }
        return next
      })
      // The bot "thinks" for 1–3s, then its pre-decided pick flips face-up.
      const t = setTimeout(
        () =>
          setBotRevealed((prev) => {
            const next = [...prev]
            next[i] = true
            return next
          }),
        BOT_REVEAL_MIN_MS +
          Math.random() * (BOT_REVEAL_MAX_MS - BOT_REVEAL_MIN_MS)
      )
      timersRef.current.push(t)
      cardShownAtRef.current = now
      if (i + 1 < session.cards.length) {
        setPhase({ kind: "SWIPING", cardIdx: i + 1 })
      } else {
        // 5th swipe = lockup starts; card expiries anchor here.
        const lockupStartMs = now
        const lockupEndMs =
          now + Math.max(...session.cards.map((c) => c.expiryOffsetMs))
        setPhase({ kind: "LOCKUP", lockupStartMs, lockupEndMs })
      }
    },
    [session]
  )

  // Settlement loop: each card settles on the first tick received at/after
  // its due time (falling back to the latest spot after a grace period so a
  // stalled stream can't wedge the match).
  useEffect(() => {
    if (phase.kind !== "LOCKUP" || !session) return
    const { lockupStartMs } = phase
    const iv = setInterval(() => {
      const tick = lastTickRef.current
      if (!tick) return
      const now = Date.now()
      setOutcomes((prev) => {
        const settled = new Set(prev.map((o) => o.cardIdx))
        const next = [...prev]
        session.cards.forEach((card, i) => {
          if (settled.has(i)) return
          const dueMs = lockupStartMs + card.expiryOffsetMs
          if (now < dueMs) return
          if (tick.receivedAtMs < dueMs && now - dueMs < SETTLE_GRACE_MS)
            return
          next.push({
            cardIdx: i,
            settlementPrice: tick.spot,
            // Contract convention: `actual_up = settlement > strike`
            // (mirrors pnl.ts — exact tie goes to DOWN).
            upWon: BigInt(tick.spot) > BigInt(card.strike),
          })
        })
        return next.length === prev.length ? prev : next
      })
    }, 250)
    return () => clearInterval(iv)
  }, [phase, session])

  // All cards settled → brief beat for the last flip, then the result.
  useEffect(() => {
    if (phase.kind !== "LOCKUP" || !session) return
    if (outcomes.length !== session.cards.length) return
    const t = setTimeout(() => setPhase({ kind: "RESULT" }), RESULT_DELAY_MS)
    return () => clearTimeout(t)
  }, [phase, outcomes, session])

  // Synthetic RoomState — the shape SwipeScreen/charts/CardLedger consume.
  const roomState: RoomState | null = useMemo(() => {
    if (!session || !address) return null
    const q = SWIPE_QUANTITY.toString()
    return {
      duelId: session.id,
      status:
        outcomes.length === session.cards.length ? "COMPLETE" : "ACTIVE",
      cardsRevealed: true,
      cardCount: session.cards.length,
      cards: session.cards.map((c, i) => ({
        expiry_market_id: `practice-${i}`,
        strike: c.strike,
      })),
      settledCount: outcomes.length,
      p0Payout: "0",
      p0Premium: "0",
      p1Payout: "0",
      p1Premium: "0",
      startedAtMs,
      creator: address,
      challenger: BOT_ADDRESS,
      stakeCoinType: "practice",
      cardOutcomes: outcomes.map((o) => {
        const card = session.cards[o.cardIdx]
        const my = playerSwipes[o.cardIdx]
        const bot = session.botSwipes[o.cardIdx]
        const myPnl =
          my === null || my === undefined
            ? null
            : o.upWon === my.isUp
              ? SWIPE_QUANTITY
              : -SWIPE_QUANTITY
        const botPnl = o.upWon === bot ? SWIPE_QUANTITY : -SWIPE_QUANTITY
        return {
          cardIdx: o.cardIdx,
          settlementPrice: o.settlementPrice,
          strike: card.strike,
          upWon: o.upWon,
          p0Pnl: myPnl === null ? null : myPnl.toString(),
          p1Pnl: botPnl.toString(),
          p0Swipe: my ? { isUp: my.isUp, quantity: q, orderId: "0" } : null,
          p1Swipe: { isUp: bot, quantity: q, orderId: "0" },
        }
      }),
      swipes: session.cards.map((_, i) => ({
        cardIdx: i,
        p0Swipe: playerSwipes[i]
          ? { isUp: playerSwipes[i]!.isUp, quantity: q, orderId: "0" }
          : null,
        p1Swipe: botRevealed[i]
          ? { isUp: session.botSwipes[i], quantity: q, orderId: "0" }
          : null,
      })),
    }
  }, [session, address, outcomes, playerSwipes, botRevealed, startedAtMs])

  // Ticks keyed by the synthetic market ids. Pre-lock, expiry is an "as if
  // you locked now" estimate (feeds the odds hint — the countdown line is
  // overridden via SwipeScreen's settleLabel); post-lock it's the real
  // settle time, so charts and countdowns converge on truth.
  const ticks = useMemo(() => {
    if (!session || !lastTick) return {}
    const lockupStartMs =
      phase.kind === "LOCKUP" ? phase.lockupStartMs : null
    const out: Record<string, { spot: string; expiry: string }> = {}
    session.cards.forEach((c, i) => {
      const expiryMs = (lockupStartMs ?? Date.now()) + c.expiryOffsetMs
      out[`practice-${i}`] = { spot: lastTick.spot, expiry: String(expiryMs) }
    })
    return out
  }, [session, lastTick, phase])

  // Final score: PnL decides the win (mirrors on-chain finalize semantics);
  // points teach the README scoring rule (1/p × speed multiplier).
  const result: PracticeResult | null = useMemo(() => {
    if (phase.kind !== "RESULT" || !session || !roomState) return null
    let yourPnl = 0n
    let botPnl = 0n
    let yourPoints = 0
    let botPoints = 0
    for (const o of roomState.cardOutcomes) {
      if (o.p0Pnl !== null) yourPnl += BigInt(o.p0Pnl)
      if (o.p1Pnl !== null) botPnl += BigInt(o.p1Pnl)
      const my = playerSwipes[o.cardIdx]
      if (my && o.upWon === my.isUp) {
        const speed =
          1 +
          0.5 * Math.max(0, 1 - my.timeOnCardMs / SPEED_BONUS_WINDOW_MS)
        yourPoints += (1 / my.pSwiped) * speed
      }
      const bot = session.botSwipes[o.cardIdx]
      if (o.upWon === bot) {
        const card = session.cards[o.cardIdx]
        const pBot = bot ? card.pUp : 1 - card.pUp
        botPoints += (1 / pBot) * BOT_SPEED_MULT
      }
    }
    return {
      yourPnl,
      botPnl,
      yourPoints,
      botPoints,
      youWon: yourPnl > botPnl,
      tied: yourPnl === botPnl,
    }
  }, [phase, session, roomState, playerSwipes])

  return {
    phase,
    cards: session?.cards ?? [],
    roomState,
    ticks,
    botRevealed,
    result,
    start,
    swipe,
    reset,
  }
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `bun typecheck && bun lint`
Expected: clean (`react-hooks/exhaustive-deps` may flag the `ticks` memo's `Date.now()` indirection — if it complains about `phase` structure, destructure `phase.kind`/`lockupStartMs` locally as shown).

- [ ] **Step 3: Commit**

```bash
bunx prettier --write apps/web/src/hooks/use-practice-session.ts
git add apps/web/src/hooks/use-practice-session.ts
git commit -m "feat(web): usePracticeSession driver hook (synthetic RoomState, 45s lockup)"
```

---

### Task 8: Web — `/game/practice` route (INTRO → SWIPING → LOCKUP → RESULT)

**Files:**
- Create: `apps/web/src/routes/game/practice.tsx`
- Modify: `apps/web/src/main.tsx` (route swap at line 37)

**Interfaces:**
- Consumes: `usePracticeSession`/`BOT_ADDRESS`/`BOT_NAME` (Task 7), `SwipeScreen`/`CardLedger`/`fmtUsd` (Task 5), `BtcSpotChart` + `StrikeLine` (Task 6), `StreamingPnlChart`, `PlayerAvatar`, `useFlickySocket`, `WsErrorBanner`, `fmtDusdcSigned` from `@/lib/pnl`.
- Produces: default export `GamePractice`.

- [ ] **Step 1: Wire the route in `main.tsx`**

Add `import GamePractice from "@/routes/game/practice.tsx"` and change line 37 to:

```tsx
      { path: "practice", element: <GamePractice /> },
```

(`GameComingSoon` stays imported for the `inventory` route.)

- [ ] **Step 2: Create `apps/web/src/routes/game/practice.tsx`** (full file):

```tsx
/**
 * Practice mode — solo vs. bot, no queue, no chain. The whole match runs
 * client-side off `usePracticeSession`; the server only supplies the
 * synthetic deck and the live `spot_tick` stream. Flow:
 *   INTRO → SWIPING (untimed, bot reveals its pick 1–3s behind you)
 *         → LOCKUP (45s: live chart + strike lines, cards flip as they
 *           expire against real Pyth spot)
 *         → RESULT (PnL verdict + 1/p × speed points recap).
 */
import { useEffect, useState } from "react"
import { Link, useNavigate } from "react-router"
import { useCurrentAccount } from "@mysten/dapp-kit-react"
import { useFlickySocket } from "@/hooks/use-flicky-socket"
import {
  BOT_ADDRESS,
  BOT_NAME,
  usePracticeSession,
  type PracticeCard,
  type PracticeResult,
} from "@/hooks/use-practice-session"
import type { RoomState } from "@/lib/room-state"
import { fmtDusdcSigned } from "@/lib/pnl"
import { SwipeScreen, CardLedger, fmtUsd } from "@/components/swipe-screen"
import { BtcSpotChart, type StrikeLine } from "@/components/btc-spot-chart"
import { StreamingPnlChart } from "@/components/streaming-pnl-chart"
import { PlayerAvatar } from "@/components/player-avatar"
import { WsErrorBanner } from "@/components/ws-error-banner"

export default function GamePractice() {
  const account = useCurrentAccount()
  const navigate = useNavigate()
  const { wsOpen, send, onMessage } = useFlickySocket(account?.address)
  const practice = usePracticeSession({
    address: account?.address,
    send,
    onMessage,
  })
  const { phase } = practice

  return (
    <div className="flex h-full flex-col gap-4 px-4 py-4 text-white">
      <WsErrorBanner onMessage={onMessage} />
      <div className="flex items-center justify-between">
        <h2 className="text-3xl tracking-[0.2em] uppercase">Practice</h2>
        <button
          type="button"
          onClick={() => navigate("/game/home")}
          className="rounded border border-white/25 bg-black/40 px-3 py-1 text-lg backdrop-blur-md hover:bg-black/55"
        >
          Exit
        </button>
      </div>

      {phase.kind !== "INTRO" && phase.kind !== "ERROR" && (
        <BotStrip
          botRevealed={practice.botRevealed}
          total={practice.cards.length}
        />
      )}

      {phase.kind === "INTRO" && (
        <IntroView
          canStart={wsOpen && !!account?.address}
          youAddress={account?.address}
          onStart={practice.start}
        />
      )}
      {phase.kind === "STARTING" && (
        <p className="flex flex-1 items-center justify-center text-base text-white/55">
          dealing a practice deck…
        </p>
      )}
      {phase.kind === "SWIPING" && practice.roomState && account && (
        <SwipeScreen
          roomState={practice.roomState}
          cardIdx={phase.cardIdx}
          ticks={practice.ticks}
          myAddress={account.address}
          opponentAddress={BOT_ADDRESS}
          busyLabel="locking pick…"
          settleLabel={settleLabelFor(practice.cards, phase.cardIdx)}
          onSwipe={async (isUp) => practice.swipe(isUp)}
          deckExhausted={null}
        />
      )}
      {phase.kind === "LOCKUP" && practice.roomState && account && (
        <LockupView
          roomState={practice.roomState}
          cards={practice.cards}
          ticks={practice.ticks}
          lockupStartMs={phase.lockupStartMs}
          lockupEndMs={phase.lockupEndMs}
          youAddress={account.address}
        />
      )}
      {phase.kind === "RESULT" &&
        practice.roomState &&
        practice.result && (
          <ResultView
            roomState={practice.roomState}
            result={practice.result}
            ticks={practice.ticks}
            onPlayAgain={() => {
              practice.reset()
              // reset() lands on INTRO; immediately deal the next hand.
              setTimeout(practice.start, 0)
            }}
          />
        )}
      {phase.kind === "ERROR" && (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
          <p className="max-w-xs text-base text-red-400">{phase.message}</p>
          <button
            type="button"
            onClick={practice.start}
            className="pixel-tile bg-emerald-600 px-4 py-3 font-pixel text-sm uppercase"
          >
            retry
          </button>
        </div>
      )}
    </div>
  )
}

/** "settles Ns after lock" — the practice stand-in for the live countdown
 *  (pre-lock there's no absolute expiry yet). */
function settleLabelFor(cards: PracticeCard[], cardIdx: number): string {
  const offset = cards[cardIdx]?.expiryOffsetMs ?? 0
  return `settles ${Math.round(offset / 1000)}s after lock`
}

/** Who you're playing: the bot, plus how many picks it has locked so far. */
function BotStrip({
  botRevealed,
  total,
}: {
  botRevealed: boolean[]
  total: number
}) {
  const locked = botRevealed.filter(Boolean).length
  return (
    <div className="flex items-center gap-2.5 border-2 border-black/55 bg-[#1b2548] px-3 py-2">
      <PlayerAvatar address={BOT_ADDRESS} size={28} />
      <span className="font-pixel text-sm tracking-[0.18em] text-white/80 uppercase">
        {BOT_NAME}
      </span>
      <span className="ml-auto font-pixel text-xs tracking-[0.18em] text-white/45 uppercase tabular-nums">
        {total > 0 ? `bot locked ${locked}/${total}` : "warming up"}
      </span>
    </div>
  )
}

function IntroView({
  canStart,
  youAddress,
  onStart,
}: {
  canStart: boolean
  youAddress: string | undefined
  onStart: () => void
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-5 px-4 text-center">
      <img
        src="/banners/mode-practice.png"
        alt=""
        aria-hidden
        className="pixel-tile no-hover w-full max-w-xs [image-rendering:pixelated]"
      />
      <div className="flex items-center gap-4">
        <PlayerAvatar address={youAddress} size={44} />
        <span className="font-pixel text-xl text-amber-300">vs</span>
        <PlayerAvatar address={BOT_ADDRESS} size={44} />
      </div>
      <div className="max-w-xs space-y-1.5 text-left text-sm leading-relaxed text-white/70">
        <p>· swipe 5 cards — YES if BTC settles above the strike, NO if not</p>
        <p>· then watch the live chart: every card resolves within 45s</p>
        <p>· riskier calls + faster swipes = more points. no stakes, no gas</p>
      </div>
      <button
        type="button"
        onClick={onStart}
        disabled={!canStart}
        className="pixel-tile w-full max-w-xs bg-emerald-600 px-4 py-3 font-pixel text-sm uppercase disabled:opacity-50"
      >
        {canStart ? "start practice" : "connecting…"}
      </button>
    </div>
  )
}

function LockupView({
  roomState,
  cards,
  ticks,
  lockupStartMs,
  lockupEndMs,
  youAddress,
}: {
  roomState: RoomState
  cards: PracticeCard[]
  ticks: Record<string, { spot: string; expiry: string }>
  lockupStartMs: number
  lockupEndMs: number
  youAddress: string
}) {
  // 4 Hz wall-clock: smooth per-card countdowns + the lockup bar.
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 250)
    return () => clearInterval(id)
  }, [])

  const totalMs = lockupEndMs - lockupStartMs
  const remainingMs = Math.max(0, lockupEndMs - nowMs)
  const frac = totalMs > 0 ? remainingMs / totalMs : 0
  const settledByIdx = new Map(
    roomState.cardOutcomes.map((o) => [o.cardIdx, o])
  )

  // Strike guides for the cards still in flight; settled ones drop off.
  const strikeLines: StrikeLine[] = cards.flatMap((c, i) =>
    settledByIdx.has(i)
      ? []
      : [
          {
            price: Number(BigInt(c.strike)) / 1e9,
            label: `#${i + 1}`,
            color: "#ffd24a",
          },
        ]
  )

  return (
    <div className="flex flex-1 flex-col gap-3 overflow-y-auto">
      {/* 45s lockup bar */}
      <div>
        <div className="flex items-center justify-between pb-1">
          <span className="font-pixel text-xs tracking-[0.2em] text-white/55 uppercase">
            picks locked — cards settling
          </span>
          <span className="font-pixel text-sm text-cyan-300 tabular-nums">
            {Math.ceil(remainingMs / 1000)}s
          </span>
        </div>
        <div className="h-2 border-2 border-black/55 bg-[#0e1530]">
          <div
            className="h-full bg-cyan-400 transition-[width] duration-200 ease-linear"
            style={{ width: `${frac * 100}%` }}
          />
        </div>
      </div>

      <BtcSpotChart
        ticks={ticks}
        cards={roomState.cards}
        strikeLines={strikeLines}
      />

      {/* per-card flip strip */}
      <div className="grid grid-cols-5 gap-1.5">
        {cards.map((c, i) => {
          const outcome = settledByIdx.get(i)
          const my = roomState.swipes[i]?.p0Swipe ?? null
          const bot = roomState.swipes[i]?.p1Swipe ?? null
          const dueMs = lockupStartMs + c.expiryOffsetMs
          const hit = outcome && my ? outcome.upWon === my.isUp : null
          return (
            <div
              key={i}
              className={`border-2 border-black/55 px-1 py-1.5 text-center transition-colors ${
                outcome
                  ? hit
                    ? "bg-emerald-900/60"
                    : "bg-rose-900/60"
                  : "bg-[#0e1530]"
              }`}
            >
              <p className="font-pixel text-[10px] text-white/45 uppercase">
                {fmtUsd(c.strike)}
              </p>
              <p className="font-pixel text-sm text-white">
                {my ? (my.isUp ? "↑" : "↓") : "—"}
                <span className="px-0.5 text-white/30">·</span>
                <span className="text-white/60">
                  {bot ? (bot.isUp ? "↑" : "↓") : "…"}
                </span>
              </p>
              <p
                className={`font-pixel text-[10px] uppercase tabular-nums ${
                  outcome
                    ? hit
                      ? "text-emerald-300"
                      : "text-rose-300"
                    : "text-cyan-300"
                }`}
              >
                {outcome
                  ? hit
                    ? "hit"
                    : "miss"
                  : `${Math.max(0, Math.ceil((dueMs - nowMs) / 1000))}s`}
              </p>
            </div>
          )
        })}
      </div>

      <StreamingPnlChart
        duel={{
          id: roomState.duelId,
          settledCount: roomState.settledCount,
          cards: roomState.cards,
          swipes: roomState.swipes,
          cardOutcomes: roomState.cardOutcomes,
        }}
        ticks={ticks}
        myIsP0={true}
        youAddress={youAddress}
        oppAddress={BOT_ADDRESS}
      />
    </div>
  )
}

function ResultView({
  roomState,
  result,
  ticks,
  onPlayAgain,
}: {
  roomState: RoomState
  result: PracticeResult
  ticks: Record<string, { spot: string; expiry: string }>
  onPlayAgain: () => void
}) {
  return (
    <div className="flex flex-1 flex-col gap-3 overflow-y-auto">
      <div className="rounded border-2 border-black/55 bg-[#1b2548] p-4 text-center">
        <h3 className="text-2xl tracking-[0.2em] uppercase">
          {result.tied ? "Tie" : result.youWon ? "Victory" : "Defeat"}
        </h3>
        <p className="mt-2 text-base text-white/70">
          you {fmtDusdcSigned(result.yourPnl)} · bot{" "}
          {fmtDusdcSigned(result.botPnl)}
        </p>
        <p className="mt-1 font-pixel text-xs tracking-[0.15em] text-amber-300/80 uppercase">
          points (1/p × speed): you {result.yourPoints.toFixed(2)} · bot{" "}
          {result.botPoints.toFixed(2)}
        </p>
        <p className="mt-1 text-xs text-white/45">
          practice runs off-chain — nothing was staked, nothing is recorded
        </p>
      </div>
      <CardLedger roomState={roomState} myIsP0={true} ticks={ticks} />
      <div className="mt-auto flex flex-col gap-2">
        <button
          type="button"
          onClick={onPlayAgain}
          className="pixel-tile bg-emerald-600 px-4 py-3 font-pixel text-sm uppercase"
        >
          play again
        </button>
        <Link
          to="/game/pvp"
          className="pixel-tile no-hover bg-[#3a4d8a] px-4 py-3 text-center font-pixel text-sm uppercase"
        >
          find a real match
        </Link>
        <Link
          to="/game/home"
          className="pixel-tile no-hover bg-[#1b2548] px-4 py-3 text-center font-pixel text-sm uppercase"
        >
          back to home
        </Link>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Typecheck + lint + format**

Run: `bun typecheck && bun lint && bunx prettier --write apps/web/src/routes/game/practice.tsx apps/web/src/main.tsx`
Expected: clean. If `/banners/mode-practice.png` 404s at runtime, keep the `<img>` (it already exists — mode-modal references it).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/routes/game/practice.tsx apps/web/src/main.tsx
git commit -m "feat(web): practice mode route — swipe vs bot, 45s live lockup, result recap"
```

---

### Task 9: End-to-end verification + docs

**Files:**
- Modify (docs only): `docs/superpowers/specs/2026-07-12-practice-mode-design.md`

- [ ] **Step 1: Full check suite**

Run: `cd apps/server && bun test; cd ../.. && bun typecheck && bun lint`
Expected: all PASS/clean.

- [ ] **Step 2: Live end-to-end run**

Run `bun dev` (web :5173 + server :3001). In the browser (Chrome automation or manual):
1. Open `localhost:5173/game/pvp`, open the MODES modal, click PRACTICE → lands on `/game/practice` INTRO (bot banner, start button enabled once WS connects).
2. Start → deck arrives (server log: `practice for 0x… — 5 synthetic cards`), card 1 shows a strike within ~$5–30 of the live BTC price, the settle line reads "settles 15s after lock", and YES/NO odds render.
3. Swipe all 5 (mix of directions). Bot strip counts up `bot locked n/5` with 1–3s lag.
4. LOCKUP: 45s bar counts down, BTC chart streams with amber `#n` strike lines that disappear as cards settle, tiles flip hit/miss at ~15/22/30/37/45s, PnL race chart moves.
5. RESULT: Victory/Defeat + PnL + points + ledger; "play again" deals a fresh deck; "find a real match" routes to `/game/pvp`.
6. Regression: run a normal PvP queue-join far enough to confirm the standby/queue screens render and no console errors from the refactor.
7. Confirm NO sponsor calls or wallet signing prompts fired during practice (server logs stay free of `/sponsor` hits for the session).

- [ ] **Step 3: Align the spec's settlement-convention note**

In `docs/superpowers/specs/2026-07-12-practice-mode-design.md`, replace both occurrences of `upWon = spot >= strike` with `upWon = spot > strike` and change the edge-case line to: "**Spot exactly at strike at expiry**: `upWon = spot > strike` — an exact tie goes to DOWN, matching the contract's `actual_up = settlement > strike` and `pnl.ts`."

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-07-12-practice-mode-design.md
git commit -m "docs: practice-mode spec — settle-tie convention matches contract (spot > strike)"
```
