import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect } from 'react';
import { useCurrentAccount, useSignAndExecuteTransaction } from '@mysten/dapp-kit';
import { Transaction } from '@mysten/sui/transactions';
import { CONFIG, DUSDC_TYPE } from '../../config';
import { client } from '../../lib/client';
import { txCompactSettledOracle, buildMarketKey, txRedeemPermissionless, } from '../../lib/predict-txb';
export default function KeeperPanel({ onOutput }) {
    const account = useCurrentAccount();
    const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
    // IDs
    const [oracleId, setOracleId] = useState(CONFIG.marketOracleId);
    const [managerId, setManagerId] = useState(() => {
        return localStorage.getItem('flicky_predict_manager_id') || '';
    });
    const [sviCapId, setSviCapId] = useState('');
    // Strike inputs for redemption
    const [strike, setStrike] = useState('');
    const [isUp, setIsUp] = useState(true);
    const [expiry, setExpiry] = useState('');
    // Quantity input for redemption
    const [quantity, setQuantity] = useState('1');
    const [loading, setLoading] = useState(false);
    // Keeper activities from public server
    const [posMints, setPosMints] = useState([]);
    const [posRedeems, setPosRedeems] = useState([]);
    const [rangeMints, setRangeMints] = useState([]);
    const [rangeRedeems, setRangeRedeems] = useState([]);
    const [activitiesLoading, setActivitiesLoading] = useState(false);
    const [activeTab, setActiveTab] = useState('positions');
    const fetchActivities = async () => {
        setActivitiesLoading(true);
        try {
            const [pm, pr, rm, rr] = await Promise.all([
                fetch('https://predict-server.testnet.mystenlabs.com/positions/minted').then(r => r.ok ? r.json() : []),
                fetch('https://predict-server.testnet.mystenlabs.com/positions/redeemed').then(r => r.ok ? r.json() : []),
                fetch('https://predict-server.testnet.mystenlabs.com/ranges/minted').then(r => r.ok ? r.json() : []),
                fetch('https://predict-server.testnet.mystenlabs.com/ranges/redeemed').then(r => r.ok ? r.json() : []),
            ]);
            setPosMints(Array.isArray(pm) ? pm : []);
            setPosRedeems(Array.isArray(pr) ? pr : []);
            setRangeMints(Array.isArray(rm) ? rm : []);
            setRangeRedeems(Array.isArray(rr) ? rr : []);
        }
        catch (err) {
            console.error('Failed to fetch keeper activities:', err);
        }
        finally {
            setActivitiesLoading(false);
        }
    };
    // Sync manager ID if changed in localStorage
    useEffect(() => {
        const handleStorageChange = () => {
            setManagerId(localStorage.getItem('flicky_predict_manager_id') || '');
        };
        window.addEventListener('storage', handleStorageChange);
        fetchActivities();
        return () => window.removeEventListener('storage', handleStorageChange);
    }, []);
    // Auto-fetch OracleSVICap ID when account changes
    useEffect(() => {
        const fetchSviCap = async () => {
            if (!account?.address) {
                setSviCapId('');
                return;
            }
            try {
                const response = await client.getOwnedObjects({
                    owner: account.address,
                    filter: {
                        StructType: `${CONFIG.predictPackageId}::oracle::OracleSVICap`
                    }
                });
                if (response.data && response.data.length > 0) {
                    const capObjId = response.data[0].data?.objectId || '';
                    setSviCapId(capObjId);
                    console.log('Automatically found OracleSVICap ID:', capObjId);
                }
                else {
                    setSviCapId('');
                }
            }
            catch (err) {
                console.error('Failed to auto-fetch OracleSVICap ID:', err);
                setSviCapId('');
            }
        };
        fetchSviCap();
    }, [account?.address]);
    const handleCompact = async () => {
        if (!oracleId || !sviCapId)
            return;
        setLoading(true);
        try {
            const tx = new Transaction();
            txCompactSettledOracle(tx, oracleId, sviCapId);
            const result = await signAndExecute({ transaction: tx });
            onOutput({
                type: 'success',
                title: 'Oracle Compacted Successfully',
                data: JSON.stringify(result, null, 2),
                txDigest: result.digest,
            });
        }
        catch (error) {
            onOutput({
                type: 'error',
                title: 'Compact Oracle Failed',
                data: String(error),
            });
        }
        finally {
            setLoading(false);
        }
    };
    const handleRedeemPermissionless = async () => {
        if (!account || !managerId || !oracleId || !strike || !expiry)
            return;
        setLoading(true);
        try {
            const strikeRaw = BigInt(Math.floor(parseFloat(strike) * 1_000_000_000));
            const expiryRaw = BigInt(expiry);
            const qty = BigInt(Math.floor(parseFloat(quantity) * 1_000_000));
            if (qty <= 0n)
                throw new Error('Quantity must be greater than 0');
            const tx = new Transaction();
            const coinType = DUSDC_TYPE(CONFIG.dusdcPackageId);
            const marketKey = buildMarketKey(tx, oracleId, expiryRaw, strikeRaw, isUp);
            txRedeemPermissionless(tx, managerId, oracleId, marketKey, qty, coinType);
            const result = await signAndExecute({ transaction: tx });
            onOutput({
                type: 'success',
                title: 'Permissionless Redemption Successful',
                data: JSON.stringify(result, null, 2),
                txDigest: result.digest,
            });
        }
        catch (error) {
            onOutput({
                type: 'error',
                title: 'Permissionless Redemption Failed',
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
    return (_jsxs("div", { className: "space-y-6", children: [_jsxs("div", { children: [_jsx("h2", { className: "text-lg font-bold", children: "Keeper Operations" }), _jsx("p", { className: "text-xs text-gray-400", children: "Operations designed to run periodically by keepers, which can be executed permissionlessly." })] }), _jsxs("div", { className: "rounded-xl border border-gray-800 bg-gray-950 p-4 space-y-3", children: [_jsxs("div", { children: [_jsx("label", { className: "block text-xs font-bold uppercase tracking-wider text-gray-400 mb-1", children: "PredictManager ID" }), _jsx("input", { type: "text", value: managerId, onChange: (e) => setManagerId(e.target.value.trim()), placeholder: "0x...", className: "w-full rounded-lg bg-gray-900 px-3 py-1.5 text-xs border border-gray-800 focus:outline-none" })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-xs font-bold uppercase tracking-wider text-gray-400 mb-1", children: "Oracle ID" }), _jsx("input", { type: "text", value: oracleId, onChange: (e) => setOracleId(e.target.value.trim()), placeholder: "0x...", className: "w-full rounded-lg bg-gray-900 px-3 py-1.5 text-xs border border-gray-800 focus:outline-none" })] })] }), _jsxs("div", { className: "rounded-xl border border-gray-800 bg-gray-900/30 p-4 space-y-3", children: [_jsxs("div", { children: [_jsx("h3", { className: "font-semibold text-sm mb-1 text-gray-200", children: "Compact Settled Oracle" }), _jsx("p", { className: "text-xs text-gray-400", children: "Compacts a settled oracle's strike matrix inside the vault to constant size." })] }), _jsxs("div", { className: "space-y-3", children: [_jsxs("div", { children: [_jsx("label", { className: "block text-xs font-bold uppercase tracking-wider text-gray-400 mb-1", children: "OracleSVICap ID" }), _jsx("input", { type: "text", value: sviCapId, onChange: (e) => setSviCapId(e.target.value.trim()), placeholder: "Oracle SVI Cap ID (0x...)", className: "w-full rounded-lg bg-gray-950 px-3 py-1.5 text-xs border border-gray-800 focus:outline-none" })] }), _jsx("button", { onClick: handleCompact, disabled: loading || !oracleId || !sviCapId, className: "w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition", children: "Compact Oracle" })] })] }), _jsxs("div", { className: "rounded-xl border border-gray-800 bg-gray-900/30 p-4 space-y-4", children: [_jsxs("div", { children: [_jsx("h3", { className: "font-semibold text-sm mb-1 text-gray-200", children: "Permissionless Redemption" }), _jsx("p", { className: "text-xs text-gray-400", children: "Settle a completed binary position in a manager permissionlessly. The payout is deposited into the owner's manager." })] }), _jsxs("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-4", children: [_jsxs("div", { className: "space-y-1", children: [_jsx("label", { className: "text-[11px] font-medium text-gray-400 block", children: "Strike Price" }), _jsx("input", { type: "number", value: strike, onChange: (e) => setStrike(e.target.value), placeholder: "e.g. 64000", className: "w-full rounded-lg bg-gray-950 px-3 py-1.5 text-xs border border-gray-800 focus:outline-none" })] }), _jsxs("div", { className: "space-y-1", children: [_jsx("label", { className: "text-[11px] font-medium text-gray-400 block", children: "Expiry Timestamp (ms)" }), _jsx("input", { type: "text", value: expiry, onChange: (e) => setExpiry(e.target.value.trim()), placeholder: "e.g. 1779532558000", className: "w-full rounded-lg bg-gray-950 px-3 py-1.5 text-xs border border-gray-800 focus:outline-none" })] })] }), _jsxs("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-4", children: [_jsxs("div", { className: "space-y-1", children: [_jsx("label", { className: "text-[11px] font-medium text-gray-400 block", children: "Direction" }), _jsxs("div", { className: "flex gap-2", children: [_jsx("button", { type: "button", onClick: () => setIsUp(true), className: `flex-1 rounded-lg py-1.5 text-xs font-semibold border ${isUp ? 'bg-green-950 text-green-400 border-green-800' : 'bg-gray-950 text-gray-400 border-gray-800'}`, children: "\uD83D\uDFE2 UP" }), _jsx("button", { type: "button", onClick: () => setIsUp(false), className: `flex-1 rounded-lg py-1.5 text-xs font-semibold border ${!isUp ? 'bg-red-950 text-red-400 border-red-800' : 'bg-gray-950 text-gray-400 border-gray-800'}`, children: "\uD83D\uDD34 DOWN" })] })] }), _jsxs("div", { className: "space-y-1", children: [_jsx("label", { className: "text-[11px] font-medium text-gray-400 block", children: "Quantity" }), _jsx("input", { type: "number", value: quantity, onChange: (e) => setQuantity(e.target.value), placeholder: "Quantity (e.g. 1.0)", className: "w-full rounded-lg bg-gray-950 px-3 py-1.5 text-xs border border-gray-800 focus:outline-none" })] })] }), _jsx("div", { className: "pt-2", children: _jsx("button", { onClick: handleRedeemPermissionless, disabled: loading || !managerId || !oracleId || !strike || !expiry, className: "w-full rounded-lg bg-green-600 px-4 py-2 text-xs font-semibold hover:bg-green-700 disabled:opacity-50 transition", children: "Settle via Oracle" }) })] }), _jsxs("div", { className: "rounded-xl border border-gray-800 bg-gray-950 p-4 space-y-4", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { children: [_jsx("h3", { className: "font-semibold text-sm text-gray-200", children: "Recent Protocol Activity" }), _jsx("p", { className: "text-[10px] text-gray-400", children: "Live feeds of mints and redemptions across all users" })] }), _jsxs("div", { className: "flex gap-2", children: [_jsx("button", { onClick: () => setActiveTab('positions'), className: `px-2.5 py-1 text-xs font-semibold rounded ${activeTab === 'positions' ? 'bg-blue-600 text-white' : 'bg-gray-900 text-gray-400 hover:bg-gray-800'}`, children: "Positions" }), _jsx("button", { onClick: () => setActiveTab('ranges'), className: `px-2.5 py-1 text-xs font-semibold rounded ${activeTab === 'ranges' ? 'bg-blue-600 text-white' : 'bg-gray-900 text-gray-400 hover:bg-gray-800'}`, children: "Ranges" }), _jsx("button", { onClick: fetchActivities, disabled: activitiesLoading, className: "text-[11px] text-blue-400 hover:text-blue-300 disabled:opacity-50 ml-1", children: activitiesLoading ? '⏳' : '🔄' })] })] }), activitiesLoading ? (_jsx("div", { className: "text-xs text-gray-500 py-6 text-center", children: "\u23F3 Loading protocol activity..." })) : activeTab === 'positions' ? (_jsxs("div", { className: "space-y-4 text-xs", children: [_jsxs("div", { className: "space-y-2", children: [_jsxs("h4", { className: "font-bold text-gray-300 text-[11px] uppercase tracking-wider flex items-center gap-1.5", children: [_jsx("span", { children: "\uD83D\uDCB9 Recent Mints" }), _jsxs("span", { className: "text-[10px] text-gray-500 font-normal", children: ["(", posMints.length, " logs)"] })] }), _jsx("div", { className: "overflow-x-auto rounded-lg border border-gray-900 bg-gray-950/40", children: _jsxs("table", { className: "w-full text-left text-gray-400 text-[11px]", children: [_jsx("thead", { className: "text-[10px] text-gray-500 uppercase bg-gray-900/50", children: _jsxs("tr", { children: [_jsx("th", { className: "p-2", children: "Time" }), _jsx("th", { className: "p-2", children: "Trader" }), _jsx("th", { className: "p-2", children: "Strike" }), _jsx("th", { className: "p-2", children: "Side" }), _jsx("th", { className: "p-2", children: "Qty" }), _jsx("th", { className: "p-2", children: "Cost" })] }) }), _jsx("tbody", { children: posMints.length === 0 ? (_jsx("tr", { children: _jsx("td", { colSpan: 6, className: "p-4 text-center text-gray-500", children: "No minted positions" }) })) : (posMints.slice(0, 5).map((item, idx) => (_jsxs("tr", { className: "border-b border-gray-900 hover:bg-gray-900/20 last:border-none", children: [_jsx("td", { className: "p-2 font-light text-gray-300", children: new Date(item.checkpoint_timestamp_ms).toLocaleTimeString() }), _jsx("td", { className: "p-2 font-mono text-gray-500 max-w-[60px] truncate", children: item.trader }), _jsxs("td", { className: "p-2 font-mono", children: ["$", (Number(item.strike) / 1e9).toFixed(2)] }), _jsx("td", { className: "p-2 font-semibold", children: item.is_up ? _jsx("span", { className: "text-green-400", children: "\uD83D\uDFE2 UP" }) : _jsx("span", { className: "text-red-400", children: "\uD83D\uDD34 DOWN" }) }), _jsx("td", { className: "p-2 font-mono", children: (Number(item.quantity) / 1e6).toFixed(2) }), _jsxs("td", { className: "p-2 font-mono", children: ["$", (Number(item.cost) / 1e6).toFixed(2)] })] }, idx)))) })] }) })] }), _jsxs("div", { className: "space-y-2", children: [_jsxs("h4", { className: "font-bold text-gray-300 text-[11px] uppercase tracking-wider flex items-center gap-1.5", children: [_jsx("span", { children: "\uD83D\uDCC9 Recent Settlements (Redeems)" }), _jsxs("span", { className: "text-[10px] text-gray-500 font-normal", children: ["(", posRedeems.length, " logs)"] })] }), _jsx("div", { className: "overflow-x-auto rounded-lg border border-gray-900 bg-gray-950/40", children: _jsxs("table", { className: "w-full text-left text-gray-400 text-[11px]", children: [_jsx("thead", { className: "text-[10px] text-gray-500 uppercase bg-gray-900/50", children: _jsxs("tr", { children: [_jsx("th", { className: "p-2", children: "Time" }), _jsx("th", { className: "p-2", children: "Owner" }), _jsx("th", { className: "p-2", children: "Strike" }), _jsx("th", { className: "p-2", children: "Qty" }), _jsx("th", { className: "p-2", children: "Payout" }), _jsx("th", { className: "p-2", children: "Status" })] }) }), _jsx("tbody", { children: posRedeems.length === 0 ? (_jsx("tr", { children: _jsx("td", { colSpan: 6, className: "p-4 text-center text-gray-500", children: "No redeemed positions" }) })) : (posRedeems.slice(0, 5).map((item, idx) => (_jsxs("tr", { className: "border-b border-gray-900 hover:bg-gray-900/20 last:border-none", children: [_jsx("td", { className: "p-2 font-light text-gray-300", children: new Date(item.checkpoint_timestamp_ms).toLocaleTimeString() }), _jsx("td", { className: "p-2 font-mono text-gray-500 max-w-[60px] truncate", children: item.owner }), _jsxs("td", { className: "p-2 font-mono", children: ["$", (Number(item.strike) / 1e9).toFixed(2)] }), _jsx("td", { className: "p-2 font-mono", children: (Number(item.quantity) / 1e6).toFixed(2) }), _jsxs("td", { className: "p-2 font-semibold text-green-400", children: ["$", (Number(item.payout) / 1e6).toFixed(2)] }), _jsx("td", { className: "p-2", children: item.is_settled ? _jsx("span", { className: "text-green-500", children: "\u2705 Settled" }) : _jsx("span", { className: "text-yellow-500", children: "\u23F3 Pending" }) })] }, idx)))) })] }) })] })] })) : (_jsxs("div", { className: "space-y-4 text-xs", children: [_jsxs("div", { className: "space-y-2", children: [_jsxs("h4", { className: "font-bold text-gray-300 text-[11px] uppercase tracking-wider flex items-center gap-1.5", children: [_jsx("span", { children: "\uD83D\uDCB9 Recent Range Mints" }), _jsxs("span", { className: "text-[10px] text-gray-500 font-normal", children: ["(", rangeMints.length, " logs)"] })] }), _jsx("div", { className: "overflow-x-auto rounded-lg border border-gray-900 bg-gray-950/40", children: _jsxs("table", { className: "w-full text-left text-gray-400 text-[11px]", children: [_jsx("thead", { className: "text-[10px] text-gray-500 uppercase bg-gray-900/50", children: _jsxs("tr", { children: [_jsx("th", { className: "p-2", children: "Time" }), _jsx("th", { className: "p-2", children: "Trader" }), _jsx("th", { className: "p-2", children: "Range Strike" }), _jsx("th", { className: "p-2", children: "Qty" }), _jsx("th", { className: "p-2", children: "Cost" })] }) }), _jsx("tbody", { children: rangeMints.length === 0 ? (_jsx("tr", { children: _jsx("td", { colSpan: 5, className: "p-4 text-center text-gray-500", children: "No minted ranges" }) })) : (rangeMints.slice(0, 5).map((item, idx) => (_jsxs("tr", { className: "border-b border-gray-900 hover:bg-gray-900/20 last:border-none", children: [_jsx("td", { className: "p-2 font-light text-gray-300", children: new Date(item.checkpoint_timestamp_ms).toLocaleTimeString() }), _jsx("td", { className: "p-2 font-mono text-gray-500 max-w-[60px] truncate", children: item.trader }), _jsxs("td", { className: "p-2", children: [Number(item.lower_strike) === 0 ? '0' : (Number(item.lower_strike) / 1e9).toFixed(2), " -", ' ', item.higher_strike?.toString()?.startsWith('184467') ? '∞' : (Number(item.higher_strike) / 1e9).toFixed(2)] }), _jsx("td", { className: "p-2 font-mono", children: (Number(item.quantity) / 1e6).toFixed(2) }), _jsxs("td", { className: "p-2 font-mono", children: ["$", (Number(item.cost) / 1e6).toFixed(2)] })] }, idx)))) })] }) })] }), _jsxs("div", { className: "space-y-2", children: [_jsxs("h4", { className: "font-bold text-gray-300 text-[11px] uppercase tracking-wider flex items-center gap-1.5", children: [_jsx("span", { children: "\uD83D\uDCC9 Recent Range Settlements" }), _jsxs("span", { className: "text-[10px] text-gray-500 font-normal", children: ["(", rangeRedeems.length, " logs)"] })] }), _jsx("div", { className: "overflow-x-auto rounded-lg border border-gray-900 bg-gray-950/40", children: _jsxs("table", { className: "w-full text-left text-gray-400 text-[11px]", children: [_jsx("thead", { className: "text-[10px] text-gray-500 uppercase bg-gray-900/50", children: _jsxs("tr", { children: [_jsx("th", { className: "p-2", children: "Time" }), _jsx("th", { className: "p-2", children: "Trader" }), _jsx("th", { className: "p-2", children: "Range Strike" }), _jsx("th", { className: "p-2", children: "Qty" }), _jsx("th", { className: "p-2", children: "Payout" }), _jsx("th", { className: "p-2", children: "Status" })] }) }), _jsx("tbody", { children: rangeRedeems.length === 0 ? (_jsx("tr", { children: _jsx("td", { colSpan: 6, className: "p-4 text-center text-gray-500", children: "No redeemed ranges" }) })) : (rangeRedeems.slice(0, 5).map((item, idx) => (_jsxs("tr", { className: "border-b border-gray-900 hover:bg-gray-900/20 last:border-none", children: [_jsx("td", { className: "p-2 font-light text-gray-300", children: new Date(item.checkpoint_timestamp_ms).toLocaleTimeString() }), _jsx("td", { className: "p-2 font-mono text-gray-500 max-w-[60px] truncate", children: item.trader }), _jsxs("td", { className: "p-2", children: [Number(item.lower_strike) === 0 ? '0' : (Number(item.lower_strike) / 1e9).toFixed(2), " -", ' ', item.higher_strike?.toString()?.startsWith('184467') ? '∞' : (Number(item.higher_strike) / 1e9).toFixed(2)] }), _jsx("td", { className: "p-2 font-mono", children: (Number(item.quantity) / 1e6).toFixed(2) }), _jsxs("td", { className: "p-2 font-semibold text-green-400", children: ["$", (Number(item.payout) / 1e6).toFixed(2)] }), _jsx("td", { className: "p-2", children: item.is_settled ? _jsx("span", { className: "text-green-500", children: "\u2705 Settled" }) : _jsx("span", { className: "text-yellow-500", children: "\u23F3 Pending" }) })] }, idx)))) })] }) })] })] }))] })] }));
}
//# sourceMappingURL=KeeperPanel.js.map