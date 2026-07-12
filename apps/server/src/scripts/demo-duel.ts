// LEGACY 4-16 diagnostic — not migrated to 6-24 (see Plan 2)
/**
 * Move-level DeepBook integration demo.
 *
 * Picks a settled BTC `OracleSVI` from DeepBook Predict on testnet, builds a
 * flicky duel referencing it, both players swipe via `record_swipe`, and we
 * settle + finalize using DeepBook's `settlement_price()`. Proves the full
 * Move-level integration: our `duel.move` reads `&deepbook_predict::oracle::OracleSVI`
 * spot/forward via the on-chain package, and our `settle_card` pulls the
 * canonical settlement price from DeepBook.
 *
 * Notes:
 * - Since all testnet BTC oracles are already settled, swipes execute against
 *   `ttl_ms == 0` and `p_swiped` clamps to 50%. Cards still score correctly
 *   based on the settlement price vs each strike.
 * - For a live (active) demo, run when a fresh BTC oracle has been created
 *   (DeepBook rotates every ~15min during operating hours).
 *
 * Usage (from apps/server):
 *   bun run src/scripts/demo-duel-deepbook.ts
 */
import { Transaction } from "@mysten/sui/transactions"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { SUI_CLOCK_OBJECT_ID, normalizeSuiObjectId } from "@mysten/sui/utils"
import {
  getAdminKeypair,
  getGraphQLClient,
  getSuiClient,
  requireEnv,
} from "../lib/sui"

const DEEPBOOK_PREDICT_PACKAGE =
  "0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138"
const STAKE_MIST = 10_000_000n // 0.01 SUI per side
const CHALLENGER_FUND_MIST = 100_000_000n // 0.1 SUI

function fmtSui(mist: bigint | number): string {
  return `${(Number(mist) / 1e9).toFixed(4)} SUI`
}

function fmtUsd(n9: bigint): string {
  return `$${(Number(n9) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
}

function fmtScore(s: bigint): string {
  return (Number(s) / 1e9).toFixed(3)
}

interface OracleSVIInfo {
  id: string
  spot: bigint
  forward: bigint
  expiry: bigint
  settled: boolean
  settlementPrice: bigint | null
}

async function findLatestOracle(): Promise<OracleSVIInfo> {
  const client = getSuiClient()
  // gRPC has no filtered event API — discover via GraphQL (mirrors keeper.ts /
  // indexer.ts). `last: N` returns the N most-recent events in ASCENDING order,
  // so reverse to scan newest-first (the old `order: "descending"` semantics).
  const res = (await getGraphQLClient().query({
    query: `query Ev($type: String!) {
      events(filter: { type: $type }, last: 10) {
        nodes { contents { json } }
      }
    }`,
    variables: { type: `${DEEPBOOK_PREDICT_PACKAGE}::registry::OracleCreated` },
  })) as {
    data?: {
      events?: {
        nodes?: Array<{ contents: { json: Record<string, unknown> } }>
      }
    }
  }
  const nodes = [...(res.data?.events?.nodes ?? [])].reverse()
  for (const node of nodes) {
    const parsed = node.contents.json as {
      oracle_id: string
      underlying_asset: string
    }
    if (parsed.underlying_asset !== "BTC") continue
    const obj = await client.core.getObject({
      objectId: parsed.oracle_id,
      include: { json: true },
    })
    // gRPC json flattens the Move struct: `prices.spot` (not `prices.fields.spot`),
    // and Option<u64> `settlement_price` is a bare string, `{fields:{vec:[…]}}`,
    // or null (same shapes keeper.ts readOracleSettled handles).
    const f = obj.object?.json as
      | {
          prices: { spot: string; forward: string }
          expiry: string
          settlement_price: string | null | { fields?: { vec?: string[] } }
        }
      | undefined
    if (!f) continue
    let settlementPrice: bigint | null = null
    if (typeof f.settlement_price === "string") {
      settlementPrice = BigInt(f.settlement_price)
    } else if (f.settlement_price && typeof f.settlement_price === "object") {
      const vec = f.settlement_price.fields?.vec ?? []
      if (vec.length > 0) settlementPrice = BigInt(vec[0])
    }
    return {
      id: normalizeSuiObjectId(parsed.oracle_id),
      spot: BigInt(f.prices.spot),
      forward: BigInt(f.prices.forward),
      expiry: BigInt(f.expiry),
      settled: settlementPrice !== null,
      settlementPrice,
    }
  }
  throw new Error("no recent BTC OracleSVI found")
}

async function main() {
  const packageId = requireEnv("FLICKY_PACKAGE_ID")
  const client = getSuiClient()
  const admin = getAdminKeypair()
  const adminAddr = admin.toSuiAddress()
  const challenger = new Ed25519Keypair()
  const challengerAddr = challenger.toSuiAddress()
  console.log(`flicky package:  ${packageId}`)
  console.log(`admin (creator): ${adminAddr}`)
  console.log(`challenger:      ${challengerAddr}`)

  console.log("\nfinding latest BTC OracleSVI on DeepBook…")
  const oracle = await findLatestOracle()
  console.log(`oracle:         ${oracle.id}`)
  console.log(`  forward:      ${fmtUsd(oracle.forward)}`)
  console.log(`  spot:         ${fmtUsd(oracle.spot)}`)
  console.log(
    `  expiry:       ${new Date(Number(oracle.expiry)).toISOString()}`
  )
  console.log(
    `  settled:      ${oracle.settled}${oracle.settlementPrice !== null ? ` @ ${fmtUsd(oracle.settlementPrice)}` : ""}`
  )
  if (!oracle.settled) {
    throw new Error(
      "oracle is still active; this script demos the settled flow. wait or use a settled one."
    )
  }

  // Fund challenger.
  {
    const tx = new Transaction()
    const [c] = tx.splitCoins(tx.gas, [tx.pure.u64(CHALLENGER_FUND_MIST)])
    tx.transferObjects([c], tx.pure.address(challengerAddr))
    const res = await client.signAndExecuteTransaction({
      transaction: tx,
      signer: admin,
    })
    if (!(res.$kind === "Transaction" && res.Transaction.status.success)) {
      throw new Error("fund failed")
    }
    await client.waitForTransaction({ digest: res.Transaction.digest })
    console.log(`\nfunded challenger with ${fmtSui(CHALLENGER_FUND_MIST)}`)
  }

  // Build strikes around the settlement price so winning/losing splits across cards.
  const ref = oracle.settlementPrice ?? oracle.forward
  const pcts = [95n, 98n, 100n, 102n, 105n]
  const strikes = pcts.map((pct) => (ref * pct) / 100n)
  console.log(`\ndeck strikes (BTC):`)
  for (const s of strikes) console.log(`  ${fmtUsd(s)}`)

  // Create duel — one new_card per strike on the same OracleSVI.
  let duelId: string
  {
    const tx = new Transaction()
    const [stake] = tx.splitCoins(tx.gas, [tx.pure.u64(STAKE_MIST)])
    const cards = strikes.map((strike) =>
      tx.moveCall({
        target: `${packageId}::duel::new_card`,
        arguments: [tx.object(oracle.id), tx.pure.u64(strike)],
      })
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
      // Need the created Duel object + its type — gRPC surfaces created objects
      // via effects.changedObjects (idOperation === "Created") and resolves each
      // id's type through objectTypes[id] (replaces v1 objectChanges).
      include: { effects: true, objectTypes: true },
    })
    if (!(res.$kind === "Transaction" && res.Transaction.status.success)) {
      const reason = res.Transaction?.status.error?.message ?? "unknown"
      throw new Error(`create_duel failed: ${reason}`)
    }
    await client.waitForTransaction({ digest: res.Transaction.digest })
    const t = res.Transaction
    const created = t.effects.changedObjects.find(
      (c) =>
        c.idOperation === "Created" &&
        (t.objectTypes[c.objectId] ?? "").includes("::duel::Duel<")
    )
    if (!created) throw new Error("Duel not found")
    duelId = normalizeSuiObjectId(created.objectId)
    console.log(
      `\nduel created: ${duelId}  (admin staked ${fmtSui(STAKE_MIST)})`
    )
  }

  // Challenger joins.
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
    })
    if (!(res.$kind === "Transaction" && res.Transaction.status.success)) {
      const reason = res.Transaction?.status.error?.message ?? "unknown"
      throw new Error(`join_duel failed: ${reason}`)
    }
    await client.waitForTransaction({ digest: res.Transaction.digest })
    console.log(`challenger joined and staked ${fmtSui(STAKE_MIST)}`)
  }

  // Both players swipe — admin UP, challenger DOWN.
  console.log("\nswipes (via record_swipe):")
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
          tx.object(oracle.id),
          tx.pure.u64(BigInt(i)),
          tx.pure.bool(isUp),
          tx.object(SUI_CLOCK_OBJECT_ID),
        ],
      })
      const res = await client.signAndExecuteTransaction({
        transaction: tx,
        signer,
      })
      if (!(res.$kind === "Transaction" && res.Transaction.status.success)) {
        const reason = res.Transaction?.status.error?.message ?? "unknown"
        throw new Error(`swipe failed (card ${i}, ${name}): ${reason}`)
      }
      await client.waitForTransaction({ digest: res.Transaction.digest })
      console.log(`  card ${i}: ${name.padEnd(10)} → ${isUp ? "UP  " : "DOWN"}`)
    }
  }

  // Settle all 5 cards via DeepBook (single PTB).
  console.log("\nsettling cards via settle_card…")
  {
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
    const res = await client.signAndExecuteTransaction({
      transaction: tx,
      signer: admin,
      // Read emitted CardSettled events directly off the execution result.
      include: { events: true },
    })
    if (!(res.$kind === "Transaction" && res.Transaction.status.success)) {
      const reason = res.Transaction?.status.error?.message ?? "unknown"
      throw new Error(`settle batch failed: ${reason}`)
    }
    await client.waitForTransaction({ digest: res.Transaction.digest })
    const settled = res.Transaction.events.filter((e) =>
      e.eventType.endsWith("::duel::CardSettled")
    )
    for (const ev of settled) {
      const p = ev.json as {
        card_idx: string
        settlement_price: string
        p0_card_score: string
        p1_card_score: string
      } | null
      if (!p) continue
      console.log(
        `  card ${p.card_idx}: strike=${fmtUsd(strikes[Number(p.card_idx)])}  ` +
          `settle=${fmtUsd(BigInt(p.settlement_price))}  ` +
          `admin=${fmtScore(BigInt(p.p0_card_score))}  ` +
          `challenger=${fmtScore(BigInt(p.p1_card_score))}`
      )
    }
  }

  // Finalize.
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
      include: { events: true },
    })
    if (!(res.$kind === "Transaction" && res.Transaction.status.success)) {
      const reason = res.Transaction?.status.error?.message ?? "unknown"
      throw new Error(`finalize failed: ${reason}`)
    }
    await client.waitForTransaction({ digest: res.Transaction.digest })
    const ev = res.Transaction.events.find((e) =>
      e.eventType.endsWith("::duel::DuelFinalized")
    )
    if (ev && ev.json) {
      const p = ev.json as {
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
        `admin score:       ${fmtScore(BigInt(p.p0_score)).padStart(8)}    payout: ${fmtSui(BigInt(p.payout_to_p0))}`
      )
      console.log(
        `challenger score:  ${fmtScore(BigInt(p.p1_score)).padStart(8)}    payout: ${fmtSui(BigInt(p.payout_to_p1))}`
      )
      console.log(`winner: ${winnerLabel}`)
    }
  }
}

await main()
