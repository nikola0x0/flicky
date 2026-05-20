/**
 * Matchmaking bot — auto-joins flicky PENDING duels for single-player demos.
 *
 * Behavior:
 *   1. Subscribe to `${packageId}::duel::DuelCreated` events.
 *   2. For each PENDING duel where the stake matches a tier we serve
 *      (default: 0.01 / 0.05 / 0.1 SUI), wait BOT_JOIN_DELAY_MS, then
 *      sign + send `join_duel`.
 *   3. Once joined, watch the duel and `record_swipe` on every card the
 *      bot hasn't swiped yet. Swipe direction = a coin flip biased by
 *      `spot vs strike` (UP if spot > strike, else DOWN), so the bot
 *      plays plausibly.
 *
 *   bun run bot
 *
 * Required env (apps/server/.env.local):
 *   BOT_SECRET_KEY  — bech32 suiprivkey1… for the bot wallet
 *                     (separate from ADMIN_SECRET_KEY; needs ≥ 0.2 SUI gas).
 *
 * Skipped at startup with a clear error if BOT_SECRET_KEY missing.
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { Transaction } from "@mysten/sui/transactions"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography"
import { SUI_CLOCK_OBJECT_ID, normalizeSuiObjectId } from "@mysten/sui/utils"
import type { SuiJsonRpcClient, SuiObjectResponse } from "@mysten/sui/jsonRpc"
import { getSuiClient } from "../lib/sui"

const BOT_JOIN_DELAY_MS = Number(process.env.BOT_JOIN_DELAY_MS ?? 5_000)
const POLL_INTERVAL_MS = 2_000
// Stake tiers we'll fill (mist). Match apps/web/src/App.tsx STAKE_TIERS.
const TIER_STAKES = new Set([10_000_000n, 50_000_000n, 100_000_000n])

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

function loadBotKeypair(): Ed25519Keypair {
  const key = process.env.BOT_SECRET_KEY
  if (!key || !key.startsWith("suiprivkey1")) {
    console.error(
      "BOT_SECRET_KEY missing. Generate a bot wallet and fund ~0.2 testnet SUI:\n" +
        "  sui keytool generate ed25519 --json\n" +
        "  sui keytool export --key-identity <new-alias>\n" +
        "Paste the suiprivkey1… into apps/server/.env.local as BOT_SECRET_KEY.",
    )
    process.exit(1)
  }
  const { secretKey } = decodeSuiPrivateKey(key)
  return Ed25519Keypair.fromSecretKey(secretKey)
}

interface ParsedDuel {
  id: string
  status: "PENDING" | "ACTIVE" | "COMPLETE"
  creator: string
  challenger: string
  stake: bigint
  p1NextCardIdx: number
  cards: Array<{ oracleId: string; strike: bigint }>
}

function parseDuelObject(obj: SuiObjectResponse): ParsedDuel | null {
  if (obj.data?.content?.dataType !== "moveObject") return null
  const f = obj.data.content.fields as {
    id: { id: string }
    status: string
    cards: Array<{ fields: { oracle_id: string; strike: string } }>
    creator: string
    challenger: string
    p0_stake: { fields: { value: string } } | string
    p1_next_card_idx: string
  }
  const stake =
    typeof f.p0_stake === "string" ? BigInt(f.p0_stake) : BigInt(f.p0_stake.fields.value)
  const statusMap: Record<string, "PENDING" | "ACTIVE" | "COMPLETE"> = {
    "1": "PENDING",
    "2": "ACTIVE",
    "3": "COMPLETE",
  }
  return {
    id: normalizeSuiObjectId(f.id.id),
    status: statusMap[String(f.status)] ?? "PENDING",
    creator: f.creator,
    challenger: f.challenger,
    stake,
    p1NextCardIdx: Number(f.p1_next_card_idx),
    cards: f.cards.map((c) => ({
      oracleId: normalizeSuiObjectId(c.fields.oracle_id),
      strike: BigInt(c.fields.strike),
    })),
  }
}

async function fetchDuel(client: SuiJsonRpcClient, id: string): Promise<ParsedDuel | null> {
  const obj = await client.getObject({ id, options: { showContent: true } })
  return parseDuelObject(obj)
}

async function fetchOracleSpot(
  client: SuiJsonRpcClient,
  oracleId: string,
): Promise<bigint | null> {
  try {
    const obj = await client.getObject({ id: oracleId, options: { showContent: true } })
    if (obj.data?.content?.dataType !== "moveObject") return null
    const f = obj.data.content.fields as {
      prices: { fields: { spot: string } }
    }
    return BigInt(f.prices.fields.spot)
  } catch {
    return null
  }
}

class Bot {
  readonly client: SuiJsonRpcClient
  readonly keypair: Ed25519Keypair
  readonly address: string
  readonly packageId: string
  readonly seen = new Set<string>()
  readonly inFlight = new Set<string>()

  constructor(client: SuiJsonRpcClient, keypair: Ed25519Keypair, packageId: string) {
    this.client = client
    this.keypair = keypair
    this.packageId = packageId
    this.address = keypair.toSuiAddress()
  }

  async signAndExecute(tx: Transaction, label: string): Promise<string> {
    const res = await this.client.signAndExecuteTransaction({
      transaction: tx,
      signer: this.keypair,
      options: { showEffects: true },
    })
    if (res.effects?.status.status !== "success") {
      throw new Error(`${label} failed: ${JSON.stringify(res.effects?.status)}`)
    }
    await this.client.waitForTransaction({ digest: res.digest })
    return res.digest
  }

  async handleDuelCreated(duelId: string) {
    if (this.seen.has(duelId) || this.inFlight.has(duelId)) return
    this.seen.add(duelId)
    this.inFlight.add(duelId)
    try {
      const duel = await fetchDuel(this.client, duelId)
      if (!duel) return
      if (duel.status !== "PENDING") return
      if (duel.creator === this.address) return // don't shadow ourselves
      if (!TIER_STAKES.has(duel.stake)) {
        console.log(`[skip] ${shortId(duelId)} — stake ${duel.stake} not in tier set`)
        return
      }
      console.log(
        `[match] ${shortId(duelId)} — waiting ${BOT_JOIN_DELAY_MS}ms before join`,
      )
      await sleep(BOT_JOIN_DELAY_MS)

      // Re-check; the duel may have been joined by a human in the meantime.
      const fresh = await fetchDuel(this.client, duelId)
      if (!fresh || fresh.status !== "PENDING") {
        console.log(`[skip] ${shortId(duelId)} — already joined by someone`)
        return
      }

      // join
      const stake = fresh.stake
      const joinTx = new Transaction()
      const [coin] = joinTx.splitCoins(joinTx.gas, [joinTx.pure.u64(stake)])
      joinTx.moveCall({
        target: `${this.packageId}::duel::join_duel`,
        typeArguments: ["0x2::sui::SUI"],
        arguments: [joinTx.object(duelId), coin, joinTx.object(SUI_CLOCK_OBJECT_ID)],
      })
      const joinDigest = await this.signAndExecute(joinTx, "join_duel")
      console.log(`[join] ${shortId(duelId)} ${shortId(joinDigest)}`)

      await this.swipeAll(duelId)
    } catch (e) {
      console.error(
        `[error] ${shortId(duelId)}: ${e instanceof Error ? e.message : String(e)}`,
      )
    } finally {
      this.inFlight.delete(duelId)
    }
  }

  async swipeAll(duelId: string) {
    // Loop on the duel state; swipe each unsent card with a delay so the
    // contract's speed-multiplier brackets actually fire (and so we don't
    // race the human player's swipes).
    for (let attempt = 0; attempt < 30; attempt++) {
      const duel = await fetchDuel(this.client, duelId)
      if (!duel) return
      if (duel.status !== "ACTIVE") return // someone settled or finalized
      if (duel.p1NextCardIdx >= 5) {
        console.log(`[done-swiping] ${shortId(duelId)}`)
        return
      }
      const idx = duel.p1NextCardIdx
      const card = duel.cards[idx]
      // Small per-card jitter (1.5–4 s) keeps the bot in the 0–5s "fast"
      // bracket while still feeling alive.
      const wait = 1500 + Math.floor(Math.random() * 2500)
      await sleep(wait)

      const spot = await fetchOracleSpot(this.client, card.oracleId)
      const isUp =
        spot !== null && spot > card.strike
          ? true
          : spot !== null && spot < card.strike
            ? false
            : Math.random() > 0.5

      const tx = new Transaction()
      tx.moveCall({
        target: `${this.packageId}::duel::record_swipe`,
        typeArguments: ["0x2::sui::SUI"],
        arguments: [
          tx.object(duelId),
          tx.object(card.oracleId),
          tx.pure.u64(BigInt(idx)),
          tx.pure.bool(isUp),
          tx.object(SUI_CLOCK_OBJECT_ID),
        ],
      })
      try {
        await this.signAndExecute(tx, `record_swipe card ${idx}`)
        console.log(
          `[swipe] ${shortId(duelId)} card ${idx} ${isUp ? "UP" : "DOWN"} (spot ${spot ?? "?"}, strike ${card.strike})`,
        )
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        // EOracleNotLive = 14: oracle settled out from under us; stop.
        if (msg.includes("EOracleNotLive") || /\b14\)/.test(msg)) {
          console.log(`[abort] ${shortId(duelId)} — oracle settled mid-swipe`)
          return
        }
        // EDuelNotActive = 2: someone already finalized.
        if (msg.includes("EDuelNotActive") || /\b2\)/.test(msg)) {
          console.log(`[abort] ${shortId(duelId)} — duel no longer active`)
          return
        }
        throw e
      }
    }
  }

  async backfill() {
    // On startup, sweep recent DuelCreated events so the bot can join
    // anything still PENDING that landed before we subscribed.
    const evts = await this.client.queryEvents({
      query: { MoveEventType: `${this.packageId}::duel::DuelCreated` },
      limit: 20,
      order: "descending",
    })
    for (const e of evts.data) {
      const p = e.parsedJson as { duel_id: string }
      this.handleDuelCreated(normalizeSuiObjectId(p.duel_id))
    }
  }

  async pollOnce() {
    // Poor-man's event loop: re-query the recent feed every POLL_INTERVAL_MS.
    // Avoids subscribeEvent which the public JSON-RPC endpoints don't expose.
    const evts = await this.client.queryEvents({
      query: { MoveEventType: `${this.packageId}::duel::DuelCreated` },
      limit: 10,
      order: "descending",
    })
    for (const e of evts.data) {
      const p = e.parsedJson as { duel_id: string }
      this.handleDuelCreated(normalizeSuiObjectId(p.duel_id))
    }
  }
}

function shortId(id: string, len = 6): string {
  return id.length > len * 2 + 2 ? `${id.slice(0, len)}…${id.slice(-len)}` : id
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function main() {
  const packageId = loadPackageId()
  const keypair = loadBotKeypair()
  const client = getSuiClient()
  const bot = new Bot(client, keypair, packageId)

  const balance = await client.getBalance({ owner: bot.address })
  console.log(`flicky package: ${packageId}`)
  console.log(`bot address:    ${bot.address}`)
  console.log(`bot balance:    ${(Number(balance.totalBalance) / 1e9).toFixed(4)} SUI`)
  console.log(`tier stakes:    ${[...TIER_STAKES].join(", ")} mist`)
  console.log(`join delay:     ${BOT_JOIN_DELAY_MS}ms`)
  console.log(`polling:        every ${POLL_INTERVAL_MS}ms\n`)

  if (BigInt(balance.totalBalance) < 100_000_000n) {
    console.warn(
      "warning: bot balance < 0.1 SUI; fund the bot wallet before duels stack up.",
    )
  }

  await bot.backfill()
  setInterval(() => {
    bot.pollOnce().catch((e) => console.error("[poll]", e))
  }, POLL_INTERVAL_MS)
}

await main()
