import { useState, useEffect } from 'react'
import { useCurrentAccount, useSignAndExecuteTransaction } from '@mysten/dapp-kit'
import { Transaction } from '@mysten/sui/transactions'
import { client } from '../../lib/client'

interface PanelOutput {
  type: 'success' | 'error' | 'info'
  title: string
  data: string
  txDigest?: string
}

interface SwapPanelProps {
  onOutput: (output: PanelOutput) => void
}

export default function SwapPanel({ onOutput }: SwapPanelProps) {
  const account = useCurrentAccount()
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction()

  // Package & Pool configuration
  const [packageId, setPackageId] = useState<string>('0x51ea0f29321f3c25f8b2f530ecd3ed3dec569d954c8832d318de7e203653a936')
  const [poolId, setPoolId] = useState<string>(() => {
    return localStorage.getItem('flicky_swap_pool_id') || ''
  })
  const [coinXType, setCoinXType] = useState<string>('0x2::sui::SUI')
  const [coinYType, setCoinYType] = useState<string>('0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC')
  const [feePct, setFeePct] = useState<string>('30') // 30 basis points = 0.3%

  // Swap operations states
  const [swapDirection, setSwapDirection] = useState<'x_to_y' | 'y_to_x'>('x_to_y')
  const [swapAmount, setSwapAmount] = useState<string>('1')
  const [minAmountOut, setMinAmountOut] = useState<string>('0')
  const [slippage, setSlippage] = useState<string>('1') // 1% default slippage

  // LP operations states
  const [addXAmount, setAddXAmount] = useState<string>('10')
  const [addYAmount, setAddYAmount] = useState<string>('100')
  const [removeLpAmount, setRemoveLpAmount] = useState<string>('1')

  // Live pool reserves
  const [poolReserves, setPoolReserves] = useState<{
    reserveX: string
    reserveY: string
    feePct: number
    lpSupply: string
    spotPrice: string
  } | null>(null)

  // Wallet balances
  const [walletXBal, setWalletXBal] = useState<string>('0')
  const [walletYBal, setWalletYBal] = useState<string>('0')
  const [walletLpBal, setWalletLpBal] = useState<string>('0')

  const [loading, setLoading] = useState(false)
  const [poolLoading, setPoolLoading] = useState(false)

  // Load recently used pools from localStorage
  const [recentPools, setRecentPools] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem('flicky_swap_recent_pools')
      return stored ? JSON.parse(stored) : []
    } catch {
      return []
    }
  })

  // Save poolId to localStorage
  useEffect(() => {
    if (poolId) {
      localStorage.setItem('flicky_swap_pool_id', poolId)
    } else {
      localStorage.removeItem('flicky_swap_pool_id')
    }
  }, [poolId])

  const addRecentPool = (id: string) => {
    if (!id || !id.startsWith('0x')) return
    setRecentPools((prev) => {
      if (prev.includes(id)) return prev
      const updated = [id, ...prev].slice(0, 10) // Keep last 10
      localStorage.setItem('flicky_swap_recent_pools', JSON.stringify(updated))
      return updated
    })
  }

  const parseU64 = (bytes: number[]) => {
    let val = 0n
    for (let i = bytes.length - 1; i >= 0; i--) {
      val = (val << 8n) | BigInt(bytes[i])
    }
    return val
  }

  const fetchPoolReserves = async () => {
    if (!poolId || !poolId.startsWith('0x')) return
    setPoolLoading(true)
    try {
      const tx = new Transaction()
      tx.moveCall({
        target: `${packageId}::swap::pool_reserves`,
        typeArguments: [coinXType, coinYType],
        arguments: [tx.object(poolId)],
      })
      tx.moveCall({
        target: `${packageId}::swap::pool_fee_pct`,
        typeArguments: [coinXType, coinYType],
        arguments: [tx.object(poolId)],
      })
      tx.moveCall({
        target: `${packageId}::swap::pool_lp_supply`,
        typeArguments: [coinXType, coinYType],
        arguments: [tx.object(poolId)],
      })

      const result = await client.devInspectTransactionBlock({
        sender: account?.address || '0x30587ef36b6a19d78e752a374a5f67a140d6a5b5471ee3ed91ff953cdb9fb0fe',
        transactionBlock: tx,
      })

      const res = result.results
      if (res && res.length >= 3) {
        const reservesRaw = res[0].returnValues
        const feeRaw = res[1].returnValues?.[0]?.[0]
        const lpSupplyRaw = res[2].returnValues?.[0]?.[0]

        if (reservesRaw && reservesRaw.length >= 2) {
          const reserveXRaw = parseU64(reservesRaw[0][0])
          const reserveYRaw = parseU64(reservesRaw[1][0])
          const fee = feeRaw ? Number(parseU64(feeRaw)) : 0
          const lpSupply = lpSupplyRaw ? parseU64(lpSupplyRaw) : 0n

          // Scaling factors: SUI uses 1e9, dUSDC uses 1e6
          const isX_Sui = coinXType === '0x2::sui::SUI'
          const isY_Sui = coinYType === '0x2::sui::SUI'
          const scaleX = isX_Sui ? 1_000_000_000 : 1_000_000
          const scaleY = isY_Sui ? 1_000_000_000 : 1_000_000

          const rxFloat = Number(reserveXRaw) / scaleX
          const ryFloat = Number(reserveYRaw) / scaleY

          const spotPrice = rxFloat > 0 ? (ryFloat / rxFloat).toFixed(6) : '0'

          setPoolReserves({
            reserveX: rxFloat.toFixed(6),
            reserveY: ryFloat.toFixed(6),
            feePct: fee,
            lpSupply: (Number(lpSupply) / 1_000_000).toFixed(6), // LP scaled by 1e6
            spotPrice,
          })
          addRecentPool(poolId)
        }
      }
    } catch (err) {
      console.error('Failed to fetch pool reserves:', err)
      setPoolReserves(null)
    } finally {
      setPoolLoading(false)
    }
  }

  const fetchWalletBalances = async () => {
    if (!account) return
    try {
      const isX_Sui = coinXType === '0x2::sui::SUI'
      const isY_Sui = coinYType === '0x2::sui::SUI'
      const scaleX = isX_Sui ? 1_000_000_000n : 1_000_000n
      const scaleY = isY_Sui ? 1_000_000_000n : 1_000_000n

      // 1. Fetch Coin X
      const coinsX = await client.getCoins({ owner: account.address, coinType: coinXType })
      const totalX = coinsX.data.reduce((sum: bigint, coin: any) => sum + BigInt(coin.balance), 0n)
      setWalletXBal((Number(totalX) / Number(scaleX)).toFixed(4))

      // 2. Fetch Coin Y
      const coinsY = await client.getCoins({ owner: account.address, coinType: coinYType })
      const totalY = coinsY.data.reduce((sum: bigint, coin: any) => sum + BigInt(coin.balance), 0n)
      setWalletYBal((Number(totalY) / Number(scaleY)).toFixed(4))

      // 3. Fetch LP
      if (poolId && poolId.startsWith('0x')) {
        const lpCoinType = `${packageId}::swap::LP<${coinXType},${coinYType}>`
        const coinsLp = await client.getCoins({ owner: account.address, coinType: lpCoinType })
        const totalLp = coinsLp.data.reduce((sum: bigint, coin: any) => sum + BigInt(coin.balance), 0n)
        setWalletLpBal((Number(totalLp) / 1_000_000).toFixed(4))
      } else {
        setWalletLpBal('0.0000')
      }
    } catch (err) {
      console.error('Failed to fetch wallet balances:', err)
    }
  }

  const syncAllData = async () => {
    await Promise.all([
      fetchPoolReserves(),
      fetchWalletBalances()
    ])
  }

  useEffect(() => {
    if (account) {
      fetchWalletBalances()
    }
  }, [account, coinXType, coinYType, packageId, poolId])

  useEffect(() => {
    if (poolId && poolId.startsWith('0x')) {
      fetchPoolReserves()
    } else {
      setPoolReserves(null)
    }
  }, [poolId, coinXType, coinYType, packageId])

  // Local swap amount simulation (AMM Constant Product formula)
  const getEstimatedOutput = () => {
    if (!poolReserves || !swapAmount || parseFloat(swapAmount) <= 0) return '0'
    const rx = parseFloat(poolReserves.reserveX)
    const ry = parseFloat(poolReserves.reserveY)
    const amt = parseFloat(swapAmount)
    if (rx <= 0 || ry <= 0) return '0'

    const fee_factor = 1.0 - poolReserves.feePct / 10000

    if (swapDirection === 'x_to_y') {
      // dy = (ry * dx * fee) / (rx + dx * fee)
      const dx_fee = amt * fee_factor
      const dy = (ry * dx_fee) / (rx + dx_fee)
      return dy.toFixed(6)
    } else {
      // dx = (rx * dy * fee) / (ry + dy * fee)
      const dy_fee = amt * fee_factor
      const dx = (rx * dy_fee) / (ry + dy_fee)
      return dx.toFixed(6)
    }
  }

  // Pre-fill slippage minimum output based on estimate
  useEffect(() => {
    const est = getEstimatedOutput()
    const slipPct = parseFloat(slippage) || 0
    const minOut = parseFloat(est) * (1 - slipPct / 100)
    setMinAmountOut(minOut > 0 ? minOut.toFixed(6) : '0')
  }, [swapAmount, swapDirection, poolReserves, slippage])

  const handleCreatePool = async () => {
    if (!account) return
    setLoading(true)
    try {
      const tx = new Transaction()
      tx.moveCall({
        target: `${packageId}::swap::entry_create_pool`,
        typeArguments: [coinXType, coinYType],
        arguments: [tx.pure.u64(Number(feePct))],
      })

      const result = await signAndExecute({ transaction: tx })

      // Fetch transaction details to get object changes (wait until indexed)
      const txData = await client.waitForTransaction({
        digest: result.digest,
        options: { showObjectChanges: true }
      })

      // Parse created object IDs to find the Pool ID
      const poolObject = txData.objectChanges?.find(
        (change: any) =>
          change.type === 'created' &&
          change.objectType.includes('::swap::Pool<')
      )
      const newPoolId = poolObject?.type === 'created' ? poolObject.objectId : ''
      if (newPoolId) {
        setPoolId(newPoolId)
        addRecentPool(newPoolId)
      }

      onOutput({
        type: 'success',
        title: 'Create Pool Successful',
        data: JSON.stringify(result, null, 2),
        txDigest: result.digest,
      })
      setTimeout(syncAllData, 2000)
    } catch (error) {
      onOutput({
        type: 'error',
        title: 'Create Pool Failed',
        data: String(error),
      })
    } finally {
      setLoading(false)
    }
  }

  const handleAddLiquidity = async () => {
    if (!account || !poolId) return
    setLoading(true)
    try {
      const isX_Sui = coinXType === '0x2::sui::SUI'
      const isY_Sui = coinYType === '0x2::sui::SUI'
      const scaleX = isX_Sui ? 1_000_000_000n : 1_000_000n
      const scaleY = isY_Sui ? 1_000_000_000n : 1_000_000n

      const amtXRaw = BigInt(Math.floor(parseFloat(addXAmount) * Number(scaleX)))
      const amtYRaw = BigInt(Math.floor(parseFloat(addYAmount) * Number(scaleY)))

      const tx = new Transaction()
      let coinXObject: any
      let coinYObject: any

      // 1. Prepare Coin X
      if (isX_Sui) {
        coinXObject = tx.splitCoins(tx.gas, [tx.pure.u64(amtXRaw)])
      } else {
        const coins = await client.getCoins({ owner: account.address, coinType: coinXType })
        if (coins.data.length === 0) throw new Error(`No ${coinXType} coins found in wallet`)
        const primary = tx.object(coins.data[0].coinObjectId)
        if (coins.data.length > 1) {
          tx.mergeCoins(primary, coins.data.slice(1).map((c: any) => tx.object(c.coinObjectId)))
        }
        coinXObject = tx.splitCoins(primary, [tx.pure.u64(amtXRaw)])
      }

      // 2. Prepare Coin Y
      if (isY_Sui) {
        coinYObject = tx.splitCoins(tx.gas, [tx.pure.u64(amtYRaw)])
      } else {
        const coins = await client.getCoins({ owner: account.address, coinType: coinYType })
        if (coins.data.length === 0) throw new Error(`No ${coinYType} coins found in wallet`)
        const primary = tx.object(coins.data[0].coinObjectId)
        if (coins.data.length > 1) {
          tx.mergeCoins(primary, coins.data.slice(1).map((c: any) => tx.object(c.coinObjectId)))
        }
        coinYObject = tx.splitCoins(primary, [tx.pure.u64(amtYRaw)])
      }

      // Call entry_add_liquidity
      tx.moveCall({
        target: `${packageId}::swap::entry_add_liquidity`,
        typeArguments: [coinXType, coinYType],
        arguments: [tx.object(poolId), coinXObject, coinYObject],
      })

      const result = await signAndExecute({ transaction: tx })
      onOutput({
        type: 'success',
        title: 'Add Liquidity Successful',
        data: JSON.stringify(result, null, 2),
        txDigest: result.digest,
      })
      setTimeout(syncAllData, 2000)
    } catch (error) {
      onOutput({
        type: 'error',
        title: 'Add Liquidity Failed',
        data: String(error),
      })
    } finally {
      setLoading(false)
    }
  }

  const handleRemoveLiquidity = async () => {
    if (!account || !poolId) return
    setLoading(true)
    try {
      const lpCoinType = `${packageId}::swap::LP<${coinXType},${coinYType}>`
      const lpAmtRaw = BigInt(Math.floor(parseFloat(removeLpAmount) * 1_000_000)) // LP tokens scale by 1e6

      const coins = await client.getCoins({ owner: account.address, coinType: lpCoinType })
      if (coins.data.length === 0) throw new Error('No LP tokens found in wallet for this pool')

      const tx = new Transaction()
      const primary = tx.object(coins.data[0].coinObjectId)
      if (coins.data.length > 1) {
        tx.mergeCoins(primary, coins.data.slice(1).map((c: any) => tx.object(c.coinObjectId)))
      }
      const splitLp = tx.splitCoins(primary, [tx.pure.u64(lpAmtRaw)])

      tx.moveCall({
        target: `${packageId}::swap::entry_remove_liquidity`,
        typeArguments: [coinXType, coinYType],
        arguments: [tx.object(poolId), splitLp],
      })

      const result = await signAndExecute({ transaction: tx })
      onOutput({
        type: 'success',
        title: 'Remove Liquidity Successful',
        data: JSON.stringify(result, null, 2),
        txDigest: result.digest,
      })
      setTimeout(syncAllData, 2000)
    } catch (error) {
      onOutput({
        type: 'error',
        title: 'Remove Liquidity Failed',
        data: String(error),
      })
    } finally {
      setLoading(false)
    }
  }

  const handleSwap = async () => {
    if (!account || !poolId) return
    setLoading(true)
    try {
      const isX_Sui = coinXType === '0x2::sui::SUI'
      const isY_Sui = coinYType === '0x2::sui::SUI'
      const scaleInput = swapDirection === 'x_to_y' ? (isX_Sui ? 1_000_000_000n : 1_000_000n) : (isY_Sui ? 1_000_000_000n : 1_000_000n)
      const scaleOutput = swapDirection === 'x_to_y' ? (isY_Sui ? 1_000_000_000n : 1_000_000n) : (isX_Sui ? 1_000_000_000n : 1_000_000n)

      const inputAmtRaw = BigInt(Math.floor(parseFloat(swapAmount) * Number(scaleInput)))
      const minOutRaw = BigInt(Math.floor(parseFloat(minAmountOut) * Number(scaleOutput)))

      const tx = new Transaction()
      let inputCoinObject: any

      if (swapDirection === 'x_to_y') {
        // Swap X for Y
        if (isX_Sui) {
          inputCoinObject = tx.splitCoins(tx.gas, [tx.pure.u64(inputAmtRaw)])
        } else {
          const coins = await client.getCoins({ owner: account.address, coinType: coinXType })
          if (coins.data.length === 0) throw new Error(`No ${coinXType} coins found in wallet`)
          const primary = tx.object(coins.data[0].coinObjectId)
          if (coins.data.length > 1) {
            tx.mergeCoins(primary, coins.data.slice(1).map((c: any) => tx.object(c.coinObjectId)))
          }
          inputCoinObject = tx.splitCoins(primary, [tx.pure.u64(inputAmtRaw)])
        }

        tx.moveCall({
          target: `${packageId}::swap::entry_swap_x_for_y`,
          typeArguments: [coinXType, coinYType],
          arguments: [tx.object(poolId), inputCoinObject, tx.pure.u64(minOutRaw)],
        })
      } else {
        // Swap Y for X
        if (isY_Sui) {
          inputCoinObject = tx.splitCoins(tx.gas, [tx.pure.u64(inputAmtRaw)])
        } else {
          const coins = await client.getCoins({ owner: account.address, coinType: coinYType })
          if (coins.data.length === 0) throw new Error(`No ${coinYType} coins found in wallet`)
          const primary = tx.object(coins.data[0].coinObjectId)
          if (coins.data.length > 1) {
            tx.mergeCoins(primary, coins.data.slice(1).map((c: any) => tx.object(c.coinObjectId)))
          }
          inputCoinObject = tx.splitCoins(primary, [tx.pure.u64(inputAmtRaw)])
        }

        tx.moveCall({
          target: `${packageId}::swap::entry_swap_y_for_x`,
          typeArguments: [coinXType, coinYType],
          arguments: [tx.object(poolId), inputCoinObject, tx.pure.u64(minOutRaw)],
        })
      }

      const result = await signAndExecute({ transaction: tx })
      onOutput({
        type: 'success',
        title: 'Token Swap Successful',
        data: JSON.stringify(result, null, 2),
        txDigest: result.digest,
      })
      setTimeout(syncAllData, 2000)
    } catch (error) {
      onOutput({
        type: 'error',
        title: 'Swap Failed',
        data: String(error),
      })
    } finally {
      setLoading(false)
    }
  }

  if (!account) {
    return (
      <div className="text-gray-400 py-10 text-center">
        🔌 Please connect your wallet to use this panel
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold">AMM Token Swap</h2>
          <p className="text-xs text-gray-400">
            Create Pools, Swap tokens, and Add/Remove liquidity on Sui Testnet
          </p>
        </div>
        <button
          onClick={syncAllData}
          disabled={poolLoading}
          className="rounded-lg bg-gray-800 px-3 py-1.5 text-xs font-semibold hover:bg-gray-700 disabled:opacity-50"
        >
          {poolLoading ? '⏳ Syncing...' : '🔄 Sync data'}
        </button>
      </div>

      {/* Package & Pool Setup */}
      <div className="rounded-xl border border-gray-800 bg-gray-950 p-4 space-y-3">
        <h3 className="text-xs font-bold uppercase tracking-wider text-gray-400">Configuration</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 uppercase mb-1">Swap Package ID</label>
            <input
              type="text"
              value={packageId}
              onChange={(e) => setPackageId(e.target.value.trim())}
              placeholder="0x..."
              className="w-full rounded-lg bg-gray-900 px-3 py-1.5 text-xs border border-gray-800 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 uppercase mb-1">Pool Shared Object ID</label>
            <input
              type="text"
              value={poolId}
              onChange={(e) => setPoolId(e.target.value.trim())}
              placeholder="0x..."
              className="w-full rounded-lg bg-gray-900 px-3 py-1.5 text-xs border border-gray-800 focus:outline-none"
            />
            {recentPools.length > 0 && (
              <div className="mt-1.5">
                <select
                  value={poolId}
                  onChange={(e) => setPoolId(e.target.value)}
                  className="w-full rounded bg-gray-900 px-2 py-1 text-[10px] border border-gray-800 text-gray-400 focus:outline-none font-mono"
                >
                  <option value="">📁 Select recent pool...</option>
                  {recentPools.map((p) => (
                    <option key={p} value={p}>
                      {p.slice(0, 12)}...{p.slice(-8)}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 uppercase mb-1">SUI Coin Type</label>
            <input
              type="text"
              value={coinXType}
              onChange={(e) => setCoinXType(e.target.value.trim())}
              placeholder="0x2::sui::SUI"
              className="w-full rounded-lg bg-gray-900 px-3 py-1.5 text-xs border border-gray-800 focus:outline-none font-mono"
            />
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 uppercase mb-1">dUSDC Coin Type</label>
            <input
              type="text"
              value={coinYType}
              onChange={(e) => setCoinYType(e.target.value.trim())}
              placeholder="0x..."
              className="w-full rounded-lg bg-gray-900 px-3 py-1.5 text-xs border border-gray-800 focus:outline-none font-mono"
            />
          </div>
        </div>
      </div>

      {/* Wallet & Pool Reserves Display */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Wallet Balances */}
        <div className="rounded-xl border border-gray-800 bg-gray-950 p-4 space-y-3">
          <span className="text-xs font-bold uppercase tracking-wider text-gray-400">Your Wallet Balances</span>
          <div className="grid grid-cols-3 gap-2 text-xs">
            <div className="rounded-lg bg-gray-900/40 p-2 border border-gray-800/50">
              <div className="text-[10px] text-gray-400 mb-0.5 font-medium font-semibold uppercase tracking-wider">SUI Balance</div>
              <div className="text-xs font-bold text-gray-100 font-mono">{walletXBal}</div>
            </div>
            <div className="rounded-lg bg-gray-900/40 p-2 border border-gray-800/50">
              <div className="text-[10px] text-gray-400 mb-0.5 font-medium font-semibold uppercase tracking-wider">dUSDC Balance</div>
              <div className="text-xs font-bold text-gray-100 font-mono">{walletYBal}</div>
            </div>
            <div className="rounded-lg bg-gray-900/40 p-2 border border-gray-800/50">
              <div className="text-[10px] text-gray-400 mb-0.5 font-medium font-semibold uppercase tracking-wider">LP Balance</div>
              <div className="text-xs font-bold text-blue-400 font-mono">{walletLpBal} LP</div>
            </div>
          </div>
        </div>

        {/* Pool Reserves */}
        <div className="rounded-xl border border-gray-800 bg-gray-950 p-4 space-y-3">
          <span className="text-xs font-bold uppercase tracking-wider text-gray-400">Live Pool Reserves</span>
          {poolReserves ? (
            <div className="grid grid-cols-3 gap-2 text-xs">
              <div className="rounded-lg bg-gray-900/40 p-2 border border-gray-800/50">
                <div className="text-[10px] text-gray-400 mb-0.5 font-medium font-semibold uppercase tracking-wider">Reserves (SUI / dUSDC)</div>
                <div className="text-xs font-bold text-gray-100 font-mono">
                  {poolReserves.reserveX} / {poolReserves.reserveY}
                </div>
              </div>
              <div className="rounded-lg bg-gray-900/40 p-2 border border-gray-800/50">
                <div className="text-[10px] text-gray-400 mb-0.5 font-medium font-semibold uppercase tracking-wider">Spot Rate</div>
                <div className="text-xs font-bold text-green-400 font-mono">
                  1 SUI = {poolReserves.spotPrice} dUSDC
                </div>
              </div>
              <div className="rounded-lg bg-gray-900/40 p-2 border border-gray-800/50">
                <div className="text-[10px] text-gray-400 mb-0.5 font-medium font-semibold uppercase tracking-wider">Pool LP Supply</div>
                <div className="text-xs font-bold text-blue-400 font-mono">
                  {poolReserves.lpSupply} LP
                </div>
              </div>
            </div>
          ) : (
            <div className="text-xs text-gray-500 py-3 text-center">
              ⚠️ Pool reserves not loaded. Ensure Pool ID is set.
            </div>
          )}
        </div>
      </div>

      {/* Create Pool Panel */}
      <div className="rounded-xl border border-gray-800 bg-gray-900/30 p-4 space-y-3">
        <div>
          <h3 className="font-semibold text-sm mb-1 text-gray-200">Initialize New Pool</h3>
          <p className="text-xs text-gray-400">Deploy a new shared swap pool for the configured token types.</p>
        </div>
        <div className="flex gap-4 items-end">
          <div className="flex-1">
            <label className="block text-[10px] font-semibold text-gray-400 uppercase mb-1">Fee (Basis Points)</label>
            <input
              type="number"
              value={feePct}
              onChange={(e) => setFeePct(e.target.value)}
              placeholder="e.g. 30"
              className="w-full rounded-lg bg-gray-950 px-3 py-1.5 text-xs border border-gray-800 focus:outline-none"
            />
          </div>
          <button
            onClick={handleCreatePool}
            disabled={loading || !packageId || !feePct}
            className="rounded-lg bg-blue-600 px-5 py-2 text-xs font-semibold hover:bg-blue-700 disabled:opacity-50 transition"
          >
            Create Shared Pool
          </button>
        </div>
      </div>

      {/* Liquidity Management (LP) */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Add Liquidity */}
        <div className="rounded-xl border border-gray-800 bg-gray-900/30 p-4 space-y-3">
          <h3 className="font-semibold text-sm text-gray-200">Add Liquidity</h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] text-gray-400 uppercase mb-1">SUI Amount</label>
              <input
                type="number"
                value={addXAmount}
                onChange={(e) => setAddXAmount(e.target.value)}
                className="w-full rounded-lg bg-gray-950 px-3 py-1.5 text-xs border border-gray-800 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-[10px] text-gray-400 uppercase mb-1">dUSDC Amount</label>
              <input
                type="number"
                value={addYAmount}
                onChange={(e) => setAddYAmount(e.target.value)}
                className="w-full rounded-lg bg-gray-950 px-3 py-1.5 text-xs border border-gray-800 focus:outline-none"
              />
            </div>
          </div>
          <button
            onClick={handleAddLiquidity}
            disabled={loading || !poolId}
            className="w-full rounded-lg bg-blue-600 py-2 text-xs font-semibold hover:bg-blue-700 disabled:opacity-50 transition"
          >
            Supply Liquidity
          </button>
        </div>

        {/* Remove Liquidity */}
        <div className="rounded-xl border border-gray-800 bg-gray-900/30 p-4 space-y-3">
          <h3 className="font-semibold text-sm text-gray-200">Remove Liquidity</h3>
          <div>
            <label className="block text-[10px] text-gray-400 uppercase mb-1">LP Tokens to Burn</label>
            <input
              type="number"
              value={removeLpAmount}
              onChange={(e) => setRemoveLpAmount(e.target.value)}
              placeholder="1.0"
              className="w-full rounded-lg bg-gray-950 px-3 py-1.5 text-xs border border-gray-800 focus:outline-none"
            />
          </div>
          <button
            onClick={handleRemoveLiquidity}
            disabled={loading || !poolId}
            className="w-full rounded-lg bg-purple-600 py-2 text-xs font-semibold hover:bg-purple-700 disabled:opacity-50 transition"
          >
            Withdraw Liquidity
          </button>
        </div>
      </div>

      {/* Swap Panel (Uniswap-style) */}
      <div className="rounded-xl border border-gray-800 bg-gray-900/30 p-5 space-y-4 max-w-lg mx-auto">
        <div className="flex justify-between items-center">
          <div>
            <h3 className="font-semibold text-sm text-gray-200">Execute Swap</h3>
            <p className="text-xs text-gray-400">Trade SUI and dUSDC instantly using constant product pricing.</p>
          </div>
        </div>

        <div className="space-y-1 relative">
          {/* Pay Block */}
          <div className="rounded-xl bg-gray-950 p-4 border border-gray-800/80 hover:border-gray-700 transition">
            <div className="flex justify-between items-center text-[10px] text-gray-400 mb-1.5">
              <span className="font-medium">You Pay</span>
              <span>
                Balance:{' '}
                <span className="font-mono text-gray-200">
                  {swapDirection === 'x_to_y' ? walletXBal : walletYBal}
                </span>
              </span>
            </div>
            <div className="flex justify-between items-center">
              <input
                type="number"
                value={swapAmount}
                onChange={(e) => setSwapAmount(e.target.value)}
                placeholder="0.0"
                className="w-full bg-transparent text-xl font-bold text-gray-100 focus:outline-none placeholder-gray-650 font-mono"
              />
              <div className="flex items-center gap-1.5 bg-gray-900 border border-gray-800 rounded-full px-3 py-1 text-xs font-semibold select-none text-gray-200">
                <span>{swapDirection === 'x_to_y' ? '💧 SUI' : '💵 dUSDC'}</span>
              </div>
            </div>
          </div>

          {/* Switcher Button */}
          <div className="flex justify-center -my-3.5 relative z-10">
            <button
              onClick={() => setSwapDirection((prev) => (prev === 'x_to_y' ? 'y_to_x' : 'x_to_y'))}
              className="w-8 h-8 rounded-full bg-gray-850 border border-gray-700 hover:border-gray-500 flex items-center justify-center text-gray-300 hover:text-white transition active:scale-90 shadow-md shadow-black/40 cursor-pointer text-xs"
              title="Switch Direction"
            >
              🔄
            </button>
          </div>

          {/* Receive Block */}
          <div className="rounded-xl bg-gray-950 p-4 border border-gray-800/80 hover:border-gray-700 transition">
            <div className="flex justify-between items-center text-[10px] text-gray-400 mb-1.5">
              <span className="font-medium">You Receive (estimated)</span>
              <span>
                Balance:{' '}
                <span className="font-mono text-gray-200">
                  {swapDirection === 'x_to_y' ? walletYBal : walletXBal}
                </span>
              </span>
            </div>
            <div className="flex justify-between items-center">
              <div className="w-full bg-transparent text-xl font-bold text-gray-100 font-mono select-all">
                {getEstimatedOutput()}
              </div>
              <div className="flex items-center gap-1.5 bg-gray-900 border border-gray-800 rounded-full px-3 py-1 text-xs font-semibold select-none text-gray-200">
                <span>{swapDirection === 'x_to_y' ? '💵 dUSDC' : '💧 SUI'}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Slippage & Output Details */}
        <div className="rounded-lg bg-gray-950/60 p-3 border border-gray-800/40 space-y-2 text-xs">
          <div className="flex justify-between items-center">
            <span className="text-[11px] text-gray-400">Max Slippage Tolerance:</span>
            <div className="flex items-center gap-1">
              <input
                type="number"
                value={slippage}
                onChange={(e) => setSlippage(e.target.value)}
                placeholder="1.0"
                className="w-12 text-center rounded bg-gray-900 border border-gray-800 text-xs font-semibold py-0.5 text-gray-200 focus:outline-none"
              />
              <span className="text-gray-400">%</span>
            </div>
          </div>
          <div className="flex justify-between items-center border-t border-gray-900 pt-2 text-[11px]">
            <span className="text-gray-400">Minimum output guaranteed:</span>
            <span className="font-mono text-green-400 font-semibold">
              {minAmountOut} {swapDirection === 'x_to_y' ? 'dUSDC' : 'SUI'}
            </span>
          </div>
        </div>

        <button
          onClick={handleSwap}
          disabled={loading || !poolId || parseFloat(swapAmount) <= 0}
          className="w-full rounded-xl bg-gradient-to-r from-green-600 to-emerald-600 py-3 text-xs font-bold uppercase tracking-wider text-white hover:from-green-500 hover:to-emerald-500 disabled:opacity-50 disabled:from-green-600 disabled:to-emerald-600 transition shadow-lg shadow-green-950/10 cursor-pointer"
        >
          {loading ? '⏳ Executing Swap...' : swapDirection === 'x_to_y' ? 'Swap SUI for dUSDC' : 'Swap dUSDC for SUI'}
        </button>
      </div>
    </div>
  )
}
