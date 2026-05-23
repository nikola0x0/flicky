import { useState, useEffect } from 'react'
import { Transaction } from '@mysten/sui/transactions'
import { CONFIG } from '../../config'
import { client } from '../../lib/client'
import {
  readOracleStatus,
  readOracleIsSettled,
  readOracleSettlementPrice,
  readOracleSpotPrice,
  readTradingPaused,
  readOracleExpiry,
  readOracleId,
  readPythSourceId,
  readBlockScholesSpot,
  readBlockScholesForward,
  readBlockScholesPriceSourceTimestamp,
  readBlockScholesPriceUpdateTimestamp,
  readBlockScholesSVI,
  readBlockScholesSVISourceTimestamp,
  readBlockScholesSVIUpdateTimestamp,
  readBaseSpread,
  readMinSpread,
  readUtilizationMultiplier,
  readMaxTotalExposurePct,
  readAcceptedQuotes,
  readAvailableWithdrawal,
  readAskBounds,
} from '../../lib/predict-txb'

// BCS Return Value Parsing Utilities
const parseSuiReturnValue = (bytes: number[], typeStr: string): string => {
  if (!bytes || bytes.length === 0) return 'Empty'
  const cleanType = typeStr.replace(/\s+/g, '')

  if (cleanType === 'bool') {
    return bytes[0] === 1 ? 'true' : 'false'
  }

  if (cleanType === 'u8') {
    return bytes[0].toString()
  }

  if (cleanType === 'u64') {
    let val = 0n
    for (let i = bytes.length - 1; i >= 0; i--) {
      val = (val << 8n) + BigInt(bytes[i])
    }
    return val.toString()
  }

  if (cleanType === 'u128') {
    let val = 0n
    for (let i = bytes.length - 1; i >= 0; i--) {
      val = (val << 8n) + BigInt(bytes[i])
    }
    return val.toString()
  }

  if (cleanType === 'address' || cleanType === '0x2::object::ID' || cleanType.endsWith('::ID')) {
    const hex = Array.from(bytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
    return '0x' + hex
  }

  if (cleanType.startsWith('0x1::option::Option<') || cleanType.startsWith('Option<')) {
    if (bytes[0] === 0) {
      return 'None'
    } else {
      const innerType = cleanType.match(/Option<(.+)>/)?.[1] || 'unknown'
      const innerBytes = bytes.slice(1)
      return parseSuiReturnValue(innerBytes, innerType)
    }
  }

  if (cleanType.includes('string::String')) {
    const decoder = new TextDecoder()
    try {
      const textBytes = bytes.length > 1 && bytes[0] === bytes.length - 1 ? bytes.slice(1) : bytes
      return decoder.decode(new Uint8Array(textBytes))
    } catch {
      return bytes.toString()
    }
  }

  const hex = Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
  return `0x${hex} (${cleanType})`
}

const parseSVIParams = (bytes: number[]): string => {
  if (bytes.length < 42) {
    return `Invalid SVIParams bytes length: ${bytes.length}`
  }

  let offset = 0

  let aVal = 0n
  for (let i = 7; i >= 0; i--) {
    aVal = (aVal << 8n) + BigInt(bytes[offset + i])
  }
  offset += 8

  let bVal = 0n
  for (let i = 7; i >= 0; i--) {
    bVal = (bVal << 8n) + BigInt(bytes[offset + i])
  }
  offset += 8

  let rhoVal = 0n
  for (let i = 7; i >= 0; i--) {
    rhoVal = (rhoVal << 8n) + BigInt(bytes[offset + i])
  }
  const rhoNeg = bytes[offset + 8] === 1
  offset += 9

  let mVal = 0n
  for (let i = 7; i >= 0; i--) {
    mVal = (mVal << 8n) + BigInt(bytes[offset + i])
  }
  const mNeg = bytes[offset + 8] === 1
  offset += 9

  let sigmaVal = 0n
  for (let i = 7; i >= 0; i--) {
    sigmaVal = (sigmaVal << 8n) + BigInt(bytes[offset + i])
  }

  const formattedRho = (rhoNeg ? '-' : '') + (Number(rhoVal) / 1e9).toFixed(4)
  const formattedM = (mNeg ? '-' : '') + (Number(mVal) / 1e9).toFixed(4)
  const formattedSigma = (Number(sigmaVal) / 1e6).toFixed(4)

  return `SVI Parameters:\n` +
    `  • a: ${aVal.toString()}\n` +
    `  • b: ${(Number(bVal) / 1e9).toFixed(4)} (raw: ${bVal.toString()})\n` +
    `  • rho: ${formattedRho} (raw: ${rhoVal.toString()})\n` +
    `  • m: ${formattedM} (raw: ${mVal.toString()})\n` +
    `  • sigma: ${formattedSigma} (raw: ${sigmaVal.toString()})`
}

const parseAskBounds = (bytes: number[]): string => {
  if (bytes.length < 16) {
    return `Invalid AskBounds bytes length: ${bytes.length}`
  }
  let offset = 0
  let minPrice = 0n
  for (let i = 7; i >= 0; i--) {
    minPrice = (minPrice << 8n) + BigInt(bytes[offset + i])
  }
  offset += 8
  let maxPrice = 0n
  for (let i = 7; i >= 0; i--) {
    maxPrice = (maxPrice << 8n) + BigInt(bytes[offset + i])
  }

  return `Ask Price Bounds:\n` +
    `  • Min Ask Price: $${(Number(minPrice) / 1e9).toFixed(4)} (raw: ${minPrice.toString()})\n` +
    `  • Max Ask Price: $${(Number(maxPrice) / 1e9).toFixed(4)} (raw: ${maxPrice.toString()})`
}

const formatInspectResult = (returnValues: any, title: string): string => {
  if (!returnValues || returnValues.length === 0) {
    return 'No return value'
  }
  
  try {
    const [bytes, typeStr] = returnValues[0] as [number[], string]
    const cleanType = typeStr.replace(/\s+/g, '')

    if (cleanType.includes('SVIParams')) {
      return parseSVIParams(bytes)
    }

    if (cleanType.includes('AskBounds')) {
      return parseAskBounds(bytes)
    }

    const rawVal = parseSuiReturnValue(bytes, typeStr)

    if (cleanType === 'bool') {
      return `Value: ${rawVal}`
    }

    if (cleanType === 'u8') {
      if (title.toLowerCase().includes('status')) {
        const statusMap: Record<string, string> = {
          '0': '0 (Inactive)',
          '1': '1 (Active)',
          '2': '2 (Pending Settlement)',
          '3': '3 (Settled)',
        }
        return `Status: ${statusMap[rawVal] || rawVal}`
      }
      return `Value: ${rawVal}`
    }

    if (cleanType === 'u64') {
      const num = Number(rawVal)
      if (title.toLowerCase().includes('price') || title.toLowerCase().includes('spot') || title.toLowerCase().includes('forward') || title.toLowerCase().includes('payout') || title.toLowerCase().includes('bounds')) {
        return `Price: $${(num / 1e9).toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 })} (raw: ${rawVal})`
      }
      if (title.toLowerCase().includes('expiry') || title.toLowerCase().includes('timestamp') || title.toLowerCase().includes('ts')) {
        return `Timestamp: ${rawVal}\nDate: ${new Date(num).toLocaleString()}`
      }
      if (title.toLowerCase().includes('spread')) {
        return `Spread: ${(num / 1e9).toFixed(4)} (raw: ${rawVal})`
      }
      if (title.toLowerCase().includes('pct') || title.toLowerCase().includes('percent') || title.toLowerCase().includes('exposure')) {
        return `Percentage: ${(num / 1e7).toFixed(2)}% (raw: ${rawVal})`
      }
      if (title.toLowerCase().includes('withdrawal') || title.toLowerCase().includes('amount') || title.toLowerCase().includes('balance')) {
        return `Amount: ${(num / 1e6).toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 })} dUSDC (raw: ${rawVal})`
      }
      return `Value: ${rawVal}`
    }

    if (cleanType.includes('vector<') || cleanType.includes('VecSet<')) {
      if (cleanType.includes('string::String') || cleanType.includes('String') || cleanType.includes('TypeName')) {
        try {
          const strings: string[] = []
          let offset = 0
          let len = 0
          let shift = 0
          while (offset < bytes.length) {
            const byte = bytes[offset++]
            len |= (byte & 0x7f) << shift
            if ((byte & 0x80) === 0) break
            shift += 7
          }
          
          for (let k = 0; k < len; k++) {
            let strLen = 0
            let strShift = 0
            while (offset < bytes.length) {
              const byte = bytes[offset++]
              strLen |= (byte & 0x7f) << strShift
              if ((byte & 0x80) === 0) break
              strShift += 7
            }
            const strBytes = bytes.slice(offset, offset + strLen)
            strings.push(new TextDecoder().decode(new Uint8Array(strBytes)))
            offset += strLen
          }
          return `List (${len} items):\n` + strings.map(s => `  • ${s}`).join('\n')
        } catch {
          // fallback
        }
      }
    }

    return `Type: ${typeStr}\nRaw Value: ${rawVal}`
  } catch (err: any) {
    return `Failed to parse return value: ${err.message}\nRaw JSON: ${JSON.stringify(returnValues)}`
  }
}

interface PanelOutput {
  type: 'success' | 'error' | 'info'
  title: string
  data: string
}

interface OraclePanelProps {
  onOutput: (output: PanelOutput) => void
}

export default function OraclePanel({ onOutput }: OraclePanelProps) {
  const [oracleId, setOracleId] = useState(CONFIG.marketOracleId)
  const [loading, setLoading] = useState(false)

  // History states from public server
  const [priceHistory, setPriceHistory] = useState<any[]>([])
  const [sviHistory, setSviHistory] = useState<any[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyTab, setHistoryTab] = useState<'prices' | 'svi'>('prices')

  // Discovered oracles state
  const [discoveredOracles, setDiscoveredOracles] = useState<any[]>([])
  const [discovering, setDiscovering] = useState(false)

  const fetchHistory = async () => {
    if (!oracleId || !oracleId.startsWith('0x')) return
    setHistoryLoading(true)
    try {
      const [pricesRes, sviRes] = await Promise.all([
        fetch(`https://predict-server.testnet.mystenlabs.com/oracles/${oracleId}/prices`).then(r => r.ok ? r.json() : []),
        fetch(`https://predict-server.testnet.mystenlabs.com/oracles/${oracleId}/svi`).then(r => r.ok ? r.json() : []),
      ])
      setPriceHistory(Array.isArray(pricesRes) ? pricesRes : [])
      setSviHistory(Array.isArray(sviRes) ? sviRes : [])
    } catch (err) {
      console.error('Failed to fetch oracle history:', err)
    } finally {
      setHistoryLoading(false)
    }
  }

  const discoverOracles = async () => {
    setDiscovering(true)
    try {
      const list: any[] = []

      // 1. Fetch from Indexer (as baseline)
      if (CONFIG.predictObjectId) {
        try {
          const res = await fetch(`https://predict-server.testnet.mystenlabs.com/predicts/${CONFIG.predictObjectId}/oracles`)
          if (res.ok) {
            const data = await res.json()
            if (Array.isArray(data)) {
              for (const item of data) {
                list.push({
                  oracle_id: item.oracle_id,
                  underlying_asset: item.underlying_asset || 'BTC',
                  status: item.status || 'unknown',
                  expiry: Number(item.expiry || 0),
                  timestamp: Number(item.timestamp || 0),
                  source: 'indexer'
                })
              }
            }
          }
        } catch (err) {
          console.error('Failed to fetch oracles from indexer:', err)
        }
      }

      // 2. Fetch from On-chain events & multiGetObjects for real-time data
      if (CONFIG.predictPackageId) {
        try {
          const events = await client.queryEvents({
            query: {
              MoveEventType: `${CONFIG.predictPackageId}::oracle::OracleActivated`
            },
            order: 'descending',
            limit: 15
          })
          const activeIds = events.data.map(evt => (evt.parsedJson as any).oracle_id)
          if (activeIds.length > 0) {
            // Deduplicate IDs before fetching objects
            const uniqueIds = Array.from(new Set(activeIds))
            const details = await client.multiGetObjects({
              ids: uniqueIds,
              options: { showContent: true }
            })
            for (const item of details) {
              const f = (item.data?.content as any)?.fields
              if (f) {
                list.push({
                  oracle_id: item.data?.objectId,
                  underlying_asset: f.underlying_asset || 'BTC',
                  status: f.active ? 'active' : (f.settlement_price?.fields?.vec?.length > 0 ? 'settled' : 'pending'),
                  expiry: Number(f.expiry || 0),
                  timestamp: Number(f.timestamp || 0),
                  source: 'blockchain'
                })
              }
            }
          }
        } catch (err) {
          console.error('Failed to query oracles from blockchain:', err)
        }
      }

      // Deduplicate by oracle_id (blockchain source is preferred since it has real-time status)
      const uniqueMap = new Map<string, any>()
      for (const item of list) {
        if (!uniqueMap.has(item.oracle_id)) {
          uniqueMap.set(item.oracle_id, item)
        } else {
          const existing = uniqueMap.get(item.oracle_id)
          // Merge
          uniqueMap.set(item.oracle_id, {
            ...existing,
            ...item,
            status: item.source === 'blockchain' ? item.status : existing.status,
            source: item.source === 'blockchain' ? 'blockchain' : existing.source
          })
        }
      }

      const finalOracles = Array.from(uniqueMap.values())

      // Sort: newest activation (timestamp) first, then expiry first
      finalOracles.sort((a, b) => {
        if (b.timestamp !== a.timestamp) {
          return b.timestamp - a.timestamp
        }
        return b.expiry - a.expiry
      })

      setDiscoveredOracles(finalOracles)

      // Auto-select the latest if not selected yet
      if (finalOracles.length > 0 && (!oracleId || oracleId === CONFIG.marketOracleId)) {
        setOracleId(finalOracles[0].oracle_id)
      }
    } catch (err) {
      console.error('Oracle discovery failed:', err)
    } finally {
      setDiscovering(false)
    }
  }

  // Load oracles on mount
  useEffect(() => {
    discoverOracles()
  }, [])

  // Sync update history logs when oracleId changes
  useEffect(() => {
    fetchHistory()
  }, [oracleId])

  const callReadFunction = async (
    fn: (tx: Transaction, id: string) => void,
    title: string,
    needsOracleId = true
  ) => {
    if (needsOracleId && !oracleId) {
      onOutput({
        type: 'error',
        title: 'Error',
        data: 'Oracle ID required',
      })
      return
    }

    setLoading(true)
    try {
      const tx = new Transaction()
      if (needsOracleId) {
        fn(tx, oracleId)
      } else {
        fn(tx, '')
      }

      const result = await client.devInspectTransactionBlock({
        sender: '0x' + '0'.repeat(64),
        transactionBlock: tx,
      })

      const returnValues = result.results?.[0]?.returnValues
      const data = returnValues
        ? formatInspectResult(returnValues, title)
        : 'No return value'

      onOutput({
        type: 'success',
        title,
        data,
      })
    } catch (error) {
      onOutput({
        type: 'error',
        title: `${title} Failed`,
        data: String(error),
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-bold">Oracle Read Operations</h2>
        <p className="text-xs text-gray-400">
          Read-only devInspect calls to query the on-chain oracle and system configurations.
        </p>
      </div>

      {/* Oracle Selection / Input */}
      <div className="rounded-xl border border-gray-800 bg-gray-950 p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-gray-400 mb-0.5">
              Select Market Oracle
            </label>
            <p className="text-[10px] text-gray-500">Choose from active on-chain or registered oracles</p>
          </div>
          <button
            onClick={discoverOracles}
            disabled={discovering}
            className="text-xs text-blue-400 hover:text-blue-300 disabled:opacity-50 flex items-center gap-1 font-semibold"
          >
            {discovering ? '⏳ Discovering...' : '🔄 Refresh List'}
          </button>
        </div>

        {discoveredOracles.length > 0 && (
          <div>
            <select
              value={oracleId}
              onChange={(e) => setOracleId(e.target.value)}
              className="w-full rounded-lg bg-gray-900 px-3 py-2 text-xs border border-gray-800 focus:outline-none text-gray-200"
            >
              <option value="">-- Select an Oracle --</option>
              {discoveredOracles.map((o, idx) => (
                <option key={o.oracle_id} value={o.oracle_id}>
                  {idx === 0 ? '🔥 [LATEST] ' : ''}{o.underlying_asset} | {o.status.toUpperCase()} | Exp: {new Date(o.expiry).toLocaleDateString()} | Src: {o.source} ({o.oracle_id.slice(0, 10)}...)
                </option>
              ))}
            </select>
          </div>
        )}

        <div>
          <label className="block text-xs font-bold uppercase tracking-wider text-gray-400 mb-1">
            Manual Oracle ID Input
          </label>
          <input
            type="text"
            value={oracleId}
            onChange={(e) => setOracleId(e.target.value.trim())}
            placeholder="0x..."
            className="w-full rounded-lg bg-gray-900 px-3 py-1.5 text-xs border border-gray-800 focus:outline-none font-mono"
          />
          <p className="mt-1 text-[10px] text-gray-500 font-mono">
            Current: {oracleId || 'None'}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Group 1: Oracle State & Prices */}
        <div className="rounded-xl border border-gray-800 bg-gray-900/30 p-4 space-y-4">
          <div>
            <h3 className="font-semibold text-sm text-gray-200">Oracle State & Prices</h3>
            <p className="text-[10px] text-gray-400">Query general status and price data from the SVI oracle object</p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => callReadFunction(readOracleStatus, 'Oracle Status')}
              disabled={loading}
              className="rounded-lg bg-blue-600/80 hover:bg-blue-600 text-white px-3 py-2 text-xs font-semibold disabled:opacity-50 transition"
            >
              Get Status
            </button>
            <button
              onClick={() => callReadFunction(readOracleIsSettled, 'Is Settled')}
              disabled={loading}
              className="rounded-lg bg-green-600/80 hover:bg-green-600 text-white px-3 py-2 text-xs font-semibold disabled:opacity-50 transition"
            >
              Check Is Settled
            </button>
            <button
              onClick={() => callReadFunction(readOracleSpotPrice, 'Spot Price')}
              disabled={loading}
              className="rounded-lg bg-cyan-600/80 hover:bg-cyan-600 text-white px-3 py-2 text-xs font-semibold disabled:opacity-50 transition"
            >
              Get Spot Price
            </button>
            <button
              onClick={() => callReadFunction(readOracleSettlementPrice, 'Settlement Price')}
              disabled={loading}
              className="rounded-lg bg-purple-600/80 hover:bg-purple-600 text-white px-3 py-2 text-xs font-semibold disabled:opacity-50 transition"
            >
              Settlement Price
            </button>
            <button
              onClick={() => callReadFunction(readOracleExpiry, 'Expiry')}
              disabled={loading}
              className="rounded-lg bg-orange-600/80 hover:bg-orange-600 text-white px-3 py-2 text-xs font-semibold disabled:opacity-50 transition col-span-2"
            >
              Get Expiry Time
            </button>
          </div>
        </div>

        {/* Group 2: Oracle Metadata & Pauses */}
        <div className="rounded-xl border border-gray-800 bg-gray-900/30 p-4 space-y-4">
          <div>
            <h3 className="font-semibold text-sm text-gray-200">Oracle Metadata & Control</h3>
            <p className="text-[10px] text-gray-400">Inspect keys, source IDs, and general contract pause states</p>
          </div>
          <div className="flex flex-col gap-2">
            <button
              onClick={() => callReadFunction(readOracleId, 'Oracle ID')}
              disabled={loading}
              className="w-full rounded-lg bg-violet-600/80 hover:bg-violet-600 text-white px-3 py-2 text-xs font-semibold disabled:opacity-50 transition"
            >
              Get Oracle ID
            </button>
            <button
              onClick={() => callReadFunction(readPythSourceId, 'Pyth Source ID')}
              disabled={loading}
              className="w-full rounded-lg bg-indigo-600/80 hover:bg-indigo-600 text-white px-3 py-2 text-xs font-semibold disabled:opacity-50 transition"
            >
              Get Pyth Source ID
            </button>
            <button
              onClick={() => callReadFunction(readTradingPaused, 'Trading Paused', false)}
              disabled={loading}
              className="w-full rounded-lg bg-pink-600/80 hover:bg-pink-600 text-white px-3 py-2 text-xs font-semibold disabled:opacity-50 transition"
            >
              Check Trading Paused
            </button>
          </div>
        </div>

        {/* Group 3: Block Scholes Pricing */}
        <div className="rounded-xl border border-gray-800 bg-gray-900/30 p-4 space-y-4 col-span-1 md:col-span-2">
          <div>
            <h3 className="font-semibold text-sm text-gray-200">Block Scholes Model & Timestamps</h3>
            <p className="text-[10px] text-gray-400">Query BS calculated prices, SVI volatility surface params, and update timestamps</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="space-y-2">
              <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-400">Model Estimates</label>
              <button
                onClick={() => callReadFunction(readBlockScholesSpot, 'BS Spot')}
                disabled={loading}
                className="w-full rounded-lg bg-sky-600/80 hover:bg-sky-600 text-white px-3 py-2 text-xs font-semibold disabled:opacity-50 transition"
              >
                Get BS Spot
              </button>
              <button
                onClick={() => callReadFunction(readBlockScholesForward, 'BS Forward')}
                disabled={loading}
                className="w-full rounded-lg bg-sky-600/80 hover:bg-sky-600 text-white px-3 py-2 text-xs font-semibold disabled:opacity-50 transition"
              >
                Get BS Forward
              </button>
            </div>

            <div className="space-y-2">
              <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-400">Volatility Surface</label>
              <button
                onClick={() => callReadFunction(readBlockScholesSVI, 'BS SVI')}
                disabled={loading}
                className="w-full rounded-lg bg-teal-600/80 hover:bg-teal-600 text-white px-3 py-2 text-xs font-semibold disabled:opacity-50 transition"
              >
                Get SVI Params
              </button>
              <button
                onClick={() => callReadFunction(readAskBounds, 'Ask Bounds', true)}
                disabled={loading || !oracleId}
                className="w-full rounded-lg bg-indigo-600/80 hover:bg-indigo-600 text-white px-3 py-2 text-xs font-semibold disabled:opacity-50 transition"
              >
                Get Ask Bounds
              </button>
            </div>

            <div className="space-y-2">
              <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-400">Timestamps</label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => callReadFunction(readBlockScholesPriceSourceTimestamp, 'BS Price Source TS')}
                  disabled={loading}
                  className="rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 px-2 py-2 text-[10px] font-semibold disabled:opacity-50 transition"
                  title="Price Source Timestamp"
                >
                  Price Src TS
                </button>
                <button
                  onClick={() => callReadFunction(readBlockScholesPriceUpdateTimestamp, 'BS Price Update TS')}
                  disabled={loading}
                  className="rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 px-2 py-2 text-[10px] font-semibold disabled:opacity-50 transition"
                  title="Price Update Timestamp"
                >
                  Price Upd TS
                </button>
                <button
                  onClick={() => callReadFunction(readBlockScholesSVISourceTimestamp, 'SVI Source TS')}
                  disabled={loading}
                  className="rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 px-2 py-2 text-[10px] font-semibold disabled:opacity-50 transition"
                  title="SVI Source Timestamp"
                >
                  SVI Src TS
                </button>
                <button
                  onClick={() => callReadFunction(readBlockScholesSVIUpdateTimestamp, 'SVI Update TS')}
                  disabled={loading}
                  className="rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 px-2 py-2 text-[10px] font-semibold disabled:opacity-50 transition"
                  title="SVI Update Timestamp"
                >
                  SVI Upd TS
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Group 4: Protocol Configuration */}
        <div className="rounded-xl border border-gray-800 bg-gray-900/30 p-4 space-y-4 col-span-1 md:col-span-2">
          <div>
            <h3 className="font-semibold text-sm text-gray-200">Protocol Global Settings</h3>
            <p className="text-[10px] text-gray-400">Read pricing rules, risk bounds, exposure percentages, and accepted asset lists</p>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            <button
              onClick={() => callReadFunction(readBaseSpread, 'Base Spread', false)}
              disabled={loading}
              className="rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-200 px-3 py-2 text-xs font-semibold disabled:opacity-50 transition"
            >
              Base Spread
            </button>
            <button
              onClick={() => callReadFunction(readMinSpread, 'Min Spread', false)}
              disabled={loading}
              className="rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-200 px-3 py-2 text-xs font-semibold disabled:opacity-50 transition"
            >
              Min Spread
            </button>
            <button
              onClick={() => callReadFunction(readUtilizationMultiplier, 'Utilization Multiplier', false)}
              disabled={loading}
              className="rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-200 px-3 py-2 text-xs font-semibold disabled:opacity-50 transition"
            >
              Utilization Mult
            </button>
            <button
              onClick={() => callReadFunction(readMaxTotalExposurePct, 'Max Exposure Pct', false)}
              disabled={loading}
              className="rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-200 px-3 py-2 text-xs font-semibold disabled:opacity-50 transition"
            >
              Max Exposure %
            </button>
            <button
              onClick={() => callReadFunction(readAvailableWithdrawal, 'Available Withdrawal', false)}
              disabled={loading}
              className="rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-200 px-3 py-2 text-xs font-semibold disabled:opacity-50 transition"
            >
              Avail Withdrawal
            </button>
            <button
              onClick={() => callReadFunction(readAcceptedQuotes, 'Accepted Quotes', false)}
              disabled={loading}
              className="rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-200 px-3 py-2 text-xs font-semibold disabled:opacity-50 transition"
            >
              Accepted Quotes
            </button>
          </div>
        </div>
      </div>

      {/* Info */}
      <div className="rounded-xl border border-blue-900 bg-blue-950/40 p-3.5 text-xs text-blue-300">
        💡 All calls are read-only devInspect (no state changes, no transaction needed)
      </div>

      {/* Oracle History Logs (from Indexer) */}
      <div className="rounded-xl border border-gray-800 bg-gray-950 p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-sm text-gray-200">Oracle Update History</h3>
            <p className="text-[10px] text-gray-400">On-chain history feeds from public server indexer</p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setHistoryTab('prices')}
              className={`px-2.5 py-1 text-xs font-semibold rounded ${
                historyTab === 'prices' ? 'bg-blue-600 text-white' : 'bg-gray-900 text-gray-400 hover:bg-gray-800'
              }`}
            >
              Prices
            </button>
            <button
              onClick={() => setHistoryTab('svi')}
              className={`px-2.5 py-1 text-xs font-semibold rounded ${
                historyTab === 'svi' ? 'bg-blue-600 text-white' : 'bg-gray-900 text-gray-400 hover:bg-gray-800'
              }`}
            >
              SVI Surface
            </button>
            <button
              onClick={fetchHistory}
              disabled={historyLoading}
              className="text-[11px] text-blue-400 hover:text-blue-300 disabled:opacity-50 ml-1"
            >
              {historyLoading ? '⏳' : '🔄'}
            </button>
          </div>
        </div>

        {historyLoading ? (
          <div className="text-xs text-gray-500 py-6 text-center">⏳ Loading history logs...</div>
        ) : historyTab === 'prices' ? (
          <div className="overflow-x-auto rounded-lg border border-gray-900 bg-gray-950/40 text-[11px]">
            <table className="w-full text-left text-gray-400">
              <thead className="text-[10px] text-gray-500 uppercase bg-gray-900/50">
                <tr>
                  <th className="p-2">Time</th>
                  <th className="p-2">Spot Price</th>
                  <th className="p-2">Forward Price</th>
                </tr>
              </thead>
              <tbody>
                {priceHistory.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="p-4 text-center text-gray-500">No price updates found</td>
                  </tr>
                ) : (
                  priceHistory.slice(0, 8).map((pt, idx) => (
                    <tr key={idx} className="border-b border-gray-900 hover:bg-gray-900/20 last:border-none">
                      <td className="p-2 text-gray-300">
                        {new Date(pt.onchain_timestamp).toLocaleString()}
                      </td>
                      <td className="p-2 font-mono text-cyan-400">
                        ${(Number(pt.spot) / 1e9).toFixed(4)}
                      </td>
                      <td className="p-2 font-mono text-blue-400">
                        ${(Number(pt.forward) / 1e9).toFixed(4)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-gray-900 bg-gray-950/40 text-[11px]">
            <table className="w-full text-left text-gray-400">
              <thead className="text-[10px] text-gray-500 uppercase bg-gray-900/50">
                <tr>
                  <th className="p-2">Time</th>
                  <th className="p-2">a</th>
                  <th className="p-2">b</th>
                  <th className="p-2">rho</th>
                  <th className="p-2">m</th>
                  <th className="p-2">sigma</th>
                </tr>
              </thead>
              <tbody>
                {sviHistory.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="p-4 text-center text-gray-500">No SVI surface updates found</td>
                  </tr>
                ) : (
                  sviHistory.slice(0, 8).map((pt, idx) => {
                    const rhoVal = (pt.rho_negative ? '-' : '') + (Number(pt.rho) / 1e9).toFixed(4);
                    const mVal = (pt.m_negative ? '-' : '') + (Number(pt.m) / 1e9).toFixed(4);
                    const sigmaVal = (Number(pt.sigma) / 1e6).toFixed(4);
                    return (
                      <tr key={idx} className="border-b border-gray-900 hover:bg-gray-900/20 last:border-none">
                        <td className="p-2 text-gray-300">
                          {new Date(pt.onchain_timestamp).toLocaleString()}
                        </td>
                        <td className="p-2 font-mono">{pt.a}</td>
                        <td className="p-2 font-mono">{pt.b}</td>
                        <td className="p-2 font-mono text-purple-400">{rhoVal}</td>
                        <td className="p-2 font-mono text-orange-400">{mVal}</td>
                        <td className="p-2 font-mono text-teal-400">{sigmaVal}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
