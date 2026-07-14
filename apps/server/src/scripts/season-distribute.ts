/**
 * Distribute the Season prize pool to the ranked winners — the on-chain payout
 * that replaces the manual `season:results` hand-off.
 *
 * It computes the SAME eligible winner list `season:results` prints (players in
 * MMR order with ≥ SEASON_MIN_STAKED_DUELS completed staked duels, top N by the
 * prize split), then calls the admin-only, single-shot `distribute` on
 * `season::prize_pool`. Each winner receives their SUI directly to their wallet,
 * and the tx emits a `Distributed` event — that transaction IS every winner's
 * receipt (see docs/season-prizes.md). A local receipt JSON is also written.
 *
 * SAFE BY DEFAULT: prints the plan and exits (dry run). Pass `--execute` to
 * actually submit the payout. Real funds move only with `--execute`.
 *
 * Env (apps/server/.env):
 *   SPONSOR_SECRET_KEY   bech32 key that holds the AdminCap (signs + pays gas)
 *   SEASON_PACKAGE_ID    published season package id
 *   SEASON_POOL_ID       shared PrizePool object id
 *   SEASON_ADMIN_CAP_ID  AdminCap object id (owned by SPONSOR_SECRET_KEY)
 *   DATABASE_URL         same DB the live server uses (for the winner list)
 *
 *   bun run season:distribute            # dry run — print the plan
 *   bun run season:distribute --execute  # submit the payout
 */
import { Transaction } from "@mysten/sui/transactions"
import { bcs } from "@mysten/sui/bcs"
import { MIST_PER_SUI } from "@mysten/sui/utils"

import { env, type PrizeTier } from "../env"
import { leaderboard, stakedDuelCounts, closeDb } from "../db"
import { getSuiClient, loadKeypairFromEnv } from "../lib/sui"

const SUI_TYPE = "0x2::sui::SUI"
const EXECUTE = process.argv.includes("--execute")
const NETWORK = process.env.SUI_NETWORK ?? "testnet"

function prizeForRank(split: PrizeTier[], position: number): number {
  for (const t of split) {
    if (position >= t.rankStart && position <= t.rankEnd) return t.amount
  }
  return 0
}

function short(a: string): string {
  return a.length < 12 ? a : `${a.slice(0, 6)}…${a.slice(-4)}`
}

const split = env.seasonPrizeSplit
const maxRank = Math.max(...split.map((t) => t.rankEnd))

// ── Compute the winner list (identical rule to season:results) ──────────────
const ranked = await leaderboard(1000)
const staked = await stakedDuelCounts()
const eligible = ranked
  .map((p) => ({ ...p, stakedDuels: staked.get(p.address) ?? 0 }))
  .filter((p) => p.stakedDuels >= env.seasonMinStakedDuels)

const winners = eligible
  .slice(0, maxRank)
  .map((p, i) => {
    const rank = i + 1
    const prize = prizeForRank(split, rank)
    return {
      rank,
      address: p.address,
      rating: p.rating,
      prize,
      amountMist: BigInt(Math.round(prize * Number(MIST_PER_SUI))),
    }
  })
  .filter((w) => w.prize > 0)

const totalSui = winners.reduce((s, w) => s + w.prize, 0)

console.log(`\n${env.seasonName} (${env.seasonId}) — prize distribution`)
console.log(`network: ${NETWORK} · pool: ${env.seasonPoolId ?? "(unset)"}`)
console.log(
  `${EXECUTE ? "EXECUTE" : "DRY RUN"} · ${winners.length} winner(s) · ${totalSui} ${env.seasonPrizeCurrency} total\n`
)
console.log("rank  address              rating  prize")
for (const w of winners) {
  console.log(
    `${String(w.rank).padStart(2)}    ${short(w.address).padEnd(18)}  ${String(w.rating).padStart(5)}   ${w.prize} ${env.seasonPrizeCurrency}`
  )
}
console.log("")

if (winners.length === 0) {
  console.log("no eligible winners — nothing to distribute.")
  await closeDb()
  process.exit(0)
}

if (!EXECUTE) {
  console.log("DRY RUN — re-run with --execute to submit the payout.")
  console.log(
    `Ensure the pool holds ≥ ${totalSui} ${env.seasonPrizeCurrency} first (bun run season:deposit <amount>).`
  )
  await closeDb()
  process.exit(0)
}

// ── Submit the on-chain distribution ────────────────────────────────────────
const pkg = env.seasonPackageId
const pool = env.seasonPoolId
const adminCap = env.seasonAdminCapId
if (!pkg || !pool || !adminCap) {
  throw new Error(
    "SEASON_PACKAGE_ID, SEASON_POOL_ID and SEASON_ADMIN_CAP_ID must all be set to --execute"
  )
}
const admin = loadKeypairFromEnv("SPONSOR_SECRET_KEY")
if (!admin)
  throw new Error("SPONSOR_SECRET_KEY is required (holds the AdminCap)")

const client = getSuiClient()
const tx = new Transaction()
tx.moveCall({
  target: `${pkg}::prize_pool::distribute`,
  typeArguments: [SUI_TYPE],
  arguments: [
    tx.object(adminCap),
    tx.object(pool),
    tx.pure(bcs.vector(bcs.Address).serialize(winners.map((w) => w.address))),
    tx.pure(
      bcs
        .vector(bcs.u64())
        .serialize(winners.map((w) => w.amountMist.toString()))
    ),
  ],
})

console.log("submitting distribute…")
const res = await client.signAndExecuteTransaction({
  transaction: tx,
  signer: admin,
})
if (!(res.$kind === "Transaction" && res.Transaction.status.success)) {
  throw new Error(`distribute failed: ${JSON.stringify(res)}`)
}
const digest = res.Transaction.digest
await client.waitForTransaction({ digest })

// ── Write the canonical receipt file ────────────────────────────────────────
const receipt = {
  season: { id: env.seasonId, name: env.seasonName, endsAt: env.seasonEndsAt },
  network: NETWORK,
  packageId: pkg,
  poolId: pool,
  txDigest: digest,
  distributedAt: new Date().toISOString(),
  currency: env.seasonPrizeCurrency,
  total: totalSui,
  winners: winners.map((w) => ({
    rank: w.rank,
    address: w.address,
    rating: w.rating,
    prize: w.prize,
    amountMist: w.amountMist.toString(),
    account: `https://suiscan.xyz/${NETWORK}/account/${w.address}`,
  })),
}
const outDir = `${import.meta.dir}/../../../contracts/season/distributions`
const outPath = `${outDir}/${env.seasonId}-${digest}.json`
await Bun.write(outPath, JSON.stringify(receipt, null, 2) + "\n")

console.log(
  `\ndistributed ${totalSui} ${env.seasonPrizeCurrency} to ${winners.length} winner(s).`
)
console.log(`digest:   ${digest}`)
console.log(`explorer: https://suiscan.xyz/${NETWORK}/tx/${digest}`)
console.log(`receipt:  ${outPath}`)

await closeDb()
