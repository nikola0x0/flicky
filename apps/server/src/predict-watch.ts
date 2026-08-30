/**
 * Predict revival watch.
 *
 * DeepBook Predict 6-24 stopped creating markets on 2026-08-17 and nobody
 * noticed for twelve days, because nothing in the system was watching the
 * upstream the entire game depends on. `/health` reported `ok: true`
 * throughout.
 *
 * This is that watcher. It polls for the newest `MarketCreated` event and logs
 * a single unmissable line the moment markets start flowing again — turning
 * "wait indefinitely and check by hand" into "get told the day it's back".
 *
 * Cheap by construction: one GraphQL query per interval (default 15 min),
 * `last: 1`. It never writes and never blocks the request path.
 */
import { env } from "./env"
import { networkEnv } from "./network-env"
import { getGraphQLClient } from "./lib/sui"
import { makeLogger } from "./log"

const log = makeLogger("predict-watch")

interface WatchState {
  /** Newest MarketCreated timestamp seen, ms. Null until the first poll. */
  newestCreatedMs: number | null
  lastCheckedMs: number | null
  /** True once we've seen a market created AFTER the process started. */
  revived: boolean
  error: string | null
}

const state: WatchState = {
  newestCreatedMs: null,
  lastCheckedMs: null,
  revived: false,
  error: null,
}

export function predictWatchSnapshot(): Readonly<WatchState> {
  return { ...state }
}

/**
 * Newest `MarketCreated` timestamp for the pinned package, or null.
 *
 * NOTE: Sui GraphQL caps page size at 50 and returns `null` (not an error)
 * above that — `last: 1` is deliberate and must stay small.
 */
async function newestMarketCreatedMs(): Promise<number | null> {
  const type = `${networkEnv(env.network).deepbookPredictPackageId}::config_events::MarketCreated`
  const res = (await getGraphQLClient().query({
    query: `query Newest($t: String!) {
      events(last: 1, filter: { type: $t }) { nodes { timestamp } }
    }`,
    variables: { t: type },
  })) as { data?: { events?: { nodes?: Array<{ timestamp?: string }> } } }
  const ts = res.data?.events?.nodes?.[0]?.timestamp
  if (!ts) return null
  const ms = Date.parse(ts)
  return Number.isFinite(ms) ? ms : null
}

async function checkOnce(bootMs: number): Promise<void> {
  try {
    const newest = await newestMarketCreatedMs()
    state.lastCheckedMs = Date.now()
    state.error = null

    if (newest === null) {
      log.warn(
        "no MarketCreated events at all for the pinned package — " +
          "check the pin (docs/predict-pin-migration.md)"
      )
      return
    }

    const previous = state.newestCreatedMs
    state.newestCreatedMs = newest

    // A market created since this process booted means Predict is producing
    // again. Log it loudly and once — this is the line worth alerting on.
    if (!state.revived && newest > bootMs) {
      state.revived = true
      log.warn(
        `PREDICT_REVIVED: a market was created at ${new Date(newest).toISOString()}, ` +
          `after this process started. DeepBook Predict is producing markets again — ` +
          `run \`bun run check:sources\` and consider re-enabling staked duels.`
      )
      return
    }

    if (previous !== null && newest > previous) {
      log.info(
        `new market created ${new Date(newest).toISOString()} (was ${new Date(previous).toISOString()})`
      )
      return
    }

    const ageDays = (Date.now() - newest) / 86_400_000
    if (ageDays >= 1) {
      log.info(
        `still dark — newest market ${ageDays.toFixed(1)}d old (${new Date(newest).toISOString()})`
      )
    }
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e)
    state.lastCheckedMs = Date.now()
    log.warn(`predict watch poll failed: ${state.error}`)
  }
}

export function startPredictWatch(): { stop: () => void } {
  if (!env.predictWatchEnabled) {
    log.info("predict revival watch disabled (PREDICT_WATCH_ENABLED=false)")
    return { stop: () => {} }
  }
  const bootMs = Date.now()
  log.info(
    `predict revival watch every ${Math.round(env.predictWatchIntervalMs / 60_000)}min`
  )
  void checkOnce(bootMs)
  const timer = setInterval(
    () => void checkOnce(bootMs),
    env.predictWatchIntervalMs
  )
  return {
    stop: () => clearInterval(timer),
  }
}
