/**
 * Deposit SUI into the sponsor's on-chain **address balance** — the balance
 * the address-balance sponsor pays gas from (empty gas payment). The faucet
 * only hands out coin *objects*, not address balance, so a fresh sponsor key
 * needs this one-time (or top-up) deposit before POST /sponsor can work.
 *
 * Mechanism: a MoveCall to `0x2::coin::send_funds<T>(coin: Coin<T>, recipient:
 * address)`, which moves a `Coin<SUI>` into the recipient's address balance.
 * The coin is split off the funder's gas coin (`useGasCoin: true`), so the
 * funder just needs a normal SUI coin from the faucet.
 *
 *   SPONSOR_SECRET_KEY   the sponsor (recipient of the address-balance deposit)
 *   FUND_FROM_SECRET_KEY optional funder (defaults to SPONSOR_SECRET_KEY, i.e.
 *                        self-fund from the sponsor's own faucet coins)
 *
 * Reads SUI_NETWORK / SUI_GRPC_URL from the environment (apps/server/.env).
 *
 *   bun run fund:sponsor          # deposit 1 SUI into the sponsor address balance
 *   bun run fund:sponsor 5        # deposit 5 SUI
 */
import { Transaction } from "@mysten/sui/transactions"
import { MIST_PER_SUI } from "@mysten/sui/utils"

import { getSuiClient, loadKeypairFromEnv } from "../lib/sui"

const SUI_TYPE = "0x2::sui::SUI"

const amountSui = Number(process.argv[2] ?? 1)
if (!Number.isFinite(amountSui) || amountSui <= 0) {
  throw new Error(`amount must be a positive number of SUI, got: ${process.argv[2]}`)
}
const amountMist = BigInt(Math.round(amountSui * Number(MIST_PER_SUI)))

const sponsor = loadKeypairFromEnv("SPONSOR_SECRET_KEY")
if (!sponsor) {
  throw new Error("SPONSOR_SECRET_KEY is required (bech32 suiprivkey1… key)")
}
const sponsorAddress = sponsor.toSuiAddress()

// Funder defaults to the sponsor itself (self-fund from its faucet coins).
const funder = loadKeypairFromEnv("FUND_FROM_SECRET_KEY") ?? sponsor
const funderAddress = funder.toSuiAddress()

const client = getSuiClient()

console.log(`sponsor (recipient): ${sponsorAddress}`)
console.log(`funder:              ${funderAddress}`)
console.log(`amount:              ${amountSui} SUI (${amountMist} MIST)`)

const before = await client.core.getBalance({ owner: sponsorAddress })
console.log(`sponsor total balance before: ${before.balance.balance} MIST`)

const tx = new Transaction()
// A Coin<SUI> split off the funder's gas coin…
const funds = tx.coin({ balance: amountMist, useGasCoin: true })
// …deposited into the sponsor's address balance.
tx.moveCall({
  target: "0x2::coin::send_funds",
  typeArguments: [SUI_TYPE],
  arguments: [funds, tx.pure.address(sponsorAddress)],
})

const res = await client.signAndExecuteTransaction({ transaction: tx, signer: funder })
if (!(res.$kind === "Transaction" && res.Transaction.status.success)) {
  throw new Error(`deposit failed: ${JSON.stringify(res)}`)
}
await client.waitForTransaction({ digest: res.Transaction.digest })

const after = await client.core.getBalance({ owner: sponsorAddress })
console.log(`deposited. digest: ${res.Transaction.digest}`)
console.log(`sponsor total balance after:  ${after.balance.balance} MIST`)
