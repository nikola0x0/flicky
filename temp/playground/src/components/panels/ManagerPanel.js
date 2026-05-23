import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect } from 'react';
import { useCurrentAccount, useSignAndExecuteTransaction } from '@mysten/dapp-kit';
import { Transaction } from '@mysten/sui/transactions';
import { CONFIG, DUSDC_TYPE } from '../../config';
import { client } from '../../lib/client';
import { txCreateManager, txDepositToManager, txWithdrawFromManager, readManagerBalance, } from '../../lib/predict-txb';
export default function ManagerPanel({ onOutput }) {
    const account = useCurrentAccount();
    const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
    const [managerId, setManagerId] = useState(() => {
        return localStorage.getItem('flicky_predict_manager_id') || '';
    });
    const [managerBalance, setManagerBalance] = useState('0');
    const [walletBalance, setWalletBalance] = useState('0');
    const [depositAmount, setDepositAmount] = useState('');
    const [withdrawAmount, setWithdrawAmount] = useState('');
    const [loading, setLoading] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    // Manager stats from public server
    const [managerSummary, setManagerSummary] = useState(null);
    const [managerPnLPoints, setManagerPnLPoints] = useState([]);
    const [summaryLoading, setSummaryLoading] = useState(false);
    // Save manager ID when it changes
    useEffect(() => {
        localStorage.setItem('flicky_predict_manager_id', managerId);
    }, [managerId]);
    const findManagerOnChain = async (address) => {
        try {
            const pkgId = CONFIG.predictPackageId.split('::')[0];
            const events = await client.queryEvents({
                query: {
                    MoveEventType: `${pkgId}::predict_manager::PredictManagerCreated`,
                },
                order: 'descending',
            });
            const found = events.data.find((evt) => evt.parsedJson?.owner === address);
            if (found && found.parsedJson?.manager_id) {
                return found.parsedJson.manager_id;
            }
        }
        catch (err) {
            console.error('Failed to query manager from onchain events:', err);
        }
        return null;
    };
    const fetchManagerStats = async () => {
        if (!managerId || !managerId.startsWith('0x')) {
            setManagerSummary(null);
            setManagerPnLPoints([]);
            return;
        }
        setSummaryLoading(true);
        try {
            const [sumRes, pnlRes] = await Promise.all([
                fetch(`https://predict-server.testnet.mystenlabs.com/managers/${managerId}/summary`).then(r => r.ok ? r.json() : null),
                fetch(`https://predict-server.testnet.mystenlabs.com/managers/${managerId}/pnl?range=ALL`).then(r => r.ok ? r.json() : null),
            ]);
            setManagerSummary(sumRes);
            setManagerPnLPoints(pnlRes && pnlRes.points ? pnlRes.points : []);
        }
        catch (err) {
            console.error('Failed to fetch manager summary/pnl:', err);
        }
        finally {
            setSummaryLoading(false);
        }
    };
    // Fetch balances
    const fetchBalances = async () => {
        if (!account)
            return;
        setRefreshing(true);
        try {
            const coinType = DUSDC_TYPE(CONFIG.dusdcPackageId);
            // 1. Fetch Wallet Balance
            const walletCoins = await client.getCoins({
                owner: account.address,
                coinType,
            });
            const totalWallet = walletCoins.data.reduce((sum, coin) => sum + BigInt(coin.balance), 0n);
            setWalletBalance((Number(totalWallet) / 1_000_000).toFixed(6));
            // 2. Fetch Manager Balance
            if (managerId && managerId.startsWith('0x')) {
                const tx = new Transaction();
                readManagerBalance(tx, managerId, coinType);
                const inspectRes = await client.devInspectTransactionBlock({
                    sender: account.address,
                    transactionBlock: tx,
                });
                const returnValues = inspectRes.results?.[0]?.returnValues;
                if (returnValues && returnValues.length > 0) {
                    // Parse returned U64 balance
                    const bytes = returnValues[0][0];
                    // Convert bytes to u64
                    let val = 0n;
                    for (let i = bytes.length - 1; i >= 0; i--) {
                        val = (val << 8n) | BigInt(bytes[i]);
                    }
                    setManagerBalance((Number(val) / 1_000_000).toFixed(6));
                }
                else {
                    setManagerBalance('0');
                }
            }
            else {
                setManagerBalance('0');
            }
        }
        catch (error) {
            console.error('Failed to fetch balances:', error);
        }
        finally {
            setRefreshing(false);
        }
    };
    const syncBalancesAndStats = () => {
        fetchBalances();
        fetchManagerStats();
    };
    useEffect(() => {
        if (account) {
            // Auto-discover manager on-chain if not set
            if (!managerId) {
                findManagerOnChain(account.address).then((id) => {
                    if (id) {
                        setManagerId(id);
                        onOutput({
                            type: 'info',
                            title: 'Manager Auto-Discovered',
                            data: `Found existing PredictManager on-chain: ${id}`,
                        });
                    }
                });
            }
            syncBalancesAndStats();
        }
    }, [account, managerId]);
    const handleCreateManager = async () => {
        if (!account)
            return;
        setLoading(true);
        try {
            const tx = new Transaction();
            txCreateManager(tx);
            const result = await signAndExecute({ transaction: tx });
            // Fetch transaction details to get object changes (wait until indexed)
            const txData = await client.waitForTransaction({
                digest: result.digest,
                options: { showObjectChanges: true }
            });
            // Parse created object IDs to find the manager ID
            const managerObject = txData.objectChanges?.find((change) => change.type === 'created' &&
                change.objectType.endsWith('::predict_manager::PredictManager'));
            const newManagerId = managerObject?.type === 'created' ? managerObject.objectId : '';
            if (newManagerId) {
                setManagerId(newManagerId);
            }
            onOutput({
                type: 'success',
                title: 'Manager Created Successfully',
                data: JSON.stringify(result, null, 2),
                txDigest: result.digest,
            });
            setTimeout(syncBalancesAndStats, 2000);
        }
        catch (error) {
            onOutput({
                type: 'error',
                title: 'Manager Creation Failed',
                data: String(error),
            });
        }
        finally {
            setLoading(false);
        }
    };
    const handleDeposit = async () => {
        if (!account || !managerId || !depositAmount)
            return;
        setLoading(true);
        try {
            const amountRaw = BigInt(Math.floor(parseFloat(depositAmount) * 1_000_000));
            const coinType = DUSDC_TYPE(CONFIG.dusdcPackageId);
            // Fetch wallet coins
            const coins = await client.getCoins({
                owner: account.address,
                coinType,
            });
            if (coins.data.length === 0) {
                throw new Error('You do not have any dUSDC in your wallet');
            }
            const tx = new Transaction();
            const primaryCoin = tx.object(coins.data[0].coinObjectId);
            // Merge remaining coins if there are multiple
            if (coins.data.length > 1) {
                tx.mergeCoins(primaryCoin, coins.data.slice(1).map((c) => tx.object(c.coinObjectId)));
            }
            // Split the deposit amount
            const [depositCoin] = tx.splitCoins(primaryCoin, [tx.pure.u64(amountRaw)]);
            // Execute deposit
            txDepositToManager(tx, managerId, depositCoin, coinType);
            const result = await signAndExecute({ transaction: tx });
            onOutput({
                type: 'success',
                title: 'Deposit Successful',
                data: JSON.stringify(result, null, 2),
                txDigest: result.digest,
            });
            setDepositAmount('');
            setTimeout(syncBalancesAndStats, 2000);
        }
        catch (error) {
            onOutput({
                type: 'error',
                title: 'Deposit Failed',
                data: String(error),
            });
        }
        finally {
            setLoading(false);
        }
    };
    const handleWithdraw = async () => {
        if (!account || !managerId || !withdrawAmount)
            return;
        setLoading(true);
        try {
            const amountRaw = BigInt(Math.floor(parseFloat(withdrawAmount) * 1_000_000));
            const coinType = DUSDC_TYPE(CONFIG.dusdcPackageId);
            const tx = new Transaction();
            const coin = txWithdrawFromManager(tx, managerId, amountRaw, coinType);
            // Transfer withdrawn coin to sender's address
            tx.transferObjects([coin], tx.pure.address(account.address));
            const result = await signAndExecute({ transaction: tx });
            onOutput({
                type: 'success',
                title: 'Withdrawal Successful',
                data: JSON.stringify(result, null, 2),
                txDigest: result.digest,
            });
            setWithdrawAmount('');
            setTimeout(syncBalancesAndStats, 2000);
        }
        catch (error) {
            onOutput({
                type: 'error',
                title: 'Withdrawal Failed',
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
    return (_jsxs("div", { className: "space-y-6", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { children: [_jsx("h2", { className: "text-lg font-bold", children: "PredictManager Settings" }), _jsx("p", { className: "text-xs text-gray-400", children: "Create or manage deposited balances for Predict trading operations" })] }), _jsx("button", { onClick: fetchBalances, disabled: refreshing, className: "rounded-lg bg-gray-800 p-2 text-xs font-semibold hover:bg-gray-700 disabled:opacity-50", children: refreshing ? '⏳ Syncing...' : '🔄 Sync Balance' })] }), _jsxs("div", { className: "grid grid-cols-2 gap-4 rounded-xl border border-gray-800 bg-gray-950 p-4", children: [_jsxs("div", { children: [_jsx("div", { className: "text-xs text-gray-400 font-medium", children: "Wallet dUSDC" }), _jsx("div", { className: "text-xl font-bold text-green-400", children: walletBalance })] }), _jsxs("div", { children: [_jsx("div", { className: "text-xs text-gray-400 font-medium", children: "Manager dUSDC" }), _jsx("div", { className: "text-xl font-bold text-blue-400", children: managerBalance })] })] }), _jsxs("div", { className: "rounded-xl border border-gray-800 bg-gray-900/50 p-4 space-y-3", children: [_jsx("label", { className: "block text-xs font-bold uppercase tracking-wider text-gray-400", children: "PredictManager Object ID" }), _jsxs("div", { className: "flex gap-2", children: [_jsx("input", { type: "text", value: managerId, onChange: (e) => setManagerId(e.target.value.trim()), placeholder: "Enter or paste your PredictManager ID (0x...)", className: "flex-1 rounded-lg bg-gray-950 px-3 py-2 text-sm border border-gray-800 focus:outline-none focus:ring-1 focus:ring-blue-500 animate-pulse-once" }), _jsx("button", { onClick: async () => {
                                    if (!account)
                                        return;
                                    setRefreshing(true);
                                    const id = await findManagerOnChain(account.address);
                                    setRefreshing(false);
                                    if (id) {
                                        setManagerId(id);
                                        onOutput({
                                            type: 'success',
                                            title: 'Manager Found On-Chain',
                                            data: `PredictManager ID: ${id}`,
                                        });
                                    }
                                    else {
                                        onOutput({
                                            type: 'error',
                                            title: 'No Manager Found',
                                            data: `No PredictManagerCreated event found on-chain for address ${account.address}`,
                                        });
                                    }
                                }, disabled: refreshing, className: "rounded-lg bg-blue-600 px-3 py-2 text-xs font-medium hover:bg-blue-700 disabled:opacity-50 transition", children: "\uD83D\uDD0D Discover" })] }), _jsx("p", { className: "text-[11px] text-gray-400", children: "\uD83D\uDCA1 If you already have a `PredictManager`, paste its ID or click **Discover** to scan the chain." })] }), _jsxs("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-6", children: [_jsxs("div", { className: "rounded-xl border border-gray-800 bg-gray-900/30 p-4 flex flex-col justify-between", children: [_jsxs("div", { children: [_jsx("h3", { className: "font-semibold text-sm mb-1 text-gray-200", children: "Create New Manager" }), _jsx("p", { className: "text-xs text-gray-400 mb-4", children: "Initialize a dedicated account for trading Predict positions." })] }), _jsx("button", { onClick: handleCreateManager, disabled: loading, className: "w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition", children: loading ? '⏳ Deploying...' : 'Deploy Manager' })] }), _jsxs("div", { className: "rounded-xl border border-gray-800 bg-gray-900/30 p-4 space-y-3", children: [_jsxs("div", { children: [_jsx("h3", { className: "font-semibold text-sm mb-1 text-gray-200", children: "Deposit dUSDC" }), _jsx("p", { className: "text-xs text-gray-400", children: "Move funds from your wallet to Manager." })] }), _jsxs("div", { className: "flex gap-2", children: [_jsx("input", { type: "number", value: depositAmount, onChange: (e) => setDepositAmount(e.target.value), placeholder: "Amount (e.g. 10.5)", disabled: !managerId, className: "flex-1 rounded-lg bg-gray-950 px-3 py-2 text-sm border border-gray-800 disabled:opacity-50" }), _jsx("button", { onClick: handleDeposit, disabled: loading || !managerId || !depositAmount, className: "rounded-lg bg-green-600 px-4 py-2 text-sm font-medium hover:bg-green-700 disabled:opacity-50 transition", children: "Deposit" })] })] })] }), _jsxs("div", { className: "rounded-xl border border-gray-800 bg-gray-900/30 p-4 space-y-3", children: [_jsxs("div", { children: [_jsx("h3", { className: "font-semibold text-sm mb-1 text-gray-200", children: "Withdraw dUSDC" }), _jsx("p", { className: "text-xs text-gray-400", children: "Withdraw quote coins back to your connected wallet." })] }), _jsxs("div", { className: "flex gap-2", children: [_jsx("input", { type: "number", value: withdrawAmount, onChange: (e) => setWithdrawAmount(e.target.value), placeholder: "Amount (e.g. 5.0)", disabled: !managerId, className: "flex-1 rounded-lg bg-gray-950 px-3 py-2 text-sm border border-gray-800 disabled:opacity-50" }), _jsx("button", { onClick: handleWithdraw, disabled: loading || !managerId || !withdrawAmount, className: "rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium hover:bg-purple-700 disabled:opacity-50 transition", children: "Withdraw" })] })] }), managerId && managerId.startsWith('0x') && (_jsxs("div", { className: "space-y-6", children: [managerSummary && (_jsxs("div", { className: "rounded-xl border border-gray-800 bg-gray-950 p-4 space-y-4", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { children: [_jsx("h3", { className: "font-semibold text-sm text-gray-200 text-left", children: "Indexer Manager Summary" }), _jsx("p", { className: "text-[10px] text-gray-400 text-left", children: "Aggregated metrics from the public server indexer" })] }), _jsx("button", { onClick: fetchManagerStats, disabled: summaryLoading, className: "text-xs text-blue-400 hover:text-blue-300 disabled:opacity-50", children: summaryLoading ? '⏳ Syncing...' : '🔄 Refresh Stats' })] }), _jsxs("div", { className: "grid grid-cols-2 md:grid-cols-4 gap-4 text-xs", children: [_jsxs("div", { className: "rounded-lg bg-gray-900/40 p-2.5 border border-gray-800/50", children: [_jsx("div", { className: "text-gray-400 mb-0.5 font-medium text-left", children: "Account Value" }), _jsxs("div", { className: "text-sm font-bold text-gray-100 text-left", children: ["$", (Number(managerSummary.account_value) / 1_000_000).toFixed(2)] })] }), _jsxs("div", { className: "rounded-lg bg-gray-900/40 p-2.5 border border-gray-800/50", children: [_jsx("div", { className: "text-gray-400 mb-0.5 font-medium text-left", children: "Realized PnL" }), _jsxs("div", { className: `text-sm font-bold text-left ${Number(managerSummary.realized_pnl) >= 0 ? 'text-green-400' : 'text-red-400'}`, children: [Number(managerSummary.realized_pnl) >= 0 ? '+' : '', "$", (Number(managerSummary.realized_pnl) / 1_000_000).toFixed(4)] })] }), _jsxs("div", { className: "rounded-lg bg-gray-900/40 p-2.5 border border-gray-800/50", children: [_jsx("div", { className: "text-gray-400 mb-0.5 font-medium text-left", children: "Unrealized PnL" }), _jsxs("div", { className: `text-sm font-bold text-left ${Number(managerSummary.unrealized_pnl) >= 0 ? 'text-green-400' : 'text-red-400'}`, children: [Number(managerSummary.unrealized_pnl) >= 0 ? '+' : '', "$", (Number(managerSummary.unrealized_pnl) / 1_000_000).toFixed(4)] })] }), _jsxs("div", { className: "rounded-lg bg-gray-900/40 p-2.5 border border-gray-800/50", children: [_jsx("div", { className: "text-gray-400 mb-0.5 font-medium text-left", children: "Trading Balance" }), _jsxs("div", { className: "text-sm font-bold text-blue-400 text-left", children: ["$", (Number(managerSummary.trading_balance) / 1_000_000).toFixed(2)] })] }), _jsxs("div", { className: "rounded-lg bg-gray-900/40 p-2.5 border border-gray-800/50", children: [_jsx("div", { className: "text-gray-400 mb-0.5 font-medium text-left", children: "Open Exposure" }), _jsxs("div", { className: "text-sm font-bold text-gray-100 text-left", children: ["$", (Number(managerSummary.open_exposure) / 1_000_000).toFixed(2)] })] }), _jsxs("div", { className: "rounded-lg bg-gray-900/40 p-2.5 border border-gray-800/50", children: [_jsx("div", { className: "text-gray-400 mb-0.5 font-medium text-left", children: "Redeemable Value" }), _jsxs("div", { className: "text-sm font-bold text-green-400 text-left", children: ["$", (Number(managerSummary.redeemable_value) / 1_000_000).toFixed(2)] })] }), _jsxs("div", { className: "rounded-lg bg-gray-900/40 p-2.5 border border-gray-800/50 col-span-2", children: [_jsx("div", { className: "text-gray-400 mb-0.5 font-medium text-left", children: "Open / Pending Settlement Positions" }), _jsxs("div", { className: "text-sm font-bold text-gray-100 text-left", children: [managerSummary.open_positions, " Open / ", managerSummary.awaiting_settlement_positions, " Awaiting"] })] })] })] })), _jsxs("div", { className: "rounded-xl border border-gray-800 bg-gray-950 p-4 space-y-3", children: [_jsx("h3", { className: "font-semibold text-sm text-gray-200 text-left", children: "Manager PnL History" }), _jsx("p", { className: "text-[10px] text-gray-400 text-left", children: "Historical realized PnL snapshots for this manager" }), summaryLoading ? (_jsx("div", { className: "text-xs text-gray-500 py-6 text-center", children: "\u23F3 Loading PnL history..." })) : managerPnLPoints.length === 0 ? (_jsx("div", { className: "text-xs text-gray-500 py-6 text-center", children: "\uD83D\uDCED No PnL records found for this manager" })) : (_jsx("div", { className: "overflow-x-auto rounded-lg border border-gray-900 bg-gray-950/40 text-[11px]", children: _jsxs("table", { className: "w-full text-left text-gray-400", children: [_jsx("thead", { className: "text-[10px] text-gray-500 uppercase bg-gray-900/50", children: _jsxs("tr", { children: [_jsx("th", { className: "p-2", children: "Time" }), _jsx("th", { className: "p-2", children: "Realized Change" }), _jsx("th", { className: "p-2", children: "Cumulative Realized PnL" })] }) }), _jsx("tbody", { children: managerPnLPoints.slice(-10).reverse().map((pt, idx) => (_jsxs("tr", { className: "border-b border-gray-900 hover:bg-gray-900/20 last:border-none", children: [_jsx("td", { className: "p-2 text-gray-300", children: new Date(pt.timestamp_ms).toLocaleString() }), _jsxs("td", { className: `p-2 font-mono ${Number(pt.realized_pnl) >= 0 ? 'text-green-400' : 'text-red-400'}`, children: [Number(pt.realized_pnl) >= 0 ? '+' : '', "$", (Number(pt.realized_pnl) / 1_000_000).toFixed(4)] }), _jsxs("td", { className: `p-2 font-mono font-semibold ${Number(pt.cumulative_realized_pnl) >= 0 ? 'text-green-400' : 'text-red-400'}`, children: [Number(pt.cumulative_realized_pnl) >= 0 ? '+' : '', "$", (Number(pt.cumulative_realized_pnl) / 1_000_000).toFixed(4)] })] }, idx))) })] }) }))] })] }))] }));
}
//# sourceMappingURL=ManagerPanel.js.map