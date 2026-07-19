/**
 * Deck-gen mint-admissibility probe.
 *
 * 6-24 `ExpiryMarket`s gate every mint on a volatile per-market LP cash
 * reserve (`expiry_cash::assert_backing`, `EInsufficientCash` / abort code
 * 0): a market that admits a mint one minute can reject it the next, and the
 * indexer exposes no backing field to read (see
 * docs/superpowers/specs/2026-07-10-6-24-e2e-results.md "Upstream blocker").
 * Left unchecked, `buildDeck` round-robins cards onto whatever markets
 * cleared the headroom filter — including momentarily-unbacked ones — and
 * those cards' swipes then abort on-chain for the player.
 *
 * This probe dry-runs (devInspect — no signing, no gas) a representative ATM
 * mint on each candidate market and keeps only the ones that currently admit
 * it. It runs ONCE at deck creation (matchmaking / practice), never on the
 * hot per-swipe path. The ATM probe is representative because a live deck's
 * cards sit within a few bps of spot (near-0.5 probability both directions),
 * so a market that admits an ATM mint admits the real cards too — and the
 * dominant failure mode it catches, `assert_backing`, is strike-independent.
 *
 * Residual risk remains — backing can flip during the ~10-min swipe window —
 * but removing already-dead markets eliminates the bulk of swipe aborts.
 */
import { Transaction } from "@mysten/sui/transactions"
import { env } from "./env"
import { getSuiClient, loadKeypairFromEnv } from "./lib/sui"
import { deriveWrapperFor } from "./predict"
import {
  buildDeck,
  snapToAdmissionTick,
  type DeckCardOut,
  type MarketSnapshot,
} from "./deckmaster"
import { makeLogger } from "./log"

const log = makeLogger("mint-probe")

/** Open-upper-bound sentinel tick — `(1 << 30) - 1`, per the 6-24 tick grid. */
const POS_INF_TICK = (1n << 30n) - 1n
const U64_MAX = 2n ** 64n - 1n
/** 1e9-scaled leverage; 1e9 == 1x. Matches the web swipe PTB. */
const LEVERAGE_1X = 1_000_000_000n
/**
 * Probe notional — MUST match the web's `SWIPE_QUANTITY` so the probe's
 * admission math (`net_premium = probability × quantity / leverage` vs
 * `min_net_premium`) mirrors what a real swipe will do.
 */
const PROBE_QTY = 6_000_000n

// ─── Off-chain BS probability check ──────────────────────────────────────────
// Mirrors the web's `upProbability` (apps/web/src/lib/pnl.ts) and the
// deckmaster's `sviRawStrike` model — same vol, same formula, forward
// direction: given (spot, strike, T) → P(up).

/** MUST match `SVI_VOL` in deckmaster.ts and `ASSUMED_VOL` in pnl.ts. */
const BS_VOL = 0.6
const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000

/** Standard normal CDF (Abramowitz & Stegun 7.1.26 erf approximation).
 *  Matches the web's `normCdf` in pnl.ts. */
function normCdf(x: number): number {
  const sign = x < 0 ? -1 : 1
  const z = Math.abs(x) / Math.SQRT2
  const t = 1 / (1 + 0.3275911 * z)
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-z * z)
  return 0.5 * (1 + sign * y)
}

/**
 * Digital-BS probability P(settle > strike) — the forward of deckmaster's
 * `sviRawStrike` inversion.  `spot` and `strike` are 1e9-fixed USD.
 * `expiryMs` is the oracle's expiry epoch-ms, `nowMs` is the current time.
 * Returns a number in [0, 1].
 */
function digitalBsProbability(
  spot: bigint,
  strike: bigint,
  expiryMs: number,
  nowMs: number
): number {
  const S = Number(spot)
  const K = Number(strike)
  if (!(S > 0) || !(K > 0)) return 0.5
  const tYears = Math.max(1e-9, (expiryMs - nowMs) / MS_PER_YEAR)
  const v = BS_VOL * Math.sqrt(tYears)
  const d2 = (Math.log(S / K) - 0.5 * v * v) / v
  return normCdf(d2)
}

/**
 * On-chain `min_net_premium` floor = $1 dUSDC = 1_000_000 micro-units.
 * A swipe's `net_premium = probability × quantity / leverage`. At leverage
 * 1× (the only lever Flicky uses), the premium for the swiped direction
 * is `p × quantity`.  If this falls below $1, the mint aborts with
 * `ENetPremiumBelowMinimum`.
 *
 * The deck is generated at match creation, but the player may swipe up to
 * `SWIPE_WINDOW_MS` (5 min) later — by which time the market's TTL has
 * shortened and time-decay has sharpened the probability further from 0.5.
 * We project the probability at the **worst-case swipe time** (end of the
 * window) and add a 50% safety margin to absorb off-chain/on-chain model
 * differences (our flat vol=0.6 BS vs the on-chain SVI surface, plus any
 * spot drift during the match).
 */
const MIN_NET_PREMIUM = 1_000_000
const SAFETY_MARGIN = 1.5
/** Must match `SWIPE_WINDOW_MS` in duel.move / swipe-window.ts. */
const SWIPE_WINDOW_MS = 300_000

/** Returns true when BOTH directions' premiums clear the floor at worst-case
 *  swipe time (end of the 5-min swipe window). */
function premiumClearsFloor(
  spot: bigint,
  strike: bigint,
  expiryMs: number,
  nowMs: number,
  quantity: number
): boolean {
  // Worst-case swipe time = the latest a player can swipe THIS card. Bounded
  // by the on-chain 5-min window, but for a short-lived market the UI's
  // per-card deadline (`expiry − txBuffer`) is tighter — projecting all the
  // way to `now + 5min` would read a POST-expiry probability (rounds to 0/1),
  // spuriously zeroing the long-shot premium and ATM-falling every short card.
  // For mid/long markets (ttl > 5min) `expiry − buffer > now + 5min`, so the
  // min() is `now + 5min` and behavior is unchanged.
  const worstCaseSwipeMs = Math.min(
    nowMs + SWIPE_WINDOW_MS,
    expiryMs - env.deckTxBufferMs
  )
  const pUp = digitalBsProbability(spot, strike, expiryMs, worstCaseSwipeMs)
  const pLong = Math.min(pUp, 1 - pUp) // the weaker side's probability
  const longPremium = pLong * quantity
  return longPremium >= MIN_NET_PREMIUM * SAFETY_MARGIN
}

/**
 * (sender, wrapper) used to build probe PTBs. `undefined` = not yet resolved,
 * `null` = unavailable (probe disables itself). The sender must own the
 * wrapper (`generate_auth` authorizes `ctx.sender()`); devInspect never
 * charges it.
 */
let probeIdentity: { sender: string; wrapperId: string } | null | undefined

async function getProbeIdentity(): Promise<{
  sender: string
  wrapperId: string
} | null> {
  if (probeIdentity !== undefined) return probeIdentity
  try {
    const kp =
      loadKeypairFromEnv("SPONSOR_SECRET_KEY") ??
      loadKeypairFromEnv("KEEPER_SECRET_KEY") ??
      loadKeypairFromEnv("BOT_SECRET_KEY")
    if (!kp) {
      probeIdentity = null
      return null
    }
    const sender = kp.getPublicKey().toSuiAddress()
    const wrapperId =
      env.probeWrapperId ?? (await deriveWrapperFor(getSuiClient(), sender))
    if (!wrapperId) {
      log.warn(
        "mint probe: probe account has no AccountWrapper — probe disabled"
      )
      probeIdentity = null
      return null
    }
    const resolved = { sender, wrapperId }
    probeIdentity = resolved
    return resolved
  } catch (e) {
    log.warn(
      `probe identity unavailable: ${e instanceof Error ? e.message : String(e)}`
    )
    probeIdentity = null
    return null
  }
}

/** Build a `mint_exact_quantity` PTB for `market` at `strikeTick` in the
 *  given direction (UP = `(K, +inf]`, DOWN = `[0, K]`), sender-set for
 *  devInspect. */
function buildMintProbeTx(
  market: MarketSnapshot,
  strikeTick: bigint,
  isUp: boolean,
  sender: string,
  wrapperId: string
): Transaction {
  const lowerTick = isUp ? strikeTick : 0n
  const higherTick = isUp ? POS_INF_TICK : strikeTick
  const tx = new Transaction()
  const auth = tx.moveCall({
    target: `${env.accountPackageId}::account::generate_auth`,
  })
  const pricer = tx.moveCall({
    target: `${env.deepbookPredictPackageId}::expiry_market::load_live_pricer`,
    arguments: [
      tx.object(market.expiryMarketId),
      tx.object(env.protocolConfigId),
      tx.object(env.oracleRegistryId),
      tx.object(env.pythFeedId),
      tx.object(env.bsSpotFeedId),
      tx.object(env.bsForwardFeedId),
      tx.object(env.bsSviFeedId),
      tx.object("0x6"),
    ],
  })
  tx.moveCall({
    target: `${env.deepbookPredictPackageId}::expiry_market::mint_exact_quantity`,
    arguments: [
      tx.object(market.expiryMarketId),
      tx.object(wrapperId),
      auth,
      tx.object(env.protocolConfigId),
      pricer,
      tx.pure.u64(lowerTick),
      tx.pure.u64(higherTick),
      tx.pure.u64(PROBE_QTY),
      tx.pure.u64(LEVERAGE_1X),
      tx.pure.u64(U64_MAX),
      tx.pure.u64(U64_MAX),
      tx.object(env.accumulatorRootId),
      tx.object("0x6"),
    ],
  })
  tx.setSender(sender)
  return tx
}

async function mintProbeSucceeds(
  market: MarketSnapshot,
  strikeTick: bigint,
  isUp: boolean,
  sender: string,
  wrapperId: string
): Promise<boolean> {
  try {
    const tx = buildMintProbeTx(market, strikeTick, isUp, sender, wrapperId)
    const res = await getSuiClient().core.simulateTransaction({
      transaction: tx,
    })
    return JSON.stringify(res).includes('"success":true')
  } catch (e) {
    log.warn(
      `probe simulate threw for ${market.expiryMarketId.slice(0, 10)}: ${
        e instanceof Error ? e.message : String(e)
      }`
    )
    return false
  }
}

/** A market is usable if a representative ATM mint currently admits (at spot,
 *  both directions are ~0.5, so the UP side is representative and the
 *  strike-independent LP-backing gate is what this catches). */
function isMarketMintable(
  market: MarketSnapshot,
  spot: bigint,
  sender: string,
  wrapperId: string
): Promise<boolean> {
  const atmTick = snapToAdmissionTick(
    spot,
    market.tickSize,
    market.admissionTickSize
  )
  return mintProbeSucceeds(market, atmTick, true, sender, wrapperId)
}

/**
 * Keep only the markets whose ATM mint currently succeeds. Fails OPEN — if
 * the probe can't run (no identity) or is disabled, returns `markets`
 * unchanged rather than nuking deck-gen. Probes run concurrently.
 */
export async function filterMintableMarkets(
  markets: MarketSnapshot[],
  spot: bigint
): Promise<MarketSnapshot[]> {
  if (!env.deckProbeMintable || markets.length === 0) return markets
  const id = await getProbeIdentity()
  if (!id) {
    log.warn("mint probe skipped (no probe identity) — using raw market set")
    return markets
  }
  const results = await Promise.all(
    markets.map(async (m) => ({
      m,
      ok: await isMarketMintable(m, spot, id.sender, id.wrapperId),
    }))
  )
  const passing = results.filter((r) => r.ok).map((r) => r.m)
  const dropped = results
    .filter((r) => !r.ok)
    .map((r) => r.m.expiryMarketId.slice(0, 10))
  if (dropped.length) {
    log.info(
      `mint probe: kept ${passing.length}/${markets.length}, dropped unbacked: ${dropped.join(", ")}`
    )
  }
  return passing
}

/** Rebuild `card` as a pure-ATM card on the same market: strike = spot
 *  snapped to the admission grid, so both directions sit at ~0.5 and mint on
 *  any backed market. Keeps `isUpFavored` for display continuity. */
function atmCard(
  card: DeckCardOut,
  market: MarketSnapshot,
  spot: bigint
): DeckCardOut {
  const strikeTick = snapToAdmissionTick(
    spot,
    market.tickSize,
    market.admissionTickSize
  )
  return {
    expiryMarketId: card.expiryMarketId,
    strike: strikeTick * market.tickSize,
    lowerTick: card.isUpFavored ? strikeTick : 0n,
    higherTick: card.isUpFavored ? POS_INF_TICK : strikeTick,
    isUpFavored: card.isUpFavored,
  }
}

/**
 * Build a deck whose every card is mintable in BOTH swipe directions.
 *
 * Uses an **off-chain** Black-Scholes probability check instead of an
 * on-chain mint probe — no AccountWrapper, no dUSDC, no network calls.
 * For each card, computes `pLong = min(pUp, 1-pUp)` (the weaker side's
 * probability) and checks `pLong × SWIPE_QUANTITY ≥ $1 floor × 1.1`.
 * Cards that fail (the long-shot side's premium would abort) are replaced
 * with pure ATM cards on the same market.
 *
 * This eliminates the dependency on the on-chain mint probe (which needed
 * a funded AccountWrapper) while catching the same failure mode:
 * `ENetPremiumBelowMinimum` on short-TTL markets where time-decay pushed
 * probability too far from 0.5 for the offset strike to admit.
 *
 * The on-chain `filterMintableMarkets` probe (ATM-level LP-backing check)
 * is a separate concern and still runs when enabled — it catches the
 * strike-independent `EInsufficientCash` failure, not the probability-band
 * violation this function handles.
 */
export function buildProbedDeck(
  markets: MarketSnapshot[],
  spot: bigint,
  seed: Uint8Array,
  deckSize: number,
  nowMs?: number
): DeckCardOut[] {
  const cards = buildDeck(markets, spot, seed, deckSize, nowMs)
  const now = nowMs ?? Date.now()
  const qty = Number(PROBE_QTY)
  return cards.map((card, i) => {
    const market = markets[i % markets.length]
    if (premiumClearsFloor(spot, card.strike, market.expiry, now, qty)) {
      return card
    }
    log.info(
      `card ${i} (${market.expiryMarketId.slice(0, 10)}) long-shot premium below floor — ATM fallback`
    )
    return atmCard(card, market, spot)
  })
}
