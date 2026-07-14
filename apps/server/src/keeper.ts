/**
 * Settled-redeem keeper — runs as a background service inside the same
 * Bun process as the HTTP/WS server.
 *
 * Flow (6-24 model — feed-settle, no on-chain oracle read):
 *   1. Sweep recent `${packageId}::duel::DuelCreated` events.
 *   2. For each duel that's not yet COMPLETE:
 *      - If ACTIVE and not revealed, reveal the deck (deckmaster has
 *        the plaintext if anyone called /deckmaster/generate before
 *        the server restart).
 *      - If both players finished all swipes and every card's `ExpiryMarket`
 *        has settled (per the predict indexer's `/markets/{id}/state`), build
 *        a single PTB chaining `settle_card × deck_size` (keeper-fed
 *        `settlement_price` + per-player `net_premium`, per card) +
 *        `finalize` (distributes the side-pot) + `redeem_settled × N`
 *        (materialises each player's 6-24 `AccountWrapper` payout). Settles
 *        run first so `settle_card`'s anti-replay check
 *        (`predict_account::has_position`) sees live positions before
 *        redeem zeroes them.
 *   3. Remember finalized duel ids so we don't re-process.
 *
 * The keeper is permissionless on chain — it just needs gas (~0.01 SUI
 * per duel closed). Disable with KEEPER_ENABLED=false to run pure
 * HTTP+WS (e.g. for staging).
 */
import { Transaction } from "@mysten/sui/transactions"
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import type { SuiGrpcClient } from "@mysten/sui/grpc"
import { normalizeSuiObjectId } from "@mysten/sui/utils"
import { env } from "./env"
import { fetchDeck } from "./deckmaster"
import { makeLogger, shortId } from "./log"
import { deriveWrapperFor } from "./predict"
import { getGraphQLClient } from "./lib/sui"

const log = makeLogger("keeper")

// GraphQL replaces JSON-RPC queryEvents in sweep (gRPC can't filter events).
const SWEEP_QUERY = `query Sweep($type: String!) {
  events(filter: { type: $type }, last: 30) {
    nodes { contents { json } }
  }
}`

interface SwipeLite {
  isUp: boolean
  quantity: bigint
  /**
   * The `order_id` returned by `expiry_market::mint_exact_quantity`,
   * chained into `record_swipe` in the same player-signed PTB. `0` for
   * free-tier swipes (never produced by the STAKED-only settle path below).
   */
  orderId: bigint
}

interface DuelLite {
  id: string
  status: "PENDING" | "ACTIVE" | "COMPLETE"
  stakeCoinType: string
  deckHashHex: string
  creator: string
  challenger: string
  p0Stake: bigint
  p1Stake: bigint
  cards: Array<{ expiryMarketId: string; strike: bigint }>
  p0Swipes: (SwipeLite | null)[]
  p1Swipes: (SwipeLite | null)[]
  p0NextCardIdx: number
  p1NextCardIdx: number
  startedAtMs: bigint
  /**
   * On-chain `Duel.cards_settled[i]` — flips true once `settle_card(i)`
   * lands, independent of the other cards. `tryClose` uses this to settle
   * cards incrementally as their own market resolves, rather than waiting
   * for every card's market to settle before touching any of them.
   */
  cardsSettled: boolean[]
}

const STATUS_MAP: Record<string, "PENDING" | "ACTIVE" | "COMPLETE"> = {
  "1": "PENDING",
  "2": "ACTIVE",
  "3": "COMPLETE",
}

export function hexFromBytes(bytes: number[] | string): string {
  if (typeof bytes === "string") {
    // gRPC json encodes vector<u8> as base64; already-hex 0x strings pass through.
    if (bytes.startsWith("0x")) return bytes.toLowerCase()
    return "0x" + Buffer.from(bytes, "base64").toString("hex")
  }
  return "0x" + bytes.map((b) => b.toString(16).padStart(2, "0")).join("")
}

/**
 * Classify a settle/redeem failure as terminal — retrying it can never
 * succeed, so the keeper should mark the duel finalized and stop. Returns
 * false for transient errors (RPC blips, 429s, timeouts, or a not-yet-fully
 * propagated settlement) that should keep retrying.
 *
 * Terminal cases:
 *   - `flicky::duel` EDuelNotActive (abort code 2): the duel already
 *     finalized/refunded out from under us. The dry-run budget error shows
 *     the raw code, not the name, so we also match a bare `2)`.
 *   - `predict_manager::decrease_position` abort (4-16 legacy, EInsufficientPosition,
 *     code 1): a player's Predict position was already redeemed.
 *     decrease_position has no other abort code, so matching the function
 *     name is sufficient. Nothing more for the keeper to do.
 *
 * Explicitly NON-terminal (documented here, not just falling through to the
 * default `false`, so the classification is intentional and testable):
 *   - `flicky::duel` EZeroSettlement (abort code 14): `settle_card`/`finalize`
 *     reject a keeper-fed `settlement_price` of 0. This should never happen —
 *     `Keeper.tryClose` only calls settle_card once `readMarketSettlement`
 *     reports `settled: true` with a non-null price — but if it does (indexer
 *     read race, stale cache), the duel isn't stuck: a later retry with a
 *     correctly-resolved settlement price can still succeed.
 */
export function isTerminalSettleError(msg: string): boolean {
  if (msg.includes("EDuelNotActive") || /\babort code: 2\b|\b2\)/.test(msg)) {
    return true
  }
  if (msg.includes("decrease_position")) return true
  if (
    msg.includes("EZeroSettlement") ||
    /\babort code: 14\b|\b14\)/.test(msg)
  ) {
    return false
  }
  return false
}

interface RawSwipe {
  is_up: boolean
  quantity: string
  order_id: string
}

export function parseSwipe(raw: RawSwipe | null): SwipeLite | null {
  if (raw === null) return null
  return {
    isUp: raw.is_up,
    quantity: BigInt(raw.quantity),
    orderId: BigInt(raw.order_id),
  }
}

/**
 * Pure parser — extract a DuelLite from `obj.data.type` + `obj.data.content.fields`
 * as returned by `SuiGrpcClient.getObject({ showContent: true, showType: true })`.
 * Returns null if the input isn't a moveObject of the expected shape.
 * Exposed so the keeper tests can exercise it without mocking the
 * full client.
 */
export function parseDuelFromObject(
  type: string | undefined,
  fields: unknown
): DuelLite | null {
  if (!fields || typeof fields !== "object") return null
  const f = fields as {
    id: string
    status: string
    deck_hash: number[] | string
    creator: string
    challenger: string
    p0_stake: string | { value?: string }
    p1_stake: string | { value?: string }
    cards: Array<{ expiry_market_id: string; strike: string }>
    p0_swipes: Array<RawSwipe | null>
    p1_swipes: Array<RawSwipe | null>
    p0_next_card_idx: string | number
    p1_next_card_idx: string | number
    started_at_ms: string | number
    cards_settled?: boolean[]
  }
  if (!f.id || f.status === undefined) return null
  const typeMatch = type?.match(/Duel<(.+)>$/)
  const stakeCoinType = typeMatch?.[1] ?? "0x2::sui::SUI"
  const stakeValue = (b: string | { value?: string }): bigint =>
    typeof b === "string" ? BigInt(b) : BigInt(b.value ?? "0")
  return {
    id: normalizeSuiObjectId(f.id),
    status: STATUS_MAP[String(f.status)] ?? "PENDING",
    stakeCoinType,
    deckHashHex: hexFromBytes(f.deck_hash),
    creator: f.creator,
    challenger: f.challenger,
    p0Stake: stakeValue(f.p0_stake),
    p1Stake: stakeValue(f.p1_stake),
    cards: f.cards.map((c) => ({
      expiryMarketId: normalizeSuiObjectId(c.expiry_market_id),
      strike: BigInt(c.strike),
    })),
    p0Swipes: f.p0_swipes.map(parseSwipe),
    p1Swipes: f.p1_swipes.map(parseSwipe),
    p0NextCardIdx:
      f.p0_next_card_idx !== undefined ? Number(f.p0_next_card_idx) : 0,
    p1NextCardIdx:
      f.p1_next_card_idx !== undefined ? Number(f.p1_next_card_idx) : 0,
    startedAtMs: f.started_at_ms !== undefined ? BigInt(f.started_at_ms) : 0n,
    cardsSettled: Array.isArray(f.cards_settled)
      ? f.cards_settled
      : f.cards.map(() => false),
  }
}

async function fetchDuel(
  client: SuiGrpcClient,
  id: string
): Promise<DuelLite | null> {
  const obj = await client.core.getObject({
    objectId: id,
    include: { json: true },
  })
  if (!obj.object?.json) return null
  return parseDuelFromObject(obj.object.type ?? undefined, obj.object.json)
}

export { type DuelLite, type SwipeLite }

interface MarketSettlementState {
  settled: boolean
  settlementPrice: bigint | null
}

/**
 * Read an `ExpiryMarket`'s settlement state via the predict indexer's
 * current-state lookup: `GET {predictIndexerUrl}/markets/{id}/state` →
 * `{ market, config, mint_paused, oracle_prices, oracle_svi, settlement }`.
 * `settlement` is `null` until `market_settled` has been indexed, else
 * `{ settlement_price: "<u64 decimal string>", settled_at_ms, ... }` (probed
 * live against testnet 2026-07-10: confirmed on both branches — `null` for a
 * future-expiry market, a populated object with `settlement_price` +
 * `kind: "market_settled"` for a past-expiry one).
 *
 * THIN LOCAL READER — Task 6 (indexer/ws field renames) added a
 * `market_settlements` Postgres mirror populated by `indexer.ts`'s own
 * `MarketSettled` tracker (see `readExpiryMarketSettlements` there), but
 * deliberately left this HTTP-based reader as the keeper's settle-time
 * source of truth: settle_card's on-chain effects are irreversible, so the
 * keeper should read the indexer directly rather than trust a mirror that
 * could lag behind (the mirror is best-effort, used only for the
 * indexer's own live-PnL preview). Kept as one small exported function so
 * a future consolidation stays a pure relocation.
 *
 * Fails closed: any fetch/parse error reports `settled: false` so the keeper
 * never mistakes an indexer hiccup for "not settled yet" vs. accidentally
 * treats it as settled with a garbage price — `tryClose` just retries later.
 */
export async function readMarketSettlement(
  expiryMarketId: string
): Promise<MarketSettlementState> {
  try {
    const res = await fetch(
      `${env.predictIndexerUrl}/markets/${expiryMarketId}/state`
    )
    if (!res.ok) return { settled: false, settlementPrice: null }
    const data = (await res.json()) as {
      settlement?: { settlement_price?: string } | null
    }
    const price = data.settlement?.settlement_price
    if (price === undefined || price === null)
      return { settled: false, settlementPrice: null }
    return { settled: true, settlementPrice: BigInt(price) }
  } catch (e) {
    log.warn(
      `readMarketSettlement(${expiryMarketId}): fetch failed, treating as unsettled: ${e instanceof Error ? e.message : String(e)}`
    )
    return { settled: false, settlementPrice: null }
  }
}

/**
 * Read a minted order's `net_premium` (DUSDC base units) for the settle-time
 * `p0_premium`/`p1_premium` args to `duel::settle_card`.
 *
 * PROBED shape (2026-07-10): the reference doc's guessed `/market-orders`,
 * `/manager-orders`, `/managers` paths all 404 on the live
 * `predict-server-beta` indexer. The real API (`crates/predict-server/API.md`
 * in the deepbookv3 branch) instead exposes a purpose-built current-state
 * lookup: `GET /markets/{expiry_market_id}/positions/{position_root_id}/cashflow`
 * → a `position_cashflow` row aggregating the whole replacement chain
 * (`net_premium`, `mint_fees`, `live_redeem_amount`, `settled_payout`, …),
 * or `null` for an unknown root — confirmed live (`/markets/<id>/positions/12345/cashflow`
 * → `200 null`). A flicky swipe's `order_id` is always a mint root (never a
 * replacement — flicky never partially closes), so `position_root_id ===
 * order_id` always holds and this is the correct, precise lookup (matches
 * `OrderMinted.net_premium` for that order without an unbounded event scan).
 *
 * DEVIATION from the brief's literal `readOrderPremium(orderId)` signature:
 * `API.md` is explicit that `order_id` is **expiry-local, not globally
 * unique** — "always treat `(expiry_market_id, order_id)` as the key" — so
 * this function takes `expiryMarketId` too. Task 6 should carry this two-arg
 * shape forward rather than the brief's one-arg guess.
 *
 * Safe-but-approximate fallback: any failure (HTTP error, no cashflow row —
 * e.g. the indexer hasn't caught up to the mint yet — or a malformed body)
 * resolves to `{ value: 0n, resolved: false }` and logs a warning.
 *
 * IMPORTANT — premium is NOT tie-break-only in flicky's winner decision:
 * `val0 = p0_payout + p1_premium` vs `val1 = p1_payout + p0_premium`, so an
 * asymmetric fallback (one player's real premium vs the other's `0`) can
 * flip who wins a close card, not just an exact tie. Callers MUST check
 * `resolved` and, if either side of a card failed to resolve, zero BOTH
 * players' premiums for that card (see `tryClose`'s per-card resolution
 * loop) so premium drops out of the comparison symmetrically instead of
 * mis-deciding the winner. Flagged LOUDLY per task instructions — see
 * task-5-report.md "premium=0 fallback" section.
 */
export async function readOrderPremium(
  expiryMarketId: string,
  orderId: bigint
): Promise<{ value: bigint; resolved: boolean }> {
  try {
    const res = await fetch(
      `${env.predictIndexerUrl}/markets/${expiryMarketId}/positions/${orderId.toString()}/cashflow`
    )
    if (!res.ok) {
      log.warn(
        `readOrderPremium(${expiryMarketId}, ${orderId}): HTTP ${res.status} — falling back to premium=0 (not resolved)`
      )
      return { value: 0n, resolved: false }
    }
    const data = (await res.json()) as { net_premium?: string } | null
    if (!data || data.net_premium === undefined) {
      log.warn(
        `readOrderPremium(${expiryMarketId}, ${orderId}): no cashflow row (indexer lag or unminted order) — falling back to premium=0`
      )
      return { value: 0n, resolved: false }
    }
    return { value: BigInt(data.net_premium), resolved: true }
  } catch (e) {
    log.warn(
      `readOrderPremium(${expiryMarketId}, ${orderId}): fetch failed — falling back to premium=0: ${e instanceof Error ? e.message : String(e)}`
    )
    return { value: 0n, resolved: false }
  }
}

/**
 * Reduce a card's two independently-resolved `readOrderPremium` results to
 * the `(p0_premium, p1_premium)` pair fed into `settle_card`.
 *
 * Symmetric fallback (see `readOrderPremium`'s doc comment): if EITHER
 * side failed to resolve, both premiums drop to `0n` for this card —
 * mixing one player's real premium with the other's `0` fallback would
 * asymmetrically bias `val0 = p0_payout + p1_premium` vs
 * `val1 = p1_payout + p0_premium` and could mis-decide the winner, not
 * just an exact tie. Pure so it's directly unit-testable without RPC
 * mocking.
 */
export function resolveCardPremiums(
  p0: { value: bigint; resolved: boolean },
  p1: { value: bigint; resolved: boolean }
): { p0Premium: bigint; p1Premium: bigint } {
  if (!p0.resolved || !p1.resolved) {
    return { p0Premium: 0n, p1Premium: 0n }
  }
  return { p0Premium: p0.value, p1Premium: p1.value }
}

/**
 * Card indices ready for a `settle_card` call right now: not already
 * settled on-chain (`cardsSettled[i]` false) AND their market has a known
 * settlement price. A duel's cards can span markets with very different
 * lifetimes (upstream 6-24 mixes ~3-min and multi-hour markets), so this
 * intentionally returns a PARTIAL list rather than requiring every card's
 * market to be settled — `settle_card`'s only on-chain guard is per-card
 * idempotency, so settling cards as their own market resolves (rather than
 * waiting for the slowest straggler) is both safe and correct. Pure so
 * it's directly unit-testable without RPC mocking.
 */
export function readyCardIndices(
  cards: Array<{ expiryMarketId: string }>,
  cardsSettled: boolean[],
  settlementByMarket: Map<string, bigint>
): number[] {
  const out: number[] = []
  for (let i = 0; i < cards.length; i++) {
    if (cardsSettled[i]) continue
    if (!settlementByMarket.has(cards[i].expiryMarketId)) continue
    out.push(i)
  }
  return out
}

export class Keeper {
  readonly client: SuiGrpcClient
  private readonly gql = getGraphQLClient()
  readonly keypair: Ed25519Keypair
  readonly packageId: string
  readonly address: string
  readonly finalized = new Set<string>()
  readonly revealed = new Set<string>()
  readonly inFlight = new Set<string>()
  private stopped = false

  constructor(
    client: SuiGrpcClient,
    keypair: Ed25519Keypair,
    packageId: string
  ) {
    this.client = client
    this.keypair = keypair
    this.packageId = packageId
    this.address = keypair.toSuiAddress()
  }

  async tryReveal(duel: DuelLite): Promise<void> {
    if (this.revealed.has(duel.id)) return
    if (duel.cards.length > 0) {
      this.revealed.add(duel.id)
      return
    }
    if (duel.status !== "ACTIVE") return
    const plaintext = await fetchDeck(duel.deckHashHex)
    if (!plaintext) return

    const tx = new Transaction()
    const cardArgs = plaintext.map((c) =>
      tx.moveCall({
        target: `${this.packageId}::duel::new_card`,
        // 6-24 `new_card(expiry_market_id: ID, strike: u64)` takes a plain
        // ID, not an owned/shared object reference.
        arguments: [tx.pure.id(c.expiryMarketId), tx.pure.u64(c.strike)],
      })
    )
    tx.moveCall({
      target: `${this.packageId}::duel::reveal_deck`,
      typeArguments: [duel.stakeCoinType],
      arguments: [
        tx.object(duel.id),
        tx.makeMoveVec({
          type: `${this.packageId}::duel::Card`,
          elements: cardArgs,
        }),
      ],
    })
    const res = await this.client.signAndExecuteTransaction({
      transaction: tx,
      signer: this.keypair,
    })
    if (res.$kind === "Transaction" && res.Transaction.status.success) {
      await this.client.waitForTransaction({ digest: res.Transaction.digest })
      this.revealed.add(duel.id)
      log.info(
        `reveal ${shortId(duel.id)} · ${shortId(res.Transaction.digest)}`
      )
    } else {
      const reason = res.Transaction?.status.error?.message ?? "unknown"
      if (reason.includes("16") || reason.includes("EDeckAlreadyRevealed")) {
        this.revealed.add(duel.id)
        return
      }
      log.warn(`reveal-skip ${shortId(duel.id)}: ${reason}`)
    }
  }

  async tryClose(duelId: string): Promise<void> {
    if (this.finalized.has(duelId) || this.inFlight.has(duelId)) return
    this.inFlight.add(duelId)
    try {
      const duel = await fetchDuel(this.client, duelId)
      if (!duel) return
      if (duel.status === "COMPLETE") {
        this.finalized.add(duelId)
        return
      }
      if (duel.status !== "ACTIVE") return

      await this.tryReveal(duel)
      if (duel.cards.length === 0) return

      // Happy path: both players completed every swipe. Partial / stuck
      // duels are left to the players' own `refund_duel` — the server
      // can't sign on their behalf.
      const deckSize = duel.cards.length
      const bothDone =
        duel.p0NextCardIdx === deckSize && duel.p1NextCardIdx === deckSize
      if (!bothDone) return

      // Per-card settlement, independent of the deck's OTHER cards. A
      // duel's 5 cards can span markets with wildly different lifetimes
      // (upstream 6-24 mixes ~3-min and multi-hour markets) — waiting for
      // EVERY market to settle before touching ANY card can strand a duel
      // behind one slow straggler for hours, even though the rest finished
      // minutes ago. `settle_card`'s only on-chain guard is per-card
      // idempotency (`cards_settled[i]` must be false), so nothing requires
      // settling in order or all at once.
      const uniqueMarketIds = Array.from(
        new Set(duel.cards.map((c) => c.expiryMarketId))
      )
      const settlementByMarket = new Map<string, bigint>()
      for (const mid of uniqueMarketIds) {
        const state = await readMarketSettlement(mid)
        if (state.settled && state.settlementPrice !== null) {
          settlementByMarket.set(mid, state.settlementPrice)
        }
      }
      const readyIdx = readyCardIndices(
        duel.cards,
        duel.cardsSettled,
        settlementByMarket
      )
      if (readyIdx.length === 0) return // nothing newly eligible this pass

      let p0Wrapper: string | null
      let p1Wrapper: string | null
      try {
        p0Wrapper = await deriveWrapperFor(this.client, duel.creator)
        p1Wrapper = await deriveWrapperFor(this.client, duel.challenger)
      } catch (e) {
        // Lookup couldn't complete (RPC error) — distinct from "no wrapper".
        // Bail and let the next poll retry rather than mis-settling.
        log.warn(
          `skip ${shortId(duelId)}: wrapper lookup failed, will retry: ${e instanceof Error ? e.message : String(e)}`
        )
        return
      }
      if (!p0Wrapper || !p1Wrapper) {
        log.warn(`skip ${shortId(duelId)}: no account wrapper for p0 or p1`)
        return
      }

      // Resolve every keeper-fed value BEFORE building the PTB — 6-24
      // exposes no public on-chain read for settlement_price or premium, so
      // both come from the predict indexer. Only for the READY cards —
      // cards whose market hasn't settled yet are left for a later pass.
      const settlementPrices = new Map<number, bigint>()
      const p0Premiums = new Map<number, bigint>()
      const p1Premiums = new Map<number, bigint>()
      for (const i of readyIdx) {
        const card = duel.cards[i]
        const price = settlementByMarket.get(card.expiryMarketId)
        if (price === undefined) continue // defensive; can't happen post-gate above
        settlementPrices.set(i, price)
        const p0Swipe = duel.p0Swipes[i]
        const p1Swipe = duel.p1Swipes[i]
        const p0Result = p0Swipe
          ? await readOrderPremium(card.expiryMarketId, p0Swipe.orderId)
          : { value: 0n, resolved: true }
        const p1Result = p1Swipe
          ? await readOrderPremium(card.expiryMarketId, p1Swipe.orderId)
          : { value: 0n, resolved: true }
        if (
          (p0Result.resolved || p1Result.resolved) &&
          !(p0Result.resolved && p1Result.resolved)
        ) {
          log.warn(
            `card ${i} of ${shortId(duelId)}: one side's premium failed to resolve — zeroing BOTH players' premiums for this card so the fallback stays symmetric`
          )
        }
        const { p0Premium, p1Premium } = resolveCardPremiums(p0Result, p1Result)
        p0Premiums.set(i, p0Premium)
        p1Premiums.set(i, p1Premium)
      }

      const tx = new Transaction()

      // 1) `settle_card` for each READY card. Scores both players' swipes
      //    on that card against the keeper-fed settlement_price and reads
      //    each player's LIVE AccountWrapper position (anti-replay:
      //    `predict_account::has_position`) to flag early-redeemers. All
      //    settles MUST run before any redeem in this PTB — redeeming
      //    first would zero the positions and make every swipe score as
      //    "redeemed early".
      for (const i of readyIdx) {
        tx.moveCall({
          target: `${this.packageId}::duel::settle_card`,
          typeArguments: [duel.stakeCoinType],
          arguments: [
            tx.object(duelId),
            tx.object(p0Wrapper),
            tx.object(p1Wrapper),
            tx.pure.u64(BigInt(i)),
            tx.pure.u64(settlementPrices.get(i)!),
            tx.pure.u64(p0Premiums.get(i)!),
            tx.pure.u64(p1Premiums.get(i)!),
          ],
        })
      }

      // 2) `finalize` (no market arg — distributes the pot from the
      //    accumulated per-player payout/premium fields) ONLY once this
      //    batch clears every remaining card. The contract itself requires
      //    `settled_count == deck_size` for the normal-resolution path
      //    (`EAllCardsNotSettled`), so this isn't optional — but there's no
      //    reason to wait on finalize before settling the cards that ARE
      //    ready; a later poll picks up any still-unsettled stragglers.
      const settledAfterThisBatch =
        duel.cardsSettled.filter(Boolean).length + readyIdx.length
      const willFinalize = settledAfterThisBatch === deckSize
      if (willFinalize) {
        tx.moveCall({
          target: `${this.packageId}::duel::finalize`,
          typeArguments: [duel.stakeCoinType],
          arguments: [tx.object(duelId), tx.object("0x6")],
        })
      }

      // 3) Redeem the READY cards' recorded positions (both players) so
      //    their dUSDC payout materializes in their AccountWrapper as soon
      //    as that specific card is settled — `redeem_settled` is a
      //    permissionless Predict call keyed on the position's own market,
      //    independent of flicky's `Duel.status`/finalize, so it doesn't
      //    need to wait for the whole deck either.
      let redeemsCount = 0
      for (const i of readyIdx) {
        const card = duel.cards[i]
        for (const [wrapper, swipe] of [
          [p0Wrapper, duel.p0Swipes[i]] as const,
          [p1Wrapper, duel.p1Swipes[i]] as const,
        ]) {
          if (!swipe || swipe.quantity <= 0n) continue
          tx.moveCall({
            target: `${env.deepbookPredictPackageId}::expiry_market::redeem_settled`,
            arguments: [
              tx.object(card.expiryMarketId),
              tx.object(env.accountRegistryId),
              tx.object(wrapper),
              tx.object(env.protocolConfigId),
              tx.object(env.oracleRegistryId),
              tx.object(env.pythFeedId),
              tx.pure.u256(swipe.orderId),
              tx.pure.u64(swipe.quantity),
              tx.object(env.accumulatorRootId),
              tx.object("0x6"),
            ],
          })
          redeemsCount++
        }
      }

      const res = await this.client.signAndExecuteTransaction({
        transaction: tx,
        signer: this.keypair,
      })
      if (!(res.$kind === "Transaction" && res.Transaction.status.success)) {
        const reason = res.Transaction?.status.error?.message ?? "unknown"
        log.warn(`skip ${shortId(duelId)}: ${reason}`)
        return
      }
      await this.client.waitForTransaction({ digest: res.Transaction.digest })
      if (willFinalize) this.finalized.add(duelId)
      log.info(
        `settle_card×${readyIdx.length}` +
          (willFinalize
            ? ` + finalize ${shortId(duelId)}`
            : ` ${shortId(duelId)} (${settledAfterThisBatch}/${deckSize})`) +
          (redeemsCount ? ` + ${redeemsCount} redeem(s)` : "") +
          ` · ${shortId(res.Transaction.digest)}`
      )
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // Terminal aborts — the duel already finalized, or (4-16 legacy) a
      // player's Predict position was already redeemed — can never succeed
      // on retry. Mark the duel done so the keeper stops re-attempting (and
      // stops logging) it.
      if (isTerminalSettleError(msg)) {
        this.finalized.add(duelId)
        return
      }
      log.error(`${shortId(duelId)}: ${msg}`)
    } finally {
      this.inFlight.delete(duelId)
    }
  }

  async sweep(): Promise<void> {
    const res = (await this.gql.query({
      query: SWEEP_QUERY,
      variables: { type: `${this.packageId}::duel::DuelCreated` },
    })) as {
      data?: {
        events?: { nodes?: Array<{ contents: { json: { duel_id: string } } }> }
      }
    }
    for (const node of res.data?.events?.nodes ?? []) {
      this.tryClose(normalizeSuiObjectId(node.contents.json.duel_id))
    }
  }

  async start(): Promise<void> {
    if (env.predictSettlementMode !== "keeper") {
      log.warn(
        `predictSettlementMode=${env.predictSettlementMode} not implemented ` +
          `(needs contract settle_card_onchain) — falling back to keeper mode`
      )
    }

    const gb = await this.client.core.getBalance({
      owner: this.address,
      coinType: "0x2::sui::SUI",
    })
    const total = BigInt(gb.balance?.balance ?? "0")
    log.info(`address ${this.address}`)
    log.info(`balance ${(Number(total) / 1e9).toFixed(4)} SUI`)
    if (total < 50_000_000n) {
      log.warn("balance < 0.05 SUI; fund the keeper wallet")
    }
    log.info(`polling every ${env.keeperPollIntervalMs}ms`)

    const loop = async () => {
      if (this.stopped) return
      try {
        await this.sweep()
      } catch (e) {
        log.error(`sweep: ${e instanceof Error ? e.message : String(e)}`)
      }
      setTimeout(loop, env.keeperPollIntervalMs)
    }
    void loop()
  }

  stop(): void {
    this.stopped = true
  }
}
