# Living Full-Match PnL Timeline — Design

**Date:** 2026-07-11 · **Branch:** `feat/predict-6-24-migration` (PR #22)
**Surface:** the "watch" / ONGOING DUEL PnL chart (`StreamingPnlChart`), shared by the duel-view route and the home-page match tile.

## Goal

Make the watch-view PnL chart feel alive and continuous:

1. **Moves every second** — the PnL line visibly drifts each second using *real* data (last-known spot + the already-time-decay-aware `upProbability` mark), never invented numbers.
2. **Survives F5** — the chart is not wiped on refresh; the prior line is restored and continues.
3. **Full-match timeline** — the x-axis spans from when watching began to now (growing), not a rolling 60 s window.

Applies to **both** surfaces (watch view and home tile) — identical behavior, no per-surface mode.

## Non-goals / honesty boundary

- We do **not** fabricate movement. If a market's oracle **never** produced a tick, that card honestly contributes `0` (dead feed = DeepBook-side issue, out of scope). The improvement targets the *sparse/frozen* feed case (≥1 tick arrived): keep using the last-known spot so real time-decay keeps the mark drifting.
- No change to how PnL itself is computed (`currentRunningPnl` / `markCardPnl` / settled `cardOutcomes` stay as-is).

## Current behavior (baseline)

`apps/web/src/components/streaming-pnl-chart.tsx`:
- `useChartHistory` samples both sides every `SAMPLE_INTERVAL_MS = 60ms` (~16 Hz) into an in-memory `samples: {t, p0, p1}[]` (React state), capped at `MAX_SAMPLES = 1000` (~60 s). A RAF loop eases each market's spot between sparse server ticks into `smoothedTicksRef`; the sampler reads the smoothed spot.
- X domain is rolling: `[tMax - WINDOW_MS, tMax]` with `WINDOW_MS = 60_000`. Fixed axis labels at `-60s / -30s / now`.
- Y domain: `[-ampNum, ampNum]` where `ampNum = max(absMax, MIN_AMP_MICRO=0.5 dUSDC) × 1.2`. The 0.5 dUSDC floor flattens small moves.
- History is React state only → **F5 resets it** to empty.
- `smoothedTicksRef` already retains the last value per market (the RAF loop only writes markets present in `target`, never deletes) — so last-known-spot stickiness largely exists already; this design makes it explicit and guaranteed.

## Architecture

Split the testable logic into a new pure-helper module and keep the React/SVG glue in the component.

- **New:** `apps/web/src/lib/pnl-history.ts` — pure functions (no React, no DOM): serialize/parse persisted history, trim to cap, compute the adaptive y-domain, and format relative-time axis labels.
- **Modify:** `apps/web/src/components/streaming-pnl-chart.tsx` — cadence, timeline x-axis, persistence wiring, adaptive y-domain, adaptive labels.
- **New:** `apps/web/src/lib/pnl-history.test.ts` — unit tests for the pure helpers (`bun:test`).

### Data shapes (in `pnl-history.ts`)

```ts
// Micro-dUSDC PnL sample. Wire form stores bigints as strings.
export interface Sample { t: number; p0: bigint; p1: bigint }
export interface Boundary { t: number; idx: number }

interface PersistedHistoryV1 {
  v: 1
  duelId: string
  firstT: number
  samples: Array<{ t: number; p0: string; p1: string }>
  boundaries: Boundary[]
}
```

### Component 1 — Per-second, self-healing mark

- Change the sampler interval `60ms → 1000ms` (rename constant to `SAMPLE_INTERVAL_MS = 1000`). Literally "per second." The RAF spot-easing loop stays (keeps the sampled spot smooth between server ticks).
- Guarantee last-known-spot: the RAF loop must never delete a market from `smoothedTicksRef` when a fresh `target` value is missing (it already doesn't — assert/document this). So `currentRunningPnl` keeps a spot to feed `markCardPnl`, and `upProbability`'s `tYears = (expiryMs - nowMs)/MS_PER_YEAR` shrinks each second → the mark drifts continuously even with a frozen feed.

### Component 2 — Full-match timeline x-axis

- X domain = `[firstT, tMax]` (growing), where `firstT` is the first sample's `t` for this duel (hydrated across F5), and `tMax` is the latest sample `t`. Replace the rolling `[tMax - WINDOW_MS, tMax]`.
- Cap: `MAX_SAMPLES = 1800` (30 min @ 1 Hz). Beyond that the oldest samples drop and the timeline becomes a rolling 30-min window (never reached in a ~5-min demo match). Boundaries older than `firstT` are dropped alongside.
- Axis labels: replace the fixed `-60s/-30s/now` with 3–4 evenly spaced ticks over `[firstT, tMax]`, labeled elapsed `m:ss` (last = `now`). Computed by `relativeTimeLabels(firstT, tMax, n)` in `pnl-history.ts`.

### Component 3 — Persistence across F5

- Key: `flicky:pnl-history:v1:<duelId>` in `localStorage`.
- Write: piggyback the 1 Hz sampler but **throttle to ≥2000 ms** between writes, plus a final flush on `visibilitychange` (when `document.hidden`) and `pagehide`. Serialize via `serializeHistory(duelId, firstT, samples, boundaries)` (bigints → strings, trimmed to `MAX_SAMPLES`).
- Hydrate: on mount / when `duelId` changes, `parseHistory(raw)`; if it parses and `duelId` matches, seed `history` state (samples, boundaries, firstT) and continue appending → continuous across F5. On mismatch/absent/corrupt → start fresh.
- Hygiene: on writing a new duel's entry, remove other `flicky:pnl-history:v1:*` keys so storage holds at most the current duel. All storage access in try/catch — quota/unavailable degrades to in-memory only (same pattern as `deepbook.ts` wrapper cache). Guard `typeof window`/`localStorage`.

### Component 4 — Y auto-zoom

- Replace the `MIN_AMP_MICRO = 0.5 dUSDC` floor with an adaptive domain from `yDomainFor(samples, myIsP0)` in `pnl-history.ts`:
  - `absMax` = max |you| and |opp| over the visible samples.
  - `amp = max(absMax × 1.15, FLOOR)` where `FLOOR = 50_000n` ($0.05) — small enough that time-decay drift fills the frame, large enough to avoid a zero-height (divide-by-zero) axis when PnL is exactly 0.
- Keep the existing label logic unchanged: `ampPercent` from `youPremium` when `> 0`, else `$` labels (premium is currently 0 → `$` mode). `yTopLabel`/`yZeroLabel`/`yBotLabel` derive from the new `amp`.

## Testing

`pnl-history.test.ts` (pure, `bun:test`):
- `serializeHistory` → `parseHistory` round-trips samples/boundaries with bigint fidelity (values > 2^53 preserved as strings).
- `parseHistory` returns `null` on corrupt JSON, wrong `v`, or missing fields (no throw).
- Trim: serializing > `MAX_SAMPLES` keeps the newest `MAX_SAMPLES`; boundaries older than the retained `firstT` are dropped.
- `yDomainFor`: empty → `[-FLOOR, FLOOR]`; small values → padded by ~15 %; picks the correct side via `myIsP0`.
- `relativeTimeLabels(firstT, tMax, n)`: returns `n` ascending `m:ss` strings, last is `now`, evenly spaced.

Not unit-tested (timer/DOM/RAF): the `setInterval` sampler, RAF easing, localStorage side-effects, SVG render. Verified live in the watch view.

## Edge cases

- `duelId` change → clear in-memory history + drop other localStorage entries, start fresh (existing duelId-guard extended).
- Corrupt/absent/quota-exceeded localStorage → start fresh / skip persist, never throw.
- Demo mode (`buildDemoDuelDetail` synthetic oracle) → unaffected; persistence keyed by the demo duel id.
- Truly dead feed (no tick ever) → honest flat `0` for that card (documented non-goal).

## Tradeoffs (accepted)

- On long-horizon cards the per-second time-decay drift is small; **Y auto-zoom** is what makes it read as motion. If both premium and PnL are ~0 with no ticks at all, the line is honestly flat.
- 1 Hz sampling steps the head once per second (vs the old 16 Hz); acceptable and matches the "per second" ask. A short CSS transition on the head/avatar can soften the step if desired (optional, not required).
- localStorage write throttled to ≥2 s → at most a ~2 s tail lost on a hard crash; a normal F5 flushes on `pagehide`.
