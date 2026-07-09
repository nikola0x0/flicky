import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useCurrentAccount, useCurrentClient } from "@mysten/dapp-kit-react"

import {
  DUSDC_COIN_TYPE,
  SUI_COIN_TYPE,
  fetchCoinBalance,
} from "@/lib/swap"
import {
  findPredictManager,
  getManagerDusdcBalance,
} from "@/lib/deepbook"

const BALANCE_ROOT_KEY = "wallet-balance"
const MANAGER_BALANCE_KEY = "manager-balance"

/**
 * Live balance hook backed by react-query. Polls every 5s while the
 * component is mounted and shares cache across every consumer, so the
 * header chips, profile stats, swap screen, and deposit modal all
 * stay in sync. Call useInvalidateWalletBalances() after any action
 * that should produce an immediate refresh (deposit, swap, etc.).
 */
export function useWalletBalance(coinType: string) {
  const account = useCurrentAccount()
  const client = useCurrentClient()
  return useQuery({
    queryKey: [BALANCE_ROOT_KEY, account?.address ?? null, coinType],
    queryFn: async () => {
      if (!account) return 0
      return fetchCoinBalance(client, account.address, coinType)
    },
    enabled: !!account,
    refetchInterval: 5_000,
    staleTime: 2_000,
  })
}

export function useSuiBalance() {
  return useWalletBalance(SUI_COIN_TYPE)
}

export function useDusdcBalance() {
  return useWalletBalance(DUSDC_COIN_TYPE)
}

export function useInvalidateWalletBalances() {
  const qc = useQueryClient()
  return () =>
    qc.invalidateQueries({
      predicate: (q) =>
        q.queryKey[0] === BALANCE_ROOT_KEY ||
        q.queryKey[0] === MANAGER_BALANCE_KEY,
    })
}

/**
 * PredictManager dUSDC balance, scaled to the same dUSDC base unit
 * (1e6 micro-units → human dUSDC) as `useDusdcBalance`. Returns the
 * float for direct UI rendering, and `managerId` for callers that
 * need to build deposit/withdraw PTBs.
 */
export function useManagerBalance() {
  const account = useCurrentAccount()
  const client = useCurrentClient()
  return useQuery({
    queryKey: [MANAGER_BALANCE_KEY, account?.address ?? null],
    queryFn: async () => {
      if (!account) return { managerId: null as string | null, balance: 0 }
      const mgr = await findPredictManager(client, account.address)
      if (!mgr) return { managerId: null, balance: 0 }
      const micro = await getManagerDusdcBalance(client, mgr.id)
      return { managerId: mgr.id, balance: Number(micro) / 1e6 }
    },
    enabled: !!account,
    refetchInterval: 5_000,
    staleTime: 2_000,
  })
}
