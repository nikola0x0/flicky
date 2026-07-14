/**
 * Fund the on-chain Season prize pool (`season::prize_pool`).
 *
 * Sends SUI into the shared `PrizePool<SUI>` via the permissionless `deposit`
 * entry. Anyone can top the pool up; here the funder is the sponsor/admin
 * wallet (`SPONSOR_SECRET_KEY`, which also holds the `AdminCap`). The prize
 * SUI is split off the funder's gas coin, so the wallet just needs enough SUI
 * for the deposit + gas.
 *
 * Env (apps/server/.env):
 *   SPONSOR_SECRET_KEY   bech32 suiprivkey1… — funder (pays the SUI + gas)
 *   SEASON_PACKAGE_ID    published season package id
 *   SEASON_POOL_ID       shared PrizePool object id (from create_pool)
 *   SUI_NETWORK / SUI_GRPC_URL   which network to hit (default testnet)
 *
 *   bun run season:deposit 10      # deposit 10 SUI into the pool
 *
 * Verify afterwards: the printed tx digest on the explorer, or re-run with a
 * balance read. Recoverable anytime by the admin via `withdraw_remainder`.
 */
import { Transaction } from "@mysten/sui/transactions"
import { MIST_PER_SUI } from "@mysten/sui/utils"

import { env } from "../env"
import { getSuiClient, loadKeypairFromEnv } from "../lib/sui"

const SUI_TYPE = "0x2::sui::SUI"

const amountSui = Number(process.argv[2])
if (!Number.isFinite(amountSui) || amountSui <= 0) {
  throw new Error(
    `usage: bun run season:deposit <amountSui>  (got: ${process.argv[2]})`
  )
}
const amountMist = BigInt(Math.round(amountSui * Number(MIST_PER_SUI)))

const pkg = env.seasonPackageId
const pool = env.seasonPoolId
if (!pkg || !pool) {
  throw new Error(
    "SEASON_PACKAGE_ID and SEASON_POOL_ID must be set in the environment"
  )
}

const funder = loadKeypairFromEnv("SPONSOR_SECRET_KEY")
if (!funder) {
  throw new Error("SPONSOR_SECRET_KEY is required (bech32 suiprivkey1… key)")
}
const funderAddress = funder.toSuiAddress()

const client = getSuiClient()

console.log(`network:  ${process.env.SUI_NETWORK ?? "testnet"}`)
console.log(`package:  ${pkg}`)
console.log(`pool:     ${pool}`)
console.log(`funder:   ${funderAddress}`)
console.log(`amount:   ${amountSui} SUI (${amountMist} MIST)\n`)

const tx = new Transaction()
// Split the prize SUI off the funder's gas coin, then deposit it into the pool.
const funds = tx.coin({ balance: amountMist, useGasCoin: true })
tx.moveCall({
  target: `${pkg}::prize_pool::deposit`,
  typeArguments: [SUI_TYPE],
  arguments: [tx.object(pool), funds],
})

const res = await client.signAndExecuteTransaction({
  transaction: tx,
  signer: funder,
})
if (!(res.$kind === "Transaction" && res.Transaction.status.success)) {
  throw new Error(`deposit failed: ${JSON.stringify(res)}`)
}
await client.waitForTransaction({ digest: res.Transaction.digest })

console.log(`deposited ${amountSui} SUI into the pool.`)
console.log(`digest:   ${res.Transaction.digest}`)
console.log(
  `explorer: https://suiscan.xyz/${process.env.SUI_NETWORK ?? "testnet"}/tx/${res.Transaction.digest}`
)
