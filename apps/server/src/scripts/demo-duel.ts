/**
 * End-to-end Flicky duel demo on testnet.
 *
 * Steps:
 *   1. Generate an ephemeral "challenger" keypair, fund it from the admin
 *      with enough SUI for gas + stake.
 *   2. Create a fresh BTC oracle with a short (90s) expiry so we can settle
 *      it within the demo's runtime.
 *   3. Push an initial Pyth-sourced price.
 *   4. Build a 5-card deck (all on the same oracle, strikes around spot).
 *   5. Admin (creator) creates the duel, both players join, both swipe.
 *   6. Wait for oracle expiry, push a settlement price, settle each card,
 *      finalize.
 *   7. Print scores + payouts.
 *
 * Usage (from apps/server):
 *   bun run src/scripts/demo-duel.ts
 */
import { Transaction } from "@mysten/sui/transactions"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { SUI_CLOCK_OBJECT_ID, normalizeSuiObjectId } from "@mysten/sui/utils"
import { getAdminKeypair, getSuiClient, requireEnv } from "../lib/sui"
import { createOracles, updatePrice } from "../lib/oracle"
import { fetchPythPrices, pythPriceTo9Decimal } from "../lib/pyth"

const STAKE_MIST = 50_000_000n // 0.05 SUI per side → 0.1 SUI pot
const CHALLENGER_FUND_MIST = 200_000_000n // 0.2 SUI (covers stake + gas)
const ORACLE_TTL_MS = 90_000 // 90s, short for demo
const SETTLEMENT_FRESHNESS_MS = 120_000n // 2min window
const MAX_SPOT_DEVIATION = 200_000_000n // 20%
const VOLATILITY = 600_000_000n

function fmtSui(mist: bigint | number): string {
  return `${(Number(mist) / 1e9).toFixed(4)} SUI`
}

function fmtUsd(n9: bigint): string {
  return `$${(Number(n9) / 1e9).toFixed(2)}`
}

function fmtScore(s: bigint): string {
  return `${(Number(s) / 1e9).toFixed(3)}`
}

async function waitFor(client: ReturnType<typeof getSuiClient>, digest: string) {
  await client.waitForTransaction({ digest })
}

async function main() {
  const packageId = requireEnv("FLICKY_PACKAGE_ID")
  const adminCapId = requireEnv("ORACLE_ADMIN_CAP_ID")
  const client = getSuiClient()
  const admin = getAdminKeypair()
  const adminAddr = admin.toSuiAddress()
  console.log(`admin (creator): ${adminAddr}`)

  // 1. Ephemeral challenger.
  const challenger = new Ed25519Keypair()
  const challengerAddr = challenger.toSuiAddress()
  console.log(`challenger:      ${challengerAddr}`)

  // 2. Fund challenger.
  {
    const tx = new Transaction()
    const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(CHALLENGER_FUND_MIST)])
    tx.transferObjects([coin], tx.pure.address(challengerAddr))
    const res = await client.signAndExecuteTransaction({
      transaction: tx,
      signer: admin,
      options: { showEffects: true },
    })
    if (res.effects?.status.status !== "success") {
      throw new Error(`fund challenger failed: ${JSON.stringify(res.effects?.status)}`)
    }
    await waitFor(client, res.digest)
    console.log(`funded challenger with ${fmtSui(CHALLENGER_FUND_MIST)}`)
  }

  // 3. Fresh short-TTL BTC oracle.
  const prices = await fetchPythPrices(["BTC"])
  const spot9 = pythPriceTo9Decimal(prices.BTC)
  const minStrike = spot9 / 2n
  const tickSize = spot9 / 100n
  const numTicks = 100n

  const oracleIds = await createOracles(
    { packageId, adminCapId, client, keypair: admin },
    [
      {
        asset: "BTC",
        expiryMs: BigInt(Date.now() + ORACLE_TTL_MS),
        minStrike,
        tickSize,
        numTicks,
        settlementFreshnessMs: SETTLEMENT_FRESHNESS_MS,
        maxSpotDeviation: MAX_SPOT_DEVIATION,
      },
    ],
  )
  const oracleId = oracleIds.BTC
  console.log(`fresh BTC oracle: ${oracleId}  (spot=${fmtUsd(spot9)})`)

  // 4. Seed price + build deck.
  await updatePrice(
    { packageId, adminCapId, client, keypair: admin },
    oracleId,
    {
      spot: spot9,
      forward: spot9,
      volatility: VOLATILITY,
      sourceTimestampMs: BigInt(prices.BTC.publishTimeMs),
    },
  )
  console.log("oracle seeded with initial price")

  // 5 strikes: 90%, 95%, 100% (ATM), 105%, 110% of spot, snapped to tick grid.
  const targetPcts = [90n, 95n, 100n, 105n, 110n]
  const strikes = targetPcts.map((pct) => {
    const raw = (spot9 * pct) / 100n
    const stepsFromMin = (raw - minStrike) / tickSize
    return minStrike + stepsFromMin * tickSize
  })
  console.log(`deck strikes: ${strikes.map((s) => fmtUsd(s)).join(", ")}`)

  // 5. Create duel as admin.
  let duelId: string
  {
    const tx = new Transaction()
    const [stake] = tx.splitCoins(tx.gas, [tx.pure.u64(STAKE_MIST)])
    const cards = strikes.map((strike) =>
      tx.moveCall({
        target: `${packageId}::duel::new_card`,
        arguments: [tx.object(oracleId), tx.pure.u64(strike)],
      }),
    )
    tx.moveCall({
      target: `${packageId}::duel::create_duel`,
      typeArguments: ["0x2::sui::SUI"],
      arguments: [stake, tx.makeMoveVec({ type: `${packageId}::duel::Card`, elements: cards })],
    })
    const res = await client.signAndExecuteTransaction({
      transaction: tx,
      signer: admin,
      options: { showObjectChanges: true, showEffects: true },
    })
    if (res.effects?.status.status !== "success") {
      throw new Error(`create_duel failed: ${JSON.stringify(res.effects?.status)}`)
    }
    await waitFor(client, res.digest)
    const created = res.objectChanges?.find(
      (c) => c.type === "created" && c.objectType.includes("::duel::Duel<"),
    )
    if (!created || created.type !== "created") {
      throw new Error("Duel object not found in objectChanges")
    }
    duelId = normalizeSuiObjectId(created.objectId)
    console.log(`duel created: ${duelId}  (admin staked ${fmtSui(STAKE_MIST)})`)
  }

  // 6. Challenger joins.
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
    if (res.effects?.status.status !== "success") {
      throw new Error(`join_duel failed: ${JSON.stringify(res.effects?.status)}`)
    }
    await waitFor(client, res.digest)
    console.log(`challenger joined and staked ${fmtSui(STAKE_MIST)}`)
  }

  // 7. Both players swipe all 5 cards. Admin = always UP, challenger = always DOWN
  // so exactly one of them is correct on every card.
  console.log("\nswipes:")
  for (let i = 0; i < 5; i++) {
    for (const [name, signer, isUp] of [
      ["admin", admin, true],
      ["challenger", challenger, false],
    ] as const) {
      const tx = new Transaction()
      tx.moveCall({
        target: `${packageId}::duel::record_swipe`,
        typeArguments: ["0x2::sui::SUI"],
        arguments: [
          tx.object(duelId),
          tx.object(oracleId),
          tx.pure.u64(BigInt(i)),
          tx.pure.bool(isUp),
          tx.object(SUI_CLOCK_OBJECT_ID),
        ],
      })
      const res = await client.signAndExecuteTransaction({
        transaction: tx,
        signer,
        options: { showEffects: true },
      })
      if (res.effects?.status.status !== "success") {
        throw new Error(`record_swipe failed (card ${i}, ${name}): ${JSON.stringify(res.effects?.status)}`)
      }
      await waitFor(client, res.digest)
      console.log(`  card ${i}: ${name.padEnd(10)} → ${isUp ? "UP  " : "DOWN"}`)
    }
  }

  // 8. Wait for oracle expiry.
  const waitMs = ORACLE_TTL_MS + 5_000
  console.log(`\nwaiting ${(waitMs / 1000).toFixed(0)}s for oracle to expire…`)
  await Bun.sleep(waitMs)

  // 9. Settle oracle with a fresh Pyth price. We pick the live price now —
  // strikes were at 90%/95%/100%/105%/110% so we'll typically get a mix of
  // UP/DOWN correctness.
  const finalPrices = await fetchPythPrices(["BTC"])
  const settlementPrice = pythPriceTo9Decimal(finalPrices.BTC)
  console.log(`settlement price: ${fmtUsd(settlementPrice)}`)

  {
    const tx = new Transaction()
    tx.moveCall({
      target: `${packageId}::oracle::settle`,
      arguments: [
        tx.object(oracleId),
        tx.object(adminCapId),
        tx.pure.u64(settlementPrice),
        tx.pure.u64(BigInt(finalPrices.BTC.publishTimeMs)),
        tx.object(SUI_CLOCK_OBJECT_ID),
      ],
    })
    const res = await client.signAndExecuteTransaction({
      transaction: tx,
      signer: admin,
      options: { showEffects: true },
    })
    if (res.effects?.status.status !== "success") {
      throw new Error(`oracle settle failed: ${JSON.stringify(res.effects?.status)}`)
    }
    await waitFor(client, res.digest)
    console.log("oracle settled")
  }

  // 10. Settle all 5 cards (single PTB).
  {
    const tx = new Transaction()
    for (let i = 0; i < 5; i++) {
      tx.moveCall({
        target: `${packageId}::duel::settle_card`,
        typeArguments: ["0x2::sui::SUI"],
        arguments: [tx.object(duelId), tx.object(oracleId), tx.pure.u64(BigInt(i))],
      })
    }
    const res = await client.signAndExecuteTransaction({
      transaction: tx,
      signer: admin,
      options: { showEffects: true, showEvents: true },
    })
    if (res.effects?.status.status !== "success") {
      throw new Error(`settle_card batch failed: ${JSON.stringify(res.effects?.status)}`)
    }
    await waitFor(client, res.digest)
    const settled =
      res.events?.filter((e) => e.type.endsWith("::duel::CardSettled")) ?? []
    console.log("\ncard settlement scores:")
    for (const ev of settled) {
      const p = ev.parsedJson as {
        card_idx: string
        settlement_price: string
        p0_card_score: string
        p1_card_score: string
      }
      console.log(
        `  card ${p.card_idx}: strike=${fmtUsd(strikes[Number(p.card_idx)])}` +
          `  admin=${fmtScore(BigInt(p.p0_card_score))}` +
          `  challenger=${fmtScore(BigInt(p.p1_card_score))}`,
      )
    }
  }

  // 11. Finalize.
  {
    const tx = new Transaction()
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
    if (res.effects?.status.status !== "success") {
      throw new Error(`finalize failed: ${JSON.stringify(res.effects?.status)}`)
    }
    await waitFor(client, res.digest)
    const ev = res.events?.find((e) => e.type.endsWith("::duel::DuelFinalized"))
    if (ev) {
      const p = ev.parsedJson as {
        p0_score: string
        p1_score: string
        winner: string
        payout_to_p0: string
        payout_to_p1: string
      }
      const winnerLabel =
        p.winner === adminAddr
          ? "admin"
          : p.winner === challengerAddr
            ? "challenger"
            : "tie"
      console.log("\n=== RESULT ===")
      console.log(
        `admin score:       ${fmtScore(BigInt(p.p0_score)).padStart(8)}    payout: ${fmtSui(BigInt(p.payout_to_p0))}`,
      )
      console.log(
        `challenger score:  ${fmtScore(BigInt(p.p1_score)).padStart(8)}    payout: ${fmtSui(BigInt(p.payout_to_p1))}`,
      )
      console.log(`winner: ${winnerLabel}`)
    }
  }
}

await main()
