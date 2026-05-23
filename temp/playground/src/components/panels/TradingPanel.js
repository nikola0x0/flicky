import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect } from 'react';
import { useCurrentAccount, useSignAndExecuteTransaction } from '@mysten/dapp-kit';
import { Transaction } from '@mysten/sui/transactions';
import { CONFIG, DUSDC_TYPE } from '../../config';
import { client } from '../../lib/client';
import { buildRangeKey, buildMarketKey, txMint, txRedeem, txMintRange, txRedeemRange, readGetTradeAmounts, readGetRangeTradeAmounts, readOracleSpotPrice, readBlockScholesForward, readOracleStatus, readOracleExpiry, readOracleSettlementPrice, } from '../../lib/predict-txb';
export default function TradingPanel({ onOutput }) {
    const account = useCurrentAccount();
    const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
    // Load saved manager ID from localStorage
    const [managerId, setManagerId] = useState(() => {
        return localStorage.getItem('flicky_predict_manager_id') || '';
    });
    const [oracleId, setOracleId] = useState(CONFIG.marketOracleId);
    const [pythSourceId, setPythSourceId] = useState(CONFIG.pythSourceId);
    // Position Type Selector
    const [positionType, setPositionType] = useState('range');
    // Range Position Strikes
    const [lowerStrike, setLowerStrike] = useState('');
    const [isNegInf, setIsNegInf] = useState(false);
    const [higherStrike, setHigherStrike] = useState('');
    const [isPosInf, setIsPosInf] = useState(false);
    // Binary Position Strikes & Side
    const [binaryStrike, setBinaryStrike] = useState('');
    const [isUp, setIsUp] = useState(true);
    // Quantity
    const [quantity, setQuantity] = useState('1');
    // UI state
    const [loading, setLoading] = useState(false);
    const [previewLoading, setPreviewLoading] = useState(false);
    const [quotePreview, setQuotePreview] = useState(null);
    // Public server data states
    const [oraclesList, setOraclesList] = useState([]);
    const [managerPositions, setManagerPositions] = useState([]);
    const [positionsLoading, setPositionsLoading] = useState(false);
    // Oracle info state
    const [oracleInfo, setOracleInfo] = useState(null);
    const [oracleInfoLoading, setOracleInfoLoading] = useState(false);
    // On-Chain positions state
    const [onChainPositions, setOnChainPositions] = useState([]);
    const [onChainPositionsLoading, setOnChainPositionsLoading] = useState(false);
    const [positionsView, setPositionsView] = useState('onchain');
    // Sync manager ID if changed in localStorage
    useEffect(() => {
        const handleStorageChange = () => {
            setManagerId(localStorage.getItem('flicky_predict_manager_id') || '');
        };
        window.addEventListener('storage', handleStorageChange);
        return () => window.removeEventListener('storage', handleStorageChange);
    }, []);
    // Helper to parse strikes and quantities with scaling
    const getParsedInputs = () => {
        const qty = BigInt(Math.floor(parseFloat(quantity) * 1_000_000));
        if (qty <= 0n) {
            throw new Error('Quantity must be greater than 0');
        }
        if (positionType === 'range') {
            let lower = 0n;
            if (!isNegInf) {
                if (!lowerStrike)
                    throw new Error('Lower strike is required');
                lower = BigInt(Math.floor(parseFloat(lowerStrike) * 1_000_000_000));
            }
            let higher = CONFIG.POS_INF_STRIKE;
            if (!isPosInf) {
                if (!higherStrike)
                    throw new Error('Higher strike is required');
                higher = BigInt(Math.floor(parseFloat(higherStrike) * 1_000_000_000));
            }
            if (lower >= higher) {
                throw new Error('Lower strike must be less than higher strike');
            }
            return { lower, higher, qty };
        }
        else {
            if (!binaryStrike)
                throw new Error('Strike is required');
            const strike = BigInt(Math.floor(parseFloat(binaryStrike) * 1_000_000_000));
            return { strike, isUp, qty };
        }
    };
    // Parse U64 bytes from devInspect
    const parseU64 = (bytes) => {
        let val = 0n;
        for (let i = bytes.length - 1; i >= 0; i--) {
            val = (val << 8n) | BigInt(bytes[i]);
        }
        return val;
    };
    const fetchOracleInfo = async () => {
        if (!account || !oracleId)
            return;
        setOracleInfoLoading(true);
        try {
            const tx = new Transaction();
            readOracleSpotPrice(tx, oracleId);
            readBlockScholesForward(tx, oracleId);
            readOracleStatus(tx, oracleId);
            readOracleExpiry(tx, oracleId);
            readOracleSettlementPrice(tx, oracleId);
            const result = await client.devInspectTransactionBlock({
                sender: account.address,
                transactionBlock: tx,
            });
            const res = result.results;
            if (res && res.length >= 5) {
                const spotRaw = res[0].returnValues?.[0]?.[0];
                const spot = spotRaw ? (Number(parseU64(spotRaw)) / 1_000_000_000).toFixed(4) : 'N/A';
                const forwardRaw = res[1].returnValues?.[0]?.[0];
                const forward = forwardRaw ? (Number(parseU64(forwardRaw)) / 1_000_000_000).toFixed(4) : 'N/A';
                const statusRaw = res[2].returnValues?.[0]?.[0];
                const statusVal = statusRaw ? statusRaw[0] : 0;
                const statusNames = ['Inactive', 'Active', 'PendingSettlement', 'Settled'];
                const status = statusNames[statusVal] || 'Unknown';
                const expiryRaw = res[3].returnValues?.[0]?.[0];
                const expiryMs = expiryRaw ? parseU64(expiryRaw) : 0n;
                const expiry = expiryMs > 0n ? new Date(Number(expiryMs)).toLocaleString() : 'N/A';
                const settlementRaw = res[4].returnValues?.[0]?.[0];
                let settlementPrice = null;
                if (settlementRaw && settlementRaw.length > 0) {
                    if (settlementRaw[0] === 1) {
                        const settRawVal = parseU64(settlementRaw.slice(1));
                        settlementPrice = (Number(settRawVal) / 1_000_000_000).toFixed(4);
                    }
                }
                setOracleInfo({
                    spotPrice: spot,
                    forwardPrice: forward,
                    status,
                    expiry,
                    expiryMs: expiryMs.toString(),
                    settlementPrice,
                });
            }
        }
        catch (err) {
            console.error('Failed to fetch oracle info:', err);
        }
        finally {
            setOracleInfoLoading(false);
        }
    };
    const fetchOraclesList = async () => {
        try {
            const list = [];
            // 1. Fetch from Indexer (as baseline)
            if (CONFIG.predictObjectId) {
                try {
                    const response = await fetch(`https://predict-server.testnet.mystenlabs.com/predicts/${CONFIG.predictObjectId}/oracles`);
                    if (response.ok) {
                        const data = await response.json();
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
            setOraclesList(finalOracles);
            // Auto-select the latest if the current oracle is the default
            if (finalOracles.length > 0 && (!oracleId || oracleId === CONFIG.marketOracleId)) {
                setOracleId(finalOracles[0].oracle_id);
            }
        }
        catch (err) {
            console.error('Failed to discover oracles list:', err);
        }
    };
    const fetchPositions = async () => {
        if (!managerId)
            return;
        setPositionsLoading(true);
        try {
            const response = await fetch(`https://predict-server.testnet.mystenlabs.com/managers/${managerId}/positions/summary`);
            if (response.ok) {
                const data = await response.json();
                setManagerPositions(Array.isArray(data) ? data : []);
            }
            else {
                setManagerPositions([]);
            }
        }
        catch (err) {
            console.error('Failed to fetch positions:', err);
            setManagerPositions([]);
        }
        finally {
            setPositionsLoading(false);
        }
    };
    // Load oracle info on mount & when account/oracleId changes
    useEffect(() => {
        if (account && oracleId) {
            fetchOracleInfo();
        }
    }, [account, oracleId]);
    // Load oracles list on mount
    useEffect(() => {
        fetchOraclesList();
    }, []);
    // Load positions when managerId changes
    useEffect(() => {
        if (managerId && managerId.startsWith('0x')) {
            fetchPositions();
            fetchOnChainPositions();
        }
        else {
            setManagerPositions([]);
            setOnChainPositions([]);
        }
    }, [managerId]);
    const fetchOnChainPositions = async () => {
        if (!managerId || !managerId.startsWith('0x')) {
            setOnChainPositions([]);
            return;
        }
        setOnChainPositionsLoading(true);
        try {
            const managerObj = await client.getObject({
                id: managerId,
                options: { showContent: true }
            });
            const fields = managerObj.data?.content?.fields;
            if (!fields) {
                setOnChainPositions([]);
                return;
            }
            const positionsTableId = fields.positions?.fields?.id?.id;
            const rangePositionsTableId = fields.range_positions?.fields?.id?.id;
            const list = [];
            // 1. Fetch Binary positions
            if (positionsTableId) {
                const dfs = await client.getDynamicFields({ parentId: positionsTableId });
                const activeDFs = dfs.data.map(df => df.objectId);
                if (activeDFs.length > 0) {
                    const details = await client.multiGetObjects({
                        ids: activeDFs,
                        options: { showContent: true }
                    });
                    for (const item of details) {
                        const f = item.data?.content?.fields;
                        if (f && f.value !== '0') {
                            list.push({
                                type: 'binary',
                                oracle_id: f.name.fields.oracle_id,
                                expiry: f.name.fields.expiry,
                                strike: f.name.fields.strike,
                                is_up: f.name.fields.direction !== undefined
                                    ? Number(f.name.fields.direction) === 0
                                    : (f.name.fields.is_up === true || f.name.fields.is_up === 'true'),
                                quantity: f.value,
                            });
                        }
                    }
                }
            }
            // 2. Fetch Range positions
            if (rangePositionsTableId) {
                const dfs = await client.getDynamicFields({ parentId: rangePositionsTableId });
                const activeDFs = dfs.data.map(df => df.objectId);
                if (activeDFs.length > 0) {
                    const details = await client.multiGetObjects({
                        ids: activeDFs,
                        options: { showContent: true }
                    });
                    for (const item of details) {
                        const f = item.data?.content?.fields;
                        if (f && f.value !== '0') {
                            list.push({
                                type: 'range',
                                oracle_id: f.name.fields.oracle_id,
                                expiry: f.name.fields.expiry,
                                lower_strike: f.name.fields.lower_strike,
                                higher_strike: f.name.fields.higher_strike,
                                quantity: f.value,
                            });
                        }
                    }
                }
            }
            setOnChainPositions(list);
        }
        catch (err) {
            console.error('Failed to fetch on-chain positions:', err);
            setOnChainPositions([]);
        }
        finally {
            setOnChainPositionsLoading(false);
        }
    };
    const getMatchingPosition = () => {
        try {
            const inputs = getParsedInputs();
            if (positionType === 'range') {
                const { lower, higher } = inputs;
                return onChainPositions.find((pos) => pos.type === 'range' &&
                    pos.oracle_id === oracleId &&
                    pos.lower_strike === lower.toString() &&
                    pos.higher_strike === higher.toString());
            }
            else {
                const { strike, isUp } = inputs;
                return onChainPositions.find((pos) => pos.type === 'binary' &&
                    pos.oracle_id === oracleId &&
                    pos.strike === strike.toString() &&
                    pos.is_up === isUp);
            }
        }
        catch {
            return null;
        }
    };
    const matchingPos = getMatchingPosition();
    const currentOwnedQty = matchingPos ? Number(matchingPos.quantity) / 1_000_000 : 0;
    const handlePreviewQuote = async () => {
        if (!account || !oracleId || !oracleInfo || !oracleInfo.expiryMs)
            return;
        setPreviewLoading(true);
        setQuotePreview(null);
        try {
            const inputs = getParsedInputs();
            const tx = new Transaction();
            const expiryBigInt = BigInt(oracleInfo.expiryMs);
            if (positionType === 'range') {
                const { lower, higher } = inputs;
                const rangeKey = buildRangeKey(tx, oracleId, expiryBigInt, lower, higher);
                readGetRangeTradeAmounts(tx, oracleId, rangeKey, 1000000n); // Unit contract (10^6 units)
            }
            else {
                const { strike, isUp } = inputs;
                const marketKey = buildMarketKey(tx, oracleId, expiryBigInt, strike, isUp);
                readGetTradeAmounts(tx, oracleId, marketKey, 1000000n); // Unit contract (10^6 units)
            }
            const result = await client.devInspectTransactionBlock({
                sender: account.address,
                transactionBlock: tx,
            });
            const returnValues = result.results?.[1]?.returnValues;
            if (returnValues && returnValues.length >= 2) {
                const mintCostRaw = parseU64(returnValues[0][0]);
                const redeemPayoutRaw = parseU64(returnValues[1][0]);
                setQuotePreview({
                    mintCost: (Number(mintCostRaw) / 1_000_000).toFixed(6),
                    redeemPayout: (Number(redeemPayoutRaw) / 1_000_000).toFixed(6),
                });
                onOutput({
                    type: 'info',
                    title: 'Quote Preview Updated',
                    data: `Unit Mint Cost: ${(Number(mintCostRaw) / 1_000_000).toFixed(6)} dUSDC\nUnit Redeem Payout: ${(Number(redeemPayoutRaw) / 1_000_000).toFixed(6)} dUSDC`,
                });
            }
            else {
                throw new Error('Invalid return values from get_trade_amounts');
            }
        }
        catch (error) {
            onOutput({
                type: 'error',
                title: 'Quote Preview Failed',
                data: String(error),
            });
        }
        finally {
            setPreviewLoading(false);
        }
    };
    const handleMint = async () => {
        if (!account || !managerId || !oracleId || !oracleInfo || !oracleInfo.expiryMs)
            return;
        setLoading(true);
        try {
            const inputs = getParsedInputs();
            const tx = new Transaction();
            const coinType = DUSDC_TYPE(CONFIG.dusdcPackageId);
            const expiryBigInt = BigInt(oracleInfo.expiryMs);
            if (positionType === 'range') {
                const { lower, higher, qty } = inputs;
                const rangeKey = buildRangeKey(tx, oracleId, expiryBigInt, lower, higher);
                txMintRange(tx, managerId, oracleId, rangeKey, qty, coinType);
            }
            else {
                const { strike, isUp, qty } = inputs;
                const marketKey = buildMarketKey(tx, oracleId, expiryBigInt, strike, isUp);
                txMint(tx, managerId, oracleId, marketKey, qty, coinType);
            }
            const result = await signAndExecute({ transaction: tx });
            onOutput({
                type: 'success',
                title: 'Mint Position Successful',
                data: JSON.stringify(result, null, 2),
                txDigest: result.digest,
            });
            setTimeout(() => {
                fetchPositions();
                fetchOnChainPositions();
                fetchOracleInfo();
            }, 2000);
        }
        catch (error) {
            onOutput({
                type: 'error',
                title: 'Mint Position Failed',
                data: String(error),
            });
        }
        finally {
            setLoading(false);
        }
    };
    const handleRedeem = async () => {
        if (!account || !managerId || !oracleId || !oracleInfo || !oracleInfo.expiryMs)
            return;
        setLoading(true);
        try {
            const inputs = getParsedInputs();
            const tx = new Transaction();
            const coinType = DUSDC_TYPE(CONFIG.dusdcPackageId);
            const expiryBigInt = BigInt(oracleInfo.expiryMs);
            if (positionType === 'range') {
                const { lower, higher, qty } = inputs;
                const rangeKey = buildRangeKey(tx, oracleId, expiryBigInt, lower, higher);
                txRedeemRange(tx, managerId, oracleId, rangeKey, qty, coinType);
            }
            else {
                const { strike, isUp, qty } = inputs;
                const marketKey = buildMarketKey(tx, oracleId, expiryBigInt, strike, isUp);
                txRedeem(tx, managerId, oracleId, marketKey, qty, coinType);
            }
            const result = await signAndExecute({ transaction: tx });
            onOutput({
                type: 'success',
                title: 'Redeem Position Successful',
                data: JSON.stringify(result, null, 2),
                txDigest: result.digest,
            });
            setTimeout(() => {
                fetchPositions();
                fetchOnChainPositions();
                fetchOracleInfo();
            }, 2000);
        }
        catch (error) {
            onOutput({
                type: 'error',
                title: 'Redeem Position Failed',
                data: String(error),
            });
        }
        finally {
            setLoading(false);
        }
    };
    if (!account) {
        return (_jsx("div", { className: "text-gray-400 py-10 text-center", children: "\uD83D\uDD0C Please connect your wallet to use this panel" }));
    }
    return (_jsxs("div", { className: "space-y-6", children: [_jsxs("div", { children: [_jsx("h2", { className: "text-lg font-bold", children: "Trading Operations" }), _jsx("p", { className: "text-xs text-gray-400", children: "Mint (Buy) or Redeem (Sell) vertical range position contracts" })] }), _jsxs("div", { className: "rounded-xl border border-gray-800 bg-gray-950 p-4 space-y-3", children: [_jsxs("div", { children: [_jsx("label", { className: "block text-xs font-bold uppercase tracking-wider text-gray-400 mb-1", children: "PredictManager ID" }), _jsx("input", { type: "text", value: managerId, onChange: (e) => setManagerId(e.target.value.trim()), placeholder: "0x... (Must configure in Manager Panel first)", className: "w-full rounded-lg bg-gray-900 px-3 py-1.5 text-xs border border-gray-800 focus:outline-none" })] }), oraclesList.length > 0 && (_jsxs("div", { children: [_jsx("label", { className: "block text-xs font-bold uppercase tracking-wider text-gray-400 mb-1", children: "Select Market Oracle" }), _jsxs("select", { value: oracleId, onChange: (e) => {
                                    const selected = oraclesList.find((o) => o.oracle_id === e.target.value);
                                    if (selected) {
                                        setOracleId(selected.oracle_id);
                                    }
                                }, className: "w-full rounded-lg bg-gray-900 px-3 py-1.5 text-xs border border-gray-800 focus:outline-none text-gray-200", children: [_jsx("option", { value: "", children: "-- Choose an active/settled market --" }), oraclesList.map((o, idx) => (_jsxs("option", { value: o.oracle_id, children: [idx === 0 ? '🔥 [LATEST] ' : '', o.underlying_asset, " | ", o.status.toUpperCase(), " | Exp: ", new Date(o.expiry).toLocaleDateString(), " (", o.oracle_id.slice(0, 10), "...)"] }, o.oracle_id)))] })] })), _jsxs("div", { children: [_jsx("label", { className: "block text-xs font-bold uppercase tracking-wider text-gray-400 mb-1", children: "Market Oracle ID" }), _jsx("input", { type: "text", value: oracleId, onChange: (e) => setOracleId(e.target.value.trim()), placeholder: "0x...", className: "w-full rounded-lg bg-gray-900 px-3 py-1.5 text-xs border border-gray-800 focus:outline-none" })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-xs font-bold uppercase tracking-wider text-gray-400 mb-1", children: "Pyth Source ID" }), _jsx("input", { type: "text", value: pythSourceId, onChange: (e) => setPythSourceId(e.target.value.trim()), placeholder: "0x...", className: "w-full rounded-lg bg-gray-900 px-3 py-1.5 text-xs border border-gray-800 focus:outline-none" })] })] }), oracleInfo && (_jsxs("div", { className: "rounded-xl border border-gray-800 bg-gray-950 p-4 space-y-3", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsx("span", { className: "text-xs font-bold uppercase tracking-wider text-gray-400", children: "Live Market Info" }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsx("span", { className: `rounded-full px-2.5 py-0.5 text-[10px] font-semibold border ${oracleInfo.status === 'Active'
                                            ? 'bg-green-500/10 text-green-400 border-green-500/20'
                                            : oracleInfo.status === 'Settled'
                                                ? 'bg-purple-500/10 text-purple-400 border-purple-500/20'
                                                : 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20'}`, children: oracleInfo.status }), _jsx("button", { onClick: fetchOracleInfo, disabled: oracleInfoLoading, className: "text-[11px] text-blue-400 hover:text-blue-300 disabled:opacity-50", children: oracleInfoLoading ? '⏳ Syncing...' : '🔄 Refresh' })] })] }), _jsxs("div", { className: "grid grid-cols-2 md:grid-cols-4 gap-4 text-xs", children: [_jsxs("div", { className: "rounded-lg bg-gray-900/40 p-2.5 border border-gray-800/50", children: [_jsx("div", { className: "text-gray-400 mb-0.5 font-medium", children: "Spot Price" }), _jsxs("div", { className: "text-sm font-bold text-gray-100", children: ["$", oracleInfo.spotPrice] })] }), _jsxs("div", { className: "rounded-lg bg-gray-900/40 p-2.5 border border-gray-800/50", children: [_jsx("div", { className: "text-gray-400 mb-0.5 font-medium", children: "BS Forward Price" }), _jsxs("div", { className: "text-sm font-bold text-gray-100", children: ["$", oracleInfo.forwardPrice] })] }), _jsxs("div", { className: "rounded-lg bg-gray-900/40 p-2.5 border border-gray-800/50", children: [_jsx("div", { className: "text-gray-400 mb-0.5 font-medium", children: "Expiry" }), _jsx("div", { className: "text-[11px] font-semibold text-gray-200 truncate", title: oracleInfo.expiry, children: oracleInfo.expiry })] }), _jsxs("div", { className: "rounded-lg bg-gray-900/40 p-2.5 border border-gray-800/50", children: [_jsx("div", { className: "text-gray-400 mb-0.5 font-medium", children: "Settlement Price" }), _jsx("div", { className: "text-sm font-bold text-purple-400", children: oracleInfo.settlementPrice ? `$${oracleInfo.settlementPrice}` : 'Not Settled' })] })] })] })), _jsxs("div", { className: "rounded-xl border border-gray-800 bg-gray-900/40 p-4 space-y-4", children: [_jsxs("div", { className: "flex gap-2 border-b border-gray-800/60 pb-3", children: [_jsx("button", { type: "button", onClick: () => { setPositionType('range'); setQuotePreview(null); }, className: `px-3.5 py-1.5 text-xs font-semibold rounded-lg transition ${positionType === 'range' ? 'bg-blue-600 text-white' : 'bg-gray-950 text-gray-400 hover:bg-gray-900'}`, children: "Range Position (Strikes Band)" }), _jsx("button", { type: "button", onClick: () => { setPositionType('binary'); setQuotePreview(null); }, className: `px-3.5 py-1.5 text-xs font-semibold rounded-lg transition ${positionType === 'binary' ? 'bg-blue-600 text-white' : 'bg-gray-950 text-gray-400 hover:bg-gray-900'}`, children: "Binary Position (Single Strike Up/Down)" })] }), positionType === 'range' ? (_jsxs("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-4", children: [_jsxs("div", { className: "space-y-2", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsx("label", { className: "block text-xs font-medium text-gray-400", children: "Lower Strike" }), _jsxs("label", { className: "flex items-center gap-1 text-[11px] text-gray-400 cursor-pointer", children: [_jsx("input", { type: "checkbox", checked: isNegInf, onChange: (e) => setIsNegInf(e.target.checked), className: "rounded border-gray-800 bg-gray-950 text-blue-600 focus:ring-0" }), "Neg Infinity (0)"] })] }), _jsx("input", { type: "number", value: lowerStrike, onChange: (e) => setLowerStrike(e.target.value), disabled: isNegInf, placeholder: "e.g. 50000", className: "w-full rounded-lg bg-gray-950 px-3 py-2 text-sm border border-gray-800 disabled:opacity-50" })] }), _jsxs("div", { className: "space-y-2", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsx("label", { className: "block text-xs font-medium text-gray-400", children: "Higher Strike" }), _jsxs("label", { className: "flex items-center gap-1 text-[11px] text-gray-400 cursor-pointer", children: [_jsx("input", { type: "checkbox", checked: isPosInf, onChange: (e) => setIsPosInf(e.target.checked), className: "rounded border-gray-800 bg-gray-950 text-blue-600 focus:ring-0" }), "Pos Infinity (max)"] })] }), _jsx("input", { type: "number", value: higherStrike, onChange: (e) => setHigherStrike(e.target.value), disabled: isPosInf, placeholder: "e.g. 55000", className: "w-full rounded-lg bg-gray-950 px-3 py-2 text-sm border border-gray-800 disabled:opacity-50" })] })] })) : (_jsxs("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-4", children: [_jsxs("div", { className: "space-y-2", children: [_jsx("label", { className: "block text-xs font-medium text-gray-400 text-left", children: "Strike Price" }), _jsx("input", { type: "number", value: binaryStrike, onChange: (e) => setBinaryStrike(e.target.value), placeholder: "e.g. 74000", className: "w-full rounded-lg bg-gray-950 px-3 py-2 text-sm border border-gray-800" })] }), _jsxs("div", { className: "space-y-2", children: [_jsx("label", { className: "block text-xs font-medium text-gray-400 text-left", children: "Direction (Side)" }), _jsxs("div", { className: "flex gap-2", children: [_jsx("button", { type: "button", onClick: () => setIsUp(true), className: `flex-1 py-2 text-xs font-bold rounded-lg border transition ${isUp
                                                    ? 'bg-green-950/40 text-green-400 border-green-600/80 shadow-[0_0_10px_rgba(34,197,94,0.15)]'
                                                    : 'bg-gray-950 text-gray-500 border-gray-900 hover:border-gray-800'}`, children: "\uD83D\uDFE2 UP (Bullish)" }), _jsx("button", { type: "button", onClick: () => setIsUp(false), className: `flex-1 py-2 text-xs font-bold rounded-lg border transition ${!isUp
                                                    ? 'bg-red-950/40 text-red-400 border-red-600/80 shadow-[0_0_10px_rgba(239,68,68,0.15)]'
                                                    : 'bg-gray-950 text-gray-500 border-gray-900 hover:border-gray-800'}`, children: "\uD83D\uDD34 DOWN (Bearish)" })] })] })] })), _jsx("p", { className: "text-[10px] text-gray-400 italic text-left", children: "* Strike inputs are automatically scaled by 10^9 (FLOAT_SCALING) under the hood." })] }), _jsxs("div", { className: "rounded-xl border border-gray-800 bg-gray-900/40 p-4 space-y-4", children: [_jsx("h3", { className: "font-semibold text-sm text-gray-200", children: "Contracts Quantity" }), _jsxs("div", { children: [_jsx("input", { type: "number", value: quantity, onChange: (e) => setQuantity(e.target.value), placeholder: "Quantity (e.g. 1.0)", className: "w-full rounded-lg bg-gray-950 px-3 py-2 text-sm border border-gray-800 focus:outline-none" }), _jsx("p", { className: "mt-1 text-[10px] text-gray-400 italic", children: "* Contract quantities are scaled by 10^6 (6 decimals). 1.0 contract = 1,000,000 units." })] }), quotePreview && (_jsxs("div", { className: "rounded-lg border border-blue-900 bg-blue-950/40 p-3 text-xs flex justify-between", children: [_jsxs("div", { children: [_jsx("span", { className: "text-gray-400", children: "Est. Unit Mint Cost: " }), _jsxs("span", { className: "font-semibold text-blue-200", children: ["$", quotePreview.mintCost, " dUSDC"] })] }), _jsxs("div", { children: [_jsx("span", { className: "text-gray-400", children: "Est. Unit Redeem Payout: " }), _jsxs("span", { className: "font-semibold text-green-400", children: ["$", quotePreview.redeemPayout, " dUSDC"] })] })] })), _jsxs("div", { className: "grid grid-cols-1 md:grid-cols-3 gap-2", children: [_jsx("button", { onClick: handlePreviewQuote, disabled: previewLoading || loading || !managerId, className: "w-full rounded-lg bg-gray-800 px-4 py-2.5 text-xs font-semibold text-gray-200 hover:bg-gray-700 disabled:opacity-50", children: previewLoading ? '⏳ Loading...' : '🔬 Preview Price' }), _jsx("button", { onClick: handleMint, disabled: loading || previewLoading || !managerId, className: "w-full rounded-lg bg-blue-600 px-4 py-2.5 text-xs font-semibold hover:bg-blue-700 disabled:opacity-50", children: loading ? '⏳ Processing...' : '💹 Buy (Mint)' }), _jsx("button", { onClick: handleRedeem, disabled: loading || previewLoading || !managerId || currentOwnedQty <= 0, className: "w-full rounded-lg bg-red-600 px-4 py-2.5 text-xs font-semibold hover:bg-red-700 disabled:opacity-50", children: loading ? '⏳ Processing...' : currentOwnedQty > 0 ? `📉 Sell (Redeem) [Owned: ${currentOwnedQty.toFixed(2)}]` : '📉 Sell (Redeem) [No Position]' })] }), _jsx("p", { className: "text-[10px] text-gray-400 mt-3 text-center border-t border-gray-800/40 pt-2", children: "\uD83D\uDCA1 **How to trade:** Choose a Direction (**UP** or **DOWN**), enter a Strike and Quantity, then click **Buy (Mint)** to open the position. Click **Sell (Redeem)** only to close/settle a position you already own (otherwise the transaction will fail on-chain)." })] }), managerId && managerId.startsWith('0x') && (_jsxs("div", { className: "rounded-xl border border-gray-800 bg-gray-900/40 p-4 space-y-4", children: [_jsxs("div", { className: "flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-gray-800/60 pb-3", children: [_jsxs("div", { className: "text-left", children: [_jsx("h3", { className: "font-semibold text-sm text-gray-200", children: "Active Positions" }), _jsx("p", { className: "text-[10px] text-gray-400", children: "View or close your open vertical range option contracts" })] }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsxs("div", { className: "flex rounded-lg bg-gray-950 p-0.5 border border-gray-800", children: [_jsx("button", { type: "button", onClick: () => setPositionsView('onchain'), className: `px-2.5 py-1 text-[10px] font-bold rounded-md transition ${positionsView === 'onchain' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-gray-200'}`, children: "Real-time (On-chain)" }), _jsx("button", { type: "button", onClick: () => setPositionsView('indexer'), className: `px-2.5 py-1 text-[10px] font-bold rounded-md transition ${positionsView === 'indexer' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-gray-200'}`, children: "Indexer PnL" })] }), _jsx("button", { onClick: () => {
                                            fetchPositions();
                                            fetchOnChainPositions();
                                        }, disabled: positionsLoading || onChainPositionsLoading, className: "text-[10px] bg-gray-800 hover:bg-gray-700 text-blue-400 hover:text-blue-300 font-semibold px-2.5 py-1.5 rounded-lg border border-gray-700 disabled:opacity-50", children: positionsLoading || onChainPositionsLoading ? '⏳' : '🔄' })] })] }), positionsView === 'onchain' ? (onChainPositionsLoading ? (_jsx("div", { className: "text-xs text-gray-500 py-6 text-center", children: "\u23F3 Loading on-chain positions..." })) : onChainPositions.length === 0 ? (_jsx("div", { className: "text-xs text-gray-500 py-6 text-center", children: "\uD83D\uDCED No active positions found on-chain for this manager" })) : (_jsx("div", { className: "overflow-x-auto rounded-lg border border-gray-800 bg-gray-950", children: _jsxs("table", { className: "w-full text-xs text-left text-gray-400", children: [_jsx("thead", { className: "text-[10px] text-gray-500 uppercase bg-gray-900/50", children: _jsxs("tr", { children: [_jsx("th", { className: "p-2.5", children: "Type" }), _jsx("th", { className: "p-2.5", children: "Oracle ID" }), _jsx("th", { className: "p-2.5", children: "Strike / Range" }), _jsx("th", { className: "p-2.5 text-right", children: "Quantity" }), _jsx("th", { className: "p-2.5 text-center", children: "Action" })] }) }), _jsx("tbody", { children: onChainPositions.map((pos, idx) => (_jsxs("tr", { className: "border-b border-gray-800/50 hover:bg-gray-900/20 last:border-none cursor-pointer", onClick: () => {
                                            setOracleId(pos.oracle_id);
                                            setPositionType(pos.type);
                                            setQuantity((Number(pos.quantity) / 1e6).toString());
                                            if (pos.type === 'binary') {
                                                setBinaryStrike((Number(pos.strike) / 1e9).toString());
                                                setIsUp(pos.is_up);
                                            }
                                            else {
                                                if (pos.lower_strike === '0') {
                                                    setIsNegInf(true);
                                                    setLowerStrike('');
                                                }
                                                else {
                                                    setIsNegInf(false);
                                                    setLowerStrike((Number(pos.lower_strike) / 1e9).toString());
                                                }
                                                if (pos.higher_strike.startsWith('184467')) {
                                                    setIsPosInf(true);
                                                    setHigherStrike('');
                                                }
                                                else {
                                                    setIsPosInf(false);
                                                    setHigherStrike((Number(pos.higher_strike) / 1e9).toString());
                                                }
                                            }
                                            onOutput({
                                                type: 'info',
                                                title: 'Position Selected',
                                                data: `Loaded position parameters into input fields:\nType: ${pos.type.toUpperCase()}\nOracle: ${pos.oracle_id}\nQuantity: ${Number(pos.quantity) / 1e6} contracts`,
                                            });
                                        }, children: [_jsx("td", { className: "p-2.5 capitalize font-medium", children: _jsx("span", { className: `px-1.5 py-0.5 rounded text-[10px] font-bold ${pos.type === 'binary' ? 'bg-indigo-950 text-indigo-400 border border-indigo-900/55' : 'bg-amber-950 text-amber-400 border border-amber-900/55'}`, children: pos.type }) }), _jsx("td", { className: "p-2.5 font-mono truncate max-w-[120px]", title: pos.oracle_id, children: pos.oracle_id }), _jsx("td", { className: "p-2.5", children: pos.type === 'binary' ? (_jsxs("span", { children: [pos.is_up ? '🟢 UP' : '🔴 DOWN', " @ ", (Number(pos.strike) / 1e9).toFixed(2)] })) : (_jsxs("span", { children: [pos.lower_strike === '0' ? '0' : (Number(pos.lower_strike) / 1e9).toFixed(2), " -", ' ', pos.higher_strike.startsWith('184467') ? '∞' : (Number(pos.higher_strike) / 1e9).toFixed(2)] })) }), _jsx("td", { className: "p-2.5 text-right font-mono text-gray-200 font-semibold", children: (Number(pos.quantity) / 1e6).toFixed(2) }), _jsx("td", { className: "p-2.5 text-center text-blue-400 font-bold hover:text-blue-300", children: "\u270F\uFE0F Use" })] }, idx))) })] }) }))) : (positionsLoading ? (_jsx("div", { className: "text-xs text-gray-500 py-6 text-center", children: "\u23F3 Loading position summary..." })) : managerPositions.length === 0 ? (_jsx("div", { className: "text-xs text-gray-500 py-6 text-center", children: "\uD83D\uDCED No active positions found in indexer" })) : (_jsx("div", { className: "overflow-x-auto rounded-lg border border-gray-800 bg-gray-950", children: _jsxs("table", { className: "w-full text-xs text-left text-gray-400", children: [_jsx("thead", { className: "text-[10px] text-gray-500 uppercase bg-gray-900/50", children: _jsxs("tr", { children: [_jsx("th", { className: "p-2.5", children: "Oracle ID" }), _jsx("th", { className: "p-2.5", children: "Strike Range" }), _jsx("th", { className: "p-2.5 text-right", children: "Quantity" }), _jsx("th", { className: "p-2.5 text-right", children: "PnL" })] }) }), _jsx("tbody", { children: managerPositions.map((pos, idx) => (_jsxs("tr", { className: "border-b border-gray-800/50 hover:bg-gray-900/20 last:border-none cursor-pointer", onClick: () => {
                                            const isBinary = pos.is_up !== undefined;
                                            setOracleId(pos.oracle_id);
                                            setPositionType(isBinary ? 'binary' : 'range');
                                            const qty = Number(pos.open_quantity !== undefined ? pos.open_quantity : (pos.quantity || 0));
                                            setQuantity((qty / 1e6).toString());
                                            if (isBinary) {
                                                setBinaryStrike((Number(pos.strike) / 1e9).toString());
                                                setIsUp(pos.is_up);
                                            }
                                            else {
                                                if (pos.lower_strike === '0' || !pos.lower_strike) {
                                                    setIsNegInf(true);
                                                    setLowerStrike('');
                                                }
                                                else {
                                                    setIsNegInf(false);
                                                    setLowerStrike((Number(pos.lower_strike) / 1e9).toString());
                                                }
                                                if (pos.higher_strike?.toString()?.startsWith('184467')) {
                                                    setIsPosInf(true);
                                                    setHigherStrike('');
                                                }
                                                else {
                                                    setIsPosInf(false);
                                                    setHigherStrike((Number(pos.higher_strike || 0) / 1e9).toString());
                                                }
                                            }
                                            onOutput({
                                                type: 'info',
                                                title: 'Position Selected',
                                                data: `Loaded position parameters into input fields:\nType: ${isBinary ? 'BINARY' : 'RANGE'}\nOracle: ${pos.oracle_id}\nQuantity: ${qty / 1e6} contracts`,
                                            });
                                        }, children: [_jsx("td", { className: "p-2.5 font-mono truncate max-w-[120px]", title: pos.oracle_id, children: pos.oracle_id }), _jsx("td", { className: "p-2.5", children: pos.is_up !== undefined ? (_jsxs("span", { children: [pos.is_up ? '🟢 UP' : '🔴 DOWN', " @ ", (Number(pos.strike) / 1e9).toFixed(2)] })) : (_jsxs("span", { children: [pos.lower_strike === '0' ? '0' : (Number(pos.lower_strike || 0) / 1e9).toFixed(2), " -", ' ', pos.higher_strike?.toString()?.startsWith('184467') ? '∞' : (Number(pos.higher_strike || 0) / 1e9).toFixed(2)] })) }), _jsx("td", { className: "p-2.5 text-right", children: (Number(pos.open_quantity !== undefined ? pos.open_quantity : (pos.quantity || 0)) / 1e6).toFixed(2) }), _jsxs("td", { className: `p-2.5 text-right font-semibold ${(pos.unrealized_pnl !== undefined ? (Number(pos.unrealized_pnl) + Number(pos.realized_pnl || 0)) : Number(pos.pnl || 0)) >= 0
                                                    ? 'text-green-400'
                                                    : 'text-red-400'}`, children: [((pos.unrealized_pnl !== undefined ? (Number(pos.unrealized_pnl) + Number(pos.realized_pnl || 0)) : Number(pos.pnl || 0)) / 1e6).toFixed(4), " dUSDC"] })] }, idx))) })] }) })))] }))] }));
}
//# sourceMappingURL=TradingPanel.js.map