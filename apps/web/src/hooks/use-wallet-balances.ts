import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useCurrentAccount, useSuiClient } from "@mysten/dapp-kit"

import {
  DUSDC_COIN_TYPE,
  SUI_COIN_TYPE,
  fetchCoinBalance,
} from "@/lib/swap"

const BALANCE_ROOT_KEY = "wallet-balance"

/**
 * Live balance hook backed by react-query. Polls every 5s while the
 * component is mounted and shares cache across every consumer, so the
 * header chips, profile stats, swap screen, and deposit modal all
 * stay in sync. Call useInvalidateWalletBalances() after any action
 * that should produce an immediate refresh (deposit, swap, etc.).
 */
export function useWalletBalance(coinType: string) {
  const account = useCurrentAccount()
  const client = useSuiClient()
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
  return () => qc.invalidateQueries({ queryKey: [BALANCE_ROOT_KEY] })
}
