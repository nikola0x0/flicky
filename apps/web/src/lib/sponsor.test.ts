import { describe, expect, test } from "bun:test"
import { Transaction } from "@mysten/sui/transactions"
import { hasBoundedExpiration } from "./sponsor"

const SENDER =
  "0x870d96f52ee9b5edda8091049c3b478c9496ce5bf66c7845a93c5ec8777775ba"
const SPONSOR =
  "0x9c08a74cca711f45a176765e9db499f01def450fa90320a4c23934b2082aa882"
const CHAIN = "69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD"

/**
 * A minimal offline-buildable sponsored tx: no object inputs, gas price +
 * budget + empty payment pre-set, so `build()` needs no client. This is
 * exactly the "already resolved" state a reused Transaction instance is in
 * — the state where the fullnode skips gas selection and the expiration is
 * whatever the instance carries.
 */
function offlineSponsoredTx(): Transaction {
  const tx = new Transaction()
  tx.moveCall({ target: "0x1::option::none", typeArguments: ["u64"] })
  tx.setSender(SENDER)
  tx.setGasOwner(SPONSOR)
  tx.setGasPayment([])
  tx.setGasPrice(1000n)
  tx.setGasBudget(2_000_000n)
  return tx
}

describe("hasBoundedExpiration", () => {
  // BCS always encodes an expiration variant, so "unset" bytes are the
  // `None` case below. (An unset-expiration + empty-payment tx can't even
  // build offline — that combination is what forces fullnode resolution.)
  test("explicit None (the EXPIRATION_REQUIRED 403 state) → false", async () => {
    const tx = offlineSponsoredTx()
    tx.setExpiration({ None: true })
    expect(hasBoundedExpiration(await tx.build())).toBe(false)
  })

  test("Epoch expiration → true", async () => {
    const tx = offlineSponsoredTx()
    tx.setExpiration({ Epoch: 1165 })
    expect(hasBoundedExpiration(await tx.build())).toBe(true)
  })

  test("ValidDuring with maxEpoch (what the fullnode attaches) → true", async () => {
    const tx = offlineSponsoredTx()
    tx.setExpiration({
      ValidDuring: {
        minEpoch: "1164",
        maxEpoch: "1165",
        minTimestamp: null,
        maxTimestamp: null,
        chain: CHAIN,
        nonce: 923575508,
      },
    })
    expect(hasBoundedExpiration(await tx.build())).toBe(true)
  })

  test("ValidDuring with timestamp bounds only → false (policy reads maxEpoch)", async () => {
    const tx = offlineSponsoredTx()
    tx.setExpiration({
      ValidDuring: {
        minEpoch: null,
        maxEpoch: null,
        minTimestamp: "1784390000000",
        maxTimestamp: "1784400000000",
        chain: CHAIN,
        nonce: 923575508,
      },
    })
    expect(hasBoundedExpiration(await tx.build())).toBe(false)
  })
})
