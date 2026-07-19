/**
 * Sponsor address-balance monitor.
 *
 * Sponsored gas is paid from the sponsor key's on-chain **address balance**
 * (the `Balance<SUI>` accumulator field, drawn via an empty gas payment — see
 * `sponsor.ts`), NOT from ordinary coin objects. That balance drains with every
 * sponsored transaction and, once empty, makes every `POST /sponsor` fail at
 * the fullnode with an opaque:
 *
 *   Invalid withdraw reservation: Available amount in account for object id
 *   0x… is less than requested: <available> < <gas needed>
 *
 * which is a silent, total outage — no player can create/join/swipe — that
 * reads like a per-player balance error but is really the shared sponsor
 * running dry. The wallet can still hold plenty of SUI in *coin* objects while
 * the address balance is empty; coins don't help sponsored gas.
 *
 * This module polls the address balance and logs a WARN below a threshold so
 * the wallet gets topped up (`bun run fund:sponsor <sui>`) before it bites. The
 * latest reading is also surfaced on `/health` so it's observable at a glance.
 */
import { env } from "./env"
import { decodeKeypair, getSuiClient } from "./lib/sui"
import { makeLogger } from "./log"

const log = makeLogger("sponsor-balance")

export interface SponsorBalanceSnapshot {
  /** Sponsor address whose address balance funds sponsored gas. */
  address: string
  /** On-chain SUI address balance (MIST) — the gas source. */
  addressBalanceMist: string
  /** Warn threshold (MIST) this reading was compared against. */
  warnBelowMist: string
  /** True when addressBalanceMist < warnBelowMist. */
  low: boolean
  /** Epoch ms of this reading. */
  checkedAtMs: number
}

let latest: SponsorBalanceSnapshot | null = null

/** Last reading, or null before the first check (or when no sponsor key). */
export function sponsorBalanceSnapshot(): SponsorBalanceSnapshot | null {
  return latest
}

/** Sponsor address derived from the configured key, or null if unset. */
export function sponsorAddress(): string | null {
  if (!env.sponsorSecretKey) return null
  return decodeKeypair(env.sponsorSecretKey).toSuiAddress()
}

/**
 * Pull `.balance.addressBalance` out of a `core.getBalance` response. Pure so
 * the nesting (which differs from the flat `.balance` a caller might expect —
 * the address balance is one level down, beside `.coinBalance`) is unit-
 * testable without a live client. Throws when the field is absent.
 */
export function parseAddressBalance(res: {
  balance?: { addressBalance?: string | number | bigint | null }
}): bigint {
  const raw = res.balance?.addressBalance
  if (raw == null) {
    throw new Error("getBalance returned no addressBalance field")
  }
  return BigInt(raw)
}

/**
 * Build a snapshot from a balance reading. Pure — the low/not-low decision and
 * the wire shape are testable without RPC or timers.
 */
export function evaluateBalance(
  address: string,
  addressBalanceMist: bigint,
  warnBelowMist: bigint,
  nowMs: number
): SponsorBalanceSnapshot {
  return {
    address,
    addressBalanceMist: addressBalanceMist.toString(),
    warnBelowMist: warnBelowMist.toString(),
    low: addressBalanceMist < warnBelowMist,
    checkedAtMs: nowMs,
  }
}

/**
 * Read the sponsor's SUI **address balance** (MIST). The SDK's
 * `getBalance().balance` exposes the split — `.addressBalance` is the gas
 * source, distinct from `.coinBalance` (ordinary coin objects). Throws on RPC
 * failure so callers can decide how to degrade.
 */
export async function readSponsorAddressBalance(
  address: string
): Promise<bigint> {
  const res = (await getSuiClient().core.getBalance({
    owner: address,
    coinType: "0x2::sui::SUI",
  })) as { balance?: { addressBalance?: string | number | bigint } }
  return parseAddressBalance(res)
}

async function checkOnce(address: string): Promise<void> {
  try {
    const bal = await readSponsorAddressBalance(address)
    latest = evaluateBalance(
      address,
      bal,
      env.sponsorMinBalanceWarnMist,
      Date.now()
    )
    if (latest.low) {
      log.warn(
        `sponsor address balance LOW: ${fmtSui(bal)} SUI < ${fmtSui(env.sponsorMinBalanceWarnMist)} SUI floor ` +
          `— sponsored gas will start failing. Top up: bun run fund:sponsor <sui> (recipient ${address})`
      )
    }
  } catch (e) {
    // A transient RPC blip shouldn't crash the loop; keep the last good
    // reading and try again next tick.
    log.warn(
      `sponsor balance check failed: ${e instanceof Error ? e.message : String(e)}`
    )
  }
}

/** MIST → SUI, 4 dp, for human-readable logs. */
function fmtSui(mist: bigint): string {
  return (Number(mist) / 1e9).toFixed(4)
}

/**
 * Start the periodic monitor. No-op (returns a null stopper) when no sponsor
 * key is configured — nothing to watch. Runs one check immediately so a
 * boot-time empty balance is caught without waiting a full interval.
 */
export function startSponsorBalanceMonitor(): { stop: () => void } {
  const address = sponsorAddress()
  if (!address) {
    log.info("sponsor balance monitor disabled — no SPONSOR_SECRET_KEY")
    return { stop: () => {} }
  }
  log.info(
    `sponsor balance monitor watching ${address} every ${Math.round(
      env.sponsorBalanceCheckIntervalMs / 1000
    )}s (warn below ${fmtSui(env.sponsorMinBalanceWarnMist)} SUI)`
  )
  void checkOnce(address)
  const timer = setInterval(
    () => void checkOnce(address),
    env.sponsorBalanceCheckIntervalMs
  )
  // Don't keep the process alive just for the monitor.
  if (typeof timer === "object" && "unref" in timer) {
    ;(timer as { unref: () => void }).unref()
  }
  return {
    stop: () => clearInterval(timer),
  }
}
