/**
 * Dev-only chart-demo plumbing. Activated via `?demoChart=1` (gated on
 * `import.meta.env.DEV`). Used by the home tile and the duel-view route
 * to bypass the backend and exercise the streaming-chart UI without a
 * real duel.
 *
 * - `useDemoChart()` reads the URL flag at hook time.
 * - `useDemoOracleTicks(...)` runs a 2 s Ornstein-Uhlenbeck process and
 *   pumps it into the tick state under `DEMO_ORACLE_ID`. Matches the
 *   server's real `ORACLE_TICK_INTERVAL_MS` so client smoothing has the
 *   same easing window in demo as in prod.
 */
import { useEffect } from "react"

export const DEMO_DUEL_ID = "demo-duel"
export const DEMO_OPP_ADDRESS =
  "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
export const DEMO_STRIKE = "100000000000" // 100.0 on 1e9 scale
export const DEMO_QUANTITY = "100000000000" // 100x quantity → BTC-scale PnL
export const DEMO_PREMIUM = "50000000" // $50 premium per swipe (display-only demo math)
// 6-24: swipe wire carries `orderId` (not `premium`) — a fake order id for
// demo swipe fixtures.
export const DEMO_ORDER_ID = "1"
export const DEMO_ORACLE_ID = "demo-oracle-2"
export const DEMO_CARD_COUNT = 5
// Oracles that aren't yet settled in the demo — these get their own
// independent OU walks. Settled cards (0, 1) don't need ticks.
export const DEMO_LIVE_ORACLE_IDS = [
  "demo-oracle-2",
  "demo-oracle-3",
  "demo-oracle-4",
]

export function useDemoChart(): boolean {
  if (!import.meta.env.DEV) return false
  if (typeof window === "undefined") return false
  return new URLSearchParams(window.location.search).get("demoChart") === "1"
}

interface DemoTick {
  spot: string
}

export function useDemoOracleTicks(
  demo: boolean,
  setTicks: (
    updater: (prev: Record<string, DemoTick>) => Record<string, DemoTick>
  ) => void
): void {
  useEffect(() => {
    if (!demo) return
    const strike = BigInt(DEMO_STRIKE)
    // Each live oracle gets its own independent OU walk so the lines
    // don't all move in lockstep.
    const devs = DEMO_LIVE_ORACLE_IDS.map(() => 0)
    const sigma = 28_000_000 // per-tick stddev (~$0.028 on quantity 1)
    const kappa = 0.04 // mean-reversion strength
    const cap = 600_000_000 // soft clamp
    const interval = setInterval(() => {
      const updates: Record<string, DemoTick> = {}
      DEMO_LIVE_ORACLE_IDS.forEach((id, i) => {
        // Box-Muller normal draw.
        const u1 = Math.max(Math.random(), 1e-9)
        const u2 = Math.random()
        const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
        devs[i] = devs[i] * (1 - kappa) + z * sigma
        if (devs[i] > cap) devs[i] = cap
        if (devs[i] < -cap) devs[i] = -cap
        const spot = strike + BigInt(Math.round(devs[i]))
        updates[id] = {
          spot: spot.toString(),
        }
      })
      setTicks((prev) => ({ ...prev, ...updates }))
    }, 2000)
    return () => clearInterval(interval)
  }, [demo, setTicks])
}
