/**
 * Settled-redeem keeper — closes the loop on duels whose oracles have settled.
 *
 * Behavior:
 *   1. Polls recent `${packageId}::duel::DuelCreated` events.
 *   2. For each duel that is still ACTIVE, reads the oracle backing
 *      card 0 (current deck builder uses a single oracle for all 5
 *      cards). If `settlement_price` is set, the keeper bundles every
 *      not-yet-settled `settle_card` + `finalize` in one PTB and signs.
 *   3. Records finalized duel ids so the same duel isn't reprocessed.
 *
 *   bun run keeper
 *
 * Required env (apps/server/.env.local):
 *   KEEPER_SECRET_KEY (or BOT_SECRET_KEY as fallback) — bech32 suiprivkey1…
 *
 * Why a separate process: matchmaking and keeping are independent
 * scalability concerns. Bot fills the entry side (joins + swipes);
 * keeper fills the exit side (settle + payout). One can run without the
 * other.
 *
 * The keeper is permissionless on chain — anyone can fire settle_card
 * and finalize. It just needs enough SUI to cover gas (~0.01 SUI per
 * duel closed).
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { Transaction } from "@mysten/sui/transactions"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography"
import { normalizeSuiObjectId } from "@mysten/sui/utils"
import type { SuiJsonRpcClient, SuiObjectResponse } from "@mysten/sui/jsonRpc"
import { getSuiClient } from "../lib/sui"

const POLL_INTERVAL_MS = Number(process.env.KEEPER_POLL_INTERVAL_MS ?? 10_000)

// DeepBook Predict + dUSDC config — env-driven so a fork or upgrade
// doesn't silently keep keeper pointed at a stale package. Mirror values
// in apps/server/.env.example (and apps/web/.env.example for the web).
function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) {
    console.error(
      `${name} is required. Copy apps/server/.env.example to apps/server/.env\n` +
        `and either keep the default testnet values or override per environment.`,
    )
    process.exit(1)
  }
  return v
}
const DEEPBOOK_PREDICT_PACKAGE = requireEnv("DEEPBOOK_PREDICT_PACKAGE_ID")
const DEEPBOOK_PREDICT_OBJECT = requireEnv("DEEPBOOK_PREDICT_OBJECT_ID")
const DUSDC_TYPE = requireEnv("DUSDC_COIN_TYPE")
const PREDICT_MANAGER_TYPE = `${DEEPBOOK_PREDICT_PACKAGE}::predict_manager::PredictManager`

interface DeployedJson {
  packageId: string | null
}

function loadPackageId(): string {
  const path = resolve(import.meta.dir, "../../../contracts/deployed.json")
  const deployed = JSON.parse(readFileSync(path, "utf-8")) as DeployedJson
  if (!deployed.packageId) {
    throw new Error("apps/contracts/deployed.json missing packageId — publish first")
  }
  return deployed.packageId
}

function loadKeeperKeypair(): Ed25519Keypair {
  const key = process.env.KEEPER_SECRET_KEY ?? process.env.BOT_SECRET_KEY
  if (!key || !key.startsWith("suiprivkey1")) {
    console.error(
      "KEEPER_SECRET_KEY (or BOT_SECRET_KEY) missing. Any funded testnet\n" +
        "wallet works — keeper functions are permissionless on chain.\n\n" +
        "  sui keytool export --key-identity $(sui client active-address)\n" +
        "and paste into apps/server/.env.local.",
    )
    process.exit(1)
  }
  const { secretKey } = decodeSuiPrivateKey(key)
  return Ed25519Keypair.fromSecretKey(secretKey)
}

interface DuelLite {
  id: string
  status: "PENDING" | "ACTIVE" | "COMPLETE"
  stakeCoinType: string
  /** sha2-256 of the committed deck, hex with 0x prefix. */
  deckHashHex: string
  creator: string
  challenger: string
  p0Stake: bigint
  p1Stake: bigint
  /** Cards from `duel.cards`. Empty until `reveal_deck` lands. */
  cards: Array<{ oracleId: string; strike: bigint }>
  cardSettlements: (bigint | null)[]
  /** Per-card direction picked by each player; null = no swipe. */
  p0Swipes: (boolean | null)[]
  p1Swipes: (boolean | null)[]
}

function hexFromBytes(bytes: number[] | string): string {
  if (typeof bytes === "string") return bytes.startsWith("0x") ? bytes.toLowerCase() : "0x" + bytes
  return "0x" + bytes.map((b) => b.toString(16).padStart(2, "0")).join("")
}

interface RawSwipe {
  fields: { is_up: boolean; p_swiped: string; decide_time_ms: string }
}

function parseDuel(obj: SuiObjectResponse): DuelLite | null {
  if (obj.data?.content?.dataType !== "moveObject") return null
  const f = obj.data.content.fields as {
    id: { id: string }
    status: string
    deck_hash: number[] | string
    creator: string
    challenger: string
    p0_stake: { fields: { value: string } } | string
    p1_stake: { fields: { value: string } } | string
    cards: Array<{ fields: { oracle_id: string; strike: string } }>
    card_settlements: Array<string | null>
    p0_swipes: Array<RawSwipe | null>
    p1_swipes: Array<RawSwipe | null>
  }
  const statusMap: Record<string, "PENDING" | "ACTIVE" | "COMPLETE"> = {
    "1": "PENDING",
    "2": "ACTIVE",
    "3": "COMPLETE",
  }
  const status = statusMap[String(f.status)] ?? "PENDING"
  // e.g. "0xpkg::duel::Duel<0x2::sui::SUI>"
  const typeMatch = obj.data.type?.match(/Duel<(.+)>$/)
  const stakeCoinType = typeMatch?.[1] ?? "0x2::sui::SUI"
  const stakeValue = (b: { fields: { value: string } } | string): bigint =>
    typeof b === "string" ? BigInt(b) : BigInt(b.fields.value)
  return {
    id: normalizeSuiObjectId(f.id.id),
    status,
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
    cardSettlements: f.card_settlements.map((s) => (s === null ? null : BigInt(s))),
    p0Swipes: f.p0_swipes.map((s) => (s === null ? null : s.fields.is_up)),
    p1Swipes: f.p1_swipes.map((s) => (s === null ? null : s.fields.is_up)),
  }
}

interface DeckmasterDeck {
  cards: Array<{ oracle_id: string; strike: string }>
  hash: string
}

async function fetchPlaintextDeck(
  baseUrl: string,
  hashHex: string,
): Promise<Array<{ oracleId: string; strike: bigint }> | null> {
  try {
    const res = await fetch(`${baseUrl}/deckmaster/reveal?hash=${hashHex}`)
    if (res.status === 404) return null
    if (!res.ok) {
      console.warn(`[deckmaster] reveal ${hashHex} → ${res.status}`)
      return null
    }
    const body = (await res.json()) as DeckmasterDeck
    return body.cards.map((c) => ({
      oracleId: c.oracle_id,
      strike: BigInt(c.strike),
    }))
  } catch (e) {
    console.warn(
      `[deckmaster] reveal fetch failed: ${e instanceof Error ? e.message : String(e)}`,
    )
    return null
  }
}

async function readOracleExpiry(
  client: SuiJsonRpcClient,
  oracleId: string,
): Promise<bigint | null> {
  try {
    const obj = await client.getObject({ id: oracleId, options: { showContent: true } })
    if (obj.data?.content?.dataType !== "moveObject") return null
    const f = obj.data.content.fields as { expiry: string }
    return BigInt(f.expiry)
  } catch {
    return null
  }
}

async function findManagerFor(
  client: SuiJsonRpcClient,
  owner: string,
): Promise<string | null> {
  try {
    const owned = await client.getOwnedObjects({
      owner,
      filter: { StructType: PREDICT_MANAGER_TYPE },
      options: { showContent: false },
    })
    const first = owned.data[0]
    if (!first?.data) return null
    return normalizeSuiObjectId(first.data.objectId)
  } catch {
    return null
  }
}

async function readOracleSettled(
  client: SuiJsonRpcClient,
  oracleId: string,
): Promise<boolean> {
  try {
    const obj = await client.getObject({ id: oracleId, options: { showContent: true } })
    if (obj.data?.content?.dataType !== "moveObject") return false
    const f = obj.data.content.fields as {
      settlement_price:
        | string
        | null
        | { fields: { vec: string[] } }
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

class Keeper {
  readonly client: SuiJsonRpcClient
  readonly keypair: Ed25519Keypair
  readonly address: string
  readonly packageId: string
  readonly deckmasterUrl: string
  readonly finalized = new Set<string>()
  readonly revealed = new Set<string>()
  readonly inFlight = new Set<string>()

  constructor(
    client: SuiJsonRpcClient,
    keypair: Ed25519Keypair,
    packageId: string,
    deckmasterUrl: string,
  ) {
    this.client = client
    this.keypair = keypair
    this.packageId = packageId
    this.deckmasterUrl = deckmasterUrl
    this.address = keypair.toSuiAddress()
  }

  /** Reveal the deck if it hasn't been revealed yet and we have plaintext. */
  async tryReveal(duel: DuelLite) {
    if (this.revealed.has(duel.id)) return
    if (duel.cards.length > 0) {
      this.revealed.add(duel.id)
      return
    }
    if (duel.status !== "ACTIVE") return // need challenger to have joined
    const plaintext = await fetchPlaintextDeck(this.deckmasterUrl, duel.deckHashHex)
    if (!plaintext) return // creator's tab will have to reveal
    const tx = new Transaction()
    const cardArgs = plaintext.map((c) =>
      tx.moveCall({
        target: `${this.packageId}::duel::new_card`,
        arguments: [tx.object(c.oracleId), tx.pure.u64(c.strike)],
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
      console.log(`[reveal] ${shortId(duel.id)} · ${shortId(res.digest)}`)
    } else {
      const reason = res.effects?.status.error ?? "unknown"
      // EDeckAlreadyRevealed = 16: race with another revealer. Mark done.
      if (reason.includes("16") || reason.includes("EDeckAlreadyRevealed")) {
        this.revealed.add(duel.id)
        return
      }
      console.warn(`[reveal-skip] ${shortId(duel.id)}: ${reason}`)
    }
  }

  async tryClose(duelId: string) {
    if (this.finalized.has(duelId) || this.inFlight.has(duelId)) return
    this.inFlight.add(duelId)
    try {
      const obj = await this.client.getObject({
        id: duelId,
        options: { showContent: true, showType: true },
      })
      const duel = parseDuel(obj)
      if (!duel) return
      if (duel.status === "COMPLETE") {
        this.finalized.add(duelId)
        return
      }
      if (duel.status !== "ACTIVE") return // PENDING — wait for join

      // Reveal first if we can (and if it hasn't happened yet).
      await this.tryReveal(duel)
      if (duel.cards.length === 0) return // still unrevealed; next poll

      // Every card's oracle must be settled before its `settle_card` will
      // succeed. Decks may span multiple oracles even if today's Deckmaster
      // picks one, so check each card individually.
      const uniqueOracleIds = Array.from(
        new Set(duel.cards.map((c) => c.oracleId)),
      )
      const oracleSettled = new Map<string, boolean>()
      for (const oid of uniqueOracleIds) {
        oracleSettled.set(oid, await readOracleSettled(this.client, oid))
      }
      if (![...oracleSettled.values()].every(Boolean)) return // wait

      // For dUSDC duels, also redeem every player's Predict position so
      // their dUSDC mint payout lands in their PredictManager. The keeper
      // signs but the payout goes to the manager's owner (permissionless).
      // Free-tier duels (stake type = SUI) skip this — no mint happened.
      const redeems: Array<{
        managerId: string
        oracleId: string
        oracleExpiry: bigint
        strike: bigint
        isUp: boolean
        quantity: bigint
      }> = []
      if (duel.stakeCoinType === DUSDC_TYPE) {
        const expiryByOracle = new Map<string, bigint>()
        for (const oid of uniqueOracleIds) {
          const e = await readOracleExpiry(this.client, oid)
          if (e !== null) expiryByOracle.set(oid, e)
        }
        // Mint quantity matches apps/web/src/App.tsx — 2% of own stake.
        const p0Quantity = (duel.p0Stake * 2n) / 100n
        const p1Quantity = (duel.p1Stake * 2n) / 100n
        const p0Manager = await findManagerFor(this.client, duel.creator)
        const p1Manager = await findManagerFor(this.client, duel.challenger)
        for (let i = 0; i < duel.cards.length; i++) {
          const card = duel.cards[i]
          const expiry = expiryByOracle.get(card.oracleId)
          if (expiry === undefined) continue
          const p0 = duel.p0Swipes[i]
          if (p0 !== null && p0Manager && p0Quantity > 0n) {
            redeems.push({
              managerId: p0Manager,
              oracleId: card.oracleId,
              oracleExpiry: expiry,
              strike: card.strike,
              isUp: p0,
              quantity: p0Quantity,
            })
          }
          const p1 = duel.p1Swipes[i]
          if (p1 !== null && p1Manager && p1Quantity > 0n) {
            redeems.push({
              managerId: p1Manager,
              oracleId: card.oracleId,
              oracleExpiry: expiry,
              strike: card.strike,
              isUp: p1,
              quantity: p1Quantity,
            })
          }
        }
      }

      // Build PTB: settle every card that isn't already settled, then
      // redeem positions (if any), then finalize. Redeems are independent
      // of settle_card so ordering doesn't matter.
      const tx = new Transaction()
      let pending = 0
      for (let i = 0; i < duel.cardSettlements.length; i++) {
        if (duel.cardSettlements[i] === null) {
          tx.moveCall({
            target: `${this.packageId}::duel::settle_card`,
            typeArguments: [duel.stakeCoinType],
            arguments: [
              tx.object(duelId),
              tx.object(duel.cards[i].oracleId),
              tx.pure.u64(BigInt(i)),
            ],
          })
          pending++
        }
      }
      for (const r of redeems) {
        const mk = tx.moveCall({
          target: `${DEEPBOOK_PREDICT_PACKAGE}::market_key::${r.isUp ? "up" : "down"}`,
          arguments: [
            tx.object(r.oracleId),
            tx.pure.u64(r.oracleExpiry),
            tx.pure.u64(r.strike),
          ],
        })
        tx.moveCall({
          target: `${DEEPBOOK_PREDICT_PACKAGE}::predict::redeem_permissionless`,
          typeArguments: [DUSDC_TYPE],
          arguments: [
            tx.object(DEEPBOOK_PREDICT_OBJECT),
            tx.object(r.managerId),
            tx.object(r.oracleId),
            mk,
            tx.pure.u64(r.quantity),
          ],
        })
      }
      tx.moveCall({
        target: `${this.packageId}::duel::finalize`,
        typeArguments: [duel.stakeCoinType],
        arguments: [tx.object(duelId)],
      })

      const res = await this.client.signAndExecuteTransaction({
        transaction: tx,
        signer: this.keypair,
        options: { showEffects: true },
      })
      if (res.effects?.status.status !== "success") {
        const reason = res.effects?.status.error ?? "unknown"
        console.warn(`[skip] ${shortId(duelId)}: ${reason}`)
        return
      }
      await this.client.waitForTransaction({ digest: res.digest })
      this.finalized.add(duelId)
      console.log(
        `[finalize] ${shortId(duelId)} — settled ${pending} card(s)` +
          (redeems.length ? ` + ${redeems.length} redeem(s)` : "") +
          ` + finalize · ${shortId(res.digest)}`,
      )
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (
        msg.includes("EDuelNotActive") ||
        msg.includes("ECardAlreadySettled") ||
        /\b2\)|\b10\)/.test(msg)
      ) {
        this.finalized.add(duelId)
        return
      }
      console.error(`[error] ${shortId(duelId)}: ${msg}`)
    } finally {
      this.inFlight.delete(duelId)
    }
  }

  async sweep() {
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
}

function shortId(id: string, len = 6): string {
  return id.length > len * 2 + 2 ? `${id.slice(0, len)}…${id.slice(-len)}` : id
}

async function main() {
  const packageId = loadPackageId()
  const keypair = loadKeeperKeypair()
  const client = getSuiClient()
  const deckmasterUrl =
    process.env.DECKMASTER_URL ?? `http://localhost:${process.env.PORT ?? 3001}`
  const keeper = new Keeper(client, keypair, packageId, deckmasterUrl)

  const balance = await client.getBalance({ owner: keeper.address })
  console.log(`flicky package: ${packageId}`)
  console.log(`keeper address: ${keeper.address}`)
  console.log(
    `keeper balance: ${(Number(balance.totalBalance) / 1e9).toFixed(4)} SUI`,
  )
  console.log(`deckmaster:     ${deckmasterUrl}`)
  console.log(`polling:        every ${POLL_INTERVAL_MS}ms\n`)

  if (BigInt(balance.totalBalance) < 50_000_000n) {
    console.warn(
      "warning: keeper balance < 0.05 SUI; fund it before duels start piling up.",
    )
  }

  await keeper.sweep()
  setInterval(() => {
    keeper.sweep().catch((e) => console.error("[poll]", e))
  }, POLL_INTERVAL_MS)
}

await main()
