/**
 * Settled-redeem keeper — runs as a background service inside the same
 * Bun process as the HTTP/WS server.
 *
 * Flow:
 *   1. Sweep recent `${packageId}::duel::DuelCreated` events.
 *   2. For each duel that's not yet COMPLETE:
 *      - If ACTIVE and not revealed, reveal the deck (deckmaster has
 *        the plaintext if anyone called /deckmaster/generate before
 *        the server restart).
 *      - If both players finished 5/5 and every card's oracle has a
 *        settlement_price, build a single PTB: finalize_multi (scores all
 *        5 cards + pays the side-pot) followed by redeem_permissionless × N
 *        (materializes each player's Predict payout). finalize runs first
 *        so it reads live positions before redeem zeroes them.
 *   3. Remember finalized duel ids so we don't re-process.
 *
 * The keeper is permissionless on chain — it just needs gas (~0.01 SUI
 * per duel closed). Disable with KEEPER_ENABLED=false to run pure
 * HTTP+WS (e.g. for staging).
 */
import { Transaction } from "@mysten/sui/transactions"
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import type { SuiClient } from "@mysten/sui/client"
import { normalizeSuiObjectId } from "@mysten/sui/utils"
import { env } from "./env"
import { fetchDeck } from "./deckmaster"
import { makeLogger, shortId } from "./log"
import { findManagerFor } from "./predict"

const log = makeLogger("keeper")

interface SwipeLite {
  isUp: boolean
  quantity: bigint
  premium: bigint
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
  cards: Array<{ oracleId: string; strike: bigint }>
  p0Swipes: (SwipeLite | null)[]
  p1Swipes: (SwipeLite | null)[]
  p0NextCardIdx: number
  p1NextCardIdx: number
  startedAtMs: bigint
}

const STATUS_MAP: Record<string, "PENDING" | "ACTIVE" | "COMPLETE"> = {
  "1": "PENDING",
  "2": "ACTIVE",
  "3": "COMPLETE",
}

export function hexFromBytes(bytes: number[] | string): string {
  if (typeof bytes === "string")
    return bytes.startsWith("0x") ? bytes.toLowerCase() : "0x" + bytes
  return "0x" + bytes.map((b) => b.toString(16).padStart(2, "0")).join("")
}

interface RawSwipe {
  fields: { is_up: boolean; quantity: string; premium: string }
}

export function parseSwipe(raw: RawSwipe | null): SwipeLite | null {
  if (raw === null) return null
  return {
    isUp: raw.fields.is_up,
    quantity: BigInt(raw.fields.quantity),
    premium: BigInt(raw.fields.premium),
  }
}

/**
 * Pure parser — extract a DuelLite from `obj.data.type` + `obj.data.content.fields`
 * as returned by `SuiClient.getObject({ showContent: true, showType: true })`.
 * Returns null if the input isn't a moveObject of the expected shape.
 * Exposed so the keeper tests can exercise it without mocking the
 * full client.
 */
export function parseDuelFromObject(
  type: string | undefined,
  fields: unknown,
): DuelLite | null {
  if (!fields || typeof fields !== "object") return null
  const f = fields as {
    id: { id: string }
    status: string
    deck_hash: number[] | string
    creator: string
    challenger: string
    p0_stake: { fields: { value: string } } | string
    p1_stake: { fields: { value: string } } | string
    cards: Array<{ fields: { oracle_id: string; strike: string } }>
    p0_swipes: Array<RawSwipe | null>
    p1_swipes: Array<RawSwipe | null>
    p0_next_card_idx: string | number
    p1_next_card_idx: string | number
    started_at_ms: string | number
  }
  if (!f.id?.id || f.status === undefined) return null
  const typeMatch = type?.match(/Duel<(.+)>$/)
  const stakeCoinType = typeMatch?.[1] ?? "0x2::sui::SUI"
  const stakeValue = (b: { fields: { value: string } } | string): bigint =>
    typeof b === "string" ? BigInt(b) : BigInt(b.fields.value)
  return {
    id: normalizeSuiObjectId(f.id.id),
    status: STATUS_MAP[String(f.status)] ?? "PENDING",
    stakeCoinType,
    deckHashHex: hexFromBytes(f.deck_hash),
    creator: f.creator,
    challenger: f.challenger,
    p0Stake: stakeValue(f.p0_stake),
    p1Stake: stakeValue(f.p1_stake),
    cards: f.cards.map((c) => ({
      oracleId: normalizeSuiObjectId(c.fields.oracle_id),
      strike: BigInt(c.fields.strike),
    })),
    p0Swipes: f.p0_swipes.map(parseSwipe),
    p1Swipes: f.p1_swipes.map(parseSwipe),
    p0NextCardIdx: f.p0_next_card_idx !== undefined ? Number(f.p0_next_card_idx) : 0,
    p1NextCardIdx: f.p1_next_card_idx !== undefined ? Number(f.p1_next_card_idx) : 0,
    startedAtMs: f.started_at_ms !== undefined ? BigInt(f.started_at_ms) : 0n,
  }
}

async function fetchDuel(client: SuiClient, id: string): Promise<DuelLite | null> {
  const obj = await client.getObject({
    id,
    options: { showContent: true, showType: true },
  })
  if (obj.data?.content?.dataType !== "moveObject") return null
  return parseDuelFromObject(obj.data.type ?? undefined, obj.data.content.fields)
}

export { type DuelLite, type SwipeLite }

async function readOracleExpiry(
  client: SuiClient,
  oracleId: string,
): Promise<bigint | null> {
  try {
    const obj = await client.getObject({
      id: oracleId,
      options: { showContent: true },
    })
    if (obj.data?.content?.dataType !== "moveObject") return null
    const f = obj.data.content.fields as { expiry: string }
    return BigInt(f.expiry)
  } catch {
    return null
  }
}

/**
 * PRD §Backend §PnL tracker says "Subscribes to Predict's settle events"
 * but the on-chain `OracleSVI` doesn't emit one — settlement is a silent
 * `settlement_price = Option::some(price)` field flip. We poll the field
 * directly via getObject; the indexer's `KEEPER_POLL_INTERVAL_MS` bounds
 * end-to-end latency. If DeepBook later adds a `Settled` event, hoist
 * this into an event tracker in `indexer.ts` instead.
 */
async function readOracleSettled(
  client: SuiClient,
  oracleId: string,
): Promise<boolean> {
  try {
    const obj = await client.getObject({
      id: oracleId,
      options: { showContent: true },
    })
    if (obj.data?.content?.dataType !== "moveObject") return false
    const f = obj.data.content.fields as {
      settlement_price: string | null | { fields: { vec: string[] } }
    }
    if (typeof f.settlement_price === "string") return true
    if (f.settlement_price && typeof f.settlement_price === "object") {
      return (f.settlement_price.fields?.vec ?? []).length > 0
    }
    return false
  } catch {
    return false
  }
}

export class Keeper {
  readonly client: SuiClient
  readonly keypair: Ed25519Keypair
  readonly packageId: string
  readonly address: string
  readonly finalized = new Set<string>()
  readonly revealed = new Set<string>()
  readonly inFlight = new Set<string>()
  private stopped = false

  constructor(client: SuiClient, keypair: Ed25519Keypair, packageId: string) {
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
    const plaintext = fetchDeck(duel.deckHashHex)
    if (!plaintext) return

    const tx = new Transaction()
    const cardArgs = plaintext.map((c) =>
      tx.moveCall({
        target: `${this.packageId}::duel::new_card`,
        arguments: [tx.object(c.oracle_id), tx.pure.u64(c.strike)],
      }),
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
      options: { showEffects: true },
    })
    if (res.effects?.status.status === "success") {
      await this.client.waitForTransaction({ digest: res.digest })
      this.revealed.add(duel.id)
      log.info(`reveal ${shortId(duel.id)} · ${shortId(res.digest)}`)
    } else {
      const reason = res.effects?.status.error ?? "unknown"
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

      // The new contract finalizes one-shot — no per-card settle. We only
      // act on the happy path: both players completed all 5 swipes AND
      // every oracle in the deck has settled (required by finalize_multi
      // and redeem_permissionless alike). Stuck / partial duels are left
      // to the players' own `refund_duel` (the server can't sign for them).
      const bothDone = duel.p0NextCardIdx === 5 && duel.p1NextCardIdx === 5
      if (!bothDone) return
      if (duel.cards.length !== 5) return

      const uniqueOracleIds = Array.from(
        new Set(duel.cards.map((c) => c.oracleId)),
      )
      for (const oid of uniqueOracleIds) {
        if (!(await readOracleSettled(this.client, oid))) return
      }

      const p0Manager = await findManagerFor(this.client, duel.creator)
      const p1Manager = await findManagerFor(this.client, duel.challenger)
      if (!p0Manager || !p1Manager) {
        log.warn(`skip ${shortId(duelId)}: missing predict manager for p0 or p1`)
        return
      }

      const expiryByOracle = new Map<string, bigint>()
      for (const oid of uniqueOracleIds) {
        const e = await readOracleExpiry(this.client, oid)
        if (e !== null) expiryByOracle.set(oid, e)
      }

      const tx = new Transaction()

      // 1) Finalize FIRST. `finalize_multi` scores each card against its
      //    own oracle's settlement_price and reads each player's LIVE
      //    PredictManager position to flag early-redeemers. It must run
      //    before any redeem in this PTB — redeeming first would zero the
      //    positions and make every swipe score as "redeemed early".
      //    oracle_i = cards[i].oracle (validated on-chain card-by-card).
      tx.moveCall({
        target: `${this.packageId}::duel::finalize_multi`,
        typeArguments: [duel.stakeCoinType],
        arguments: [
          tx.object(duelId),
          tx.object(p0Manager),
          tx.object(p1Manager),
          tx.object(duel.cards[0].oracleId),
          tx.object(duel.cards[1].oracleId),
          tx.object(duel.cards[2].oracleId),
          tx.object(duel.cards[3].oracleId),
          tx.object(duel.cards[4].oracleId),
          tx.object("0x6"),
        ],
      })

      // 2) Redeem every recorded position (both players) so their dUSDC
      //    payout materializes in their PredictManager. Predict positions
      //    are dUSDC regardless of the Duel<T> stake type. market_key takes
      //    the oracle as a *pure* ID; redeem takes it as the &OracleSVI
      //    object — different input kinds, so no dedup conflict.
      let redeemsCount = 0
      for (let i = 0; i < duel.cards.length; i++) {
        const card = duel.cards[i]
        const expiry = expiryByOracle.get(card.oracleId)
        if (expiry === undefined) continue
        for (const [mgr, swipe] of [
          [p0Manager, duel.p0Swipes[i]] as const,
          [p1Manager, duel.p1Swipes[i]] as const,
        ]) {
          if (!swipe || swipe.quantity <= 0n) continue
          const mk = tx.moveCall({
            target: `${env.deepbookPredictPackageId}::market_key::${swipe.isUp ? "up" : "down"}`,
            arguments: [
              tx.pure.id(card.oracleId),
              tx.pure.u64(expiry),
              tx.pure.u64(card.strike),
            ],
          })
          tx.moveCall({
            target: `${env.deepbookPredictPackageId}::predict::redeem_permissionless`,
            typeArguments: [env.dusdcCoinType],
            arguments: [
              tx.object(env.deepbookPredictObjectId),
              tx.object(mgr),
              tx.object(card.oracleId),
              mk,
              tx.pure.u64(swipe.quantity),
              tx.object("0x6"),
            ],
          })
          redeemsCount++
        }
      }

      const res = await this.client.signAndExecuteTransaction({
        transaction: tx,
        signer: this.keypair,
        options: { showEffects: true },
      })
      if (res.effects?.status.status !== "success") {
        const reason = res.effects?.status.error ?? "unknown"
        log.warn(`skip ${shortId(duelId)}: ${reason}`)
        return
      }
      await this.client.waitForTransaction({ digest: res.digest })
      this.finalized.add(duelId)
      log.info(
        `finalize_multi ${shortId(duelId)}` +
        (redeemsCount ? ` + ${redeemsCount} redeem(s)` : "") +
        ` · ${shortId(res.digest)}`,
      )
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // EDuelNotActive (code 2) means the duel already finalized/refunded
      // out from under us — stop retrying it.
      if (msg.includes("EDuelNotActive") || /\babort code: 2\b|\b2\)/.test(msg)) {
        this.finalized.add(duelId)
        return
      }
      log.error(`${shortId(duelId)}: ${msg}`)
    } finally {
      this.inFlight.delete(duelId)
    }
  }

  async sweep(): Promise<void> {
    const evts = await this.client.queryEvents({
      query: { MoveEventType: `${this.packageId}::duel::DuelCreated` },
      limit: 30,
      order: "descending",
    })
    for (const e of evts.data) {
      const p = e.parsedJson as { duel_id: string }
      this.tryClose(normalizeSuiObjectId(p.duel_id))
    }
  }

  async start(): Promise<void> {
    const balance = await this.client.getBalance({ owner: this.address })
    log.info(`address ${this.address}`)
    log.info(`balance ${(Number(balance.totalBalance) / 1e9).toFixed(4)} SUI`)
    if (BigInt(balance.totalBalance) < 50_000_000n) {
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
