# PR #22 Follow-ups — Demo-Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the four agreed PR #22 follow-ups so one clean, recordable 5-card duel runs end-to-end on the 6-24 (predict) migration before Demo Day (2026-07-18).

**Architecture:** Four ordered, independently-verifiable changes. Task 1 is env-only (restart server). Task 2 raises swipe quantity across web + probe and flips the probe to require both directions. Task 3 halves the on-chain swipe window (contract republish + web mirror + tests). Task 4 makes the queue funding gate tier-aware. Tasks 1+2 are the demo-critical pair; do all four in order — each is verifiable with a live duel.

**Tech Stack:** Bun workspaces + Turborepo; `apps/web` (Vite/React 19/Tailwind v4), `apps/server` (Bun runtime), `apps/contracts` (Sui Move), `bun:test`.

## Global Constraints

- Package manager: `bun` (≥ 1.3) only — never npm/pnpm/yarn. `packageManager: bun@1.3.9`.
- Prettier: no semicolons, double quotes, 2-space, trailing comma `es5`, print width 80. **Scope formatting with `bunx prettier --write <files>`** — `bun format` reformats the whole repo (large prettier drift).
- TypeScript `strict: true`; `moduleResolution: bundler`, `target: ES2022`.
- dUSDC amounts are `bigint`, 6 decimals (`3_000_000n` = 3 dUSDC).
- `bun --hot` reloads code, **not** env — any `.env.local` change requires a manual `bun --filter server dev` restart.
- Demo runs on `standard` (5 dUSDC) tier or above — **never** `starter`. Do not touch the protocol `min_net_premium` floor.
- **Do NOT work on** (explicitly deferred): $1/swipe premium floor, M2 WS reconnect churn, K2 duplicate cards, M3 bot fallback.
- Final gate before pushing: `bun typecheck` (5/5), `bun --filter server test`, `bun --filter web test` — all green.
- Source of decisions: `temp/docs/pr22-followup-task.md`. Report backlog: `docs/report/2026-07-11-predict-6-24-update.md` §8.

---

## File Structure

| File | Task | Responsibility / change |
|---|---|---|
| `apps/server/.env.local` | 1 | Add `DECK_CARD_MIN_HEADROOM_MS=1800000`; remove stale contradictory comment |
| `apps/server/src/deckmaster.ts` | 1 (opt), 2 (opt) | `findDeckMarkets` soft fallback (optional); `ZONE_TARGET_PROB.edge` 0.65→0.63 (optional) |
| `apps/web/src/components/onboarding-modal.tsx` | 2, 4 | `SWIPE_QUANTITY` 2→3 dUSDC; deposit-guidance copy |
| `apps/web/src/routes/game/active-duel.tsx` | 2 | Auto-scaling consumers (no logic edit; verify + doc-comments) |
| `apps/server/src/mint-probe.ts` | 2 | `PROBE_QTY` 2→3 dUSDC; `buildProbedDeck` probe BOTH directions |
| `apps/contracts/sources/duel.move` | 3 | `SWIPE_WINDOW_MS` 600_000→300_000 |
| `apps/contracts/scripts/publish.ts` + `deployed.json` | 3 | Republish package, update deployed ids |
| `apps/web/src/lib/swipe-window.ts` | 3 | Mirror `SWIPE_WINDOW_MS` = 300_000 |
| `apps/web/src/lib/swipe-window.test.ts` | 3 | Update fixtures for 5-min window |
| `apps/web/src/App.tsx` | 3 | Fix stale "10-min" comment at :1580 |
| `apps/server/src/predict.ts` | 4 | `requiredQueueBalance(tier)` helper; keep `MIN_BALANCE_FOR_QUEUE` as floor |
| `apps/server/src/predict.test.ts` (new or existing) | 4 | Unit-test `requiredQueueBalance` |
| `apps/server/src/ws/handlers.ts` | 4 | Pass tier-derived required amount into the gate + error copy |

---

## Task 1: Stable market band (env-only)

**Solves:** M1 find-match loops, K3, most of S2/S3. Effort ~1 min + restart.

**Root cause:** `filterMintableMarkets` (mint-probe.ts) dry-runs a mint per candidate market. With only 1–2 live short markets, both can dip below LP backing at the same instant → probe returns zero → deck-gen fails → "trouble setting up the match" loop. The 30 min–3 h band (~84-min and ~144-min BTC markets) is the stable supply. `selectMarketRows` (deckmaster.ts:99) already filters to `[now + minHeadroomMs, now + maxHorizonMs]`; only the env default (`DECK_CARD_MIN_HEADROOM_MS`, env.ts:117, default `10*60*1000`) is wrong for 6-24.

**Files:**
- Modify: `apps/server/.env.local`

**Interfaces:**
- Consumes: `env.deckCardMinHeadroomMs` (env.ts:116-118, reads `process.env.DECK_CARD_MIN_HEADROOM_MS`), `env.deckCardMaxHorizonMs` (env.ts:125-126, default 3h — leave it).
- Produces: nothing new; just raises the deck-gen headroom floor to 30 min.

- [ ] **Step 1: Read the current env block**

Read `apps/server/.env.local`. Note the stale comment near the bottom:
```
# headroom excluded them all. Lower it so short markets qualify for the deck.
```
This comment predates the decision and now contradicts it (we are *raising* headroom). It will be replaced.

- [ ] **Step 2: Edit `.env.local`**

Replace the stale comment line with the new setting. The block should read:

```bash
# Deck-gen only draws from the stable 30 min–3 h market band. Short (<15 min)
# BTC markets flicker LP backing within seconds → deck-gen fails → "trouble
# setting up the match" loop. 30-min floor keeps decks on well-backed markets.
DECK_CARD_MIN_HEADROOM_MS=1800000   # 30 min (default 600000 = 10 min)
# DECK_CARD_MAX_HORIZON_MS stays at default 3h
```

- [ ] **Step 3: Restart the server (env is not hot-reloaded)**

Run: `bun --filter server dev`
Expected: server boots; at deck-gen the selected markets' expiries are ≥ 30 min out.

- [ ] **Step 4: Live-verify the loop is gone**

- Queue two clients ~5 times in a row → no "trouble setting up" loop.
- Server log `mint probe: kept N/M` → `N === M` almost always (stable markets rarely dip).
- Deck-gen log shows selected market expiries ≥ 30 min out.

- [ ] **Step 5: Commit**

```bash
git add apps/server/.env.local
git commit -m "feat(6-24): deck-gen draws only from stable 30min-3h market band"
```

**Optional (only if time) — soft fallback:** in `findDeckMarkets` (deckmaster.ts:136), if the 30 min–3 h band returns empty at some instant, fall back to the widest available future-dated band instead of returning `[]`. The hard env floor is enough to record on; skip unless the live run shows intermittent empties.

---

## Task 2: `SWIPE_QUANTITY` 2 → 3 dUSDC + both-direction probe

**Solves:** S1 long-shot abort (offset-strike long-shot side aborts on-chain at qty=2). Effort ~30 min.

**Root cause:** premium = `p × quantity` must clear the protocol `min_net_premium` ($1) per side. At qty=2 the long-shot side (`p < 0.5`) aborts (`assert_mint_admission`, code 4). At qty=3 the both-sides-mintable band widens to `p ∈ [0.334, 0.666]`, covering all `ZONE_TARGET_PROB` values (close 0.56, mid 0.61, edge 0.65 → long-shot premiums $1.32 / $1.17 / $1.05, all ≥ $1).

**Decision:** raise quantity; do NOT dim/disable the long-shot button. Web `SWIPE_QUANTITY` and server `PROBE_QTY` **must** move together or the probe validates wrong economics.

**Files:**
- Modify: `apps/web/src/components/onboarding-modal.tsx:49`
- Modify: `apps/server/src/mint-probe.ts:48` (`PROBE_QTY`) and `:256-295` (`buildProbedDeck`)
- Verify (no logic edit): `apps/web/src/routes/game/active-duel.tsx:48,680`
- Modify (optional): `apps/server/src/deckmaster.ts:406-410` (`ZONE_TARGET_PROB.edge`)

**Interfaces:**
- Consumes: `SWIPE_QUANTITY` (web, onboarding-modal.tsx:49) is imported by `active-duel.tsx:34`; `MIN_ACCOUNT_PER_SWIPE = (SWIPE_QUANTITY * 7n) / 10n` (active-duel.tsx:48) and the swipe PTB `quantity: SWIPE_QUANTITY` (active-duel.tsx:680) auto-scale.
- Produces: web-side per-swipe quantity = server-side probe quantity = `3_000_000n`. `buildProbedDeck` now guarantees both YES and NO are mintable per card (ATM fallback only if either side fails).

- [ ] **Step 1: Raise `SWIPE_QUANTITY` (web)**

Edit `apps/web/src/components/onboarding-modal.tsx:49`:

```ts
export const SWIPE_QUANTITY = 3_000_000n // was 2_000_000n
```

Update the stale "2 dUSDC / practical minimum" doc-comments around the constant (lines ~50-60) to say 3 dUSDC.

- [ ] **Step 2: Raise `PROBE_QTY` (server) — MUST match Step 1**

Edit `apps/server/src/mint-probe.ts:48`:

```ts
const PROBE_QTY = 3_000_000n // was 2_000_000n — MUST match web SWIPE_QUANTITY
```

- [ ] **Step 3: Flip `buildProbedDeck` to require BOTH directions**

In `apps/server/src/mint-probe.ts` `buildProbedDeck` (currently favored-only, lines 271-292), replace the single-direction probe with a both-directions probe. New body of the `cards.map` callback:

```ts
      const market = markets[i % markets.length]
      const strikeTick = card.strike / market.tickSize
      // At qty=3 + Task 1's 30min-3h markets, BOTH sides clear the
      // min_net_premium floor at placement — so require YES *and* NO to be
      // mintable and only fall back to ATM if EITHER fails. (Old favored-only
      // rule existed because at qty=2 the long-shot could never clear the
      // floor with any offset; that constraint is gone.) This is the line
      // that keeps both swipe directions playable.
      const [upMints, downMints] = await Promise.all([
        mintProbeSucceeds(market, strikeTick, true, id.sender, id.wrapperId),
        mintProbeSucceeds(market, strikeTick, false, id.sender, id.wrapperId),
      ])
      if (upMints && downMints) return card
      log.info(
        `card ${i} (${market.expiryMarketId.slice(0, 10)}) not mintable both ways (up=${upMints} down=${downMints}) — ATM fallback`
      )
      return atmCard(card, market, spot)
```

Also update the function's doc-comment (lines 240-254): it already says "mintable in BOTH directions" — reconcile any lingering favored-only phrasing so the comment matches the new behavior.

- [ ] **Step 4: (Optional) widen the edge-zone margin**

Edit `apps/server/src/deckmaster.ts:409`:

```ts
  edge: 0.63, // was 0.65 — raises long-shot floor clearance $1.05 → $1.11
```

Recommended (more headroom vs. time-decay late in the match) but not required.

- [ ] **Step 5: Typecheck**

Run: `bun typecheck`
Expected: all workspaces pass (5/5).

- [ ] **Step 6: Live-verify both directions mint**

Live duel on an `svi_quote` deck (`.env.local` `DECK_STRIKE_MODE=svi_quote` is already set). Swipe the **long-shot** (lower-%) side on at least 2 cards early in the match → both mint, no code-4 aborts. Confirm the swipe stake label and `MIN_ACCOUNT_PER_SWIPE` UI reflect 3 dUSDC (active-duel.tsx auto-scaled).

- [ ] **Step 7: Format + commit**

```bash
bunx prettier --write apps/web/src/components/onboarding-modal.tsx apps/server/src/mint-probe.ts apps/server/src/deckmaster.ts
git add apps/web/src/components/onboarding-modal.tsx apps/server/src/mint-probe.ts apps/server/src/deckmaster.ts
git commit -m "feat(6-24): SWIPE_QUANTITY 2->3 dUSDC; probe both swipe directions"
```

**Accepted cost:** a 5-card duel now draws ~$7.5–9 in premiums (was ~$5–6). Fine on `standard`/`high_roller`; `starter` stays off the demo table.

---

## Task 3: Swipe window 10 → 5 min (contract republish)

**Solves:** pacing; halves the window in which a card's market can expire (S2) or backing can flip (S3); halves time-decay drift (protects Task 2's long-shot margin). Effort ~1–2 h. **Does NOT** justify lowering Task 1's headroom.

**Files:**
- Modify: `apps/contracts/sources/duel.move:99`
- Run + modify: `apps/contracts/scripts/publish.ts` → updates `apps/contracts/deployed.json`
- Modify: `apps/web/src/lib/swipe-window.ts:4`
- Modify: `apps/web/src/lib/swipe-window.test.ts`
- Modify: `apps/web/src/App.tsx:1580` (comment only)

**Interfaces:**
- Consumes: `SWIPE_WINDOW_MS` enforced in Move at `record_swipe` (duel.move:450) and forfeit logic (duel.move:699). `REFUND_TIMEOUT_MS` (duel.move:100, 3_600_000) and `REVEAL_TIMEOUT_MS` (duel.move:101, 300_000) are **separate** — leave them.
- Produces: on-chain window = web mirror = `300_000`. New package id in `deployed.json`; `FLICKY_PACKAGE_ID` env stays unset so it falls back to `deployed.json`.

- [ ] **Step 1: Halve the contract constant**

Edit `apps/contracts/sources/duel.move:99`:

```move
const SWIPE_WINDOW_MS: u64 = 300_000; // 5 minutes (was 600_000)
```

Confirm `REFUND_TIMEOUT_MS` (line 100) and `REVEAL_TIMEOUT_MS` (line 101) are untouched.

- [ ] **Step 2: Update the web mirror**

Edit `apps/web/src/lib/swipe-window.ts:4`:

```ts
export const SWIPE_WINDOW_MS = 300_000
```

Update the doc-comment above it if it names "10 minutes".

- [ ] **Step 3: Update the failing test fixtures**

Edit `apps/web/src/lib/swipe-window.test.ts` — the whole file, so each fixture reflects a 300_000 window:

```ts
import { expect, test } from "bun:test"
import { SWIPE_WINDOW_MS, swipeWindowRemainingMs } from "./swipe-window"

test("SWIPE_WINDOW_MS matches the contract's 5-minute window", () => {
  expect(SWIPE_WINDOW_MS).toBe(300_000)
})

test("full window remaining at start with no clock skew", () => {
  expect(
    swipeWindowRemainingMs({ startedAtMs: 0, serverClockOffsetMs: 0, nowMs: 0 }),
  ).toBe(300_000)
})

test("counts down as wall-clock advances", () => {
  expect(
    swipeWindowRemainingMs({
      startedAtMs: 0,
      serverClockOffsetMs: 0,
      nowMs: 150_000,
    }),
  ).toBe(150_000)
})

test("goes negative once the window has elapsed", () => {
  expect(
    swipeWindowRemainingMs({
      startedAtMs: 0,
      serverClockOffsetMs: 0,
      nowMs: 300_001,
    }),
  ).toBe(-1)
})

test("server offset corrects a fast client clock", () => {
  // Client clock reads 10_000 but the server is 4s behind it (offset -4000),
  // so the true elapsed time is 6_000 → 294_000 remaining.
  expect(
    swipeWindowRemainingMs({
      startedAtMs: 0,
      serverClockOffsetMs: -4_000,
      nowMs: 10_000,
    }),
  ).toBe(294_000)
})
```

- [ ] **Step 4: Run the web tests**

Run: `bun --filter web test`
Expected: all `swipe-window.test.ts` cases PASS (green).

- [ ] **Step 5: Fix the stale App.tsx comment**

Edit `apps/web/src/App.tsx:1580`: change "single 10-min `SWIPE_WINDOW_MS`" → "single 5-min `SWIPE_WINDOW_MS`".

> Note: `SWIPE_PHASE_MS = 60_000` (App.tsx:176) is the **per-card** pacing bar and is *independent* of `SWIPE_WINDOW_MS`. 5 cards × 60s already fits a 5-min window, so leave `SWIPE_PHASE_MS` alone. The per-card countdown bar stays 60s (the demo doc's "countdown bar starts at 5:00" describes the on-chain window, not the UI bar).

- [ ] **Step 6: Republish the package**

Run the publish dance (same as the 2026-07-09 publish, with the transitive-dep-closure fix): `apps/contracts/scripts/publish.ts`, which updates `apps/contracts/deployed.json`. Old testnet duels are orphaned — fine. Leave `FLICKY_PACKAGE_ID` unset in `.env.local` so it falls back to `deployed.json` (report §6.6 gotcha). Restart the server after `deployed.json` changes.

- [ ] **Step 7: Live-verify a full 5-card duel inside 5 min**

New duel → complete a full 5-card duel; deck locks at zero when the on-chain window elapses; the forfeit path (duel.move:699) still covers a slow opponent. Pacing is snug (~50 s/card incl. sponsored PTB round-trip) but playable.

- [ ] **Step 8: Commit**

```bash
bunx prettier --write apps/web/src/lib/swipe-window.ts apps/web/src/lib/swipe-window.test.ts
git add apps/contracts/sources/duel.move apps/contracts/deployed.json apps/web/src/lib/swipe-window.ts apps/web/src/lib/swipe-window.test.ts apps/web/src/App.tsx
git commit -m "feat(6-24): swipe window 10->5 min; republish package"
```

---

## Task 4: Queue funding gate scales with the new cost

**Solves:** S4 account-drain mid-game. Effort ~15 min.

**Root cause:** the account funds stake + every premium from one pool. The gate is a flat `MIN_BALANCE_FOR_QUEUE = 5_000_000n` (predict.ts:67), checked in `checkQueueBalanceGate` (predict.ts:214) from the `queue_join` handler (handlers.ts:73-139). After Task 2 a 5-card duel draws ~$15 in premiums *plus* the stake, so a gate-passing player can still drain mid-game (`account::withdraw_balance` abort, code 1).

**Decision:** make the gate tier-aware — `required = tierStake + maxDeckSize × SWIPE_QUANTITY`. With `maxDeckSize = 5` and swipe quantity `3_000_000n`, the premium budget is `15_000_000n`. Deck size isn't known at queue time, so use the max (5). Keep the web pre-swipe balance check + top-up prompt as the in-match backstop.

**Files:**
- Modify: `apps/server/src/predict.ts` — add `requiredQueueBalance(tier)`, keep `MIN_BALANCE_FOR_QUEUE` as an absolute floor; extend `checkQueueBalanceGate` to accept a required amount.
- Test: `apps/server/src/predict.test.ts` (create if absent).
- Modify: `apps/server/src/ws/handlers.ts` — compute required from `msg.tier`, pass it in, update the error copy.
- Modify: `apps/web/src/components/onboarding-modal.tsx` — deposit-guidance copy.

**Interfaces:**
- Consumes: `STAKE_TIERS` (ws/protocol.ts:14-20 — practice 0, casual 3M, standard 5M, high_roller 10M, starter 1M), `Tier` type (protocol.ts:22). Swipe quantity `3_000_000n` (from Task 2).
- Produces: `requiredQueueBalance(tier: Tier): bigint` returning `STAKE_TIERS[tier] + MAX_DECK_SIZE * SWIPE_QUANTITY_MIST`, floored at `MIN_BALANCE_FOR_QUEUE`. `checkQueueBalanceGate(client, owner, required)` compares balance against `required`.

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/predict.test.ts`:

```ts
import { expect, test } from "bun:test"
import { requiredQueueBalance } from "./predict"

// required = tierStake + 5 cards × 3 dUSDC premium budget (15 dUSDC),
// floored at the absolute 5 dUSDC minimum.
test("standard tier: stake 5 + 15 premium budget", () => {
  expect(requiredQueueBalance("standard")).toBe(20_000_000n)
})

test("high_roller tier: stake 10 + 15 premium budget", () => {
  expect(requiredQueueBalance("high_roller")).toBe(25_000_000n)
})

test("starter tier: stake 1 + 15 premium budget", () => {
  expect(requiredQueueBalance("starter")).toBe(16_000_000n)
})
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `bun --filter server test predict.test.ts`
Expected: FAIL — `requiredQueueBalance` is not exported.

- [ ] **Step 3: Implement `requiredQueueBalance`**

In `apps/server/src/predict.ts`, near `MIN_BALANCE_FOR_QUEUE` (line 67), add (import `STAKE_TIERS` / `Tier` from `./ws/protocol` if not already imported):

```ts
// Per-swipe premium quantity — MUST match web SWIPE_QUANTITY (onboarding-modal.tsx)
// and server PROBE_QTY (mint-probe.ts). A deck is at most MAX_DECK_SIZE cards.
export const SWIPE_QUANTITY_MIST = 3_000_000n
export const MAX_DECK_SIZE = 5n

/**
 * dUSDC the funding account needs before queueing at `tier`: the tier stake
 * plus the worst-case premium budget (5 cards × per-swipe quantity), since
 * both the stake and every swipe premium draw from the same account. Floored
 * at MIN_BALANCE_FOR_QUEUE so no tier drops below the protocol minimum.
 */
export function requiredQueueBalance(tier: Tier): bigint {
  const required = STAKE_TIERS[tier] + MAX_DECK_SIZE * SWIPE_QUANTITY_MIST
  return required > MIN_BALANCE_FOR_QUEUE ? required : MIN_BALANCE_FOR_QUEUE
}
```

Then extend `checkQueueBalanceGate` (predict.ts:214) to take the required amount and compare against it instead of the bare constant:

```ts
export async function checkQueueBalanceGate(
  client: SuiClient,
  owner: string,
  required: bigint = MIN_BALANCE_FOR_QUEUE
) {
  // ...unchanged wrapper + balance reads...
  if (balance < required) {
    return { ok: false, reason: "insufficient_balance", wrapper, balance }
  }
  return { ok: true, wrapper, balance }
}
```

(Keep the existing default so any other caller stays on the 5 dUSDC floor.)

- [ ] **Step 4: Run the test to confirm it passes**

Run: `bun --filter server test predict.test.ts`
Expected: PASS (3/3).

- [ ] **Step 5: Wire the tier-aware amount into the handler**

In `apps/server/src/ws/handlers.ts`, `queue_join` case: after tier validation, compute the required amount and pass it to the gate, and use it in the insufficient-balance error:

```ts
const required = requiredQueueBalance(msg.tier)
const gate = await checkQueueBalanceGate(getSuiClient(), ws.data.address, required)
```

Update the `insufficient_balance` branch (handlers.ts:121-130) to report `required` instead of `MIN_BALANCE_FOR_QUEUE`:

```ts
message: `account balance < ${required} (need stake + ~15 dUSDC premium budget) — deposit before queueing`,
detail: { need: required.toString(), have: gate.balance.toString() },
```

Add `requiredQueueBalance` to the existing `import { ... } from "../predict"` line (handlers.ts:9).

- [ ] **Step 6: Update onboarding deposit copy**

In `apps/web/src/components/onboarding-modal.tsx`, update the deposit-guidance copy (report §5.6's "~$8–11" is stale) to "~`stake + $15`" so a `standard`-tier player is told to hold ~20 dUSDC.

- [ ] **Step 7: Typecheck + full server tests**

Run: `bun typecheck && bun --filter server test`
Expected: typecheck 5/5; server tests green.

- [ ] **Step 8: Live-verify the gate**

- Queue with a wallet holding < `stake + 15` dUSDC → friendly gate message, no mid-game abort.
- Queue with ≥ enough → full duel completes with no code-1 (`withdraw_balance`) abort.

- [ ] **Step 9: Format + commit**

```bash
bunx prettier --write apps/server/src/predict.ts apps/server/src/predict.test.ts apps/server/src/ws/handlers.ts apps/web/src/components/onboarding-modal.tsx
git add apps/server/src/predict.ts apps/server/src/predict.test.ts apps/server/src/ws/handlers.ts apps/web/src/components/onboarding-modal.tsx
git commit -m "feat(6-24): tier-aware queue funding gate (stake + premium budget)"
```

---

## Done criteria (the recordable run)

One live duel, two zkLogin players, `standard` tier or above, all of:

1. Match forms first try (no "trouble setting up" loop) — Task 1
2. Every card swipeable in **both** directions, no code-4/code-0 aborts — Tasks 1+2
3. No card expires mid-match — Tasks 1+3
4. No account-drain abort — Task 4
5. Keeper settles + redeems; winner paid from the stake pool
6. Full run captured on video (pre-record safety copy)

Then re-run before pushing to PR #22:

```bash
bun typecheck                 # 5/5
bun --filter server test      # green
bun --filter web test         # green
```

---

## Self-review notes

- **Spec coverage:** Tasks 1–4 map 1:1 to the doc's four tasks; optional items (Task 1 soft-fallback, Task 2 edge 0.63) are marked optional as the doc states. Deferred items are recorded in Global Constraints as "do NOT work on".
- **Path corrections vs. the doc:** `active-duel.tsx` is at `apps/web/src/routes/game/active-duel.tsx` (doc said `components/`). `ZONE_TARGET_PROB.edge` is deckmaster.ts:409. `checkQueueBalanceGate` is the real gate function (predict.ts:214), not just the constant.
- **UI-timer nuance:** doc's "countdown bar starts at 5:00" refers to the on-chain window; the UI's per-card bar is `SWIPE_PHASE_MS = 60_000` and is intentionally left unchanged.
- **Type consistency:** `SWIPE_QUANTITY` (web) = `PROBE_QTY` (mint-probe) = `SWIPE_QUANTITY_MIST` (predict) = `3_000_000n`. `SWIPE_WINDOW_MS` (contract) = web mirror = `300_000`. `requiredQueueBalance(tier)` name is used identically in predict.ts, predict.test.ts, and handlers.ts.
