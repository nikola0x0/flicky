# PvP E2E Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the end-to-end PvP duel flow (matchmake → create/join → server-revealed deck → 5-card staked swipes → keeper finalize → results) into `apps/web` on top of the existing pixel-art UI shell, with incremental per-card PnL projection driven from the backend indexer.

**Architecture:** Web app consumes the existing `lib/flicky.ts` + `lib/deepbook.ts` codegen-based PTB builders (no playground porting). A single `active-duel.tsx` state machine handles both creator and challenger paths after the initial `create_duel` / `join_duel` sign step. The server's indexer is upgraded to project per-card `cardOutcomes` the moment each card's oracle settles, independent of `finalize_multi`. The keeper still owns reveal + finalize + redeem. All player-signed PTBs go through sponsored gas via `useFlickySign`.

**Tech Stack:**
- Web: Vite + React 19 + Tailwind v4 + `@mysten/dapp-kit` + `@mysten/sui` (codegen bindings in `apps/web/src/sui/gen/`).
- Server: Bun runtime, `Bun.serve` + WebSocket, SQLite mirror, in-process indexer + keeper.
- Tests: `bun test` (co-located `*.test.ts` files).
- Spec: `docs/superpowers/specs/2026-05-26-pvp-e2e-integration-design.md`.

---

## File map

### Modify (backend)
- `apps/server/src/ws/protocol.ts` — add `cards` field to `room_state`.
- `apps/web/src/lib/protocol.ts` — same change (mirror).
- `apps/server/src/indexer.ts` — incremental per-card oracle reads + projection.

### Create (web)
- `apps/web/src/lib/pnl.ts` — pure PnL math (`liveCardPnl`, `runningPnl`, `computePnl`) + co-located tests.
- `apps/web/src/components/onboarding-modal.tsx` — PredictManager + dUSDC onboarding UI.

### Modify (web)
- `apps/web/src/hooks/use-flicky-socket.ts` — subscription pattern.
- `apps/web/src/lib/deepbook.ts` — add `quoteSwipePremium` (UI display only).
- `apps/web/src/routes/game/pvp.tsx` — onboarding gate before queue_join.
- `apps/web/src/routes/game/active-duel.tsx` — full state machine.
- `apps/web/src/lib/config.ts` — packageId already bumped to `0x4ab5...` (done out-of-band).

---

## Task 1: Backend — surface `cards` in `room_state`

**Files:**
- Modify: `apps/server/src/ws/protocol.ts:67-109` (add field to `room_state` variant)
- Modify: `apps/web/src/lib/protocol.ts:67-109` (mirror)
- Modify: `apps/server/src/indexer.ts:447-464` (include `cards` in `broadcastRoom`)
- Modify: `apps/server/src/indexer.ts` `DuelLite` type (around line 70-85) — add `cards` field

- [ ] **Step 1: Add `cards` to the `DuelLite` type in indexer.ts**

Find the `DuelLite` interface around line 70-85. Add:

```ts
export interface DuelLite {
  // ... existing fields
  /** Revealed deck cards. Empty until DeckRevealed; one entry per slot. */
  cards: Array<{ oracle_id: string; strike: string }>
}
```

In the return of `fetchDuel` (around line 216-232), add:

```ts
return {
  // ... existing fields
  cards: cards.map((c) => ({
    oracle_id: c.fields?.oracle_id ?? "",
    strike: c.fields?.strike ?? "0",
  })),
}
```

- [ ] **Step 2: Add `cards` to `room_state` in both protocol files**

In both `apps/server/src/ws/protocol.ts` and `apps/web/src/lib/protocol.ts`, find the `room_state` variant (line 67-109) and add:

```ts
| {
    type: "room_state"
    duelId: string
    status: "PENDING" | "ACTIVE" | "COMPLETE"
    cardsRevealed: boolean
    cardCount: number
    settledCount: number
    /**
     * Revealed cards — empty array until DeckRevealed lands. Each card has
     * an oracle_id (DeepBook OracleSVI) and a u64 strike. The web UI uses
     * these to render the swipe deck and to look up per-card oracle ticks.
     */
    cards: Array<{ oracle_id: string; strike: string }>
    // ... rest of existing fields unchanged
```

- [ ] **Step 3: Include `cards` in `broadcastRoom` payload**

In `apps/server/src/indexer.ts` around line 447-464:

```ts
broadcastRoom(duelId, {
  type: "room_state",
  duelId,
  status: d.status,
  cardsRevealed: d.cardsRevealed,
  cardCount: d.cardCount,
  settledCount: d.settledCount,
  cards: d.cards,                          // <-- add
  p0Payout: d.p0Payout.toString(),
  // ... rest unchanged
})
```

- [ ] **Step 4: Update SQLite mirror if it stores cards**

If `upsertDuel` in `apps/server/src/db.ts` doesn't already persist cards, leave the mirror alone — cards can be re-derived from chain on restart. (If you find it does store something related, append `cards: d.cards` to the upsert call too.)

- [ ] **Step 5: Run server tests**

Run: `bun --filter server test`
Expected: all pre-existing tests pass; `room_state` payloads in any test fixtures may need `cards: []` added. Fix any TypeScript errors from the new required field.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/ws/protocol.ts apps/web/src/lib/protocol.ts apps/server/src/indexer.ts
git commit -m "feat(protocol): surface revealed cards in room_state"
```

---

## Task 2: Backend — incremental per-card PnL projection (B1 + B2)

**Files:**
- Modify: `apps/server/src/indexer.ts:185-215` (the `cardOutcomes` projection block)
- Modify: `apps/server/src/indexer.ts:143-147` (fetchDuel signature — drop `settlementPrice` arg)
- Modify: `apps/server/src/indexer.ts:380-395` (caller in `tick`)
- Test: `apps/server/src/indexer.test.ts` (new file)

**Background:** today `cardOutcomes` only populates when a `DuelFinalized` event's `settlement_price` is passed in, and uses one price for all 5 cards. We need each card to read its OWN oracle's `settlement_price`, and to populate the moment each oracle settles — not waiting for finalize.

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/indexer.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { computeCardOutcomes } from "./indexer"

// Pure function unit tests — the actual projection helper we'll extract.
describe("computeCardOutcomes", () => {
  test("returns empty when no oracles settled", () => {
    const out = computeCardOutcomes({
      cards: [
        { oracle_id: "0xA", strike: "100" },
        { oracle_id: "0xB", strike: "200" },
      ],
      p0Swipes: [
        { isUp: true, quantity: "1000000", premium: "300000", p_swiped: "0" },
        null,
      ],
      p1Swipes: [null, null],
      oracleSettlements: new Map(), // none settled
    })
    expect(out).toEqual([])
  })

  test("projects only cards whose oracle has settled", () => {
    const out = computeCardOutcomes({
      cards: [
        { oracle_id: "0xA", strike: "100" },
        { oracle_id: "0xB", strike: "200" },
      ],
      p0Swipes: [
        { isUp: true, quantity: "1000000", premium: "300000", p_swiped: "0" },
        { isUp: false, quantity: "1000000", premium: "700000", p_swiped: "0" },
      ],
      p1Swipes: [null, null],
      oracleSettlements: new Map([["0xA", "150"]]), // only A settled
    })
    expect(out.length).toBe(1)
    expect(out[0].cardIdx).toBe(0)
    expect(out[0].upWon).toBe(true) // 150 > 100
    expect(out[0].p0Pnl).toBe("700000") // 1_000_000 - 300_000
    expect(out[0].p1Pnl).toBe(null)
  })

  test("uses each card's own oracle (multi-oracle deck)", () => {
    const out = computeCardOutcomes({
      cards: [
        { oracle_id: "0xA", strike: "100" },
        { oracle_id: "0xB", strike: "200" },
      ],
      p0Swipes: [
        { isUp: true, quantity: "1000000", premium: "300000", p_swiped: "0" },
        { isUp: true, quantity: "1000000", premium: "500000", p_swiped: "0" },
      ],
      p1Swipes: [null, null],
      // Card 0's oracle settled BELOW strike, card 1's settled ABOVE strike.
      // If we (incorrectly) used one price for both, p0Pnl would be wrong on one.
      oracleSettlements: new Map([
        ["0xA", "50"],   // below 100 → UP loses
        ["0xB", "250"],  // above 200 → UP wins
      ]),
    })
    expect(out.length).toBe(2)
    expect(out[0].upWon).toBe(false)
    expect(out[0].p0Pnl).toBe("-300000") // lost: 0 - 300_000
    expect(out[1].upWon).toBe(true)
    expect(out[1].p0Pnl).toBe("500000")  // won: 1_000_000 - 500_000
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun --filter server test src/indexer.test.ts`
Expected: FAIL — `computeCardOutcomes` is not exported from indexer.

- [ ] **Step 3: Extract + export `computeCardOutcomes` from indexer.ts**

In `apps/server/src/indexer.ts`, replace the inline projection block (around lines 185-215) with an extracted pure function. Above the `fetchDuel` definition, add:

```ts
interface SwipeLite {
  isUp: boolean
  quantity: string
  premium: string
  p_swiped: string
}

export interface CardOutcomeInput {
  cards: Array<{ oracle_id: string; strike: string }>
  p0Swipes: Array<SwipeLite | null>
  p1Swipes: Array<SwipeLite | null>
  /** Map from oracle_id to its settlement_price (as base-10 string). Only
   *  contains oracles that have settled (settlement_price.is_some()). */
  oracleSettlements: Map<string, string>
}

/**
 * Project per-card outcomes deterministically from on-chain inputs.
 *
 * For each card whose oracle has settled, computes `upWon` and signed-
 * decimal per-player PnL using the same math the duel contract uses inside
 * `finalize_multi`:
 *
 *   upWon = settlement_price > strike
 *   playerPnl = (swipe.isUp == upWon ? quantity : 0) - premium
 *
 * Cards whose oracle hasn't settled yet are omitted (the array grows as
 * settlements roll in). Pure / synchronous so it's trivially testable.
 */
export function computeCardOutcomes(input: CardOutcomeInput): CardOutcome[] {
  const out: CardOutcome[] = []
  for (let i = 0; i < input.cards.length; i++) {
    const card = input.cards[i]
    const price = input.oracleSettlements.get(card.oracle_id)
    if (price === undefined) continue
    const upWon = BigInt(price) > BigInt(card.strike)
    const p0Swipe = input.p0Swipes[i] ?? null
    const p1Swipe = input.p1Swipes[i] ?? null
    out.push({
      cardIdx: i,
      settlementPrice: price,
      strike: card.strike,
      upWon,
      p0Swipe,
      p1Swipe,
      p0Pnl: computePnl(p0Swipe, upWon),
      p1Pnl: computePnl(p1Swipe, upWon),
    })
  }
  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun --filter server test src/indexer.test.ts`
Expected: 3 tests PASS.

- [ ] **Step 5: Wire `computeCardOutcomes` into `fetchDuel`**

Replace the old inline projection in `fetchDuel` (around lines 185-215) with a call to `computeCardOutcomes`. First, the function needs access to `oracleSettlements`. Change the signature:

```ts
async function fetchDuel(
  client: SuiClient,
  id: string,
  oracleSettlements: Map<string, string>,
): Promise<DuelLite | null>
```

Then replace the inline `if (settlementPrice != null) { ... }` block with:

```ts
const cardsLite = cards.map((c) => ({
  oracle_id: c.fields?.oracle_id ?? "",
  strike: c.fields?.strike ?? "0",
}))
const p0SwipesParsed = p0SwipesRaw.map(parseSwipeRaw)
const p1SwipesParsed = p1SwipesRaw.map(parseSwipeRaw)
const cardOutcomes = computeCardOutcomes({
  cards: cardsLite,
  p0Swipes: p0SwipesParsed,
  p1Swipes: p1SwipesParsed,
  oracleSettlements,
})
```

Update the return to use `cardsLite` for the `cards` field too (from Task 1).

- [ ] **Step 6: Update `refreshDuel` to read per-card oracles**

In `refreshDuel` (around line 418), replace the `settlementPrice?: string | null` parameter with `oracleSettlements`:

```ts
private async refreshDuel(
  duelId: string,
  oracleSettlements: Map<string, string>,
): Promise<void> {
  const d = await fetchDuel(this.client, duelId, oracleSettlements)
  // ... rest unchanged
}
```

Then in `tick` (around line 380-395), replace the per-duel `priceByDuel` accumulation with a call to read each tracked duel's cards' oracles in bulk. Add a helper above the class:

```ts
async function readOracleSettlements(
  client: SuiClient,
  oracleIds: string[],
): Promise<Map<string, string>> {
  if (oracleIds.length === 0) return new Map()
  const objs = await client.multiGetObjects({
    ids: Array.from(new Set(oracleIds)),
    options: { showContent: true },
  })
  const out = new Map<string, string>()
  for (const o of objs) {
    if (o.data?.content?.dataType !== "moveObject") continue
    const f = o.data.content.fields as {
      settlement_price?: { fields?: { vec?: string[] } } | string | null
    }
    let price: string | undefined
    if (typeof f.settlement_price === "string") {
      price = f.settlement_price
    } else if (f.settlement_price && typeof f.settlement_price === "object") {
      const vec = f.settlement_price.fields?.vec ?? []
      if (vec.length > 0) price = vec[0]
    }
    if (price !== undefined && o.data.objectId)
      out.set(o.data.objectId, price)
  }
  return out
}
```

In the `tick` loop, for each duel being refreshed:

```ts
// Build settlements map for THIS duel's cards.
const duelObj = await this.client.getObject({
  id: duelId,
  options: { showContent: true },
})
const f = duelObj.data?.content?.dataType === "moveObject"
  ? (duelObj.data.content.fields as { cards?: Array<{ fields?: { oracle_id?: string } }> })
  : undefined
const oracleIds = (f?.cards ?? [])
  .map((c) => c.fields?.oracle_id)
  .filter((x): x is string => !!x)
const settlements = await readOracleSettlements(this.client, oracleIds)
await this.refreshDuel(duelId, settlements)
```

(Optimization later: cache oracle settlements across duels in the same tick, but get correctness first.)

- [ ] **Step 7: Run all server tests**

Run: `bun --filter server test`
Expected: all tests pass. Some tests previously calling `refreshDuel(duelId, someString)` may need updating to pass a Map.

- [ ] **Step 8: Smoke check against running server**

Start the server: `bun --filter server dev`.
Look in logs for "indexer: tick" messages. They should still appear at ~3s intervals.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/indexer.ts apps/server/src/indexer.test.ts
git commit -m "feat(indexer): per-card cardOutcomes from per-oracle reads

cardOutcomes now grows incrementally as each card's oracle settles,
independent of finalize_multi. Each card reads its OWN oracle's
settlement_price (was: reused one price from DuelFinalized event,
broken for multi-oracle decks). Extracted pure computeCardOutcomes
helper with unit tests."
```

---

## Task 3: Web — port PnL math to `lib/pnl.ts`

**Files:**
- Create: `apps/web/src/lib/pnl.ts`
- Create: `apps/web/src/lib/pnl.test.ts`

The web app's `active-duel.tsx` needs the same `liveCardPnl` / `runningPnl` math the playground already uses. Extract it as a shared web util so the component stays focused on rendering.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/pnl.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { liveCardPnl, runningPnl } from "./pnl"

describe("liveCardPnl", () => {
  test("returns null when swipe missing", () => {
    expect(liveCardPnl(null, "100", "120")).toBeNull()
  })
  test("returns null when strike or forward missing", () => {
    const sw = { isUp: true, quantity: "1000000", premium: "300000" }
    expect(liveCardPnl(sw, undefined, "120")).toBeNull()
    expect(liveCardPnl(sw, "100", undefined)).toBeNull()
  })
  test("UP swipe favored when forward > strike", () => {
    const sw = { isUp: true, quantity: "1000000000", premium: "0" }
    // diff = 120 - 100 = 20; pnl = 20 * 1e9 / 1e9 = 20
    expect(liveCardPnl(sw, "100", "120")).toBe(20n)
  })
  test("UP swipe penalized when forward < strike", () => {
    const sw = { isUp: true, quantity: "1000000000", premium: "0" }
    expect(liveCardPnl(sw, "100", "80")).toBe(-20n)
  })
  test("DOWN swipe inverts sign", () => {
    const sw = { isUp: false, quantity: "1000000000", premium: "0" }
    expect(liveCardPnl(sw, "100", "120")).toBe(-20n)
    expect(liveCardPnl(sw, "100", "80")).toBe(20n)
  })
})

describe("runningPnl", () => {
  const deck = {
    cards: [
      { oracle_id: "0xA", strike: "100" },
      { oracle_id: "0xB", strike: "200" },
    ],
  }
  const ticks = {
    "0xA": { spot: "100", forward: "110" },
    "0xB": { spot: "200", forward: "190" },
  }

  test("sums settled + live for the same side", () => {
    const rs = {
      p0Payout: "700000",
      p0Premium: "300000",
      p1Payout: "0",
      p1Premium: "0",
      cardOutcomes: [
        { cardIdx: 0 }, // card 0 already settled — use real p0 PnL from payout-premium
      ],
      swipes: [
        // card 0 — settled
        {
          cardIdx: 0,
          p0Swipe: { isUp: true, quantity: "1000000", premium: "300000" },
          p1Swipe: null,
        },
        // card 1 — not settled, live
        {
          cardIdx: 1,
          p0Swipe: { isUp: false, quantity: "1000000000", premium: "0" },
          p1Swipe: null,
        },
      ],
    }
    // settled = 700_000 - 300_000 = 400_000
    // live   = (strike 200 - forward 190) * 1e9 / 1e9 = 10
    // total  = 400_010
    expect(runningPnl(rs, "p0", deck, ticks)).toBe(400010n)
  })

  test("returns settled-only when no live ticks", () => {
    const rs = {
      p0Payout: "500000",
      p0Premium: "200000",
      p1Payout: "0",
      p1Premium: "0",
      cardOutcomes: [{ cardIdx: 0 }, { cardIdx: 1 }],
      swipes: [],
    }
    expect(runningPnl(rs, "p0", deck, ticks)).toBe(300000n)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun --filter web test src/lib/pnl.test.ts`
Expected: FAIL — `liveCardPnl` and `runningPnl` not exported.

- [ ] **Step 3: Implement `lib/pnl.ts`**

Create `apps/web/src/lib/pnl.ts`:

```ts
/**
 * Per-card live PnL — proportional (mark-to-market) view.
 *
 *   diff = isUp ? (forward - strike) : (strike - forward)
 *   pnl  = diff * quantity / FLOAT_SCALING (1e9)
 *
 * Returns null when we lack the data to project a sign (no swipe, no
 * tick, no strike). Settled cards skip this and use the contract's
 * binary PnL from `cardOutcomes[i]` instead.
 */
const FLOAT_SCALING = 1_000_000_000n

export interface SwipeLite {
  isUp: boolean
  quantity: string
  premium: string
}

export function liveCardPnl(
  swipe: SwipeLite | null,
  strike: string | undefined,
  forward: string | undefined,
): bigint | null {
  if (!swipe || strike === undefined || forward === undefined) return null
  const s = BigInt(strike)
  const f = BigInt(forward)
  const q = BigInt(swipe.quantity)
  const diff = swipe.isUp ? f - s : s - f
  return (diff * q) / FLOAT_SCALING
}

/**
 * Combine settled real PnL + live mark-to-market projections into one
 * running total for `side`.
 *
 * Settled portion = contract-aggregated `payout - premium` (truth).
 * Live portion = sum of `liveCardPnl` over swiped-but-unsettled cards.
 * Unswiped cards contribute 0. Swiped cards without a tick are skipped.
 */
export function runningPnl(
  rs: {
    p0Payout: string
    p0Premium: string
    p1Payout: string
    p1Premium: string
    cardOutcomes: Array<{ cardIdx: number }>
    swipes: Array<{
      cardIdx: number
      p0Swipe: SwipeLite | null
      p1Swipe: SwipeLite | null
    }>
  },
  side: "p0" | "p1",
  deck: { cards: Array<{ oracle_id: string; strike: string }> } | null,
  ticks: Record<string, { spot: string; forward: string }>,
): bigint {
  const settled =
    side === "p0"
      ? BigInt(rs.p0Payout) - BigInt(rs.p0Premium)
      : BigInt(rs.p1Payout) - BigInt(rs.p1Premium)
  const settledIdx = new Set(rs.cardOutcomes.map((o) => o.cardIdx))
  let live = 0n
  for (const s of rs.swipes) {
    if (settledIdx.has(s.cardIdx)) continue
    const swipe = side === "p0" ? s.p0Swipe : s.p1Swipe
    if (!swipe) continue
    const card = deck?.cards[s.cardIdx]
    if (!card) continue
    const tick = ticks[card.oracle_id]
    if (!tick) continue
    const pnl = liveCardPnl(swipe, card.strike, tick.forward)
    if (pnl !== null) live += pnl
  }
  return settled + live
}

/**
 * dUSDC micro-units (1e6) → human string with 4 decimals.
 */
export function fmtDusdcSigned(microUnits: bigint): string {
  const sign = microUnits < 0n ? "-" : "+"
  const abs = microUnits < 0n ? -microUnits : microUnits
  return `${sign}${(Number(abs) / 1e6).toFixed(4)} dUSDC`
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun --filter web test src/lib/pnl.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/pnl.ts apps/web/src/lib/pnl.test.ts
git commit -m "feat(web): PnL math util (liveCardPnl, runningPnl)"
```

---

## Task 4: Web — add `quoteSwipePremium` (UI display only)

**Files:**
- Modify: `apps/web/src/lib/deepbook.ts` (append a new export near the bottom, before `extractManagerIdFromChanges`)
- Modify: `apps/web/src/lib/flicky.test.ts` (or new `deepbook.test.ts`) — devInspect tests are hard offline; add a non-network unit test that exercises just the BCS parsing instead

The contract snapshots `premium` on chain — this helper exists ONLY so the UI can display an estimated cost on the UP/DOWN buttons.

- [ ] **Step 1: Add the helper to `lib/deepbook.ts`**

Open `apps/web/src/lib/deepbook.ts` and add near the bottom of the file (before `extractManagerIdFromChanges`):

```ts
// === UI-only premium quoter ===

import * as predictGen from "@/sui/gen/deepbook_predict/predict"

export interface SwipeQuote {
  /**
   * dUSDC micro-units. Display only — do NOT pass to buildStakedSwipeTx.
   * The contract recomputes premium on-chain via get_trade_amounts at
   * swipe time; this is an estimate that may drift by a few atoms.
   */
  premium: bigint
  /** Implied probability in 1e9 fixed point (e.g. 700_000_000 = 0.70). */
  pUp: bigint
}

/**
 * devInspect `predict::get_trade_amounts` to preview a swipe's cost
 * BEFORE the user clicks UP/DOWN. The return tuple is `(premium, p_up)`
 * encoded as two consecutive u64s; we decode via BCS.
 */
export async function quoteSwipePremium(
  client: SuiClient,
  args: {
    oracleSviId: string
    oracleExpiry: bigint
    strike: bigint
    isUp: boolean
    quantity: bigint
  },
): Promise<SwipeQuote> {
  const tx = new Transaction()
  const mk = tx.add(
    args.isUp
      ? marketKey.up({
          package: DEEPBOOK.package,
          arguments: [args.oracleSviId, args.oracleExpiry, args.strike],
        })
      : marketKey.down({
          package: DEEPBOOK.package,
          arguments: [args.oracleSviId, args.oracleExpiry, args.strike],
        }),
  )
  tx.add(
    predictGen.getTradeAmounts({
      package: DEEPBOOK.package,
      arguments: [DEEPBOOK.predictObject, args.oracleSviId, mk, args.quantity],
    }),
  )
  const res = await client.devInspectTransactionBlock({
    sender: "0x0000000000000000000000000000000000000000000000000000000000000000",
    transactionBlock: tx,
  })
  const rets = res.results?.[res.results.length - 1]?.returnValues ?? []
  if (rets.length < 2) {
    throw new Error("quoteSwipePremium: unexpected devInspect return shape")
  }
  const premium = BigInt(bcs.U64.parse(Uint8Array.from(rets[0][0])))
  const pUp = BigInt(bcs.U64.parse(Uint8Array.from(rets[1][0])))
  return { premium, pUp }
}
```

(If `predictGen.getTradeAmounts` doesn't exist in the codegen, use a direct `tx.moveCall` against `${DEEPBOOK.package}::predict::get_trade_amounts` instead, with the same args.)

- [ ] **Step 2: Type-check**

Run: `bun --filter web typecheck`
Expected: passes. If `predictGen.getTradeAmounts` is missing, the build will fail clearly; fall back to the manual moveCall form above.

- [ ] **Step 3: Manually verify against testnet (no automated test)**

Quick smoke from a Node REPL or temp file isn't worth writing — this will get exercised in Task 9 (swipe phase) and any drift will surface there. Skip unit test for this one; devInspect requires a live client.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/deepbook.ts
git commit -m "feat(web): quoteSwipePremium for UI swipe-cost preview

devInspect-based estimate; the contract recomputes on-chain at swipe
time. Display only — never passed to buildStakedSwipeTx (the new
record_swipe doesn't take a premium arg)."
```

---

## Task 5: Web — refactor `use-flicky-socket` to subscription pattern

**Files:**
- Modify: `apps/web/src/hooks/use-flicky-socket.ts`

The current hook exposes `lastMsg: ServerMsg | null`. With two components (`pvp.tsx` watching `queue_status`/`match_found`, `active-duel.tsx` watching `room_state`/`oracle_tick`/`duel_assigned`), the single-state model drops messages. Replace with handler registration.

- [ ] **Step 1: Replace the hook implementation**

Overwrite `apps/web/src/hooks/use-flicky-socket.ts`:

```ts
import { useEffect, useRef, useState, useCallback } from "react"
import { CONFIG } from "@/lib/config"
import { ServerMsg, ClientMsg } from "@/lib/protocol"

export type Unsubscribe = () => void

/**
 * Connect to the Flicky WS server. Returns:
 *   - `wsOpen`: connection state.
 *   - `send`: write a typed ClientMsg.
 *   - `onMessage(handler)`: subscribe to ALL incoming server msgs. Caller
 *     filters by `msg.type`. Returns an unsubscribe fn — wire it through
 *     a useEffect cleanup so handlers don't leak.
 *
 * Multiple components can subscribe simultaneously; each handler is
 * invoked for every message. No single-`lastMsg` race.
 */
export function useFlickySocket(address?: string) {
  const wsRef = useRef<WebSocket | null>(null)
  const handlersRef = useRef<Set<(msg: ServerMsg) => void>>(new Set())
  const [wsOpen, setWsOpen] = useState(false)

  useEffect(() => {
    if (!address) return
    const ws = new WebSocket(CONFIG.serverWsUrl)
    wsRef.current = ws

    ws.onopen = () => {
      setWsOpen(true)
      ws.send(JSON.stringify({ type: "hello", address } satisfies ClientMsg))
    }

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as ServerMsg
        for (const h of handlersRef.current) h(msg)
      } catch (err) {
        console.error("WS parse error", err)
      }
    }

    ws.onclose = () => setWsOpen(false)

    return () => {
      ws.close()
      wsRef.current = null
      setWsOpen(false)
    }
  }, [address])

  const send = useCallback((msg: ClientMsg) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg))
    }
  }, [])

  const onMessage = useCallback((handler: (msg: ServerMsg) => void): Unsubscribe => {
    handlersRef.current.add(handler)
    return () => {
      handlersRef.current.delete(handler)
    }
  }, [])

  return { wsOpen, send, onMessage }
}
```

- [ ] **Step 2: Type-check**

Run: `bun --filter web typecheck`
Expected: existing callers (`pvp.tsx`) will error because they read `lastMsg`. We rewrite them in subsequent tasks — that's expected. If the typecheck error noise is intolerable, comment out the `lastMsg`-using code blocks in `pvp.tsx` temporarily before commit.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/hooks/use-flicky-socket.ts
git commit -m "refactor(web): typed onMessage subscription for use-flicky-socket"
```

---

## Task 6: Web — onboarding modal component

**Files:**
- Create: `apps/web/src/components/onboarding-modal.tsx`

Two-step modal: (1) create PredictManager if missing, (2) deposit dUSDC to reach 5 dUSDC. Both calls go through `useFlickySign`. Used by `pvp.tsx` before allowing queue_join.

- [ ] **Step 1: Create the component**

Create `apps/web/src/components/onboarding-modal.tsx`:

```tsx
import { useEffect, useState } from "react"
import { useCurrentAccount, useSuiClient } from "@mysten/dapp-kit"
import { useFlickySign } from "@/lib/use-flicky-sign"
import {
  buildCreateManagerTx,
  buildDepositDusdcTx,
  findPredictManager,
  getManagerDusdcBalance,
  getWalletDusdcBalance,
  writeManagerCache,
  extractManagerIdFromChanges,
  fmtDusdc,
  DEEPBOOK,
} from "@/lib/deepbook"

/** 5 dUSDC — covers worst-case 5-card exposure at SWIPE_QUANTITY = 1 dUSDC. */
export const MIN_MANAGER_BALANCE = 5_000_000n
/** Per-swipe Predict position size. */
export const SWIPE_QUANTITY = 1_000_000n

interface Props {
  open: boolean
  onClose: () => void
  onReady: (managerId: string) => void
}

type Phase =
  | { kind: "checking" }
  | { kind: "needs_manager" }
  | { kind: "needs_deposit"; managerId: string; current: bigint }
  | { kind: "ready"; managerId: string }
  | { kind: "error"; message: string }

export function OnboardingModal({ open, onClose, onReady }: Props) {
  const account = useCurrentAccount()
  const client = useSuiClient()
  const sign = useFlickySign()
  const [phase, setPhase] = useState<Phase>({ kind: "checking" })
  const [walletDusdc, setWalletDusdc] = useState<bigint>(0n)

  // Re-check state every time the modal opens.
  useEffect(() => {
    if (!open || !account) return
    let cancelled = false
    setPhase({ kind: "checking" })
    ;(async () => {
      try {
        const wallet = await getWalletDusdcBalance(client, account.address)
        if (cancelled) return
        setWalletDusdc(wallet)
        const mgr = await findPredictManager(client, account.address)
        if (cancelled) return
        if (!mgr) {
          setPhase({ kind: "needs_manager" })
          return
        }
        const bal = await getManagerDusdcBalance(client, mgr.id)
        if (cancelled) return
        if (bal >= MIN_MANAGER_BALANCE) {
          setPhase({ kind: "ready", managerId: mgr.id })
          return
        }
        setPhase({ kind: "needs_deposit", managerId: mgr.id, current: bal })
      } catch (e) {
        if (!cancelled)
          setPhase({
            kind: "error",
            message: e instanceof Error ? e.message : String(e),
          })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, account, client])

  // Drive the "ready" notify outside render.
  useEffect(() => {
    if (phase.kind === "ready") onReady(phase.managerId)
  }, [phase, onReady])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-md border-2 border-black/55 bg-[#1b2548] p-5 text-white shadow-[0_6px_0_rgba(0,0,0,0.45)]">
        <h2 className="mb-3 text-xl tracking-[0.2em] uppercase">Prepare to duel</h2>

        {phase.kind === "checking" && (
          <p className="text-sm text-white/70">Checking your Predict account…</p>
        )}

        {phase.kind === "needs_manager" && (
          <NeedsManagerStep
            walletDusdc={walletDusdc}
            onCreate={async () => {
              if (!account) return
              try {
                const tx = buildCreateManagerTx()
                const res = await sign.mutateAsync({ transaction: tx })
                const mgrId = extractManagerIdFromChanges(
                  (res as { objectChanges?: Array<{ type: string; objectType?: string; objectId?: string }> })
                    .objectChanges ?? [],
                )
                if (!mgrId) throw new Error("manager id not found in tx result")
                writeManagerCache(account.address, mgrId)
                const bal = await getManagerDusdcBalance(client, mgrId)
                if (bal >= MIN_MANAGER_BALANCE)
                  setPhase({ kind: "ready", managerId: mgrId })
                else setPhase({ kind: "needs_deposit", managerId: mgrId, current: bal })
              } catch (e) {
                setPhase({
                  kind: "error",
                  message: e instanceof Error ? e.message : String(e),
                })
              }
            }}
          />
        )}

        {phase.kind === "needs_deposit" && (
          <NeedsDepositStep
            current={phase.current}
            walletDusdc={walletDusdc}
            onDeposit={async () => {
              if (!account) return
              const needed = MIN_MANAGER_BALANCE - phase.current
              if (walletDusdc < needed) {
                setPhase({
                  kind: "error",
                  message: `Wallet has ${fmtDusdc(walletDusdc)} but needs ${fmtDusdc(needed)} dUSDC.`,
                })
                return
              }
              try {
                const tx = await buildDepositDusdcTx(
                  client,
                  account.address,
                  phase.managerId,
                  needed,
                )
                await sign.mutateAsync({ transaction: tx })
                setPhase({ kind: "ready", managerId: phase.managerId })
              } catch (e) {
                setPhase({
                  kind: "error",
                  message: e instanceof Error ? e.message : String(e),
                })
              }
            }}
          />
        )}

        {phase.kind === "ready" && (
          <p className="text-sm text-green-400">
            Ready — joining queue…
          </p>
        )}

        {phase.kind === "error" && (
          <div className="space-y-2">
            <p className="text-sm text-red-400">{phase.message}</p>
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-white/30 bg-white/5 px-3 py-1 text-sm hover:bg-white/10"
            >
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function NeedsManagerStep({
  walletDusdc,
  onCreate,
}: {
  walletDusdc: bigint
  onCreate: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  return (
    <div className="space-y-3">
      <p className="text-sm text-white/80">
        You need a Predict account to swipe. We&rsquo;ll create one and then deposit
        5 dUSDC.
      </p>
      <p className="text-xs text-white/55">
        Wallet balance: {fmtDusdc(walletDusdc)}
      </p>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          try {
            await onCreate()
          } finally {
            setBusy(false)
          }
        }}
        className="w-full rounded-md bg-[#e08a2b] px-4 py-2 text-lg font-bold text-white disabled:opacity-50"
      >
        {busy ? "Creating…" : "Create Predict account"}
      </button>
    </div>
  )
}

function NeedsDepositStep({
  current,
  walletDusdc,
  onDeposit,
}: {
  current: bigint
  walletDusdc: bigint
  onDeposit: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const needed = MIN_MANAGER_BALANCE - current
  return (
    <div className="space-y-3">
      <p className="text-sm text-white/80">
        Your Predict account has {fmtDusdc(current)}. We need {fmtDusdc(MIN_MANAGER_BALANCE)}.
        Deposit {fmtDusdc(needed)}?
      </p>
      <p className="text-xs text-white/55">Wallet balance: {fmtDusdc(walletDusdc)}</p>
      <button
        type="button"
        disabled={busy || walletDusdc < needed}
        onClick={async () => {
          setBusy(true)
          try {
            await onDeposit()
          } finally {
            setBusy(false)
          }
        }}
        className="w-full rounded-md bg-[#e08a2b] px-4 py-2 text-lg font-bold text-white disabled:opacity-50"
      >
        {busy
          ? "Depositing…"
          : walletDusdc < needed
            ? "Insufficient dUSDC in wallet"
            : `Deposit ${fmtDusdc(needed)}`}
      </button>
    </div>
  )
}
```

- [ ] **Step 2: Type-check**

Run: `bun --filter web typecheck`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/onboarding-modal.tsx
git commit -m "feat(web): onboarding modal for PredictManager + dUSDC"
```

---

## Task 7: Web — wire onboarding gate in `pvp.tsx`

**Files:**
- Modify: `apps/web/src/routes/game/pvp.tsx`

Before sending `queue_join`, run the onboarding check. On success, store the managerId and proceed to queue. Also rewires `useFlickySocket` to the new subscription API.

- [ ] **Step 1: Rewrite `pvp.tsx`**

Replace the body of `apps/web/src/routes/game/pvp.tsx` (keep the existing `StakeSelector` + `ChevronDown` at the bottom unchanged):

```tsx
import { useEffect, useRef, useState } from "react"
import type { CSSProperties } from "react"
import { useCurrentAccount } from "@mysten/dapp-kit"

import { MatchButton } from "@/components/match-button"
import { ModeModal } from "@/components/mode-modal"
import { OnboardingModal } from "@/components/onboarding-modal"
import { useFlickySocket } from "@/hooks/use-flicky-socket"
import { ActiveDuel } from "./active-duel"
import type { Tier, ServerMsg } from "@/lib/protocol"

const STAKES = [1, 3, 5, 10] as const
type Stake = (typeof STAKES)[number]

const MODE_BRAND_STYLE = {
  "--btn-bg": "#e08a2b",
  "--btn-highlight": "#f4b966",
} as CSSProperties

export default function GamePvp() {
  const account = useCurrentAccount()
  const [stake, setStake] = useState<Stake>(3)
  const [modeOpen, setModeOpen] = useState(false)
  const [onboardingOpen, setOnboardingOpen] = useState(false)
  const [managerId, setManagerId] = useState<string | null>(null)

  const { wsOpen, send, onMessage } = useFlickySocket(account?.address)

  const [queueSize, setQueueSize] = useState<number | null>(null)
  const [matched, setMatched] = useState<{
    role: "creator" | "challenger"
    opponent: string
  } | null>(null)

  const tier: Tier =
    stake === 1 ? "starter"
    : stake === 3 ? "casual"
    : stake === 5 ? "standard"
    : "high_roller"

  useEffect(() => {
    return onMessage((msg: ServerMsg) => {
      if (msg.type === "queue_status") setQueueSize(msg.size)
      else if (msg.type === "queue_left") setQueueSize(null)
      else if (msg.type === "match_found")
        setMatched({ role: msg.role, opponent: msg.opponent })
    })
  }, [onMessage])

  const onQueueMatch = () => {
    if (!account) {
      alert("Please sign in first")
      return
    }
    if (!wsOpen) {
      alert("Connecting to server… Please wait.")
      return
    }
    if (queueSize !== null) {
      send({ type: "queue_leave" })
      return
    }
    // Open onboarding modal — it checks state and either auto-completes
    // (if already provisioned) or walks the user through create/deposit.
    setOnboardingOpen(true)
  }

  // Active duel takes over once a match is found.
  if (matched && managerId) {
    return (
      <ActiveDuel
        role={matched.role}
        tier={tier}
        managerId={managerId}
        wsOpen={wsOpen}
        send={send}
        onMessage={onMessage}
        onExit={() => {
          setMatched(null)
          setQueueSize(null)
        }}
      />
    )
  }

  return (
    <div className="flex h-full flex-col gap-5 px-4 py-4">
      <img
        src="/banners/pvp-banner.png"
        alt="pvp duel"
        className="mt-4 block aspect-video w-full object-cover [image-rendering:pixelated]"
      />
      <header className="flex items-center justify-center gap-3">
        <img
          src="/icons/swords.png"
          alt=""
          aria-hidden
          className="size-5 opacity-55 [image-rendering:pixelated]"
        />
        <h2 className="text-2xl tracking-[0.2em] text-white uppercase">duel</h2>
        <img
          src="/icons/swords.png"
          alt=""
          aria-hidden
          className="size-5 -scale-x-100 opacity-55 [image-rendering:pixelated]"
        />
      </header>
      <div className="flex flex-col gap-2">
        <div className="flex items-stretch gap-2">
          <StakeSelector
            value={stake}
            onChange={setStake}
            disabled={queueSize !== null}
          />
          <MatchButton
            className="flex-1"
            label={
              <span className="text-2xl">
                {queueSize !== null
                  ? `queueing (${queueSize})`
                  : "queue match"}
              </span>
            }
            onClick={onQueueMatch}
          />
        </div>
        <MatchButton
          label={<span className="text-2xl">game mode</span>}
          style={MODE_BRAND_STYLE}
          onClick={() => setModeOpen(true)}
        />
      </div>
      <p className="text-center text-[10px] tracking-[0.18em] text-white/45 uppercase">
        match starts when an opponent joins
      </p>
      <ModeModal open={modeOpen} onClose={() => setModeOpen(false)} />
      <OnboardingModal
        open={onboardingOpen}
        onClose={() => setOnboardingOpen(false)}
        onReady={(mgrId) => {
          setManagerId(mgrId)
          setOnboardingOpen(false)
          send({ type: "queue_join", tier })
        }}
      />
    </div>
  )
}

// StakeSelector and ChevronDown unchanged — keep the existing implementations
// from the previous version of this file (lines 129 onwards before this edit).
```

(Preserve the existing `StakeSelector` + `ChevronDown` components at the bottom — they don't change.)

- [ ] **Step 2: Type-check and dev-server-build**

Run: `bun --filter web typecheck`
Expected: passes (active-duel.tsx may complain about missing props — those are addressed in Task 8).

Run: `bun --filter web dev` in one terminal, then open http://localhost:5173.
Navigate to the PvP page, press "queue match" without being signed in → alert. Sign in via Enoki. Press queue match → onboarding modal opens.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/routes/game/pvp.tsx
git commit -m "feat(web): onboarding gate before queue_join in pvp.tsx"
```

---

## Task 8: Web — `active-duel.tsx` ENTRY + AWAIT_REVEAL

**Files:**
- Modify: `apps/web/src/routes/game/active-duel.tsx` (full rewrite of the placeholder)

This is the largest task. To keep it bite-sized, we build the state machine in two halves: the ENTRY + AWAIT_REVEAL phases here, then SWIPING + AWAIT_SETTLEMENT + COMPLETE in Task 9.

- [ ] **Step 1: Rewrite `active-duel.tsx` — ENTRY + AWAIT_REVEAL skeleton**

Overwrite `apps/web/src/routes/game/active-duel.tsx`:

```tsx
import { useEffect, useRef, useState } from "react"
import { useCurrentAccount, useSuiClient } from "@mysten/dapp-kit"
import type { ClientMsg, ServerMsg } from "@/lib/protocol"
import type { Unsubscribe } from "@/hooks/use-flicky-socket"
import {
  buildCreateDuelDusdcTx,
  buildJoinDuelDusdcTx,
} from "@/lib/flicky"
import { DEEPBOOK } from "@/lib/deepbook"
import { useFlickySign } from "@/lib/use-flicky-sign"
import { STAKE_TIERS, type Tier } from "@/lib/protocol"

interface Props {
  role: "creator" | "challenger"
  tier: Tier
  managerId: string
  wsOpen: boolean
  send: (msg: ClientMsg) => void
  onMessage: (handler: (msg: ServerMsg) => void) => Unsubscribe
  onExit: () => void
}

type Phase =
  | { kind: "ENTRY"; reason: string }
  | { kind: "AWAIT_REVEAL"; duelId: string }
  | { kind: "SWIPING"; duelId: string; cardIdx: number }
  | { kind: "AWAIT_SETTLEMENT"; duelId: string }
  | { kind: "COMPLETE"; duelId: string }
  | { kind: "ERROR"; message: string }

interface RoomState {
  duelId: string
  status: "PENDING" | "ACTIVE" | "COMPLETE"
  cardsRevealed: boolean
  cardCount: number
  settledCount: number
  cards: Array<{ oracle_id: string; strike: string }>
  p0Payout: string
  p0Premium: string
  p1Payout: string
  p1Premium: string
  startedAtMs: number
  creator: string
  challenger: string
  cardOutcomes: Array<{
    cardIdx: number
    settlementPrice: string
    strike: string
    upWon: boolean
    p0Pnl: string | null
    p1Pnl: string | null
    p0Swipe: { isUp: boolean; quantity: string; premium: string } | null
    p1Swipe: { isUp: boolean; quantity: string; premium: string } | null
  }>
  swipes: Array<{
    cardIdx: number
    p0Swipe: { isUp: boolean; quantity: string; premium: string } | null
    p1Swipe: { isUp: boolean; quantity: string; premium: string } | null
  }>
}

export function ActiveDuel({
  role,
  tier,
  managerId,
  wsOpen,
  send,
  onMessage,
  onExit,
}: Props) {
  const account = useCurrentAccount()
  const client = useSuiClient()
  const sign = useFlickySign()
  const [phase, setPhase] = useState<Phase>({
    kind: "ENTRY",
    reason: role === "creator" ? "Waiting for deck hash…" : "Waiting for opponent…",
  })
  const [roomState, setRoomState] = useState<RoomState | null>(null)
  // Refs so async callbacks see latest values without re-binding subscriptions.
  const phaseRef = useRef(phase)
  phaseRef.current = phase

  // Subscribe to server messages for the entire lifetime of the component.
  useEffect(() => {
    return onMessage(async (msg) => {
      if (msg.type === "room_state") {
        setRoomState(msg as RoomState)
        // Transition AWAIT_REVEAL → SWIPING when cards arrive.
        if (
          phaseRef.current.kind === "AWAIT_REVEAL" &&
          msg.cardsRevealed &&
          msg.cards.length === 5
        ) {
          setPhase({
            kind: "SWIPING",
            duelId: phaseRef.current.duelId,
            cardIdx: nextCardIdx(msg, account?.address),
          })
        }
        // Transition into AWAIT_SETTLEMENT once this player has swiped all 5.
        if (
          phaseRef.current.kind === "SWIPING" &&
          countMySwipes(msg, account?.address) === 5
        ) {
          setPhase({
            kind: "AWAIT_SETTLEMENT",
            duelId: phaseRef.current.duelId,
          })
        }
        // Transition to COMPLETE on status flip.
        if (msg.status === "COMPLETE") {
          setPhase((p) =>
            p.kind === "COMPLETE" || p.kind === "ENTRY"
              ? p
              : { kind: "COMPLETE", duelId: msg.duelId },
          )
        }
      }
      if (msg.type === "duel_assigned" && role === "challenger") {
        try {
          if (!account) throw new Error("wallet not connected")
          const tx = await buildJoinDuelDusdcTx(
            client,
            account.address,
            msg.duelId,
            STAKE_TIERS[tier],
            DEEPBOOK.dusdcType,
          )
          await sign.mutateAsync({ transaction: tx })
          send({ type: "room_subscribe", duelId: msg.duelId })
          setPhase({ kind: "AWAIT_REVEAL", duelId: msg.duelId })
        } catch (e) {
          setPhase({
            kind: "ERROR",
            message: e instanceof Error ? e.message : String(e),
          })
        }
      }
    })
  }, [onMessage, account, client, role, send, sign, tier])

  // Creator: kick off create_duel as soon as we're mounted + the WS is up.
  // The server includes deckHash in match_found; in this scaffold we pull
  // it from a prop on the match_found event we already consumed in pvp.tsx —
  // but to keep state colocated, we re-listen here.
  // NOTE: this assumes match_found carried `deckHash`. If the server doesn't
  // yet add that field, see Task 0 prerequisites — this plan assumes B0
  // (server includes deckHash in match_found) lands as part of the backend
  // batch alongside B1/B2.
  useEffect(() => {
    if (role !== "creator") return
    // Subscribe specifically for match_found (re-fires on F5 if the queue
    // server keeps it; otherwise an explicit "rehydrate" is needed).
    let cancelled = false
    const unsub = onMessage(async (msg) => {
      if (msg.type !== "match_found") return
      if (!("deckHash" in msg)) {
        setPhase({
          kind: "ERROR",
          message: "server didn't include deckHash in match_found",
        })
        return
      }
      try {
        if (!account) throw new Error("wallet not connected")
        const deckHashBytes = hexToBytes((msg as { deckHash: string }).deckHash)
        const tx = await buildCreateDuelDusdcTx(
          client,
          account.address,
          deckHashBytes,
          STAKE_TIERS[tier],
          DEEPBOOK.dusdcType,
        )
        const res = await sign.mutateAsync({ transaction: tx })
        if (cancelled) return
        const duelId = extractDuelIdFromChanges(
          (res as { objectChanges?: Array<{ type: string; objectType?: string; objectId?: string }> })
            .objectChanges ?? [],
        )
        if (!duelId) throw new Error("duelId not found in create_duel result")
        send({ type: "room_subscribe", duelId })
        setPhase({ kind: "AWAIT_REVEAL", duelId })
      } catch (e) {
        if (!cancelled)
          setPhase({
            kind: "ERROR",
            message: e instanceof Error ? e.message : String(e),
          })
      }
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [role, onMessage, account, client, send, sign, tier])

  return (
    <div className="flex h-full flex-col gap-4 px-4 py-4 text-white">
      <div className="flex items-center justify-between">
        <h2 className="text-xl tracking-[0.2em] uppercase">Active Match</h2>
        <button
          type="button"
          onClick={onExit}
          className="rounded border border-white/30 bg-white/5 px-3 py-1 text-sm hover:bg-white/10"
        >
          Exit
        </button>
      </div>
      <div className="text-xs text-white/55">
        role: {role} · tier: {tier} · ws: {wsOpen ? "open" : "closed"}
      </div>

      {phase.kind === "ENTRY" && <PhaseEntry reason={phase.reason} />}
      {phase.kind === "AWAIT_REVEAL" && (
        <PhaseAwaitReveal duelId={phase.duelId} roomState={roomState} />
      )}
      {/* SWIPING / AWAIT_SETTLEMENT / COMPLETE — added in Task 9 */}
      {phase.kind === "ERROR" && (
        <p className="text-sm text-red-400">{phase.message}</p>
      )}
    </div>
  )
}

function PhaseEntry({ reason }: { reason: string }) {
  return (
    <div className="rounded border border-white/10 bg-white/5 p-4">
      <p className="text-sm text-white/70">{reason}</p>
    </div>
  )
}

function PhaseAwaitReveal({
  duelId,
  roomState,
}: {
  duelId: string
  roomState: RoomState | null
}) {
  return (
    <div className="rounded border border-white/10 bg-white/5 p-4">
      <p className="text-sm text-white/70">Duel {duelId.slice(0, 10)}… revealing…</p>
      <p className="mt-1 text-xs text-white/40">
        status: {roomState?.status ?? "—"} · cards: {roomState?.cards.length ?? 0}/5
      </p>
    </div>
  )
}

function nextCardIdx(
  rs: RoomState,
  myAddress: string | undefined,
): number {
  if (!myAddress) return 0
  const isP0 = myAddress.toLowerCase() === rs.creator.toLowerCase()
  let n = 0
  for (const s of rs.swipes) {
    const my = isP0 ? s.p0Swipe : s.p1Swipe
    if (my) n = Math.max(n, s.cardIdx + 1)
  }
  return Math.min(n, 5)
}

function countMySwipes(
  rs: RoomState,
  myAddress: string | undefined,
): number {
  if (!myAddress) return 0
  const isP0 = myAddress.toLowerCase() === rs.creator.toLowerCase()
  let n = 0
  for (const s of rs.swipes) {
    const my = isP0 ? s.p0Swipe : s.p1Swipe
    if (my) n++
  }
  return n
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = parseInt(clean.substr(i * 2, 2), 16)
  return bytes
}

function extractDuelIdFromChanges(
  changes: Array<{ type: string; objectType?: string; objectId?: string }>,
): string | null {
  for (const c of changes) {
    if (c.type !== "created") continue
    if (!c.objectType || !c.objectType.includes("::duel::Duel<")) continue
    return c.objectId ?? null
  }
  return null
}
```

- [ ] **Step 2: Add `deckHash` to `match_found` in both protocol files**

This is a backend prereq the spec assumed under "match_found payload now carries `deckHash`."

Add to the `match_found` variant in both `apps/server/src/ws/protocol.ts` and `apps/web/src/lib/protocol.ts`:

```ts
| {
    type: "match_found"
    tier: Tier
    role: "creator" | "challenger"
    opponent: string
    /** Server pre-generates the deck at matchmaking and hands the
     *  creator the sha2_256 hash to use in create_duel. The plaintext
     *  stays server-side until reveal_deck lands. Always populated
     *  (empty string only for free-tier matches without a deck commit). */
    deckHash: string
  }
```

Then in `apps/server/src/ws/matchmaking.ts` (or wherever `match_found` is constructed — search `"match_found"`), generate the deck via Deckmaster at match-found time and include the hash:

```ts
// At the moment a pair is matched:
const deck = await deckmaster.generate(/* tier or default args */)
// deck.cards: DeckCard[]; deck.deckHashHex: string
broadcastToTwo(p0, p1, {
  type: "match_found",
  tier,
  role: /* creator|challenger per assignment */,
  opponent: /* other player's address */,
  deckHash: deck.deckHashHex,
})
```

(The exact Deckmaster API exists in `apps/server/src/deckmaster.ts`; mirror what the playground's deck-generation endpoint already does.)

- [ ] **Step 3: Type-check both halves**

Run: `bun --filter web typecheck && bun --filter server typecheck`
Expected: pass. Any test file in `apps/server` that constructs a `match_found` object will need `deckHash: ""` added; fix those.

- [ ] **Step 4: Manual smoke (without the swipe phase yet)**

Start: `bun --filter server dev` and `bun --filter web dev`.
Two browser windows. Both sign in. Both press queue match → onboarding modals complete → both queue. Match found. Creator's browser fires `create_duel` PTB. Challenger's browser fires `join_duel` PTB. Both transition to `AWAIT_REVEAL` showing the duel id.

Expected behavior at this point: server's keeper sees status ACTIVE and calls `reveal_deck`. Indexer pushes `room_state` with `cards: [...]` and `cardsRevealed: true`. Both clients flip to `SWIPING(0)` — but the swipe UI isn't built yet, so they'll show nothing past `AWAIT_REVEAL`. That's expected.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/game/active-duel.tsx apps/server/src/ws/protocol.ts apps/web/src/lib/protocol.ts apps/server/src/ws/matchmaking.ts
git commit -m "feat(web): active-duel ENTRY + AWAIT_REVEAL phases

Single state machine for both roles. Creator builds create_duel(stake,
deckHash) from match_found.deckHash; challenger builds join_duel from
duel_assigned. Both subscribe to room_state. Server now generates the
deck at matchmaking time and includes the hash in match_found."
```

---

## Task 9: Web — `active-duel.tsx` SWIPING + AWAIT_SETTLEMENT + COMPLETE

**Files:**
- Modify: `apps/web/src/routes/game/active-duel.tsx` (add three more phase components)

- [ ] **Step 1: Subscribe to oracle ticks + add SWIPING phase**

In `active-duel.tsx`, just before the return statement, add:

```ts
// Oracle ticks per oracle id, refreshed by oracle_tick events.
const [ticks, setTicks] = useState<
  Record<string, { spot: string; forward: string }>
>({})
useEffect(() => {
  return onMessage((msg) => {
    if (msg.type === "oracle_tick") {
      setTicks((prev) => ({
        ...prev,
        [msg.oracleId]: { spot: msg.spot, forward: msg.forward },
      }))
    }
  })
}, [onMessage])

// Oracle expiry per oracle (needed to build MarketKey for swipes + quotes).
// We fetch each unique oracle's `OracleSVI` once when cards arrive.
const [expiries, setExpiries] = useState<Record<string, bigint>>({})
useEffect(() => {
  if (!roomState || roomState.cards.length === 0) return
  const unique = Array.from(new Set(roomState.cards.map((c) => c.oracle_id)))
  ;(async () => {
    const next: Record<string, bigint> = {}
    for (const id of unique) {
      try {
        const info = await fetchOracleSvi(client, id)
        next[id] = info.expiry
      } catch {
        // surface lazily; swipes that need it will error
      }
    }
    setExpiries((prev) => ({ ...prev, ...next }))
    // Subscribe to oracle ticks for live PnL.
    send({ type: "oracle_subscribe", oracleIds: unique })
  })()
}, [roomState?.cards, client, send])
```

Add the import at the top of the file:

```ts
import { fetchOracleSvi } from "@/lib/flicky"
import { quoteSwipePremium, buildStakedSwipeTx } from "@/lib/deepbook"
import { liveCardPnl, runningPnl, fmtDusdcSigned } from "@/lib/pnl"
import { SWIPE_QUANTITY } from "@/components/onboarding-modal"
```

Add the SWIPING phase component below `PhaseAwaitReveal`:

```tsx
function PhaseSwiping({
  duelId,
  cardIdx,
  roomState,
  managerId,
  expiries,
  ticks,
  myAddress,
  sign,
  onSwipeDone,
}: {
  duelId: string
  cardIdx: number
  roomState: RoomState
  managerId: string
  expiries: Record<string, bigint>
  ticks: Record<string, { spot: string; forward: string }>
  myAddress: string
  sign: ReturnType<typeof useFlickySign>
  onSwipeDone: () => void
}) {
  const card = roomState.cards[cardIdx]
  const expiry = card ? expiries[card.oracle_id] : undefined
  const [quoteUp, setQuoteUp] = useState<{ premium: bigint; pUp: bigint } | null>(null)
  const [quoteDown, setQuoteDown] = useState<{ premium: bigint; pUp: bigint } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const client = useSuiClient()

  useEffect(() => {
    if (!card || !expiry) return
    let cancelled = false
    ;(async () => {
      try {
        const [up, down] = await Promise.all([
          quoteSwipePremium(client, {
            oracleSviId: card.oracle_id,
            oracleExpiry: expiry,
            strike: BigInt(card.strike),
            isUp: true,
            quantity: SWIPE_QUANTITY,
          }),
          quoteSwipePremium(client, {
            oracleSviId: card.oracle_id,
            oracleExpiry: expiry,
            strike: BigInt(card.strike),
            isUp: false,
            quantity: SWIPE_QUANTITY,
          }),
        ])
        if (cancelled) return
        setQuoteUp(up)
        setQuoteDown(down)
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [card?.oracle_id, card?.strike, expiry, client])

  if (!card || !expiry) {
    return <p className="text-sm text-white/55">Loading card {cardIdx}…</p>
  }

  const tick = ticks[card.oracle_id]
  const myIsP0 = myAddress.toLowerCase() === roomState.creator.toLowerCase()
  const myRunning = runningPnl(roomState, myIsP0 ? "p0" : "p1", { cards: roomState.cards }, ticks)
  const oppRunning = runningPnl(roomState, myIsP0 ? "p1" : "p0", { cards: roomState.cards }, ticks)

  const doSwipe = async (isUp: boolean) => {
    setBusy(true)
    setError(null)
    try {
      const tx = buildStakedSwipeTx({
        duelId,
        oracleSviId: card.oracle_id,
        managerId,
        oracleExpiry: expiry,
        strike: BigInt(card.strike),
        isUp,
        quantity: SWIPE_QUANTITY,
        cardIdx,
      })
      await sign.mutateAsync({ transaction: tx })
      onSwipeDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded border-2 border-black/55 bg-[#1b2548] p-4">
        <p className="text-xs tracking-[0.2em] text-white/55 uppercase">
          card {cardIdx + 1} / 5
        </p>
        <p className="mt-1 text-2xl font-bold">strike {card.strike}</p>
        <p className="text-sm text-white/70">
          spot {tick?.spot ?? "—"} · forward {tick?.forward ?? "—"}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          disabled={busy || quoteUp === null}
          onClick={() => doSwipe(true)}
          className="rounded-md bg-emerald-600 px-4 py-3 font-bold text-white disabled:opacity-40"
        >
          <div>UP</div>
          <div className="text-xs opacity-80">
            cost {quoteUp ? fmtDusdcSigned(-quoteUp.premium) : "…"}
          </div>
          <div className="text-xs opacity-60">
            p {quoteUp ? `${(Number(quoteUp.pUp) / 1e7).toFixed(1)}%` : "…"}
          </div>
        </button>
        <button
          type="button"
          disabled={busy || quoteDown === null}
          onClick={() => doSwipe(false)}
          className="rounded-md bg-rose-600 px-4 py-3 font-bold text-white disabled:opacity-40"
        >
          <div>DOWN</div>
          <div className="text-xs opacity-80">
            cost {quoteDown ? fmtDusdcSigned(-quoteDown.premium) : "…"}
          </div>
          <div className="text-xs opacity-60">
            p {quoteDown ? `${(Number(quoteDown.pUp) / 1e7).toFixed(1)}%` : "…"}
          </div>
        </button>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <CardLedger roomState={roomState} myIsP0={myIsP0} ticks={ticks} />

      <div className="rounded border border-white/10 bg-white/5 p-3 text-sm">
        <div>you: {fmtDusdcSigned(myRunning)}</div>
        <div>opponent: {fmtDusdcSigned(oppRunning)}</div>
      </div>
    </div>
  )
}

/**
 * Per-card running ledger. Settled cards show frozen binary PnL from
 * cardOutcomes; unsettled-but-swiped show live mark-to-market.
 */
function CardLedger({
  roomState,
  myIsP0,
  ticks,
}: {
  roomState: RoomState
  myIsP0: boolean
  ticks: Record<string, { spot: string; forward: string }>
}) {
  const settledByIdx = new Map(
    roomState.cardOutcomes.map((o) => [o.cardIdx, o]),
  )
  return (
    <div className="rounded border border-white/10 bg-white/5 text-xs">
      {roomState.cards.map((card, i) => {
        const settled = settledByIdx.get(i)
        const swipeSlot = roomState.swipes.find((s) => s.cardIdx === i)
        const mySwipe = swipeSlot
          ? myIsP0
            ? swipeSlot.p0Swipe
            : swipeSlot.p1Swipe
          : null
        let pnlLabel = "—"
        if (settled) {
          const pnl = myIsP0 ? settled.p0Pnl : settled.p1Pnl
          pnlLabel =
            pnl !== null
              ? `${fmtDusdcSigned(BigInt(pnl))} (settled)`
              : "skipped"
        } else if (mySwipe) {
          const live = liveCardPnl(mySwipe, card.strike, ticks[card.oracle_id]?.forward)
          pnlLabel =
            live !== null ? `${fmtDusdcSigned(live)} (live)` : "ticking…"
        }
        return (
          <div
            key={i}
            className="flex items-center justify-between border-b border-white/5 px-3 py-1 last:border-b-0"
          >
            <span>card {i + 1}</span>
            <span>{pnlLabel}</span>
          </div>
        )
      })}
    </div>
  )
}
```

In the main return JSX, replace the SWIPING-phase placeholder with:

```tsx
{phase.kind === "SWIPING" && roomState && account && (
  <PhaseSwiping
    duelId={phase.duelId}
    cardIdx={phase.cardIdx}
    roomState={roomState}
    managerId={managerId}
    expiries={expiries}
    ticks={ticks}
    myAddress={account.address}
    sign={sign}
    onSwipeDone={() => {
      // Advance card index optimistically; room_state reconciles.
      setPhase((p) =>
        p.kind === "SWIPING"
          ? { kind: "SWIPING", duelId: p.duelId, cardIdx: p.cardIdx + 1 }
          : p,
      )
    }}
  />
)}
{phase.kind === "AWAIT_SETTLEMENT" && roomState && account && (
  <PhaseAwaitSettlement
    roomState={roomState}
    myAddress={account.address}
    ticks={ticks}
  />
)}
{phase.kind === "COMPLETE" && roomState && account && (
  <PhaseComplete roomState={roomState} myAddress={account.address} />
)}
```

- [ ] **Step 2: Add `PhaseAwaitSettlement` + `PhaseComplete`**

Below `CardLedger` in the same file:

```tsx
function PhaseAwaitSettlement({
  roomState,
  myAddress,
  ticks,
}: {
  roomState: RoomState
  myAddress: string
  ticks: Record<string, { spot: string; forward: string }>
}) {
  const myIsP0 = myAddress.toLowerCase() === roomState.creator.toLowerCase()
  const myRunning = runningPnl(roomState, myIsP0 ? "p0" : "p1", { cards: roomState.cards }, ticks)
  const oppRunning = runningPnl(roomState, myIsP0 ? "p1" : "p0", { cards: roomState.cards }, ticks)
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded border border-white/10 bg-white/5 p-3 text-sm">
        <p className="text-white/70">
          all swipes locked · {roomState.settledCount} / 5 cards settled
        </p>
        {roomState.settledCount === 5 && (
          <p className="mt-1 text-white/50">awaiting finalize tx…</p>
        )}
      </div>
      <CardLedger roomState={roomState} myIsP0={myIsP0} ticks={ticks} />
      <div className="rounded border border-white/10 bg-white/5 p-3 text-sm">
        <div>you: {fmtDusdcSigned(myRunning)}</div>
        <div>opponent: {fmtDusdcSigned(oppRunning)}</div>
      </div>
    </div>
  )
}

function PhaseComplete({
  roomState,
  myAddress,
}: {
  roomState: RoomState
  myAddress: string
}) {
  const myIsP0 = myAddress.toLowerCase() === roomState.creator.toLowerCase()
  const myNet =
    BigInt(myIsP0 ? roomState.p0Payout : roomState.p1Payout) -
    BigInt(myIsP0 ? roomState.p0Premium : roomState.p1Premium)
  const oppNet =
    BigInt(myIsP0 ? roomState.p1Payout : roomState.p0Payout) -
    BigInt(myIsP0 ? roomState.p1Premium : roomState.p0Premium)
  const youWon = myNet > oppNet
  const tied = myNet === oppNet
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded border-2 border-black/55 bg-[#1b2548] p-4">
        <h3 className="text-2xl tracking-[0.2em] uppercase">
          {tied ? "Tie" : youWon ? "Victory" : "Defeat"}
        </h3>
        <p className="mt-1 text-sm text-white/70">
          you {fmtDusdcSigned(myNet)} · opponent {fmtDusdcSigned(oppNet)}
        </p>
      </div>
      <CardLedger roomState={roomState} myIsP0={myIsP0} ticks={{}} />
    </div>
  )
}
```

- [ ] **Step 3: Type-check**

Run: `bun --filter web typecheck`
Expected: pass.

- [ ] **Step 4: Manual smoke**

Same setup as Task 8 step 4. This time the full flow should work:
- Match found, both sign create / join.
- AWAIT_REVEAL.
- Server keeper reveals → room_state.cards populated → both clients flip to SWIPING(0).
- UP/DOWN buttons show estimated swipe cost + implied probability.
- Click a button → buildStakedSwipeTx → sponsored sign → execute. cardIdx advances.
- After 5 swipes by each player, AWAIT_SETTLEMENT. settledCount climbs 0→5 as oracles settle.
- Once keeper finalizes, COMPLETE screen renders with winner.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/game/active-duel.tsx
git commit -m "feat(web): active-duel SWIPING + settlement + results

Per-card UP/DOWN buttons show quoted swipe cost. Mixed PnL display:
settled cards frozen at binary PnL from cardOutcomes, unsettled swiped
cards mark-to-market from oracle_tick. Running net + per-card ledger
update on every WS message."
```

---

## Task 10: Smoke verification — full two-window E2E

**Files:** none (verification only)

- [ ] **Step 1: Start everything**

In separate terminals:
```bash
bun --filter server dev
bun --filter web dev
```

- [ ] **Step 2: Open two browser windows**

http://localhost:5173 in each. Sign in with two different Enoki / Google accounts. Both navigate to PvP page.

- [ ] **Step 3: Onboarding gate**

Window A: stake = 3 dUSDC, press queue match. Onboarding modal appears (assuming no existing manager). Walk through Create Manager → Deposit 5 dUSDC. Confirm queue starts.

Repeat in Window B.

- [ ] **Step 4: Match found**

Verify match_found fires in both. Verify creator's wallet confirm dialog for `create_duel` shows ONLY a 32-byte hash for the deck arg — NO card content (no oracle ids or strikes visible). This validates the no-headstart property.

- [ ] **Step 5: Reveal**

After both sign create/join, server keeper reveals. Both clients flip to SWIPING(0). Verify both see the same first card at the same instant (within a second).

- [ ] **Step 6: Swipe**

Each player swipes UP/DOWN through all 5 cards. Watch that:
- swipe cost on each button updates per card.
- live mark-to-market PnL ticks under each unsettled card.
- after each swipe, card ledger row updates.

- [ ] **Step 7: Per-card settlement (the headline B1 behavior)**

After all 10 swipes (5 per player), wait for oracles to settle. As each oracle settles, that card's row should flip from `(live)` to `(settled)` with a frozen PnL value. Other unsettled cards keep ticking. Verify `settledCount` in the UI grows 0→1→2→3→4→5 BEFORE the duel status flips to COMPLETE.

- [ ] **Step 8: Finalize**

Once all 5 settle, keeper fires `finalize_multi`. Status flips to COMPLETE. Results screen shows winner. Verify the running total just before finalize matches the COMPLETE result (within drift atoms from rounding).

- [ ] **Step 9: F5 mid-duel test**

Restart a swipe-phase duel in one window: hit F5 mid-swipe. UI rehydrates from `room_state.swipes` — the swiped cards remain marked as swiped, cardIdx resumes at the next slot, no double-swipe is possible.

- [ ] **Step 10: Commit a verification note**

```bash
echo "PvP E2E flow verified $(date +%Y-%m-%d) — all 10 verification steps pass." >> docs/superpowers/plans/2026-05-27-pvp-e2e-integration.md
git add docs/superpowers/plans/2026-05-27-pvp-e2e-integration.md
git commit -m "chore: log PvP E2E verification pass"
```

---

## Out of scope for this plan

The following are explicitly deferred (per spec):

- Practice tier UI (separate spec).
- Client-side finalize fallback if keeper lags.
- Forfeit grace timer UI logic (peer_left displays a banner but doesn't drive any action).
- Refund button for stuck duels (`refund_duel` exists in the contract; not surfaced).
- Configurable `SWIPE_QUANTITY` per card.
- Reclaim-stuck-stake UI.
- 10-minute swipe-window countdown UI (`SWIPE_WINDOW_MS` is enforced by the contract; UI doesn't need a visible timer for v1 — players have plenty of time).
- Reveal-timeout backstop (`REVEAL_TIMEOUT_MS` = 5 min; keeper reveals in ~seconds, the 5-min ceiling exists only as a forfeit window the UI doesn't need to surface).

## Assumptions this plan relies on (verify before starting)

- `apps/server/src/keeper.ts` already calls `reveal_deck` after `join_duel` lands (confirmed in pre-plan review at line 228). No keeper changes are part of this plan.
- `apps/server/src/keeper.ts` already calls `finalize_multi` once both players are 5/5 and all oracles are settled (confirmed at line 310). No keeper changes.
- `apps/web/src/lib/config.ts` `packageId` has been bumped to `0x4ab5...` in your working tree (done earlier in this session, currently uncommitted alongside other in-progress edits). If you're starting this plan from a clean checkout, run **one preparatory commit** first:

  ```bash
  # Only the packageId-line change, not the other in-progress files.
  git add -p apps/web/src/lib/config.ts  # accept only the packageId hunk
  git commit -m "chore(web): bump packageId to current testnet deploy"
  ```

- `predict::get_trade_amounts` is exposed via the deepbook_predict codegen. If `predictGen.getTradeAmounts` isn't generated, Task 4 step 1 includes the fallback `tx.moveCall` form.

These can each be follow-up plans built on the foundation this plan establishes.
