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
  oracleId: string
  cardSettlements: (bigint | null)[]
}

function parseDuel(obj: SuiObjectResponse): DuelLite | null {
  if (obj.data?.content?.dataType !== "moveObject") return null
  const f = obj.data.content.fields as {
    id: { id: string }
    status: string
    cards: Array<{ fields: { oracle_id: string; strike: string } }>
    card_settlements: Array<string | null>
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
  return {
    id: normalizeSuiObjectId(f.id.id),
    status,
    stakeCoinType,
    oracleId: normalizeSuiObjectId(f.cards[0].fields.oracle_id),
    cardSettlements: f.card_settlements.map((s) => (s === null ? null : BigInt(s))),
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
  readonly finalized = new Set<string>()
  readonly inFlight = new Set<string>()

  constructor(client: SuiJsonRpcClient, keypair: Ed25519Keypair, packageId: string) {
    this.client = client
    this.keypair = keypair
    this.packageId = packageId
    this.address = keypair.toSuiAddress()
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

      const settled = await readOracleSettled(this.client, duel.oracleId)
      if (!settled) return // oracle hasn't ticked past expiry yet

      // Build PTB: settle every card that isn't already settled, then finalize.
      const tx = new Transaction()
      let pending = 0
      for (let i = 0; i < duel.cardSettlements.length; i++) {
        if (duel.cardSettlements[i] === null) {
          tx.moveCall({
            target: `${this.packageId}::duel::settle_card`,
            typeArguments: [duel.stakeCoinType],
            arguments: [
              tx.object(duelId),
              tx.object(duel.oracleId),
              tx.pure.u64(BigInt(i)),
            ],
          })
          pending++
        }
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
        // EAllCardsNotSettled = 11 (we mis-counted) or EDuelNotActive = 2
        // (someone beat us to it) — both safe to ignore on next poll.
        console.warn(`[skip] ${shortId(duelId)}: ${reason}`)
        return
      }
      await this.client.waitForTransaction({ digest: res.digest })
      this.finalized.add(duelId)
      console.log(
        `[finalize] ${shortId(duelId)} — settled ${pending} card(s) + finalize · ${shortId(res.digest)}`,
      )
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // Silence the "already finalized" and "already settled" races — they
      // happen normally if a player manually clicked the settle button.
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
  const keeper = new Keeper(client, keypair, packageId)

  const balance = await client.getBalance({ owner: keeper.address })
  console.log(`flicky package: ${packageId}`)
  console.log(`keeper address: ${keeper.address}`)
  console.log(
    `keeper balance: ${(Number(balance.totalBalance) / 1e9).toFixed(4)} SUI`,
  )
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
