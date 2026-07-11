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
