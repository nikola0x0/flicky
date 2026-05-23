import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect } from 'react';
import { Transaction } from '@mysten/sui/transactions';
import { CONFIG } from '../../config';
import { client } from '../../lib/client';
import { readOracleStatus, readOracleIsSettled, readOracleSettlementPrice, readOracleSpotPrice, readTradingPaused, readOracleExpiry, readOracleId, readPythSourceId, readBlockScholesSpot, readBlockScholesForward, readBlockScholesPriceSourceTimestamp, readBlockScholesPriceUpdateTimestamp, readBlockScholesSVI, readBlockScholesSVISourceTimestamp, readBlockScholesSVIUpdateTimestamp, readBaseSpread, readMinSpread, readUtilizationMultiplier, readMaxTotalExposurePct, readAcceptedQuotes, readAvailableWithdrawal, readAskBounds, } from '../../lib/predict-txb';
// BCS Return Value Parsing Utilities
const parseSuiReturnValue = (bytes, typeStr) => {
    if (!bytes || bytes.length === 0)
        return 'Empty';
    const cleanType = typeStr.replace(/\s+/g, '');
    if (cleanType === 'bool') {
        return bytes[0] === 1 ? 'true' : 'false';
    }
    if (cleanType === 'u8') {
        return bytes[0].toString();
    }
    if (cleanType === 'u64') {
        let val = 0n;
        for (let i = bytes.length - 1; i >= 0; i--) {
            val = (val << 8n) + BigInt(bytes[i]);
        }
        return val.toString();
    }
    if (cleanType === 'u128') {
        let val = 0n;
        for (let i = bytes.length - 1; i >= 0; i--) {
            val = (val << 8n) + BigInt(bytes[i]);
        }
        return val.toString();
    }
    if (cleanType === 'address' || cleanType === '0x2::object::ID' || cleanType.endsWith('::ID')) {
        const hex = Array.from(bytes)
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
        return '0x' + hex;
    }
    if (cleanType.startsWith('0x1::option::Option<') || cleanType.startsWith('Option<')) {
        if (bytes[0] === 0) {
            return 'None';
        }
        else {
            const innerType = cleanType.match(/Option<(.+)>/)?.[1] || 'unknown';
            const innerBytes = bytes.slice(1);
            return parseSuiReturnValue(innerBytes, innerType);
        }
    }
    if (cleanType.includes('string::String')) {
        const decoder = new TextDecoder();
        try {
            const textBytes = bytes.length > 1 && bytes[0] === bytes.length - 1 ? bytes.slice(1) : bytes;
            return decoder.decode(new Uint8Array(textBytes));
        }
        catch {
            return bytes.toString();
        }
    }
    const hex = Array.from(bytes)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    return `0x${hex} (${cleanType})`;
};
const parseSVIParams = (bytes) => {
    if (bytes.length < 42) {
        return `Invalid SVIParams bytes length: ${bytes.length}`;
    }
    let offset = 0;
    let aVal = 0n;
    for (let i = 7; i >= 0; i--) {
        aVal = (aVal << 8n) + BigInt(bytes[offset + i]);
    }
    offset += 8;
    let bVal = 0n;
    for (let i = 7; i >= 0; i--) {
        bVal = (bVal << 8n) + BigInt(bytes[offset + i]);
    }
    offset += 8;
    let rhoVal = 0n;
    for (let i = 7; i >= 0; i--) {
        rhoVal = (rhoVal << 8n) + BigInt(bytes[offset + i]);
    }
    const rhoNeg = bytes[offset + 8] === 1;
    offset += 9;
    let mVal = 0n;
    for (let i = 7; i >= 0; i--) {
        mVal = (mVal << 8n) + BigInt(bytes[offset + i]);
    }
    const mNeg = bytes[offset + 8] === 1;
    offset += 9;
    let sigmaVal = 0n;
    for (let i = 7; i >= 0; i--) {
        sigmaVal = (sigmaVal << 8n) + BigInt(bytes[offset + i]);
    }
    const formattedRho = (rhoNeg ? '-' : '') + (Number(rhoVal) / 1e9).toFixed(4);
    const formattedM = (mNeg ? '-' : '') + (Number(mVal) / 1e9).toFixed(4);
    const formattedSigma = (Number(sigmaVal) / 1e6).toFixed(4);
    return `SVI Parameters:\n` +
        `  • a: ${aVal.toString()}\n` +
        `  • b: ${(Number(bVal) / 1e9).toFixed(4)} (raw: ${bVal.toString()})\n` +
        `  • rho: ${formattedRho} (raw: ${rhoVal.toString()})\n` +
        `  • m: ${formattedM} (raw: ${mVal.toString()})\n` +
        `  • sigma: ${formattedSigma} (raw: ${sigmaVal.toString()})`;
};
const parseAskBounds = (bytes) => {
    if (bytes.length < 16) {
        return `Invalid AskBounds bytes length: ${bytes.length}`;
    }
    let offset = 0;
    let minPrice = 0n;
    for (let i = 7; i >= 0; i--) {
        minPrice = (minPrice << 8n) + BigInt(bytes[offset + i]);
    }
    offset += 8;
    let maxPrice = 0n;
    for (let i = 7; i >= 0; i--) {
        maxPrice = (maxPrice << 8n) + BigInt(bytes[offset + i]);
    }
    return `Ask Price Bounds:\n` +
        `  • Min Ask Price: $${(Number(minPrice) / 1e9).toFixed(4)} (raw: ${minPrice.toString()})\n` +
        `  • Max Ask Price: $${(Number(maxPrice) / 1e9).toFixed(4)} (raw: ${maxPrice.toString()})`;
};
const formatInspectResult = (returnValues, title) => {
    if (!returnValues || returnValues.length === 0) {
        return 'No return value';
    }
    try {
        const [bytes, typeStr] = returnValues[0];
        const cleanType = typeStr.replace(/\s+/g, '');
        if (cleanType.includes('SVIParams')) {
            return parseSVIParams(bytes);
        }
        if (cleanType.includes('AskBounds')) {
            return parseAskBounds(bytes);
        }
        const rawVal = parseSuiReturnValue(bytes, typeStr);
        if (cleanType === 'bool') {
            return `Value: ${rawVal}`;
        }
        if (cleanType === 'u8') {
            if (title.toLowerCase().includes('status')) {
                const statusMap = {
                    '0': '0 (Inactive)',
                    '1': '1 (Active)',
                    '2': '2 (Pending Settlement)',
                    '3': '3 (Settled)',
                };
                return `Status: ${statusMap[rawVal] || rawVal}`;
            }
            return `Value: ${rawVal}`;
        }
        if (cleanType === 'u64') {
            const num = Number(rawVal);
            if (title.toLowerCase().includes('price') || title.toLowerCase().includes('spot') || title.toLowerCase().includes('forward') || title.toLowerCase().includes('payout') || title.toLowerCase().includes('bounds')) {
                return `Price: $${(num / 1e9).toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 })} (raw: ${rawVal})`;
            }
            if (title.toLowerCase().includes('expiry') || title.toLowerCase().includes('timestamp') || title.toLowerCase().includes('ts')) {
                return `Timestamp: ${rawVal}\nDate: ${new Date(num).toLocaleString()}`;
            }
            if (title.toLowerCase().includes('spread')) {
                return `Spread: ${(num / 1e9).toFixed(4)} (raw: ${rawVal})`;
            }
            if (title.toLowerCase().includes('pct') || title.toLowerCase().includes('percent') || title.toLowerCase().includes('exposure')) {
                return `Percentage: ${(num / 1e7).toFixed(2)}% (raw: ${rawVal})`;
            }
            if (title.toLowerCase().includes('withdrawal') || title.toLowerCase().includes('amount') || title.toLowerCase().includes('balance')) {
                return `Amount: ${(num / 1e6).toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 })} dUSDC (raw: ${rawVal})`;
            }
            return `Value: ${rawVal}`;
        }
        if (cleanType.includes('vector<') || cleanType.includes('VecSet<')) {
            if (cleanType.includes('string::String') || cleanType.includes('String') || cleanType.includes('TypeName')) {
                try {
                    const strings = [];
                    let offset = 0;
                    let len = 0;
                    let shift = 0;
                    while (offset < bytes.length) {
                        const byte = bytes[offset++];
                        len |= (byte & 0x7f) << shift;
                        if ((byte & 0x80) === 0)
                            break;
                        shift += 7;
                    }
                    for (let k = 0; k < len; k++) {
                        let strLen = 0;
                        let strShift = 0;
                        while (offset < bytes.length) {
                            const byte = bytes[offset++];
                            strLen |= (byte & 0x7f) << strShift;
                            if ((byte & 0x80) === 0)
                                break;
                            strShift += 7;
                        }
                        const strBytes = bytes.slice(offset, offset + strLen);
                        strings.push(new TextDecoder().decode(new Uint8Array(strBytes)));
                        offset += strLen;
                    }
                    return `List (${len} items):\n` + strings.map(s => `  • ${s}`).join('\n');
                }
                catch {
                    // fallback
                }
            }
        }
        return `Type: ${typeStr}\nRaw Value: ${rawVal}`;
    }
    catch (err) {
        return `Failed to parse return value: ${err.message}\nRaw JSON: ${JSON.stringify(returnValues)}`;
    }
};
export default function OraclePanel({ onOutput }) {
    const [oracleId, setOracleId] = useState(CONFIG.marketOracleId);
    const [loading, setLoading] = useState(false);
    // History states from public server
    const [priceHistory, setPriceHistory] = useState([]);
    const [sviHistory, setSviHistory] = useState([]);
    const [historyLoading, setHistoryLoading] = useState(false);
    const [historyTab, setHistoryTab] = useState('prices');
    // Discovered oracles state
    const [discoveredOracles, setDiscoveredOracles] = useState([]);
    const [discovering, setDiscovering] = useState(false);
    const fetchHistory = async () => {
        if (!oracleId || !oracleId.startsWith('0x'))
            return;
        setHistoryLoading(true);
        try {
            const [pricesRes, sviRes] = await Promise.all([
                fetch(`https://predict-server.testnet.mystenlabs.com/oracles/${oracleId}/prices`).then(r => r.ok ? r.json() : []),
                fetch(`https://predict-server.testnet.mystenlabs.com/oracles/${oracleId}/svi`).then(r => r.ok ? r.json() : []),
            ]);
            setPriceHistory(Array.isArray(pricesRes) ? pricesRes : []);
            setSviHistory(Array.isArray(sviRes) ? sviRes : []);
        }
        catch (err) {
            console.error('Failed to fetch oracle history:', err);
        }
        finally {
            setHistoryLoading(false);
        }
    };
    const discoverOracles = async () => {
        setDiscovering(true);
        try {
            const list = [];
            // 1. Fetch from Indexer (as baseline)
            if (CONFIG.predictObjectId) {
                try {
                    const res = await fetch(`https://predict-server.testnet.mystenlabs.com/predicts/${CONFIG.predictObjectId}/oracles`);
                    if (res.ok) {
                        const data = await res.json();
                        if (Array.isArray(data)) {
                            for (const item of data) {
                                list.push({
                                    oracle_id: item.oracle_id,
                                    underlying_asset: item.underlying_asset || 'BTC',
                                    status: item.status || 'unknown',
                                    expiry: Number(item.expiry || 0),
                                    timestamp: Number(item.timestamp || 0),
                                    source: 'indexer'
                                });
                            }
                        }
                    }
                }
                catch (err) {
                    console.error('Failed to fetch oracles from indexer:', err);
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
                    });
                    const activeIds = events.data.map(evt => evt.parsedJson.oracle_id);
                    if (activeIds.length > 0) {
                        // Deduplicate IDs before fetching objects
                        const uniqueIds = Array.from(new Set(activeIds));
                        const details = await client.multiGetObjects({
                            ids: uniqueIds,
                            options: { showContent: true }
                        });
                        for (const item of details) {
                            const f = item.data?.content?.fields;
                            if (f) {
                                list.push({
                                    oracle_id: item.data?.objectId,
                                    underlying_asset: f.underlying_asset || 'BTC',
                                    status: f.active ? 'active' : (f.settlement_price?.fields?.vec?.length > 0 ? 'settled' : 'pending'),
                                    expiry: Number(f.expiry || 0),
                                    timestamp: Number(f.timestamp || 0),
                                    source: 'blockchain'
                                });
                            }
                        }
                    }
                }
                catch (err) {
                    console.error('Failed to query oracles from blockchain:', err);
                }
            }
            // Deduplicate by oracle_id (blockchain source is preferred since it has real-time status)
            const uniqueMap = new Map();
            for (const item of list) {
                if (!uniqueMap.has(item.oracle_id)) {
                    uniqueMap.set(item.oracle_id, item);
                }
                else {
                    const existing = uniqueMap.get(item.oracle_id);
                    // Merge
                    uniqueMap.set(item.oracle_id, {
                        ...existing,
                        ...item,
                        status: item.source === 'blockchain' ? item.status : existing.status,
                        source: item.source === 'blockchain' ? 'blockchain' : existing.source
                    });
                }
            }
            const finalOracles = Array.from(uniqueMap.values());
            // Sort: newest activation (timestamp) first, then expiry first
            finalOracles.sort((a, b) => {
                if (b.timestamp !== a.timestamp) {
                    return b.timestamp - a.timestamp;
                }
                return b.expiry - a.expiry;
            });
            setDiscoveredOracles(finalOracles);
            // Auto-select the latest if not selected yet
            if (finalOracles.length > 0 && (!oracleId || oracleId === CONFIG.marketOracleId)) {
                setOracleId(finalOracles[0].oracle_id);
            }
        }
        catch (err) {
            console.error('Oracle discovery failed:', err);
        }
        finally {
            setDiscovering(false);
        }
    };
    // Load oracles on mount
    useEffect(() => {
        discoverOracles();
    }, []);
    // Sync update history logs when oracleId changes
    useEffect(() => {
        fetchHistory();
    }, [oracleId]);
    const callReadFunction = async (fn, title, needsOracleId = true) => {
        if (needsOracleId && !oracleId) {
            onOutput({
                type: 'error',
                title: 'Error',
                data: 'Oracle ID required',
            });
            return;
        }
        setLoading(true);
        try {
            const tx = new Transaction();
            if (needsOracleId) {
                fn(tx, oracleId);
            }
            else {
                fn(tx, '');
            }
            const result = await client.devInspectTransactionBlock({
                sender: '0x' + '0'.repeat(64),
                transactionBlock: tx,
            });
            const returnValues = result.results?.[0]?.returnValues;
            const data = returnValues
                ? formatInspectResult(returnValues, title)
                : 'No return value';
            onOutput({
                type: 'success',
                title,
                data,
            });
        }
        catch (error) {
            onOutput({
                type: 'error',
                title: `${title} Failed`,
                data: String(error),
            });
        }
        finally {
            setLoading(false);
        }
    };
    return (_jsxs("div", { className: "space-y-6", children: [_jsxs("div", { children: [_jsx("h2", { className: "text-lg font-bold", children: "Oracle Read Operations" }), _jsx("p", { className: "text-xs text-gray-400", children: "Read-only devInspect calls to query the on-chain oracle and system configurations." })] }), _jsxs("div", { className: "rounded-xl border border-gray-800 bg-gray-950 p-4 space-y-4", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { children: [_jsx("label", { className: "block text-xs font-bold uppercase tracking-wider text-gray-400 mb-0.5", children: "Select Market Oracle" }), _jsx("p", { className: "text-[10px] text-gray-500", children: "Choose from active on-chain or registered oracles" })] }), _jsx("button", { onClick: discoverOracles, disabled: discovering, className: "text-xs text-blue-400 hover:text-blue-300 disabled:opacity-50 flex items-center gap-1 font-semibold", children: discovering ? '⏳ Discovering...' : '🔄 Refresh List' })] }), discoveredOracles.length > 0 && (_jsx("div", { children: _jsxs("select", { value: oracleId, onChange: (e) => setOracleId(e.target.value), className: "w-full rounded-lg bg-gray-900 px-3 py-2 text-xs border border-gray-800 focus:outline-none text-gray-200", children: [_jsx("option", { value: "", children: "-- Select an Oracle --" }), discoveredOracles.map((o, idx) => (_jsxs("option", { value: o.oracle_id, children: [idx === 0 ? '🔥 [LATEST] ' : '', o.underlying_asset, " | ", o.status.toUpperCase(), " | Exp: ", new Date(o.expiry).toLocaleDateString(), " | Src: ", o.source, " (", o.oracle_id.slice(0, 10), "...)"] }, o.oracle_id)))] }) })), _jsxs("div", { children: [_jsx("label", { className: "block text-xs font-bold uppercase tracking-wider text-gray-400 mb-1", children: "Manual Oracle ID Input" }), _jsx("input", { type: "text", value: oracleId, onChange: (e) => setOracleId(e.target.value.trim()), placeholder: "0x...", className: "w-full rounded-lg bg-gray-900 px-3 py-1.5 text-xs border border-gray-800 focus:outline-none font-mono" }), _jsxs("p", { className: "mt-1 text-[10px] text-gray-500 font-mono", children: ["Current: ", oracleId || 'None'] })] })] }), _jsxs("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-4", children: [_jsxs("div", { className: "rounded-xl border border-gray-800 bg-gray-900/30 p-4 space-y-4", children: [_jsxs("div", { children: [_jsx("h3", { className: "font-semibold text-sm text-gray-200", children: "Oracle State & Prices" }), _jsx("p", { className: "text-[10px] text-gray-400", children: "Query general status and price data from the SVI oracle object" })] }), _jsxs("div", { className: "grid grid-cols-2 gap-2", children: [_jsx("button", { onClick: () => callReadFunction(readOracleStatus, 'Oracle Status'), disabled: loading, className: "rounded-lg bg-blue-600/80 hover:bg-blue-600 text-white px-3 py-2 text-xs font-semibold disabled:opacity-50 transition", children: "Get Status" }), _jsx("button", { onClick: () => callReadFunction(readOracleIsSettled, 'Is Settled'), disabled: loading, className: "rounded-lg bg-green-600/80 hover:bg-green-600 text-white px-3 py-2 text-xs font-semibold disabled:opacity-50 transition", children: "Check Is Settled" }), _jsx("button", { onClick: () => callReadFunction(readOracleSpotPrice, 'Spot Price'), disabled: loading, className: "rounded-lg bg-cyan-600/80 hover:bg-cyan-600 text-white px-3 py-2 text-xs font-semibold disabled:opacity-50 transition", children: "Get Spot Price" }), _jsx("button", { onClick: () => callReadFunction(readOracleSettlementPrice, 'Settlement Price'), disabled: loading, className: "rounded-lg bg-purple-600/80 hover:bg-purple-600 text-white px-3 py-2 text-xs font-semibold disabled:opacity-50 transition", children: "Settlement Price" }), _jsx("button", { onClick: () => callReadFunction(readOracleExpiry, 'Expiry'), disabled: loading, className: "rounded-lg bg-orange-600/80 hover:bg-orange-600 text-white px-3 py-2 text-xs font-semibold disabled:opacity-50 transition col-span-2", children: "Get Expiry Time" })] })] }), _jsxs("div", { className: "rounded-xl border border-gray-800 bg-gray-900/30 p-4 space-y-4", children: [_jsxs("div", { children: [_jsx("h3", { className: "font-semibold text-sm text-gray-200", children: "Oracle Metadata & Control" }), _jsx("p", { className: "text-[10px] text-gray-400", children: "Inspect keys, source IDs, and general contract pause states" })] }), _jsxs("div", { className: "flex flex-col gap-2", children: [_jsx("button", { onClick: () => callReadFunction(readOracleId, 'Oracle ID'), disabled: loading, className: "w-full rounded-lg bg-violet-600/80 hover:bg-violet-600 text-white px-3 py-2 text-xs font-semibold disabled:opacity-50 transition", children: "Get Oracle ID" }), _jsx("button", { onClick: () => callReadFunction(readPythSourceId, 'Pyth Source ID'), disabled: loading, className: "w-full rounded-lg bg-indigo-600/80 hover:bg-indigo-600 text-white px-3 py-2 text-xs font-semibold disabled:opacity-50 transition", children: "Get Pyth Source ID" }), _jsx("button", { onClick: () => callReadFunction(readTradingPaused, 'Trading Paused', false), disabled: loading, className: "w-full rounded-lg bg-pink-600/80 hover:bg-pink-600 text-white px-3 py-2 text-xs font-semibold disabled:opacity-50 transition", children: "Check Trading Paused" })] })] }), _jsxs("div", { className: "rounded-xl border border-gray-800 bg-gray-900/30 p-4 space-y-4 col-span-1 md:col-span-2", children: [_jsxs("div", { children: [_jsx("h3", { className: "font-semibold text-sm text-gray-200", children: "Block Scholes Model & Timestamps" }), _jsx("p", { className: "text-[10px] text-gray-400", children: "Query BS calculated prices, SVI volatility surface params, and update timestamps" })] }), _jsxs("div", { className: "grid grid-cols-1 sm:grid-cols-3 gap-3", children: [_jsxs("div", { className: "space-y-2", children: [_jsx("label", { className: "block text-[10px] font-bold uppercase tracking-wider text-gray-400", children: "Model Estimates" }), _jsx("button", { onClick: () => callReadFunction(readBlockScholesSpot, 'BS Spot'), disabled: loading, className: "w-full rounded-lg bg-sky-600/80 hover:bg-sky-600 text-white px-3 py-2 text-xs font-semibold disabled:opacity-50 transition", children: "Get BS Spot" }), _jsx("button", { onClick: () => callReadFunction(readBlockScholesForward, 'BS Forward'), disabled: loading, className: "w-full rounded-lg bg-sky-600/80 hover:bg-sky-600 text-white px-3 py-2 text-xs font-semibold disabled:opacity-50 transition", children: "Get BS Forward" })] }), _jsxs("div", { className: "space-y-2", children: [_jsx("label", { className: "block text-[10px] font-bold uppercase tracking-wider text-gray-400", children: "Volatility Surface" }), _jsx("button", { onClick: () => callReadFunction(readBlockScholesSVI, 'BS SVI'), disabled: loading, className: "w-full rounded-lg bg-teal-600/80 hover:bg-teal-600 text-white px-3 py-2 text-xs font-semibold disabled:opacity-50 transition", children: "Get SVI Params" }), _jsx("button", { onClick: () => callReadFunction(readAskBounds, 'Ask Bounds', true), disabled: loading || !oracleId, className: "w-full rounded-lg bg-indigo-600/80 hover:bg-indigo-600 text-white px-3 py-2 text-xs font-semibold disabled:opacity-50 transition", children: "Get Ask Bounds" })] }), _jsxs("div", { className: "space-y-2", children: [_jsx("label", { className: "block text-[10px] font-bold uppercase tracking-wider text-gray-400", children: "Timestamps" }), _jsxs("div", { className: "grid grid-cols-2 gap-2", children: [_jsx("button", { onClick: () => callReadFunction(readBlockScholesPriceSourceTimestamp, 'BS Price Source TS'), disabled: loading, className: "rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 px-2 py-2 text-[10px] font-semibold disabled:opacity-50 transition", title: "Price Source Timestamp", children: "Price Src TS" }), _jsx("button", { onClick: () => callReadFunction(readBlockScholesPriceUpdateTimestamp, 'BS Price Update TS'), disabled: loading, className: "rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 px-2 py-2 text-[10px] font-semibold disabled:opacity-50 transition", title: "Price Update Timestamp", children: "Price Upd TS" }), _jsx("button", { onClick: () => callReadFunction(readBlockScholesSVISourceTimestamp, 'SVI Source TS'), disabled: loading, className: "rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 px-2 py-2 text-[10px] font-semibold disabled:opacity-50 transition", title: "SVI Source Timestamp", children: "SVI Src TS" }), _jsx("button", { onClick: () => callReadFunction(readBlockScholesSVIUpdateTimestamp, 'SVI Update TS'), disabled: loading, className: "rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 px-2 py-2 text-[10px] font-semibold disabled:opacity-50 transition", title: "SVI Update Timestamp", children: "SVI Upd TS" })] })] })] })] }), _jsxs("div", { className: "rounded-xl border border-gray-800 bg-gray-900/30 p-4 space-y-4 col-span-1 md:col-span-2", children: [_jsxs("div", { children: [_jsx("h3", { className: "font-semibold text-sm text-gray-200", children: "Protocol Global Settings" }), _jsx("p", { className: "text-[10px] text-gray-400", children: "Read pricing rules, risk bounds, exposure percentages, and accepted asset lists" })] }), _jsxs("div", { className: "grid grid-cols-2 sm:grid-cols-3 gap-2", children: [_jsx("button", { onClick: () => callReadFunction(readBaseSpread, 'Base Spread', false), disabled: loading, className: "rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-200 px-3 py-2 text-xs font-semibold disabled:opacity-50 transition", children: "Base Spread" }), _jsx("button", { onClick: () => callReadFunction(readMinSpread, 'Min Spread', false), disabled: loading, className: "rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-200 px-3 py-2 text-xs font-semibold disabled:opacity-50 transition", children: "Min Spread" }), _jsx("button", { onClick: () => callReadFunction(readUtilizationMultiplier, 'Utilization Multiplier', false), disabled: loading, className: "rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-200 px-3 py-2 text-xs font-semibold disabled:opacity-50 transition", children: "Utilization Mult" }), _jsx("button", { onClick: () => callReadFunction(readMaxTotalExposurePct, 'Max Exposure Pct', false), disabled: loading, className: "rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-200 px-3 py-2 text-xs font-semibold disabled:opacity-50 transition", children: "Max Exposure %" }), _jsx("button", { onClick: () => callReadFunction(readAvailableWithdrawal, 'Available Withdrawal', false), disabled: loading, className: "rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-200 px-3 py-2 text-xs font-semibold disabled:opacity-50 transition", children: "Avail Withdrawal" }), _jsx("button", { onClick: () => callReadFunction(readAcceptedQuotes, 'Accepted Quotes', false), disabled: loading, className: "rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-200 px-3 py-2 text-xs font-semibold disabled:opacity-50 transition", children: "Accepted Quotes" })] })] })] }), _jsx("div", { className: "rounded-xl border border-blue-900 bg-blue-950/40 p-3.5 text-xs text-blue-300", children: "\uD83D\uDCA1 All calls are read-only devInspect (no state changes, no transaction needed)" }), _jsxs("div", { className: "rounded-xl border border-gray-800 bg-gray-950 p-4 space-y-4", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { children: [_jsx("h3", { className: "font-semibold text-sm text-gray-200", children: "Oracle Update History" }), _jsx("p", { className: "text-[10px] text-gray-400", children: "On-chain history feeds from public server indexer" })] }), _jsxs("div", { className: "flex gap-2", children: [_jsx("button", { onClick: () => setHistoryTab('prices'), className: `px-2.5 py-1 text-xs font-semibold rounded ${historyTab === 'prices' ? 'bg-blue-600 text-white' : 'bg-gray-900 text-gray-400 hover:bg-gray-800'}`, children: "Prices" }), _jsx("button", { onClick: () => setHistoryTab('svi'), className: `px-2.5 py-1 text-xs font-semibold rounded ${historyTab === 'svi' ? 'bg-blue-600 text-white' : 'bg-gray-900 text-gray-400 hover:bg-gray-800'}`, children: "SVI Surface" }), _jsx("button", { onClick: fetchHistory, disabled: historyLoading, className: "text-[11px] text-blue-400 hover:text-blue-300 disabled:opacity-50 ml-1", children: historyLoading ? '⏳' : '🔄' })] })] }), historyLoading ? (_jsx("div", { className: "text-xs text-gray-500 py-6 text-center", children: "\u23F3 Loading history logs..." })) : historyTab === 'prices' ? (_jsx("div", { className: "overflow-x-auto rounded-lg border border-gray-900 bg-gray-950/40 text-[11px]", children: _jsxs("table", { className: "w-full text-left text-gray-400", children: [_jsx("thead", { className: "text-[10px] text-gray-500 uppercase bg-gray-900/50", children: _jsxs("tr", { children: [_jsx("th", { className: "p-2", children: "Time" }), _jsx("th", { className: "p-2", children: "Spot Price" }), _jsx("th", { className: "p-2", children: "Forward Price" })] }) }), _jsx("tbody", { children: priceHistory.length === 0 ? (_jsx("tr", { children: _jsx("td", { colSpan: 3, className: "p-4 text-center text-gray-500", children: "No price updates found" }) })) : (priceHistory.slice(0, 8).map((pt, idx) => (_jsxs("tr", { className: "border-b border-gray-900 hover:bg-gray-900/20 last:border-none", children: [_jsx("td", { className: "p-2 text-gray-300", children: new Date(pt.onchain_timestamp).toLocaleString() }), _jsxs("td", { className: "p-2 font-mono text-cyan-400", children: ["$", (Number(pt.spot) / 1e9).toFixed(4)] }), _jsxs("td", { className: "p-2 font-mono text-blue-400", children: ["$", (Number(pt.forward) / 1e9).toFixed(4)] })] }, idx)))) })] }) })) : (_jsx("div", { className: "overflow-x-auto rounded-lg border border-gray-900 bg-gray-950/40 text-[11px]", children: _jsxs("table", { className: "w-full text-left text-gray-400", children: [_jsx("thead", { className: "text-[10px] text-gray-500 uppercase bg-gray-900/50", children: _jsxs("tr", { children: [_jsx("th", { className: "p-2", children: "Time" }), _jsx("th", { className: "p-2", children: "a" }), _jsx("th", { className: "p-2", children: "b" }), _jsx("th", { className: "p-2", children: "rho" }), _jsx("th", { className: "p-2", children: "m" }), _jsx("th", { className: "p-2", children: "sigma" })] }) }), _jsx("tbody", { children: sviHistory.length === 0 ? (_jsx("tr", { children: _jsx("td", { colSpan: 6, className: "p-4 text-center text-gray-500", children: "No SVI surface updates found" }) })) : (sviHistory.slice(0, 8).map((pt, idx) => {
                                        const rhoVal = (pt.rho_negative ? '-' : '') + (Number(pt.rho) / 1e9).toFixed(4);
                                        const mVal = (pt.m_negative ? '-' : '') + (Number(pt.m) / 1e9).toFixed(4);
                                        const sigmaVal = (Number(pt.sigma) / 1e6).toFixed(4);
                                        return (_jsxs("tr", { className: "border-b border-gray-900 hover:bg-gray-900/20 last:border-none", children: [_jsx("td", { className: "p-2 text-gray-300", children: new Date(pt.onchain_timestamp).toLocaleString() }), _jsx("td", { className: "p-2 font-mono", children: pt.a }), _jsx("td", { className: "p-2 font-mono", children: pt.b }), _jsx("td", { className: "p-2 font-mono text-purple-400", children: rhoVal }), _jsx("td", { className: "p-2 font-mono text-orange-400", children: mVal }), _jsx("td", { className: "p-2 font-mono text-teal-400", children: sigmaVal })] }, idx));
                                    })) })] }) }))] })] }));
}
//# sourceMappingURL=OraclePanel.js.map