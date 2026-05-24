import { useState, useEffect } from 'react'
import { useCurrentAccount, useSignAndExecuteTransaction } from '@mysten/dapp-kit'
import { Transaction } from '@mysten/sui/transactions'
import { CONFIG, DUSDC_TYPE } from '../../config'
import { client } from '../../lib/client'
import {
  txCompactSettledOracle,
  buildMarketKey,
  txRedeemPermissionless,
} from '../../lib/predict-txb'

interface PanelOutput {
  type: 'success' | 'error' | 'info'
  title: string
  data: string
  txDigest?: string
}

interface KeeperPanelProps {
  onOutput: (output: PanelOutput) => void
}

export default function KeeperPanel({ onOutput }: KeeperPanelProps) {
  const account = useCurrentAccount()
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction()

  // IDs
  const [oracleId, setOracleId] = useState<string>(CONFIG.marketOracleId)
  const [managerId, setManagerId] = useState<string>(() => {
    return localStorage.getItem('flicky_predict_manager_id') || ''
  })
  const [sviCapId, setSviCapId] = useState<string>('')

  // Strike inputs for redemption
  const [strike, setStrike] = useState<string>('')
  const [isUp, setIsUp] = useState<boolean>(true)
  const [expiry, setExpiry] = useState<string>('')

  // Quantity input for redemption
  const [quantity, setQuantity] = useState<string>('1')

  const [loading, setLoading] = useState(false)

  // Keeper activities from public server
  const [posMints, setPosMints] = useState<any[]>([])
  const [posRedeems, setPosRedeems] = useState<any[]>([])
  const [rangeMints, setRangeMints] = useState<any[]>([])
  const [rangeRedeems, setRangeRedeems] = useState<any[]>([])
  const [activitiesLoading, setActivitiesLoading] = useState(false)
  const [activeTab, setActiveTab] = useState<'positions' | 'ranges'>('positions')

  const fetchActivities = async () => {
    setActivitiesLoading(true)
    try {
      const [pm, pr, rm, rr] = await Promise.all([
        fetch('https://predict-server.testnet.mystenlabs.com/positions/minted').then(r => r.ok ? r.json() : []),
        fetch('https://predict-server.testnet.mystenlabs.com/positions/redeemed').then(r => r.ok ? r.json() : []),
        fetch('https://predict-server.testnet.mystenlabs.com/ranges/minted').then(r => r.ok ? r.json() : []),
        fetch('https://predict-server.testnet.mystenlabs.com/ranges/redeemed').then(r => r.ok ? r.json() : []),
      ])
      setPosMints(Array.isArray(pm) ? pm : [])
      setPosRedeems(Array.isArray(pr) ? pr : [])
      setRangeMints(Array.isArray(rm) ? rm : [])
      setRangeRedeems(Array.isArray(rr) ? rr : [])
    } catch (err) {
      console.error('Failed to fetch keeper activities:', err)
    } finally {
      setActivitiesLoading(false)
    }
  }

  // Sync manager ID if changed in localStorage
  useEffect(() => {
    const handleStorageChange = () => {
      setManagerId(localStorage.getItem('flicky_predict_manager_id') || '')
    }
    window.addEventListener('storage', handleStorageChange)
    fetchActivities()
    return () => window.removeEventListener('storage', handleStorageChange)
  }, [])

  // Auto-fetch OracleSVICap ID when account changes
  useEffect(() => {
    const fetchSviCap = async () => {
      if (!account?.address) {
        setSviCapId('')
        return
      }
      try {
        const response = await client.getOwnedObjects({
          owner: account.address,
          filter: {
            StructType: `${CONFIG.predictPackageId}::oracle::OracleSVICap`
          }
        })
        if (response.data && response.data.length > 0) {
          const capObjId = response.data[0].data?.objectId || ''
          setSviCapId(capObjId)
          console.log('Automatically found OracleSVICap ID:', capObjId)
        } else {
          setSviCapId('')
        }
      } catch (err) {
        console.error('Failed to auto-fetch OracleSVICap ID:', err)
        setSviCapId('')
      }
    }
    fetchSviCap()
  }, [account?.address])

  const handleCompact = async () => {
    if (!oracleId || !sviCapId) return
    setLoading(true)
    try {
      const tx = new Transaction()
      txCompactSettledOracle(tx, oracleId, sviCapId)

      const result = await signAndExecute({ transaction: tx })
      onOutput({
        type: 'success',
        title: 'Oracle Compacted Successfully',
        data: JSON.stringify(result, null, 2),
        txDigest: result.digest,
      })
    } catch (error) {
      onOutput({
        type: 'error',
        title: 'Compact Oracle Failed',
        data: String(error),
      })
    } finally {
      setLoading(false)
    }
  }

  const handleRedeemPermissionless = async () => {
    if (!account || !managerId || !oracleId || !strike || !expiry) return
    setLoading(true)
    try {
      const strikeRaw = BigInt(Math.floor(parseFloat(strike) * 1_000_000_000))
      const expiryRaw = BigInt(expiry)
      const qty = BigInt(Math.floor(parseFloat(quantity) * 1_000_000))
      if (qty <= 0n) throw new Error('Quantity must be greater than 0')

      const tx = new Transaction()
      const coinType = DUSDC_TYPE(CONFIG.dusdcPackageId)

      const marketKey = buildMarketKey(tx, oracleId, expiryRaw, strikeRaw, isUp)
      txRedeemPermissionless(tx, managerId, oracleId, marketKey, qty, coinType)

      const result = await signAndExecute({ transaction: tx })
      onOutput({
        type: 'success',
        title: 'Permissionless Redemption Successful',
        data: JSON.stringify(result, null, 2),
        txDigest: result.digest,
      })
    } catch (error) {
      onOutput({
        type: 'error',
        title: 'Permissionless Redemption Failed',
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
      <div>
        <h2 className="text-lg font-bold">Keeper Operations</h2>
        <p className="text-xs text-gray-400">
          Operations designed to run periodically by keepers, which can be executed permissionlessly.
        </p>
      </div>

      {/* ID inputs */}
      <div className="rounded-xl border border-gray-800 bg-gray-950 p-4 space-y-3">
        <div>
          <label className="block text-xs font-bold uppercase tracking-wider text-gray-400 mb-1">
            PredictManager ID
          </label>
          <input
            type="text"
            value={managerId}
            onChange={(e) => setManagerId(e.target.value.trim())}
            placeholder="0x..."
            className="w-full rounded-lg bg-gray-900 px-3 py-1.5 text-xs border border-gray-800 focus:outline-none"
          />
        </div>
        <div>
          <label className="block text-xs font-bold uppercase tracking-wider text-gray-400 mb-1">
            Oracle ID
          </label>
          <input
            type="text"
            value={oracleId}
            onChange={(e) => setOracleId(e.target.value.trim())}
            placeholder="0x..."
            className="w-full rounded-lg bg-gray-900 px-3 py-1.5 text-xs border border-gray-800 focus:outline-none"
          />
        </div>
      </div>

      {/* 1. Compact Settled Oracle */}
      <div className="rounded-xl border border-gray-800 bg-gray-900/30 p-4 space-y-3">
        <div>
          <h3 className="font-semibold text-sm mb-1 text-gray-200">Compact Settled Oracle</h3>
          <p className="text-xs text-gray-400">
            Compacts a settled oracle's strike matrix inside the vault to constant size.
          </p>
        </div>
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-gray-400 mb-1">
              OracleSVICap ID
            </label>
            <input
              type="text"
              value={sviCapId}
              onChange={(e) => setSviCapId(e.target.value.trim())}
              placeholder="Oracle SVI Cap ID (0x...)"
              className="w-full rounded-lg bg-gray-950 px-3 py-1.5 text-xs border border-gray-800 focus:outline-none"
            />
          </div>
          <button
            onClick={handleCompact}
            disabled={loading || !oracleId || !sviCapId}
            className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition"
          >
            Compact Oracle
          </button>
        </div>
      </div>

      {/* 2. Permissionless Redemption */}
      <div className="rounded-xl border border-gray-800 bg-gray-900/30 p-4 space-y-4">
        <div>
          <h3 className="font-semibold text-sm mb-1 text-gray-200">Permissionless Redemption</h3>
          <p className="text-xs text-gray-400">
            Settle a completed binary position in a manager permissionlessly. The payout is deposited into the owner's manager.
          </p>
        </div>

        {/* Binary Position Inputs */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-gray-400 block">Strike Price</label>
            <input
              type="number"
              value={strike}
              onChange={(e) => setStrike(e.target.value)}
              placeholder="e.g. 64000"
              className="w-full rounded-lg bg-gray-950 px-3 py-1.5 text-xs border border-gray-800 focus:outline-none"
            />
          </div>

          <div className="space-y-1">
            <label className="text-[11px] font-medium text-gray-400 block">Expiry Timestamp (ms)</label>
            <input
              type="text"
              value={expiry}
              onChange={(e) => setExpiry(e.target.value.trim())}
              placeholder="e.g. 1779532558000"
              className="w-full rounded-lg bg-gray-950 px-3 py-1.5 text-xs border border-gray-800 focus:outline-none"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-gray-400 block">Direction</label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setIsUp(true)}
                className={`flex-1 rounded-lg py-1.5 text-xs font-semibold border ${
                  isUp ? 'bg-green-950 text-green-400 border-green-800' : 'bg-gray-950 text-gray-400 border-gray-800'
                }`}
              >
                🟢 UP
              </button>
              <button
                type="button"
                onClick={() => setIsUp(false)}
                className={`flex-1 rounded-lg py-1.5 text-xs font-semibold border ${
                  !isUp ? 'bg-red-950 text-red-400 border-red-800' : 'bg-gray-950 text-gray-400 border-gray-800'
                }`}
              >
                🔴 DOWN
              </button>
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-[11px] font-medium text-gray-400 block">Quantity</label>
            <input
              type="number"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              placeholder="Quantity (e.g. 1.0)"
              className="w-full rounded-lg bg-gray-950 px-3 py-1.5 text-xs border border-gray-800 focus:outline-none"
            />
          </div>
        </div>

        <div className="pt-2">
          <button
            onClick={handleRedeemPermissionless}
            disabled={loading || !managerId || !oracleId || !strike || !expiry}
            className="w-full rounded-lg bg-green-600 px-4 py-2 text-xs font-semibold hover:bg-green-700 disabled:opacity-50 transition"
          >
            Settle via Oracle
          </button>
        </div>
      </div>

      {/* Recent Activities & Events Feed */}
      <div className="rounded-xl border border-gray-800 bg-gray-950 p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-sm text-gray-200">Recent Protocol Activity</h3>
            <p className="text-[10px] text-gray-400">Live feeds of mints and redemptions across all users</p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setActiveTab('positions')}
              className={`px-2.5 py-1 text-xs font-semibold rounded ${
                activeTab === 'positions' ? 'bg-blue-600 text-white' : 'bg-gray-900 text-gray-400 hover:bg-gray-800'
              }`}
            >
              Positions
            </button>
            <button
              onClick={() => setActiveTab('ranges')}
              className={`px-2.5 py-1 text-xs font-semibold rounded ${
                activeTab === 'ranges' ? 'bg-blue-600 text-white' : 'bg-gray-900 text-gray-400 hover:bg-gray-800'
              }`}
            >
              Ranges
            </button>
            <button
              onClick={fetchActivities}
              disabled={activitiesLoading}
              className="text-[11px] text-blue-400 hover:text-blue-300 disabled:opacity-50 ml-1"
            >
              {activitiesLoading ? '⏳' : '🔄'}
            </button>
          </div>
        </div>

        {activitiesLoading ? (
          <div className="text-xs text-gray-500 py-6 text-center">⏳ Loading protocol activity...</div>
        ) : activeTab === 'positions' ? (
          <div className="space-y-4 text-xs">
            {/* Minted Positions */}
            <div className="space-y-2">
              <h4 className="font-bold text-gray-300 text-[11px] uppercase tracking-wider flex items-center gap-1.5">
                <span>💹 Recent Mints</span>
                <span className="text-[10px] text-gray-500 font-normal">({posMints.length} logs)</span>
              </h4>
              <div className="overflow-x-auto rounded-lg border border-gray-900 bg-gray-950/40">
                <table className="w-full text-left text-gray-400 text-[11px]">
                  <thead className="text-[10px] text-gray-500 uppercase bg-gray-900/50">
                    <tr>
                      <th className="p-2">Time</th>
                      <th className="p-2">Trader</th>
                      <th className="p-2">Strike</th>
                      <th className="p-2">Side</th>
                      <th className="p-2">Qty</th>
                      <th className="p-2">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {posMints.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="p-4 text-center text-gray-500">No minted positions</td>
                      </tr>
                    ) : (
                      posMints.slice(0, 5).map((item, idx) => (
                        <tr key={idx} className="border-b border-gray-900 hover:bg-gray-900/20 last:border-none">
                          <td className="p-2 font-light text-gray-300">{new Date(item.checkpoint_timestamp_ms).toLocaleTimeString()}</td>
                          <td className="p-2 font-mono text-gray-500 max-w-[60px] truncate">{item.trader}</td>
                          <td className="p-2 font-mono">${(Number(item.strike) / 1e9).toFixed(2)}</td>
                          <td className="p-2 font-semibold">{item.is_up ? <span className="text-green-400">🟢 UP</span> : <span className="text-red-400">🔴 DOWN</span>}</td>
                          <td className="p-2 font-mono">{(Number(item.quantity) / 1e6).toFixed(2)}</td>
                          <td className="p-2 font-mono">${(Number(item.cost) / 1e6).toFixed(2)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Redeemed Positions */}
            <div className="space-y-2">
              <h4 className="font-bold text-gray-300 text-[11px] uppercase tracking-wider flex items-center gap-1.5">
                <span>📉 Recent Settlements (Redeems)</span>
                <span className="text-[10px] text-gray-500 font-normal">({posRedeems.length} logs)</span>
              </h4>
              <div className="overflow-x-auto rounded-lg border border-gray-900 bg-gray-950/40">
                <table className="w-full text-left text-gray-400 text-[11px]">
                  <thead className="text-[10px] text-gray-500 uppercase bg-gray-900/50">
                    <tr>
                      <th className="p-2">Time</th>
                      <th className="p-2">Owner</th>
                      <th className="p-2">Strike</th>
                      <th className="p-2">Qty</th>
                      <th className="p-2">Payout</th>
                      <th className="p-2">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {posRedeems.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="p-4 text-center text-gray-500">No redeemed positions</td>
                      </tr>
                    ) : (
                      posRedeems.slice(0, 5).map((item, idx) => (
                        <tr key={idx} className="border-b border-gray-900 hover:bg-gray-900/20 last:border-none">
                          <td className="p-2 font-light text-gray-300">{new Date(item.checkpoint_timestamp_ms).toLocaleTimeString()}</td>
                          <td className="p-2 font-mono text-gray-500 max-w-[60px] truncate">{item.owner}</td>
                          <td className="p-2 font-mono">${(Number(item.strike) / 1e9).toFixed(2)}</td>
                          <td className="p-2 font-mono">{(Number(item.quantity) / 1e6).toFixed(2)}</td>
                          <td className="p-2 font-semibold text-green-400">${(Number(item.payout) / 1e6).toFixed(2)}</td>
                          <td className="p-2">{item.is_settled ? <span className="text-green-500">✅ Settled</span> : <span className="text-yellow-500">⏳ Pending</span>}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-4 text-xs">
            {/* Minted Ranges */}
            <div className="space-y-2">
              <h4 className="font-bold text-gray-300 text-[11px] uppercase tracking-wider flex items-center gap-1.5">
                <span>💹 Recent Range Mints</span>
                <span className="text-[10px] text-gray-500 font-normal">({rangeMints.length} logs)</span>
              </h4>
              <div className="overflow-x-auto rounded-lg border border-gray-900 bg-gray-950/40">
                <table className="w-full text-left text-gray-400 text-[11px]">
                  <thead className="text-[10px] text-gray-500 uppercase bg-gray-900/50">
                    <tr>
                      <th className="p-2">Time</th>
                      <th className="p-2">Trader</th>
                      <th className="p-2">Range Strike</th>
                      <th className="p-2">Qty</th>
                      <th className="p-2">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rangeMints.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="p-4 text-center text-gray-500">No minted ranges</td>
                      </tr>
                    ) : (
                      rangeMints.slice(0, 5).map((item, idx) => (
                        <tr key={idx} className="border-b border-gray-900 hover:bg-gray-900/20 last:border-none">
                          <td className="p-2 font-light text-gray-300">{new Date(item.checkpoint_timestamp_ms).toLocaleTimeString()}</td>
                          <td className="p-2 font-mono text-gray-500 max-w-[60px] truncate">{item.trader}</td>
                          <td className="p-2">
                            {Number(item.lower_strike) === 0 ? '0' : (Number(item.lower_strike) / 1e9).toFixed(2)} -{' '}
                            {item.higher_strike?.toString()?.startsWith('184467') ? '∞' : (Number(item.higher_strike) / 1e9).toFixed(2)}
                          </td>
                          <td className="p-2 font-mono">{(Number(item.quantity) / 1e6).toFixed(2)}</td>
                          <td className="p-2 font-mono">${(Number(item.cost) / 1e6).toFixed(2)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Redeemed Ranges */}
            <div className="space-y-2">
              <h4 className="font-bold text-gray-300 text-[11px] uppercase tracking-wider flex items-center gap-1.5">
                <span>📉 Recent Range Settlements</span>
                <span className="text-[10px] text-gray-500 font-normal">({rangeRedeems.length} logs)</span>
              </h4>
              <div className="overflow-x-auto rounded-lg border border-gray-900 bg-gray-950/40">
                <table className="w-full text-left text-gray-400 text-[11px]">
                  <thead className="text-[10px] text-gray-500 uppercase bg-gray-900/50">
                    <tr>
                      <th className="p-2">Time</th>
                      <th className="p-2">Trader</th>
                      <th className="p-2">Range Strike</th>
                      <th className="p-2">Qty</th>
                      <th className="p-2">Payout</th>
                      <th className="p-2">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rangeRedeems.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="p-4 text-center text-gray-500">No redeemed ranges</td>
                      </tr>
                    ) : (
                      rangeRedeems.slice(0, 5).map((item, idx) => (
                        <tr key={idx} className="border-b border-gray-900 hover:bg-gray-900/20 last:border-none">
                          <td className="p-2 font-light text-gray-300">{new Date(item.checkpoint_timestamp_ms).toLocaleTimeString()}</td>
                          <td className="p-2 font-mono text-gray-500 max-w-[60px] truncate">{item.trader}</td>
                          <td className="p-2">
                            {Number(item.lower_strike) === 0 ? '0' : (Number(item.lower_strike) / 1e9).toFixed(2)} -{' '}
                            {item.higher_strike?.toString()?.startsWith('184467') ? '∞' : (Number(item.higher_strike) / 1e9).toFixed(2)}
                          </td>
                          <td className="p-2 font-mono">{(Number(item.quantity) / 1e6).toFixed(2)}</td>
                          <td className="p-2 font-semibold text-green-400">${(Number(item.payout) / 1e6).toFixed(2)}</td>
                          <td className="p-2">{item.is_settled ? <span className="text-green-500">✅ Settled</span> : <span className="text-yellow-500">⏳ Pending</span>}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
