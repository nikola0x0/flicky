/**
 * Single signing entrypoint for the app. Try the sponsored path first
 * (Enoki via apps/server/POST /sponsor), fall back to wallet-paid gas
 * if the server is unreachable / unconfigured / rejects.
 *
 * Shape matches `useSignAndExecuteTransaction` from dapp-kit so call
 * sites can swap with a one-line change.
 */
import { useCallback, useState } from "react"
import { toBase64 } from "@mysten/sui/utils"
import type { Transaction } from "@mysten/sui/transactions"
import { useCurrentAccount, useCurrentClient, useDAppKit } from "@mysten/dapp-kit-react"

import { signAndExecuteWithSponsorOrFallback } from "./sponsor"

export function useFlickySign() {
  const client = useCurrentClient()
  const account = useCurrentAccount()
  const dAppKit = useDAppKit()
  // dApp Kit v2 sign actions are imperative Promises (no mutation-hook
  // `isPending`), so track the in-flight state ourselves.
  const [isPending, setIsPending] = useState(false)

  const mutateAsync = useCallback(
    async ({ transaction }: { transaction: Transaction }) => {
      if (!account) throw new Error("wallet not connected")
      setIsPending(true)
      try {
        const signer = {
          toSuiAddress: () => account.address,
          signTransaction: async (bytes: Uint8Array) => {
            // dapp-kit accepts base64 bytes or a Transaction; sponsored
            // bytes already have gas + sponsor set by the server, so we
            // pass them through as-is for the wallet to sign.
            const { signature } = await dAppKit.signTransaction({
              transaction: toBase64(bytes),
            })
            return { signature }
          },
        }
        return await signAndExecuteWithSponsorOrFallback(
          client,
          transaction,
          signer,
          {
            // Wallet-paid fallback. v2 returns the gRPC-style discriminated
            // result — unwrap the digest, throw on FailedTransaction.
            signAndExecuteTransaction: async ({ transaction }) => {
              const res = await dAppKit.signAndExecuteTransaction({
                transaction,
              })
              if (res.$kind !== "Transaction") {
                throw new Error("transaction failed")
              }
              return { digest: res.Transaction.digest }
            },
          },
        )
      } finally {
        setIsPending(false)
      }
    },
    [account, client, dAppKit],
  )

  return { mutateAsync, isPending }
}
