import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect } from 'react';
import { useCurrentAccount, useSignAndExecuteTransaction } from '@mysten/dapp-kit';
import { Transaction } from '@mysten/sui/transactions';
import { CONFIG, DUSDC_TYPE, PLPCoin } from '../../config';
import { client } from '../../lib/client';
import { txSupply, txWithdraw } from '../../lib/predict-txb';
export default function LPPanel({ onOutput }) {
    const account = useCurrentAccount();
    const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
    const [walletUSDC, setWalletUSDC] = useState('0');
    const [walletPLP, setWalletPLP] = useState('0');
    const [supplyAmount, setSupplyAmount] = useState('');
    const [withdrawAmount, setWithdrawAmount] = useState('');
    const [loading, setLoading] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    // Vault summary states
    const [vaultSummary, setVaultSummary] = useState(null);
    const [vaultPerformance, setVaultPerformance] = useState(null);
    const [vaultLoading, setVaultLoading] = useState(false);
    const fetchBalances = async () => {
        if (!account)
            return;
        setRefreshing(true);
        try {
            const usdcType = DUSDC_TYPE(CONFIG.dusdcPackageId);
            const plpType = PLPCoin(CONFIG.predictPackageId);
            // 1. Fetch Wallet dUSDC
            const walletCoins = await client.getCoins({
                owner: account.address,
                coinType: usdcType,
            });
            const totalUSDC = walletCoins.data.reduce((sum, coin) => sum + BigInt(coin.balance), 0n);
            setWalletUSDC((Number(totalUSDC) / 1_000_000).toFixed(6));
            // 2. Fetch Wallet PLP
            const lpCoins = await client.getCoins({
                owner: account.address,
                coinType: plpType,
            });
            const totalPLP = lpCoins.data.reduce((sum, coin) => sum + BigInt(coin.balance), 0n);
            setWalletPLP((Number(totalPLP) / 1_000_000).toFixed(6));
        }
        catch (error) {
            console.error('Failed to fetch LP balances:', error);
        }
        finally {
            setRefreshing(false);
        }
    };
    const fetchVaultSummary = async () => {
        if (!CONFIG.predictObjectId)
            return;
        setVaultLoading(true);
        try {
            const response = await fetch(`https://predict-server.testnet.mystenlabs.com/predicts/${CONFIG.predictObjectId}/vault/summary`);
            if (response.ok) {
                const data = await response.json();
                setVaultSummary(data);
            }
            const perfResponse = await fetch(`https://predict-server.testnet.mystenlabs.com/predicts/${CONFIG.predictObjectId}/vault/performance?range=ALL`);
            if (perfResponse.ok) {
                const data = await perfResponse.json();
                setVaultPerformance(data);
            }
        }
        catch (err) {
            console.error('Failed to fetch vault summary/performance:', err);
        }
        finally {
            setVaultLoading(false);
        }
    };
    useEffect(() => {
        if (account) {
            fetchBalances();
            fetchVaultSummary();
        }
    }, [account]);
    const handleSupply = async () => {
        if (!account || !supplyAmount)
            return;
        setLoading(true);
        try {
            const amountRaw = BigInt(Math.floor(parseFloat(supplyAmount) * 1_000_000));
            const coinType = DUSDC_TYPE(CONFIG.dusdcPackageId);
            // Fetch dUSDC coins
            const coins = await client.getCoins({
                owner: account.address,
                coinType,
            });
            if (coins.data.length === 0) {
                throw new Error('You do not have any dUSDC in your wallet to supply');
            }
            const tx = new Transaction();
            const primaryCoin = tx.object(coins.data[0].coinObjectId);
            if (coins.data.length > 1) {
                tx.mergeCoins(primaryCoin, coins.data.slice(1).map((c) => tx.object(c.coinObjectId)));
            }
            const [supplyCoin] = tx.splitCoins(primaryCoin, [tx.pure.u64(amountRaw)]);
            // Supply liquidity
            const plpCoin = txSupply(tx, supplyCoin, coinType);
            // Transfer the minted PLP shares back to the user
            tx.transferObjects([plpCoin], tx.pure.address(account.address));
            const result = await signAndExecute({ transaction: tx });
            onOutput({
                type: 'success',
                title: 'Liquidity Supplied Successfully',
                data: JSON.stringify(result, null, 2),
                txDigest: result.digest,
            });
            setSupplyAmount('');
            setTimeout(() => {
                fetchBalances();
                fetchVaultSummary();
            }, 2000);
        }
        catch (error) {
            onOutput({
                type: 'error',
                title: 'Supply Liquidity Failed',
                data: String(error),
            });
        }
        finally {
            setLoading(false);
        }
    };
    const handleWithdraw = async () => {
        if (!account || !withdrawAmount)
            return;
        setLoading(true);
        try {
            const amountRaw = BigInt(Math.floor(parseFloat(withdrawAmount) * 1_000_000));
            const coinType = DUSDC_TYPE(CONFIG.dusdcPackageId);
            const plpType = PLPCoin(CONFIG.predictPackageId);
            // Fetch PLP coins in wallet
            const coins = await client.getCoins({
                owner: account.address,
                coinType: plpType,
            });
            if (coins.data.length === 0) {
                throw new Error('You do not have any PLP shares to withdraw');
            }
            const tx = new Transaction();
            const primaryCoin = tx.object(coins.data[0].coinObjectId);
            if (coins.data.length > 1) {
                tx.mergeCoins(primaryCoin, coins.data.slice(1).map((c) => tx.object(c.coinObjectId)));
            }
            const [withdrawCoin] = tx.splitCoins(primaryCoin, [tx.pure.u64(amountRaw)]);
            // Withdraw liquidity
            const quoteCoin = txWithdraw(tx, withdrawCoin, coinType);
            // Transfer returned dUSDC back to the user
            tx.transferObjects([quoteCoin], tx.pure.address(account.address));
            const result = await signAndExecute({ transaction: tx });
            onOutput({
                type: 'success',
                title: 'Liquidity Withdrawn Successfully',
                data: JSON.stringify(result, null, 2),
                txDigest: result.digest,
            });
            setWithdrawAmount('');
            setTimeout(() => {
                fetchBalances();
                fetchVaultSummary();
            }, 2000);
        }
        catch (error) {
            onOutput({
                type: 'error',
                title: 'Withdraw Liquidity Failed',
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
    return (_jsxs("div", { className: "space-y-6", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { children: [_jsx("h2", { className: "text-lg font-bold", children: "LP Operations" }), _jsx("p", { className: "text-xs text-gray-400", children: "Supply dUSDC to earn fees or Withdraw liquidity from the LP pool" })] }), _jsx("button", { onClick: fetchBalances, disabled: refreshing, className: "rounded-lg bg-gray-800 p-2 text-xs font-semibold hover:bg-gray-700 disabled:opacity-50", children: refreshing ? '⏳ Syncing...' : '🔄 Sync Balance' })] }), _jsxs("div", { className: "grid grid-cols-2 gap-4 rounded-xl border border-gray-800 bg-gray-950 p-4", children: [_jsxs("div", { children: [_jsx("div", { className: "text-xs text-gray-400 font-medium", children: "Wallet dUSDC" }), _jsx("div", { className: "text-xl font-bold text-green-400", children: walletUSDC })] }), _jsxs("div", { children: [_jsx("div", { className: "text-xs text-gray-400 font-medium", children: "Wallet PLP Shares" }), _jsx("div", { className: "text-xl font-bold text-blue-400", children: walletPLP })] })] }), vaultSummary && (_jsxs("div", { className: "rounded-xl border border-gray-800 bg-gray-950 p-4 space-y-4", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsx("span", { className: "text-xs font-bold uppercase tracking-wider text-gray-400", children: "Live Vault Summary" }), _jsx("button", { onClick: fetchVaultSummary, disabled: vaultLoading, className: "text-[11px] text-blue-400 hover:text-blue-300 disabled:opacity-50", children: vaultLoading ? '⏳ Syncing...' : '🔄 Refresh Vault' })] }), _jsxs("div", { className: "grid grid-cols-2 md:grid-cols-3 gap-4 text-xs", children: [_jsxs("div", { className: "rounded-lg bg-gray-900/40 p-2.5 border border-gray-800/50", children: [_jsx("div", { className: "text-gray-400 mb-0.5 font-medium", children: "Vault Value" }), _jsxs("div", { className: "text-sm font-bold text-gray-100", children: ["$", (Number(vaultSummary.vault_value) / 1_000_000).toFixed(2), " dUSDC"] })] }), _jsxs("div", { className: "rounded-lg bg-gray-900/40 p-2.5 border border-gray-800/50", children: [_jsx("div", { className: "text-gray-400 mb-0.5 font-medium", children: "PLP Share Price" }), _jsxs("div", { className: "text-sm font-bold text-blue-400", children: [Number(vaultSummary.plp_share_price).toFixed(6), " dUSDC"] })] }), _jsxs("div", { className: "rounded-lg bg-gray-900/40 p-2.5 border border-gray-800/50", children: [_jsx("div", { className: "text-gray-400 mb-0.5 font-medium", children: "Total PLP Supply" }), _jsxs("div", { className: "text-sm font-bold text-gray-100", children: [(Number(vaultSummary.plp_total_supply) / 1_000_000).toFixed(2), " PLP"] })] }), _jsxs("div", { className: "rounded-lg bg-gray-900/40 p-2.5 border border-gray-800/50", children: [_jsx("div", { className: "text-gray-400 mb-0.5 font-medium", children: "Available Liquidity" }), _jsxs("div", { className: "text-sm font-bold text-green-400", children: ["$", (Number(vaultSummary.available_liquidity) / 1_000_000).toFixed(2)] })] }), _jsxs("div", { className: "rounded-lg bg-gray-900/40 p-2.5 border border-gray-800/50", children: [_jsx("div", { className: "text-gray-400 mb-0.5 font-medium", children: "Total Supplied" }), _jsxs("div", { className: "text-sm font-bold text-gray-100", children: ["$", (Number(vaultSummary.total_supplied) / 1_000_000).toFixed(2)] })] }), _jsxs("div", { className: "rounded-lg bg-gray-900/40 p-2.5 border border-gray-800/50", children: [_jsx("div", { className: "text-gray-400 mb-0.5 font-medium", children: "Pool Utilization" }), _jsxs("div", { className: "text-sm font-bold text-yellow-500", children: [(Number(vaultSummary.utilization) * 100).toFixed(4), "%"] })] })] }), vaultPerformance && vaultPerformance.points && vaultPerformance.points.length > 0 && (() => {
                        const points = vaultPerformance.points;
                        const initialPrice = points[0]?.share_price || 1.0;
                        const currentPrice = points[points.length - 1]?.share_price || 1.0;
                        const yieldPct = ((currentPrice - initialPrice) / initialPrice * 100);
                        return (_jsxs("div", { className: "border-t border-gray-800/60 pt-3 space-y-2", children: [_jsxs("div", { className: "flex justify-between items-center text-xs", children: [_jsx("span", { className: "text-[11px] font-bold uppercase tracking-wider text-gray-400", children: "Vault Performance History" }), _jsxs("span", { className: `font-semibold ${yieldPct >= 0 ? 'text-green-400' : 'text-red-400'}`, children: ["Net Yield: ", yieldPct >= 0 ? '+' : '', yieldPct.toFixed(6), "%"] })] }), _jsx("div", { className: "overflow-x-auto rounded-lg border border-gray-800 bg-gray-950/40 text-[11px]", children: _jsxs("table", { className: "w-full text-left text-gray-400", children: [_jsx("thead", { className: "text-[10px] text-gray-500 uppercase bg-gray-900/30", children: _jsxs("tr", { children: [_jsx("th", { className: "p-2", children: "Time" }), _jsx("th", { className: "p-2", children: "Share Price" }), _jsx("th", { className: "p-2", children: "Vault Value" }), _jsx("th", { className: "p-2", children: "Total Shares" })] }) }), _jsx("tbody", { children: points.slice(-5).reverse().map((pt, idx) => (_jsxs("tr", { className: "border-b border-gray-800/30 last:border-none hover:bg-gray-900/10", children: [_jsx("td", { className: "p-2 text-gray-300", children: new Date(pt.timestamp_ms).toLocaleString() }), _jsx("td", { className: "p-2 font-mono text-blue-400", children: pt.share_price.toFixed(6) }), _jsxs("td", { className: "p-2 font-mono", children: ["$", (Number(pt.vault_value) / 1_000_000).toFixed(2)] }), _jsx("td", { className: "p-2 font-mono", children: (Number(pt.total_shares) / 1_000_000).toFixed(2) })] }, idx))) })] }) })] }));
                    })()] })), _jsxs("div", { className: "rounded-xl border border-gray-800 bg-gray-900/30 p-4 space-y-3", children: [_jsxs("div", { children: [_jsx("h3", { className: "font-semibold text-sm mb-1 text-gray-200", children: "Supply Liquidity" }), _jsx("p", { className: "text-xs text-gray-400", children: "Supply dUSDC in exchange for PLP shares." })] }), _jsxs("div", { className: "flex gap-2", children: [_jsx("input", { type: "number", value: supplyAmount, onChange: (e) => setSupplyAmount(e.target.value), placeholder: "USDC Amount (e.g. 50.0)", className: "flex-1 rounded-lg bg-gray-950 px-3 py-2 text-sm border border-gray-800" }), _jsx("button", { onClick: handleSupply, disabled: loading || !supplyAmount, className: "rounded-lg bg-green-600 px-4 py-2 text-sm font-medium hover:bg-green-700 disabled:opacity-50 transition", children: "Supply" })] })] }), _jsxs("div", { className: "rounded-xl border border-gray-800 bg-gray-900/30 p-4 space-y-3", children: [_jsxs("div", { children: [_jsx("h3", { className: "font-semibold text-sm mb-1 text-gray-200", children: "Withdraw Liquidity" }), _jsx("p", { className: "text-xs text-gray-400", children: "Burn PLP shares to withdraw your dUSDC." })] }), _jsxs("div", { className: "flex gap-2", children: [_jsx("input", { type: "number", value: withdrawAmount, onChange: (e) => setWithdrawAmount(e.target.value), placeholder: "PLP Shares (e.g. 10.0)", className: "flex-1 rounded-lg bg-gray-950 px-3 py-2 text-sm border border-gray-800" }), _jsx("button", { onClick: handleWithdraw, disabled: loading || !withdrawAmount, className: "rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium hover:bg-purple-700 disabled:opacity-50 transition", children: "Withdraw" })] })] })] }));
}
//# sourceMappingURL=LPPanel.js.map