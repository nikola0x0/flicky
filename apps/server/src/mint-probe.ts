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
 * Build a deck whose every card is currently mintable in BOTH directions.
 *
 * Starts from `buildDeck`, then per card probes UP and DOWN; any card that
 * fails either direction — its offset strike pushed one side's premium under
 * the floor (`ENetPremiumBelowMinimum`) on a short-expiry market — is
 * replaced with a pure ATM card on the same market, which mints ~0.5 both
 * ways. This is the 6-24 revival of the old 4-16 `buildAndProbeDeck`
 * ATM-fallback (env.ts's `deckCardMinHeadroomMs` comment).
 *
 * At `PROBE_QTY = 6` dUSDC (matching web `SWIPE_QUANTITY`) the both-sides-
 * mintable band widens to p ∈ [0.167, 0.833], which covers every deckmaster
 * `ZONE_TARGET_PROB` zone with wide margin — so both directions can be
 * required outright instead of favored-only, and the margin survives the
 * time-decay/drift erosion that broke the long-shot side at qty=3 (see
 * docs/report/2026-07-18-longshot-swipe-abort-report.md).
 *
 * Fail-open: if the probe can't run (disabled / no identity) it returns the
 * raw `buildDeck` output. Assumes `markets` already passed
 * `filterMintableMarkets`, so the ATM fallback is guaranteed to admit. Two
 * cards on the same market falling back to ATM become identical (market,
 * strike) — a harmless duplicate in the committed vector.
 */
export async function buildProbedDeck(
  markets: MarketSnapshot[],
  spot: bigint,
  seed: Uint8Array,
  deckSize: number,
  nowMs?: number
): Promise<DeckCardOut[]> {
  const cards = buildDeck(markets, spot, seed, deckSize, nowMs)
  if (!env.deckProbeMintable) return cards
  const id = await getProbeIdentity()
  if (!id) return cards
  return Promise.all(
    cards.map(async (card, i) => {
      const market = markets[i % markets.length]
      const strikeTick = card.strike / market.tickSize
      // At qty=6, BOTH sides clear the min_net_premium floor at placement
      // with wide margin — so require YES *and* NO to be mintable and only
      // fall back to ATM if EITHER fails. (Old favored-only rule existed
      // because at qty=2 the long-shot could never clear the floor with any
      // offset; that constraint is gone.) This is the line that keeps both
      // swipe directions playable.
      const [upMints, downMints] = await Promise.all([
        mintProbeSucceeds(market, strikeTick, true, id.sender, id.wrapperId),
        mintProbeSucceeds(market, strikeTick, false, id.sender, id.wrapperId),
      ])
      if (upMints && downMints) return card
      log.info(
        `card ${i} (${market.expiryMarketId.slice(0, 10)}) not mintable both ways (up=${upMints} down=${downMints}) — ATM fallback`
      )
      return atmCard(card, market, spot)
    })
  )
}
