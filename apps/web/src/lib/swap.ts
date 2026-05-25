import { Transaction } from "@mysten/sui/transactions"
import type { SuiJsonRpcClient } from "@mysten/sui/jsonRpc"

export const SWAP_PACKAGE_ID = import.meta.env.VITE_SWAP_PACKAGE_ID as string
export const SWAP_POOL_ID = import.meta.env.VITE_SWAP_POOL_ID as string
export const SUI_COIN_TYPE = (import.meta.env.VITE_SUI_COIN_TYPE ||
  "0x2::sui::SUI") as string
export const DUSDC_COIN_TYPE = import.meta.env.VITE_DUSDC_COIN_TYPE as string

export const SUI_DECIMALS = 9
export const DUSDC_DECIMALS = 6
export const SUI_SCALE = 10n ** BigInt(SUI_DECIMALS)
export const DUSDC_SCALE = 10n ** BigInt(DUSDC_DECIMALS)

export type SwapDirection = "sui_to_dusdc" | "dusdc_to_sui"

export interface PoolReserves {
  reserveSui: number
  reserveDusdc: number
  feeBps: number
  lpSupply: number
  spotPrice: number
}

function parseU64Bytes(bytes: number[]): bigint {
  let v = 0n
  for (let i = bytes.length - 1; i >= 0; i--) {
    v = (v << 8n) | BigInt(bytes[i])
  }
  return v
}

export function isSwapConfigured(): boolean {
  return Boolean(
    SWAP_PACKAGE_ID &&
      SWAP_POOL_ID &&
      SUI_COIN_TYPE &&
      DUSDC_COIN_TYPE &&
      SWAP_POOL_ID.startsWith("0x"),
  )
}

/**
 * Reads the pool's reserves, fee, and LP supply via devInspect. Returns
 * scaled numbers in token units (NOT raw u64).
 */
export async function fetchPoolReserves(
  client: SuiJsonRpcClient,
  sender?: string,
): Promise<PoolReserves | null> {
  if (!isSwapConfigured()) return null
  const tx = new Transaction()
  tx.moveCall({
    target: `${SWAP_PACKAGE_ID}::swap::pool_reserves`,
    typeArguments: [SUI_COIN_TYPE, DUSDC_COIN_TYPE],
    arguments: [tx.object(SWAP_POOL_ID)],
  })
  tx.moveCall({
    target: `${SWAP_PACKAGE_ID}::swap::pool_fee_pct`,
    typeArguments: [SUI_COIN_TYPE, DUSDC_COIN_TYPE],
    arguments: [tx.object(SWAP_POOL_ID)],
  })
  tx.moveCall({
    target: `${SWAP_PACKAGE_ID}::swap::pool_lp_supply`,
    typeArguments: [SUI_COIN_TYPE, DUSDC_COIN_TYPE],
    arguments: [tx.object(SWAP_POOL_ID)],
  })

  const result = await client.devInspectTransactionBlock({
    sender:
      sender ||
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    transactionBlock: tx,
  })

  const res = result.results
  if (!res || res.length < 3) return null
  const reserves = res[0].returnValues
  if (!reserves || reserves.length < 2) return null

  const reserveSuiRaw = parseU64Bytes(reserves[0][0])
  const reserveDusdcRaw = parseU64Bytes(reserves[1][0])
  const feeBpsRaw = res[1].returnValues?.[0]?.[0]
  const lpSupplyRaw = res[2].returnValues?.[0]?.[0]

  const reserveSui = Number(reserveSuiRaw) / Number(SUI_SCALE)
  const reserveDusdc = Number(reserveDusdcRaw) / Number(DUSDC_SCALE)
  const feeBps = feeBpsRaw ? Number(parseU64Bytes(feeBpsRaw)) : 0
  const lpSupply = lpSupplyRaw ? Number(parseU64Bytes(lpSupplyRaw)) / 1e6 : 0

  return {
    reserveSui,
    reserveDusdc,
    feeBps,
    lpSupply,
    spotPrice: reserveSui > 0 ? reserveDusdc / reserveSui : 0,
  }
}

/**
 * Constant-product output estimate, accounting for the LP fee.
 * Returns the expected output in token units (decimal-scaled).
 */
export function estimateSwapOutput(
  pool: PoolReserves,
  direction: SwapDirection,
  inputAmount: number,
): number {
  if (inputAmount <= 0) return 0
  const feeFactor = 1 - pool.feeBps / 10_000
  if (direction === "sui_to_dusdc") {
    const dx = inputAmount * feeFactor
    return (pool.reserveDusdc * dx) / (pool.reserveSui + dx)
  } else {
    const dy = inputAmount * feeFactor
    return (pool.reserveSui * dy) / (pool.reserveDusdc + dy)
  }
}

/**
 * Builds a swap PTB.
 *
 * For sui_to_dusdc: splits SUI off the gas coin (zkLogin/sponsored
 * wallets may not hold SUI separately, so we always split from gas).
 * For dusdc_to_sui: merges all the sender's dUSDC coins, then splits
 * the requested amount.
 *
 * `minOutputRaw` and `inputAmountRaw` are u64-scaled bigints in the
 * RAW token decimals (9 for SUI, 6 for dUSDC).
 */
export async function buildSwapTx(
  client: SuiJsonRpcClient,
  sender: string,
  direction: SwapDirection,
  inputAmountRaw: bigint,
  minOutputRaw: bigint,
): Promise<Transaction> {
  if (!isSwapConfigured()) {
    throw new Error("Swap is not configured. Set VITE_SWAP_POOL_ID.")
  }
  const tx = new Transaction()

  if (direction === "sui_to_dusdc") {
    const [coinIn] = tx.splitCoins(tx.gas, [tx.pure.u64(inputAmountRaw)])
    tx.moveCall({
      target: `${SWAP_PACKAGE_ID}::swap::entry_swap_x_for_y`,
      typeArguments: [SUI_COIN_TYPE, DUSDC_COIN_TYPE],
      arguments: [tx.object(SWAP_POOL_ID), coinIn, tx.pure.u64(minOutputRaw)],
    })
  } else {
    const coins = await client.getCoins({
      owner: sender,
      coinType: DUSDC_COIN_TYPE,
    })
    if (coins.data.length === 0) {
      throw new Error("No dUSDC coins found in wallet")
    }
    const primary = tx.object(coins.data[0].coinObjectId)
    if (coins.data.length > 1) {
      tx.mergeCoins(
        primary,
        coins.data.slice(1).map((c: { coinObjectId: string }) =>
          tx.object(c.coinObjectId),
        ),
      )
    }
    const [coinIn] = tx.splitCoins(primary, [tx.pure.u64(inputAmountRaw)])
    tx.moveCall({
      target: `${SWAP_PACKAGE_ID}::swap::entry_swap_y_for_x`,
      typeArguments: [SUI_COIN_TYPE, DUSDC_COIN_TYPE],
      arguments: [tx.object(SWAP_POOL_ID), coinIn, tx.pure.u64(minOutputRaw)],
    })
  }

  return tx
}

/**
 * Returns the sender's total wallet balance for a given coin type as
 * a decimal-scaled number. Uses `getBalance` (single aggregated RPC
 * call) instead of `getCoins` so paginated coin objects from the
 * faucet are all counted.
 */
export async function fetchCoinBalance(
  client: SuiJsonRpcClient,
  owner: string,
  coinType: string,
): Promise<number> {
  const result = await client.getBalance({ owner, coinType })
  const totalRaw = BigInt(result.totalBalance)
  const scale = coinType === SUI_COIN_TYPE ? SUI_SCALE : DUSDC_SCALE
  return Number(totalRaw) / Number(scale)
}

export function toRawAmount(decimalAmount: number, decimals: number): bigint {
  if (!isFinite(decimalAmount) || decimalAmount < 0) return 0n
  const scale = 10n ** BigInt(decimals)
  return BigInt(Math.floor(decimalAmount * Number(scale)))
}
