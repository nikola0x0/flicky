/**
 * End-to-end test against live Sui testnet.
 *
 * Exercises the post-join lifecycle (create → join → settle_card × 5 →
 * finalize) against a real settled BTC `OracleSVI` from DeepBook Predict.
 * Asserts the tie-refund path: both players skip swipes ⇒ scores are
 * 0/0 ⇒ each receives their original stake back.
 *
 * Why no `record_swipe` step here: the Move contract correctly refuses to
 * record swipes against an already-settled oracle (`EOracleNotLive`). The
 * scoring + speed-multiplier logic is exhaustively covered by the Move
 * unit suite under `apps/contracts/tests/duel_tests.move` against a
 * mocked-active oracle. This test instead validates the chain-level
 * integration: TS signs PTBs → testnet executes → events emit → the
 * payout balances reconcile.
 *
 * Required env (in apps/server/.env.local):
 *   - ADMIN_SECRET_KEY (suiprivkey1…) — the test creator + funder
 *   - SUI_NETWORK=testnet (default)
 *
 * Requirements:
 *   - admin wallet holds ≥ 0.3 testnet SUI
 *   - at least one SETTLED BTC OracleSVI exists on DeepBook Predict
 *
 * Skipped when ADMIN_SECRET_KEY is unset so default `bun test` runs in
 * CI (no secrets) stay green.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { Transaction } from "@mysten/sui/transactions"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography"
import { SUI_CLOCK_OBJECT_ID, normalizeSuiObjectId } from "@mysten/sui/utils"
import type { SuiJsonRpcClient } from "@mysten/sui/jsonRpc"
import { getSuiClient } from "../lib/sui"

const DEEPBOOK_PREDICT_PACKAGE =
  "0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138"
const STAKE_MIST = 10_000_000n // 0.01 SUI per side
const CHALLENGER_FUND_MIST = 200_000_000n // 0.2 SUI

interface OracleSVI {
  id: string
  spot: bigint
  forward: bigint
  expiry: bigint
  settlementPrice: bigint | null
}

interface DeployedJson {
  packageId: string | null
}

const adminKey = process.env.ADMIN_SECRET_KEY
const hasAdmin = typeof adminKey === "string" && adminKey.startsWith("suiprivkey1")

function loadPackageId(): string | null {
  try {
    const path = resolve(import.meta.dir, "../../../contracts/deployed.json")
    const deployed = JSON.parse(readFileSync(path, "utf-8")) as DeployedJson
    return deployed.packageId
  } catch {
    return null
  }
}

async function findSettledBtcOracle(client: SuiJsonRpcClient): Promise<OracleSVI | null> {
  const evts = await client.queryEvents({
    query: { MoveEventType: `${DEEPBOOK_PREDICT_PACKAGE}::registry::OracleCreated` },
    limit: 30,
    order: "descending",
  })
  for (const e of evts.data) {
    const parsed = e.parsedJson as { oracle_id: string; underlying_asset: string }
    if (parsed.underlying_asset !== "BTC") continue
    const obj = await client.getObject({
      id: parsed.oracle_id,
      options: { showContent: true },
    })
    if (obj.data?.content?.dataType !== "moveObject") continue
    const f = obj.data.content.fields as {
      prices: { fields: { spot: string; forward: string } }
      expiry: string
      settlement_price:
        | string
        | null
        | { fields: { vec: string[] } }
    }
    let settlementPrice: bigint | null = null
    if (typeof f.settlement_price === "string") {
      settlementPrice = BigInt(f.settlement_price)
    } else if (f.settlement_price && typeof f.settlement_price === "object") {
      const vec = f.settlement_price.fields?.vec ?? []
      if (vec.length > 0) settlementPrice = BigInt(vec[0])
    }
    if (settlementPrice === null) continue // skip unsettled
    return {
      id: normalizeSuiObjectId(parsed.oracle_id),
      spot: BigInt(f.prices.fields.spot),
      forward: BigInt(f.prices.fields.forward),
      expiry: BigInt(f.expiry),
      settlementPrice,
    }
  }
  return null
}

const describeFn = hasAdmin ? describe : describe.skip

describeFn("e2e duel against testnet", () => {
  let client: SuiJsonRpcClient
  let packageId: string
  let admin: Ed25519Keypair
  let challenger: Ed25519Keypair
  let adminAddr: string
  let challengerAddr: string
  let oracle: OracleSVI | null = null
  let duelId: string | null = null

  beforeAll(async () => {
    const pkg = loadPackageId()
    if (!pkg) throw new Error("apps/contracts/deployed.json missing packageId — publish first")
    packageId = pkg
    client = getSuiClient()
    const { secretKey } = decodeSuiPrivateKey(adminKey!)
    admin = Ed25519Keypair.fromSecretKey(secretKey)
    challenger = new Ed25519Keypair()
    adminAddr = admin.toSuiAddress()
    challengerAddr = challenger.toSuiAddress()
    console.log(`flicky package:  ${packageId}`)
    console.log(`admin:           ${adminAddr}`)
    console.log(`challenger:      ${challengerAddr}`)
  })

  test(
    "discovers a settled BTC OracleSVI",
    async () => {
      const found = await findSettledBtcOracle(client)
      if (!found) {
        console.log("no settled BTC OracleSVI on testnet — skipping rest of suite")
        return
      }
      oracle = found
      expect(oracle.settlementPrice).not.toBeNull()
      expect(oracle.forward).toBeGreaterThan(0n)
      console.log(
        `oracle ${oracle.id} settled @ $${(Number(oracle.settlementPrice!) / 1e9).toFixed(2)}`,
      )
    },
    30_000,
  )

  test(
    "admin funds challenger",
    async () => {
      if (!oracle) return
      const tx = new Transaction()
      const [c] = tx.splitCoins(tx.gas, [tx.pure.u64(CHALLENGER_FUND_MIST)])
      tx.transferObjects([c], tx.pure.address(challengerAddr))
      const res = await client.signAndExecuteTransaction({
        transaction: tx,
        signer: admin,
        options: { showEffects: true },
      })
      expect(res.effects?.status.status).toBe("success")
      await client.waitForTransaction({ digest: res.digest })
    },
    30_000,
  )

  test(
    "admin creates duel referencing the settled oracle",
    async () => {
      if (!oracle) return
      // Strikes anywhere on the grid; they don't affect the tie-flow.
      const ref = oracle.settlementPrice!
      const strikes = [70n, 80n, 90n, 100n, 110n].map((p) => (ref * p) / 100n)

      const tx = new Transaction()
      const [stake] = tx.splitCoins(tx.gas, [tx.pure.u64(STAKE_MIST)])
      const cards = strikes.map((strike) =>
        tx.moveCall({
          target: `${packageId}::duel::new_card`,
          arguments: [tx.object(oracle!.id), tx.pure.u64(strike)],
        }),
      )
      tx.moveCall({
        target: `${packageId}::duel::create_duel`,
        typeArguments: ["0x2::sui::SUI"],
        arguments: [
          stake,
          tx.makeMoveVec({ type: `${packageId}::duel::Card`, elements: cards }),
        ],
      })
      const res = await client.signAndExecuteTransaction({
        transaction: tx,
        signer: admin,
        options: { showObjectChanges: true, showEffects: true },
      })
      expect(res.effects?.status.status).toBe("success")
      await client.waitForTransaction({ digest: res.digest })

      const created = res.objectChanges?.find(
        (c) => c.type === "created" && c.objectType.includes("::duel::Duel<"),
      )
      expect(created?.type).toBe("created")
      if (created?.type !== "created") throw new Error("no Duel object created")
      duelId = normalizeSuiObjectId(created.objectId)
      console.log(`duel: ${duelId}`)
    },
    60_000,
  )

  test(
    "swipe against settled oracle is correctly rejected (EOracleNotLive)",
    async () => {
      if (!oracle || !duelId) return
      // First, challenger must join to flip status → ACTIVE.
      {
        const tx = new Transaction()
        const [stake] = tx.splitCoins(tx.gas, [tx.pure.u64(STAKE_MIST)])
        tx.moveCall({
          target: `${packageId}::duel::join_duel`,
          typeArguments: ["0x2::sui::SUI"],
          arguments: [tx.object(duelId), stake, tx.object(SUI_CLOCK_OBJECT_ID)],
        })
        const res = await client.signAndExecuteTransaction({
          transaction: tx,
          signer: challenger,
          options: { showEffects: true },
        })
        expect(res.effects?.status.status).toBe("success")
        await client.waitForTransaction({ digest: res.digest })
      }

      // Now try to swipe. The contract should abort with EOracleNotLive
      // because oracle.status(clock) is SETTLED, not ACTIVE.
      const tx = new Transaction()
      tx.moveCall({
        target: `${packageId}::duel::record_swipe`,
        typeArguments: ["0x2::sui::SUI"],
        arguments: [
          tx.object(duelId),
          tx.object(oracle.id),
          tx.pure.u64(0n),
          tx.pure.bool(true),
          tx.object(SUI_CLOCK_OBJECT_ID),
        ],
      })

      let aborted = false
      try {
        await client.signAndExecuteTransaction({
          transaction: tx,
          signer: admin,
          options: { showEffects: true },
        })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        // EOracleNotLive is u64 = 14 in duel.move
        expect(msg).toMatch(/MoveAbort.*duel.*record_swipe.*14|14\)|EOracleNotLive/i)
        aborted = true
      }
      expect(aborted).toBe(true)
    },
    60_000,
  )

  test(
    "settle 5 cards + finalize → tie (no swipes ⇒ both scores 0)",
    async () => {
      if (!oracle || !duelId) return
      const tx = new Transaction()
      for (let i = 0; i < 5; i++) {
        tx.moveCall({
          target: `${packageId}::duel::settle_card`,
          typeArguments: ["0x2::sui::SUI"],
          arguments: [
            tx.object(duelId),
            tx.object(oracle.id),
            tx.pure.u64(BigInt(i)),
          ],
        })
      }
      tx.moveCall({
        target: `${packageId}::duel::finalize`,
        typeArguments: ["0x2::sui::SUI"],
        arguments: [tx.object(duelId)],
      })
      const res = await client.signAndExecuteTransaction({
        transaction: tx,
        signer: admin,
        options: { showEffects: true, showEvents: true },
      })
      expect(res.effects?.status.status).toBe("success")
      await client.waitForTransaction({ digest: res.digest })

      const cardEvents =
        res.events?.filter((e) => e.type.endsWith("::duel::CardSettled")) ?? []
      expect(cardEvents).toHaveLength(5)
      // No swipes were recorded; each card_score == 0 for both players.
      for (const ev of cardEvents) {
        const p = ev.parsedJson as { p0_card_score: string; p1_card_score: string }
        expect(BigInt(p.p0_card_score)).toBe(0n)
        expect(BigInt(p.p1_card_score)).toBe(0n)
      }

      const ev = res.events?.find((e) => e.type.endsWith("::duel::DuelFinalized"))
      expect(ev).toBeDefined()
      const p = ev!.parsedJson as {
        p0_score: string
        p1_score: string
        winner: string
        payout_to_p0: string
        payout_to_p1: string
      }
      // Both scores 0 ⇒ tie ⇒ each player gets back their own stake.
      expect(BigInt(p.p0_score)).toBe(0n)
      expect(BigInt(p.p1_score)).toBe(0n)
      // winner is @0x0 (normalized 64-char hex) on a tie.
      expect(p.winner).toMatch(/^0x0+$/)
      expect(BigInt(p.payout_to_p0)).toBe(STAKE_MIST)
      expect(BigInt(p.payout_to_p1)).toBe(STAKE_MIST)
      console.log(
        `tie: each player refunded ${(Number(STAKE_MIST) / 1e9).toFixed(4)} SUI`,
      )
    },
    60_000,
  )

  afterAll(async () => {
    // Return whatever the challenger has left to admin so testnet SUI
    // doesn't pile up in throwaway keypairs across runs.
    if (!hasAdmin) return
    try {
      const balance = await client.getBalance({ owner: challengerAddr })
      const total = BigInt(balance.totalBalance)
      if (total <= 2_000_000n) return
      const tx = new Transaction()
      tx.setGasBudget(2_000_000n)
      tx.transferObjects([tx.gas], tx.pure.address(adminAddr))
      const res = await client.signAndExecuteTransaction({
        transaction: tx,
        signer: challenger,
        options: { showEffects: true },
      })
      if (res.effects?.status.status === "success") {
        await client.waitForTransaction({ digest: res.digest })
      }
    } catch {
      // best-effort
    }
  })
})
