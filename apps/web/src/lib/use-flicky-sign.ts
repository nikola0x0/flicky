/**
 * Single signing entrypoint for the app. Try the sponsored path first
 * (Enoki via apps/server/POST /sponsor), fall back to wallet-paid gas
 * if the server is unreachable / unconfigured / rejects.
 *
 * Shape matches `useSignAndExecuteTransaction` from dapp-kit so call
 * sites can swap with a one-line change.
 */
import { useCallback } from "react"
import { toBase64 } from "@mysten/sui/utils"
import type { Transaction } from "@mysten/sui/transactions"
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSignTransaction,
  useSuiClient,
} from "@mysten/dapp-kit"

import { signAndExecuteWithSponsorOrFallback } from "./sponsor"

export function useFlickySign() {
  const client = useSuiClient()
  const account = useCurrentAccount()
  const { mutateAsync: signTxAsync, isPending: signing } = useSignTransaction()
  const { mutateAsync: execAsync, isPending: executing } =
    useSignAndExecuteTransaction()

  const mutateAsync = useCallback(
    async ({ transaction }: { transaction: Transaction }) => {
      if (!account) throw new Error("wallet not connected")
      const signer = {
        toSuiAddress: () => account.address,
        signTransaction: async (bytes: Uint8Array) => {
          // dapp-kit accepts base64 bytes or a Transaction; sponsored
          // bytes already have gas + sponsor set by the server, so we
          // pass them through as-is for the wallet to sign.
          const { signature } = await signTxAsync({
            transaction: toBase64(bytes),
          })
          return { signature }
        },
      }
      return signAndExecuteWithSponsorOrFallback(client, transaction, signer, {
        signAndExecuteTransaction: ({ transaction }) =>
          execAsync({ transaction }),
      })
    },
    [account, client, signTxAsync, execAsync],
  )

  return { mutateAsync, isPending: signing || executing }
}
