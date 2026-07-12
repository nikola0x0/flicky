# Living Full-Match PnL Timeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the watch-view PnL chart move every second (real time-decay data), span the full match timeline, survive F5, and auto-zoom the Y axis so small drift reads as motion — on both the duel-view chart and the home match tile.

**Architecture:** Extract testable logic into a new pure module `apps/web/src/lib/pnl-history.ts` (serialize/parse/trim, adaptive y-amplitude, relative-time axis labels) with unit tests; then rewire `StreamingPnlChart` to (Task 2) 1 Hz sampling + full-match x-axis + adaptive labels + Y auto-zoom, and (Task 3) localStorage persistence across refresh.

**Tech Stack:** React 19, TypeScript strict, `@visx/*` SVG chart primitives, `bun:test`, `localStorage`.

**Spec:** `docs/superpowers/specs/2026-07-11-watch-pnl-timeline-design.md` (authoritative).

## Global Constraints

- Branch: `feat/watch-pnl-timeline` (already checked out; do NOT touch `feat/predict-6-24-migration`).
- `bun` only (never npm/pnpm/yarn).
- Prettier: no semicolons, double quotes, 2-space, trailing comma `es5`, print width 80. Format ONLY touched files with `bunx prettier --write <files>` — NEVER `bun format`.
- TypeScript `strict: true`. dUSDC PnL values are `bigint`, micro-units (1e6). Serialize bigints as strings.
- Honesty: no fabricated data. Movement comes from real last-known spot + real time-decay only.
- Web test runner: `bun --filter web test` (globs `src/lib`, so new `src/lib/*.test.ts` is auto-included). Typecheck: `bun typecheck`.
- End every commit message with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

## File Structure

| File | Task | Responsibility |
|---|---|---|
| `apps/web/src/lib/pnl-history.ts` | 1 | Pure helpers: `Sample`/`Boundary` types, `MAX_SAMPLES`, `Y_FLOOR_MICRO`, `yAmpFor`, `relativeTimeLabels`, `trimHistory`, `serializeHistory`, `parseHistory`. No React, no DOM. |
| `apps/web/src/lib/pnl-history.test.ts` | 1 | `bun:test` unit tests for the pure helpers. |
| `apps/web/src/components/streaming-pnl-chart.tsx` | 2, 3 | Consume the helpers; 1 Hz sampler; full-match x-axis + adaptive labels; Y auto-zoom (Task 2); localStorage hydrate/persist/flush (Task 3). |

---

## Task 1: Pure history helpers + tests

**Files:**
- Create: `apps/web/src/lib/pnl-history.ts`
- Test: `apps/web/src/lib/pnl-history.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 2 & 3):
  - `interface Sample { t: number; p0: bigint; p1: bigint }`
  - `interface Boundary { t: number; idx: number }`
  - `const MAX_SAMPLES = 1800`
  - `const Y_FLOOR_MICRO = 50_000n`
  - `function yAmpFor(samples: Sample[], myIsP0: boolean): number` — symmetric half-amplitude (micro) for a `[-amp, amp]` y-domain.
  - `function relativeTimeLabels(firstT: number, lastT: number, n: number): Array<{ t: number; label: string }>`
  - `function trimHistory(samples: Sample[], boundaries: Boundary[]): { samples: Sample[]; boundaries: Boundary[]; firstT: number }`
  - `function serializeHistory(duelId: string, samples: Sample[], boundaries: Boundary[]): string`
  - `function parseHistory(raw: string | null): { duelId: string; firstT: number; samples: Sample[]; boundaries: Boundary[] } | null`

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/lib/pnl-history.test.ts`:

```ts
import { expect, test } from "bun:test"
import {
  MAX_SAMPLES,
  Y_FLOOR_MICRO,
  yAmpFor,
  relativeTimeLabels,
  trimHistory,
  serializeHistory,
  parseHistory,
  type Sample,
  type Boundary,
} from "./pnl-history"

test("yAmpFor floors at Y_FLOOR_MICRO for empty samples", () => {
  expect(yAmpFor([], true)).toBe(Number((Y_FLOOR_MICRO * 115n) / 100n))
})

test("yAmpFor frames the larger side, padded 15%", () => {
  const samples: Sample[] = [{ t: 0, p0: 2_000_000n, p1: -500_000n }]
  expect(yAmpFor(samples, true)).toBe(Number((2_000_000n * 115n) / 100n))
  expect(yAmpFor(samples, false)).toBe(Number((2_000_000n * 115n) / 100n))
})

test("relativeTimeLabels spaces n marks; last is now", () => {
  const l = relativeTimeLabels(0, 120_000, 3)
  expect(l.map((x) => x.t)).toEqual([0, 60_000, 120_000])
  expect(l.map((x) => x.label)).toEqual(["0:00", "1:00", "now"])
})

test("relativeTimeLabels pads seconds", () => {
  const l = relativeTimeLabels(0, 5_000, 2)
  expect(l[0].label).toBe("0:00")
  expect(l[1].label).toBe("now")
})

test("trimHistory keeps newest MAX_SAMPLES and drops stale boundaries", () => {
  const samples: Sample[] = Array.from({ length: MAX_SAMPLES + 5 }, (_, i) => ({
    t: i * 1000,
    p0: BigInt(i),
    p1: 0n,
  }))
  const boundaries: Boundary[] = [
    { t: 0, idx: 0 },
    { t: (MAX_SAMPLES + 4) * 1000, idx: 1 },
  ]
  const r = trimHistory(samples, boundaries)
  expect(r.samples.length).toBe(MAX_SAMPLES)
  expect(r.samples[0].t).toBe(5 * 1000)
  expect(r.firstT).toBe(5 * 1000)
  expect(r.boundaries).toEqual([{ t: (MAX_SAMPLES + 4) * 1000, idx: 1 }])
})

test("serializeHistory/parseHistory round-trips bigints beyond 2^53", () => {
  const big = 9_007_199_254_740_993n
  const samples: Sample[] = [
    { t: 1000, p0: big, p1: -big },
    { t: 2000, p0: 0n, p1: 3n },
  ]
  const boundaries: Boundary[] = [{ t: 1500, idx: 0 }]
  const parsed = parseHistory(serializeHistory("duel-x", samples, boundaries))
  expect(parsed).not.toBeNull()
  expect(parsed!.duelId).toBe("duel-x")
  expect(parsed!.samples).toEqual(samples)
  expect(parsed!.boundaries).toEqual(boundaries)
  expect(parsed!.firstT).toBe(1000)
})

test("parseHistory returns null on corrupt/mismatched input", () => {
  expect(parseHistory(null)).toBeNull()
  expect(parseHistory("not json")).toBeNull()
  expect(
    parseHistory(
      JSON.stringify({ v: 2, duelId: "x", samples: [], boundaries: [] })
    )
  ).toBeNull()
  expect(
    parseHistory(
      JSON.stringify({ v: 1, duelId: 123, samples: [], boundaries: [] })
    )
  ).toBeNull()
  expect(
    parseHistory(
      JSON.stringify({ v: 1, duelId: "x", samples: "nope", boundaries: [] })
    )
  ).toBeNull()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun --filter web test`
Expected: FAIL — cannot resolve `./pnl-history` (module not created yet).

- [ ] **Step 3: Implement `pnl-history.ts`**

Create `apps/web/src/lib/pnl-history.ts`:

```ts
/**
 * Pure helpers for the streaming PnL chart's rolling/persisted history.
 * No React, no DOM — all logic here is unit-tested; the component owns the
 * timers, RAF easing, SVG render, and localStorage side-effects.
 */

export interface Sample {
  t: number
  p0: bigint
  p1: bigint
}

export interface Boundary {
  t: number
  idx: number
}

/** Max retained samples — 30 min at the 1 Hz sampler. Beyond this the oldest
 *  drop and the full-match timeline becomes a rolling 30-min window (never
 *  reached in a ~5-min demo match). */
export const MAX_SAMPLES = 1800

/** Y-axis half-amplitude floor (micro-dUSDC, $0.05): small enough that
 *  time-decay drift fills the frame, large enough to avoid a zero-height
 *  (divide-by-zero) axis when PnL is flat 0. */
export const Y_FLOOR_MICRO = 50_000n

const PERSIST_VERSION = 1 as const

interface PersistedHistoryV1 {
  v: 1
  duelId: string
  firstT: number
  samples: Array<{ t: number; p0: string; p1: string }>
  boundaries: Boundary[]
}

/** Symmetric half-amplitude (micro-dUSDC) framing both players' PnL over
 *  `samples`, padded 15% and floored at Y_FLOOR_MICRO. Y-domain is
 *  [-amp, amp] around the break-even midline. */
export function yAmpFor(samples: Sample[], myIsP0: boolean): number {
  let absMax = 0n
  for (const s of samples) {
    const you = myIsP0 ? s.p0 : s.p1
    const opp = myIsP0 ? s.p1 : s.p0
    const ya = you < 0n ? -you : you
    const oa = opp < 0n ? -opp : opp
    if (ya > absMax) absMax = ya
    if (oa > absMax) absMax = oa
  }
  const base = absMax > Y_FLOOR_MICRO ? absMax : Y_FLOOR_MICRO
  return Number((base * 115n) / 100n)
}

/** `n` ascending x-axis marks evenly spaced across [firstT, lastT]; the last
 *  is "now", the rest elapsed `m:ss` from firstT. */
export function relativeTimeLabels(
  firstT: number,
  lastT: number,
  n: number
): Array<{ t: number; label: string }> {
  const span = Math.max(0, lastT - firstT)
  const out: Array<{ t: number; label: string }> = []
  for (let i = 0; i < n; i++) {
    const frac = n === 1 ? 1 : i / (n - 1)
    const t = firstT + span * frac
    out.push({ t, label: i === n - 1 ? "now" : fmtElapsed(t - firstT) })
  }
  return out
}

function fmtElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${s.toString().padStart(2, "0")}`
}

/** Keep the newest MAX_SAMPLES samples; drop boundaries before the retained
 *  window's first sample. */
export function trimHistory(
  samples: Sample[],
  boundaries: Boundary[]
): { samples: Sample[]; boundaries: Boundary[]; firstT: number } {
  const trimmed =
    samples.length > MAX_SAMPLES ? samples.slice(-MAX_SAMPLES) : samples
  const firstT = trimmed.length > 0 ? trimmed[0].t : 0
  return {
    samples: trimmed,
    boundaries: boundaries.filter((b) => b.t >= firstT),
    firstT,
  }
}

/** Serialize (trimmed) history to JSON for localStorage. bigints as strings
 *  to survive JSON and preserve values beyond 2^53. */
export function serializeHistory(
  duelId: string,
  samples: Sample[],
  boundaries: Boundary[]
): string {
  const t = trimHistory(samples, boundaries)
  const payload: PersistedHistoryV1 = {
    v: PERSIST_VERSION,
    duelId,
    firstT: t.firstT,
    samples: t.samples.map((s) => ({
      t: s.t,
      p0: s.p0.toString(),
      p1: s.p1.toString(),
    })),
    boundaries: t.boundaries,
  }
  return JSON.stringify(payload)
}

/** Parse a persisted history string. Returns null on any malformation — bad
 *  JSON, wrong version, missing/mistyped fields — and never throws. */
export function parseHistory(raw: string | null): {
  duelId: string
  firstT: number
  samples: Sample[]
  boundaries: Boundary[]
} | null {
  if (!raw) return null
  try {
    const p = JSON.parse(raw) as Partial<PersistedHistoryV1>
    if (p.v !== PERSIST_VERSION) return null
    if (typeof p.duelId !== "string") return null
    if (!Array.isArray(p.samples) || !Array.isArray(p.boundaries)) return null
    const samples: Sample[] = p.samples.map((s) => ({
      t: Number(s.t),
      p0: BigInt(s.p0),
      p1: BigInt(s.p1),
    }))
    const boundaries: Boundary[] = p.boundaries.map((b) => ({
      t: Number(b.t),
      idx: Number(b.idx),
    }))
    const firstT =
      typeof p.firstT === "number" ? p.firstT : (samples[0]?.t ?? 0)
    return { duelId: p.duelId, firstT, samples, boundaries }
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun --filter web test`
Expected: PASS — all `pnl-history.test.ts` cases green, existing `src/lib` tests still green.

- [ ] **Step 5: Format + commit**

```bash
bunx prettier --write apps/web/src/lib/pnl-history.ts apps/web/src/lib/pnl-history.test.ts
git add apps/web/src/lib/pnl-history.ts apps/web/src/lib/pnl-history.test.ts
git commit -m "feat(watch): pure pnl-history helpers (serialize/trim/y-amp/time-labels)"
```

---

## Task 2: 1 Hz sampling + full-match x-axis + adaptive labels + Y auto-zoom

**Files:**
- Modify: `apps/web/src/components/streaming-pnl-chart.tsx`

**Interfaces:**
- Consumes from Task 1: `Sample`, `Boundary`, `MAX_SAMPLES`, `yAmpFor`, `relativeTimeLabels`.
- Produces: the same `StreamingPnlChart` export (no prop change) with new behavior. Task 3 adds persistence on top of the `useChartHistory` this task leaves in place.

- [ ] **Step 1: Swap local types + constants for the helper module**

In `apps/web/src/components/streaming-pnl-chart.tsx`:

Add to the imports block (near the `markCardPnl` import):

```ts
import {
  MAX_SAMPLES,
  yAmpFor,
  relativeTimeLabels,
  type Sample,
  type Boundary,
} from "@/lib/pnl-history"
```

Delete the local `interface Sample { … }` and `interface Boundary { … }` declarations (they now come from `pnl-history`).

Replace the constants block:

```ts
const SAMPLE_INTERVAL_MS = 60 // ~16 Hz — smoother head than 10 Hz
const MAX_SAMPLES = 1000 // ~60 s rolling window at ~16 Hz
// Bounds for the adaptive ease duration (matched to observed tick cadence).
const EASE_MIN_MS = 500
const EASE_MAX_MS = 3000
const WINDOW_MS = 60_000 // x-axis visible window
const MIN_AMP_MICRO = 500_000n // 0.5 dUSDC y-axis floor
```

with:

```ts
const SAMPLE_INTERVAL_MS = 1000 // 1 Hz — one PnL sample per second
// Bounds for the adaptive ease duration (matched to observed tick cadence).
const EASE_MIN_MS = 500
const EASE_MAX_MS = 3000
```

(`MAX_SAMPLES`, the y-floor, and the window constant now live in `pnl-history`; the x-axis is a growing full-match span, not a fixed window.)

- [ ] **Step 2: Confirm the sampler uses the imported cap**

In `useChartHistory`, the sampler's cap already references `MAX_SAMPLES`; it now resolves to the imported `1800`. No change beyond the constant swap. Verify the slice still reads:

```ts
        const samples =
          prev.samples.length >= MAX_SAMPLES
            ? [...prev.samples.slice(-MAX_SAMPLES + 1), sample]
            : [...prev.samples, sample]
```

Add a one-line comment above `smoothedTicksRef` noting the last-known-spot guarantee (the RAF loop only writes markets present in `target` and never deletes, so a frozen/sparse feed keeps its last spot and time-decay keeps the mark drifting):

```ts
  // Eased copy updated each animation frame — what the sampler reads. Never
  // deletes a market: a sparse/frozen feed keeps its last-known spot so
  // `upProbability` time-decay keeps the mark drifting each second.
  const smoothedTicksRef = useRef<Record<string, ChartTick>>({})
```

- [ ] **Step 3: Full-match x-domain in `ChartCanvas`**

Replace the `{ ampNum, xDomain }` memo:

```ts
  const { ampNum, xDomain } = useMemo(() => {
    let absMax = 0n
    let tMax = Number.NEGATIVE_INFINITY
    for (const s of samples) {
      const y = youOf(s)
      const o = oppOf(s)
      const ya = y < 0n ? -y : y
      const oa = o < 0n ? -o : o
      if (ya > absMax) absMax = ya
      if (oa > absMax) absMax = oa
      if (s.t > tMax) tMax = s.t
    }
    const padded =
      ((absMax > MIN_AMP_MICRO ? absMax : MIN_AMP_MICRO) * 12n) / 10n
    const domain: [number, number] = !isFinite(tMax)
      ? [0, 1]
      : [tMax - WINDOW_MS, tMax]
    return { ampNum: Number(padded), xDomain: domain }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [samples, myIsP0])
```

with a full-match span anchored to the first sample and Y auto-zoom via `yAmpFor`:

```ts
  const { ampNum, xDomain } = useMemo(() => {
    const firstT = samples.length > 0 ? samples[0].t : 0
    let tMax = Number.NEGATIVE_INFINITY
    for (const s of samples) if (s.t > tMax) tMax = s.t
    // Growing full-match window [firstT, now]; guard the degenerate
    // single-sample case so the x-scale has a non-zero span.
    const domain: [number, number] = !isFinite(tMax)
      ? [0, 1]
      : firstT < tMax
        ? [firstT, tMax]
        : [tMax - SAMPLE_INTERVAL_MS, tMax]
    return { ampNum: yAmpFor(samples, myIsP0), xDomain: domain }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [samples, myIsP0])
```

- [ ] **Step 4: Adaptive relative-time axis labels**

Replace the fixed `-60s / -30s / now` label block:

```ts
          {hasData &&
            [
              { ago: 60_000, anchor: "start" as const },
              { ago: 30_000, anchor: "middle" as const },
              { ago: 0, anchor: "end" as const },
            ].map(({ ago, anchor }) => {
              const tx = xDomain[1] - ago
              const x = xScale(tx)
              return (
                <g key={ago} opacity={0.55}>
                  <line x1={x} x2={x} y1={ih} y2={ih + 3} stroke="#ffffff55" />
                  <text
                    x={x}
                    y={ih + 18}
                    fill="#ffffff70"
                    fontSize="11"
                    textAnchor={anchor}
                    dominantBaseline="hanging"
                  >
                    {ago === 0 ? "now" : `-${ago / 1000}s`}
                  </text>
                </g>
              )
            })}
```

with adaptive marks spanning `[firstT, now]`:

```ts
          {hasData &&
            relativeTimeLabels(xDomain[0], xDomain[1], 4).map((mark, i, all) => {
              const x = xScale(mark.t)
              const anchor =
                i === 0 ? "start" : i === all.length - 1 ? "end" : "middle"
              return (
                <g key={mark.t} opacity={0.55}>
                  <line x1={x} x2={x} y1={ih} y2={ih + 3} stroke="#ffffff55" />
                  <text
                    x={x}
                    y={ih + 18}
                    fill="#ffffff70"
                    fontSize="11"
                    textAnchor={anchor}
                    dominantBaseline="hanging"
                  >
                    {mark.label}
                  </text>
                </g>
              )
            })}
```

- [ ] **Step 5: Typecheck**

Run: `bun typecheck`
Expected: all 5 workspaces pass. (Confirms `MIN_AMP_MICRO` / `WINDOW_MS` / local `Sample`/`Boundary` are fully removed and every reference resolves to the imported symbols.)

- [ ] **Step 6: Web tests still green**

Run: `bun --filter web test`
Expected: PASS (no regressions; Task 1 tests included).

- [ ] **Step 7: Manual live check**

In the watch view (or demo duel): the PnL line advances one point per second and the head drifts continuously even on a frozen feed; the x-axis reads `m:ss … now` over the whole session; the Y axis tightens so small moves are visible. (Automated gate is typecheck + web test; this is the visual confirmation.)

- [ ] **Step 8: Format + commit**

```bash
bunx prettier --write apps/web/src/components/streaming-pnl-chart.tsx
git add apps/web/src/components/streaming-pnl-chart.tsx
git commit -m "feat(watch): 1Hz full-match PnL timeline + Y auto-zoom"
```

---

## Task 3: localStorage persistence across F5

**Files:**
- Modify: `apps/web/src/components/streaming-pnl-chart.tsx`

**Interfaces:**
- Consumes from Task 1: `serializeHistory`, `parseHistory`.
- Produces: history hydrated from and persisted to `localStorage` under `flicky:pnl-history:v1:<duelId>`, so refresh continues the same line.

- [ ] **Step 1: Import persistence helpers + add the storage prefix**

Extend the `pnl-history` import to include `serializeHistory, parseHistory`. Add near the constants:

```ts
const STORAGE_PREFIX = "flicky:pnl-history:v1:"
```

- [ ] **Step 2: Hydrate on mount / duelId change**

Inside `useChartHistory`, add a `historyRef` mirror and a hydration effect. Place after the existing `const [history, setHistory] = useState(...)` and `const prevSettledRef = useRef(0)`:

```ts
  // Mirror the latest history for the throttled persister + unload flush,
  // which must read current state without re-subscribing every render.
  const historyRef = useRef(history)
  useEffect(() => {
    historyRef.current = history
  }, [history])

  // Hydrate from localStorage when the duel changes (incl. first mount /
  // F5), so a refresh continues the same line instead of resetting.
  useEffect(() => {
    if (typeof window === "undefined") return
    try {
      const restored = parseHistory(
        window.localStorage.getItem(STORAGE_PREFIX + duelId)
      )
      if (restored && restored.duelId === duelId) {
        setHistory({
          duelId,
          samples: restored.samples,
          boundaries: restored.boundaries,
        })
        prevSettledRef.current = duelRef.current.settledCount
      }
    } catch {
      // corrupt / unavailable storage — start fresh, never throw
    }
  }, [duelId])
```

- [ ] **Step 3: Throttled persist (piggyback the 1 Hz sampler) + key hygiene**

Add a persist effect after the sampler `useEffect`:

```ts
  // Persist at most every 2 s (piggybacking the 1 Hz sampler's state
  // changes). bigints serialize as strings; only the current duel's entry
  // is kept so storage can't grow across matches.
  const lastPersistRef = useRef(0)
  useEffect(() => {
    if (typeof window === "undefined") return
    if (history.duelId !== duelId || history.samples.length === 0) return
    const now = Date.now()
    if (now - lastPersistRef.current < 2000) return
    lastPersistRef.current = now
    try {
      const key = STORAGE_PREFIX + duelId
      window.localStorage.setItem(
        key,
        serializeHistory(duelId, history.samples, history.boundaries)
      )
      for (let i = window.localStorage.length - 1; i >= 0; i--) {
        const k = window.localStorage.key(i)
        if (k && k.startsWith(STORAGE_PREFIX) && k !== key) {
          window.localStorage.removeItem(k)
        }
      }
    } catch {
      // quota / unavailable — degrade to in-memory only
    }
  }, [history, duelId])
```

- [ ] **Step 4: Flush on tab hide / unload**

Add a flush effect (mount-scoped) so a normal F5 captures the freshest samples even between throttled writes:

```ts
  // Flush the freshest samples when the tab is hidden or navigated away,
  // so a refresh restores right up to the last visible point.
  useEffect(() => {
    if (typeof window === "undefined") return
    const flush = () => {
      const h = historyRef.current
      if (h.duelId !== duelId || h.samples.length === 0) return
      try {
        window.localStorage.setItem(
          STORAGE_PREFIX + duelId,
          serializeHistory(duelId, h.samples, h.boundaries)
        )
      } catch {
        // ignore
      }
    }
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush()
    }
    window.addEventListener("pagehide", flush)
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      window.removeEventListener("pagehide", flush)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [duelId])
```

- [ ] **Step 5: Typecheck**

Run: `bun typecheck`
Expected: all 5 workspaces pass.

- [ ] **Step 6: Web tests still green**

Run: `bun --filter web test`
Expected: PASS.

- [ ] **Step 7: Manual live check**

In the watch view: let the chart accumulate ~10 s, press F5 → the prior line is restored (not reset) and continues. Switching to a different duel starts a fresh line and the previous duel's storage key is removed.

- [ ] **Step 8: Format + commit**

```bash
bunx prettier --write apps/web/src/components/streaming-pnl-chart.tsx
git add apps/web/src/components/streaming-pnl-chart.tsx
git commit -m "feat(watch): persist PnL timeline across F5 (localStorage)"
```

---

## Self-review notes

- **Spec coverage:** per-second (Task 2 Step 1), last-known-spot/time-decay (Task 2 Step 2), full-match x-axis + adaptive labels (Task 2 Steps 3–4), Y auto-zoom (Task 1 `yAmpFor` + Task 2 Step 3), persistence + hygiene + flush (Task 3), applies to both surfaces (no prop change — same component). Honesty boundary and dead-feed non-goal preserved (no fabricated data added).
- **Type consistency:** `Sample`/`Boundary` are defined once in `pnl-history.ts` and imported everywhere; `MAX_SAMPLES`, `yAmpFor`, `relativeTimeLabels`, `serializeHistory`, `parseHistory` names are used identically across tasks.
- **No dangling refs:** Task 2 removes `MIN_AMP_MICRO` and `WINDOW_MS`; Step 5 typecheck is the guard that no other reference to them survives (e.g. the y-label block still uses `ampNum`, which remains defined).
