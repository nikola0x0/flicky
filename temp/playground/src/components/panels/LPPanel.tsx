import { useState, useEffect } from 'react'
import { useCurrentAccount, useSignAndExecuteTransaction } from '@mysten/dapp-kit'
import { Transaction } from '@mysten/sui/transactions'
import { CONFIG, DUSDC_TYPE, PLPCoin } from '../../config'
import { client } from '../../lib/client'
import { txSupply, txWithdraw } from '../../lib/predict-txb'

interface PanelOutput {
  type: 'success' | 'error' | 'info'
  title: string
  data: string
  txDigest?: string
}

interface LPPanelProps {
  onOutput: (output: PanelOutput) => void
}

export default function LPPanel({ onOutput }: LPPanelProps) {
  const account = useCurrentAccount()
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction()

  const [walletUSDC, setWalletUSDC] = useState<string>('0')
  const [walletPLP, setWalletPLP] = useState<string>('0')
  const [supplyAmount, setSupplyAmount] = useState<string>('')
  const [withdrawAmount, setWithdrawAmount] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  // Vault summary states
  const [vaultSummary, setVaultSummary] = useState<any>(null)
  const [vaultPerformance, setVaultPerformance] = useState<any>(null)
  const [vaultLoading, setVaultLoading] = useState(false)

  const fetchBalances = async () => {
    if (!account) return
    setRefreshing(true)
    try {
      const usdcType = DUSDC_TYPE(CONFIG.dusdcPackageId)
      const plpType = PLPCoin(CONFIG.predictPackageId)

      // 1. Fetch Wallet dUSDC
      const walletCoins = await client.getCoins({
        owner: account.address,
        coinType: usdcType,
      })
      const totalUSDC = walletCoins.data.reduce(
        (sum: bigint, coin: any) => sum + BigInt(coin.balance),
        0n
      )
      setWalletUSDC((Number(totalUSDC) / 1_000_000).toFixed(6))

      // 2. Fetch Wallet PLP
      const lpCoins = await client.getCoins({
        owner: account.address,
        coinType: plpType,
      })
      const totalPLP = lpCoins.data.reduce(
        (sum: bigint, coin: any) => sum + BigInt(coin.balance),
        0n
      )
      setWalletPLP((Number(totalPLP) / 1_000_000).toFixed(6))
    } catch (error) {
      console.error('Failed to fetch LP balances:', error)
    } finally {
      setRefreshing(false)
    }
  }

  const fetchVaultSummary = async () => {
    if (!CONFIG.predictObjectId) return
    setVaultLoading(true)
    try {
      const response = await fetch(
        `https://predict-server.testnet.mystenlabs.com/predicts/${CONFIG.predictObjectId}/vault/summary`
      )
      if (response.ok) {
        const data = await response.json()
        setVaultSummary(data)
      }

      const perfResponse = await fetch(
        `https://predict-server.testnet.mystenlabs.com/predicts/${CONFIG.predictObjectId}/vault/performance?range=ALL`
      )
      if (perfResponse.ok) {
        const data = await perfResponse.json()
        setVaultPerformance(data)
      }
    } catch (err) {
      console.error('Failed to fetch vault summary/performance:', err)
    } finally {
      setVaultLoading(false)
    }
  }

  useEffect(() => {
    if (account) {
      fetchBalances()
      fetchVaultSummary()
    }
  }, [account])

  const handleSupply = async () => {
    if (!account || !supplyAmount) return
    setLoading(true)
    try {
      const amountRaw = BigInt(Math.floor(parseFloat(supplyAmount) * 1_000_000))
      const coinType = DUSDC_TYPE(CONFIG.dusdcPackageId)

      // Fetch dUSDC coins
      const coins = await client.getCoins({
        owner: account.address,
        coinType,
      })

      if (coins.data.length === 0) {
        throw new Error('You do not have any dUSDC in your wallet to supply')
      }

      const tx = new Transaction()
      const primaryCoin = tx.object(coins.data[0].coinObjectId)

      if (coins.data.length > 1) {
        tx.mergeCoins(
          primaryCoin,
          coins.data.slice(1).map((c: any) => tx.object(c.coinObjectId))
        )
      }

      const [supplyCoin] = tx.splitCoins(primaryCoin, [tx.pure.u64(amountRaw)])

      // Supply liquidity
      const plpCoin = txSupply(tx, supplyCoin, coinType)

      // Transfer the minted PLP shares back to the user
      tx.transferObjects([plpCoin], tx.pure.address(account.address))

      const result = await signAndExecute({ transaction: tx })
      onOutput({
        type: 'success',
        title: 'Liquidity Supplied Successfully',
        data: JSON.stringify(result, null, 2),
        txDigest: result.digest,
      })
      setSupplyAmount('')
      setTimeout(() => {
        fetchBalances()
        fetchVaultSummary()
      }, 2000)
    } catch (error) {
      onOutput({
        type: 'error',
        title: 'Supply Liquidity Failed',
        data: String(error),
      })
    } finally {
      setLoading(false)
    }
  }

  const handleWithdraw = async () => {
    if (!account || !withdrawAmount) return
    setLoading(true)
    try {
      const amountRaw = BigInt(Math.floor(parseFloat(withdrawAmount) * 1_000_000))
      const coinType = DUSDC_TYPE(CONFIG.dusdcPackageId)
      const plpType = PLPCoin(CONFIG.predictPackageId)

      // Fetch PLP coins in wallet
      const coins = await client.getCoins({
        owner: account.address,
        coinType: plpType,
      })

      if (coins.data.length === 0) {
        throw new Error('You do not have any PLP shares to withdraw')
      }

      const tx = new Transaction()
      const primaryCoin = tx.object(coins.data[0].coinObjectId)

      if (coins.data.length > 1) {
        tx.mergeCoins(
          primaryCoin,
          coins.data.slice(1).map((c: any) => tx.object(c.coinObjectId))
        )
      }

      const [withdrawCoin] = tx.splitCoins(primaryCoin, [tx.pure.u64(amountRaw)])

      // Withdraw liquidity
      const quoteCoin = txWithdraw(tx, withdrawCoin, coinType)

      // Transfer returned dUSDC back to the user
      tx.transferObjects([quoteCoin], tx.pure.address(account.address))

      const result = await signAndExecute({ transaction: tx })
      onOutput({
        type: 'success',
        title: 'Liquidity Withdrawn Successfully',
        data: JSON.stringify(result, null, 2),
        txDigest: result.digest,
      })
      setWithdrawAmount('')
      setTimeout(() => {
        fetchBalances()
        fetchVaultSummary()
      }, 2000)
    } catch (error) {
      onOutput({
        type: 'error',
        title: 'Withdraw Liquidity Failed',
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
          <h2 className="text-lg font-bold">LP Operations</h2>
          <p className="text-xs text-gray-400">
            Supply dUSDC to earn fees or Withdraw liquidity from the LP pool
          </p>
        </div>
        <button
          onClick={fetchBalances}
          disabled={refreshing}
          className="rounded-lg bg-gray-800 p-2 text-xs font-semibold hover:bg-gray-700 disabled:opacity-50"
        >
          {refreshing ? '⏳ Syncing...' : '🔄 Sync Balance'}
        </button>
      </div>

      {/* Info & Balances */}
      <div className="grid grid-cols-2 gap-4 rounded-xl border border-gray-800 bg-gray-950 p-4">
        <div>
          <div className="text-xs text-gray-400 font-medium">Wallet dUSDC</div>
          <div className="text-xl font-bold text-green-400">{walletUSDC}</div>
        </div>
        <div>
          <div className="text-xs text-gray-400 font-medium">Wallet PLP Shares</div>
          <div className="text-xl font-bold text-blue-400">{walletPLP}</div>
        </div>
      </div>

      {/* Vault Status (from Public Server) */}
      {vaultSummary && (
        <div className="rounded-xl border border-gray-800 bg-gray-950 p-4 space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wider text-gray-400">
              Live Vault Summary
            </span>
            <button
              onClick={fetchVaultSummary}
              disabled={vaultLoading}
              className="text-[11px] text-blue-400 hover:text-blue-300 disabled:opacity-50"
            >
              {vaultLoading ? '⏳ Syncing...' : '🔄 Refresh Vault'}
            </button>
          </div>
          
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-xs">
            <div className="rounded-lg bg-gray-900/40 p-2.5 border border-gray-800/50">
              <div className="text-gray-400 mb-0.5 font-medium">Vault Value</div>
              <div className="text-sm font-bold text-gray-100">${(Number(vaultSummary.vault_value) / 1_000_000).toFixed(2)} dUSDC</div>
            </div>
            <div className="rounded-lg bg-gray-900/40 p-2.5 border border-gray-800/50">
              <div className="text-gray-400 mb-0.5 font-medium">PLP Share Price</div>
              <div className="text-sm font-bold text-blue-400">{Number(vaultSummary.plp_share_price).toFixed(6)} dUSDC</div>
            </div>
            <div className="rounded-lg bg-gray-900/40 p-2.5 border border-gray-800/50">
              <div className="text-gray-400 mb-0.5 font-medium">Total PLP Supply</div>
              <div className="text-sm font-bold text-gray-100">{(Number(vaultSummary.plp_total_supply) / 1_000_000).toFixed(2)} PLP</div>
            </div>
            <div className="rounded-lg bg-gray-900/40 p-2.5 border border-gray-800/50">
              <div className="text-gray-400 mb-0.5 font-medium">Available Liquidity</div>
              <div className="text-sm font-bold text-green-400">${(Number(vaultSummary.available_liquidity) / 1_000_000).toFixed(2)}</div>
            </div>
            <div className="rounded-lg bg-gray-900/40 p-2.5 border border-gray-800/50">
              <div className="text-gray-400 mb-0.5 font-medium">Total Supplied</div>
              <div className="text-sm font-bold text-gray-100">${(Number(vaultSummary.total_supplied) / 1_000_000).toFixed(2)}</div>
            </div>
            <div className="rounded-lg bg-gray-900/40 p-2.5 border border-gray-800/50">
              <div className="text-gray-400 mb-0.5 font-medium">Pool Utilization</div>
              <div className="text-sm font-bold text-yellow-500">{(Number(vaultSummary.utilization) * 100).toFixed(4)}%</div>
            </div>
          </div>

          {/* Vault Performance Metrics */}
          {vaultPerformance && vaultPerformance.points && vaultPerformance.points.length > 0 && (() => {
            const points = vaultPerformance.points;
            const initialPrice = points[0]?.share_price || 1.0;
            const currentPrice = points[points.length - 1]?.share_price || 1.0;
            const yieldPct = ((currentPrice - initialPrice) / initialPrice * 100);
            
            return (
              <div className="border-t border-gray-800/60 pt-3 space-y-2">
                <div className="flex justify-between items-center text-xs">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-gray-400">Vault Performance History</span>
                  <span className={`font-semibold ${yieldPct >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    Net Yield: {yieldPct >= 0 ? '+' : ''}{yieldPct.toFixed(6)}%
                  </span>
                </div>
                <div className="overflow-x-auto rounded-lg border border-gray-800 bg-gray-950/40 text-[11px]">
                  <table className="w-full text-left text-gray-400">
                    <thead className="text-[10px] text-gray-500 uppercase bg-gray-900/30">
                      <tr>
                        <th className="p-2">Time</th>
                        <th className="p-2">Share Price</th>
                        <th className="p-2">Vault Value</th>
                        <th className="p-2">Total Shares</th>
                      </tr>
                    </thead>
                    <tbody>
                      {points.slice(-5).reverse().map((pt: any, idx: number) => (
                        <tr key={idx} className="border-b border-gray-800/30 last:border-none hover:bg-gray-900/10">
                          <td className="p-2 text-gray-300">
                            {new Date(pt.timestamp_ms).toLocaleString()}
                          </td>
                          <td className="p-2 font-mono text-blue-400">
                            {pt.share_price.toFixed(6)}
                          </td>
                          <td className="p-2 font-mono">
                            ${(Number(pt.vault_value) / 1_000_000).toFixed(2)}
                          </td>
                          <td className="p-2 font-mono">
                            {(Number(pt.total_shares) / 1_000_000).toFixed(2)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {/* Supply LP Liquidity */}
      <div className="rounded-xl border border-gray-800 bg-gray-900/30 p-4 space-y-3">
        <div>
          <h3 className="font-semibold text-sm mb-1 text-gray-200">Supply Liquidity</h3>
          <p className="text-xs text-gray-400">Supply dUSDC in exchange for PLP shares.</p>
        </div>
        <div className="flex gap-2">
          <input
            type="number"
            value={supplyAmount}
            onChange={(e) => setSupplyAmount(e.target.value)}
            placeholder="USDC Amount (e.g. 50.0)"
            className="flex-1 rounded-lg bg-gray-950 px-3 py-2 text-sm border border-gray-800"
          />
          <button
            onClick={handleSupply}
            disabled={loading || !supplyAmount}
            className="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium hover:bg-green-700 disabled:opacity-50 transition"
          >
            Supply
          </button>
        </div>
      </div>

      {/* Withdraw LP Liquidity */}
      <div className="rounded-xl border border-gray-800 bg-gray-900/30 p-4 space-y-3">
        <div>
          <h3 className="font-semibold text-sm mb-1 text-gray-200">Withdraw Liquidity</h3>
          <p className="text-xs text-gray-400">Burn PLP shares to withdraw your dUSDC.</p>
        </div>
        <div className="flex gap-2">
          <input
            type="number"
            value={withdrawAmount}
            onChange={(e) => setWithdrawAmount(e.target.value)}
            placeholder="PLP Shares (e.g. 10.0)"
            className="flex-1 rounded-lg bg-gray-950 px-3 py-2 text-sm border border-gray-800"
          />
          <button
            onClick={handleWithdraw}
            disabled={loading || !withdrawAmount}
            className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium hover:bg-purple-700 disabled:opacity-50 transition"
          >
            Withdraw
          </button>
        </div>
      </div>
    </div>
  )
}
