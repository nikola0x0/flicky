import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect } from 'react';
import { useCurrentAccount, useSignAndExecuteTransaction } from '@mysten/dapp-kit';
import { Transaction } from '@mysten/sui/transactions';
import { client } from '../../lib/client';
export default function SwapPanel({ onOutput }) {
    const account = useCurrentAccount();
    const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
    // Package & Pool configuration
    const [packageId, setPackageId] = useState('0x51ea0f29321f3c25f8b2f530ecd3ed3dec569d954c8832d318de7e203653a936');
    const [poolId, setPoolId] = useState(() => {
        return localStorage.getItem('flicky_swap_pool_id') || '';
    });
    const [coinXType, setCoinXType] = useState('0x2::sui::SUI');
    const [coinYType, setCoinYType] = useState('0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC');
    const [feePct, setFeePct] = useState('30'); // 30 basis points = 0.3%
    // Swap operations states
    const [swapDirection, setSwapDirection] = useState('x_to_y');
    const [swapAmount, setSwapAmount] = useState('1');
    const [minAmountOut, setMinAmountOut] = useState('0');
    const [slippage, setSlippage] = useState('1'); // 1% default slippage
    // LP operations states
    const [addXAmount, setAddXAmount] = useState('10');
    const [addYAmount, setAddYAmount] = useState('100');
    const [removeLpAmount, setRemoveLpAmount] = useState('1');
    // Live pool reserves
    const [poolReserves, setPoolReserves] = useState(null);
    // Wallet balances
    const [walletXBal, setWalletXBal] = useState('0');
    const [walletYBal, setWalletYBal] = useState('0');
    const [walletLpBal, setWalletLpBal] = useState('0');
    const [loading, setLoading] = useState(false);
    const [poolLoading, setPoolLoading] = useState(false);
    // Load recently used pools from localStorage
    const [recentPools, setRecentPools] = useState(() => {
        try {
            const stored = localStorage.getItem('flicky_swap_recent_pools');
            return stored ? JSON.parse(stored) : [];
        }
        catch {
            return [];
        }
    });
    // Save poolId to localStorage
    useEffect(() => {
        if (poolId) {
            localStorage.setItem('flicky_swap_pool_id', poolId);
        }
        else {
            localStorage.removeItem('flicky_swap_pool_id');
        }
    }, [poolId]);
    const addRecentPool = (id) => {
        if (!id || !id.startsWith('0x'))
            return;
        setRecentPools((prev) => {
            if (prev.includes(id))
                return prev;
            const updated = [id, ...prev].slice(0, 10); // Keep last 10
            localStorage.setItem('flicky_swap_recent_pools', JSON.stringify(updated));
            return updated;
        });
    };
    const parseU64 = (bytes) => {
        let val = 0n;
        for (let i = bytes.length - 1; i >= 0; i--) {
            val = (val << 8n) | BigInt(bytes[i]);
        }
        return val;
    };
    const fetchPoolReserves = async () => {
        if (!poolId || !poolId.startsWith('0x'))
            return;
        setPoolLoading(true);
        try {
            const tx = new Transaction();
            tx.moveCall({
                target: `${packageId}::swap::pool_reserves`,
                typeArguments: [coinXType, coinYType],
                arguments: [tx.object(poolId)],
            });
            tx.moveCall({
                target: `${packageId}::swap::pool_fee_pct`,
                typeArguments: [coinXType, coinYType],
                arguments: [tx.object(poolId)],
            });
            tx.moveCall({
                target: `${packageId}::swap::pool_lp_supply`,
                typeArguments: [coinXType, coinYType],
                arguments: [tx.object(poolId)],
            });
            const result = await client.devInspectTransactionBlock({
                sender: account?.address || '0x30587ef36b6a19d78e752a374a5f67a140d6a5b5471ee3ed91ff953cdb9fb0fe',
                transactionBlock: tx,
            });
            const res = result.results;
            if (res && res.length >= 3) {
                const reservesRaw = res[0].returnValues;
                const feeRaw = res[1].returnValues?.[0]?.[0];
                const lpSupplyRaw = res[2].returnValues?.[0]?.[0];
                if (reservesRaw && reservesRaw.length >= 2) {
                    const reserveXRaw = parseU64(reservesRaw[0][0]);
                    const reserveYRaw = parseU64(reservesRaw[1][0]);
                    const fee = feeRaw ? Number(parseU64(feeRaw)) : 0;
                    const lpSupply = lpSupplyRaw ? parseU64(lpSupplyRaw) : 0n;
                    // Scaling factors: SUI uses 1e9, dUSDC uses 1e6
                    const isX_Sui = coinXType === '0x2::sui::SUI';
                    const isY_Sui = coinYType === '0x2::sui::SUI';
                    const scaleX = isX_Sui ? 1_000_000_000 : 1_000_000;
                    const scaleY = isY_Sui ? 1_000_000_000 : 1_000_000;
                    const rxFloat = Number(reserveXRaw) / scaleX;
                    const ryFloat = Number(reserveYRaw) / scaleY;
                    const spotPrice = rxFloat > 0 ? (ryFloat / rxFloat).toFixed(6) : '0';
                    setPoolReserves({
                        reserveX: rxFloat.toFixed(6),
                        reserveY: ryFloat.toFixed(6),
                        feePct: fee,
                        lpSupply: (Number(lpSupply) / 1_000_000).toFixed(6), // LP scaled by 1e6
                        spotPrice,
                    });
                    addRecentPool(poolId);
                }
            }
        }
        catch (err) {
            console.error('Failed to fetch pool reserves:', err);
            setPoolReserves(null);
        }
        finally {
            setPoolLoading(false);
        }
    };
    const fetchWalletBalances = async () => {
        if (!account)
            return;
        try {
            const isX_Sui = coinXType === '0x2::sui::SUI';
            const isY_Sui = coinYType === '0x2::sui::SUI';
            const scaleX = isX_Sui ? 1000000000n : 1000000n;
            const scaleY = isY_Sui ? 1000000000n : 1000000n;
            // 1. Fetch Coin X
            const coinsX = await client.getCoins({ owner: account.address, coinType: coinXType });
            const totalX = coinsX.data.reduce((sum, coin) => sum + BigInt(coin.balance), 0n);
            setWalletXBal((Number(totalX) / Number(scaleX)).toFixed(4));
            // 2. Fetch Coin Y
            const coinsY = await client.getCoins({ owner: account.address, coinType: coinYType });
            const totalY = coinsY.data.reduce((sum, coin) => sum + BigInt(coin.balance), 0n);
            setWalletYBal((Number(totalY) / Number(scaleY)).toFixed(4));
            // 3. Fetch LP
            if (poolId && poolId.startsWith('0x')) {
                const lpCoinType = `${packageId}::swap::LP<${coinXType},${coinYType}>`;
                const coinsLp = await client.getCoins({ owner: account.address, coinType: lpCoinType });
                const totalLp = coinsLp.data.reduce((sum, coin) => sum + BigInt(coin.balance), 0n);
                setWalletLpBal((Number(totalLp) / 1_000_000).toFixed(4));
            }
            else {
                setWalletLpBal('0.0000');
            }
        }
        catch (err) {
            console.error('Failed to fetch wallet balances:', err);
        }
    };
    const syncAllData = async () => {
        await Promise.all([
            fetchPoolReserves(),
            fetchWalletBalances()
        ]);
    };
    useEffect(() => {
        if (account) {
            fetchWalletBalances();
        }
    }, [account, coinXType, coinYType, packageId, poolId]);
    useEffect(() => {
        if (poolId && poolId.startsWith('0x')) {
            fetchPoolReserves();
        }
        else {
            setPoolReserves(null);
        }
    }, [poolId, coinXType, coinYType, packageId]);
    // Local swap amount simulation (AMM Constant Product formula)
    const getEstimatedOutput = () => {
        if (!poolReserves || !swapAmount || parseFloat(swapAmount) <= 0)
            return '0';
        const rx = parseFloat(poolReserves.reserveX);
        const ry = parseFloat(poolReserves.reserveY);
        const amt = parseFloat(swapAmount);
        if (rx <= 0 || ry <= 0)
            return '0';
        const fee_factor = 1.0 - poolReserves.feePct / 10000;
        if (swapDirection === 'x_to_y') {
            // dy = (ry * dx * fee) / (rx + dx * fee)
            const dx_fee = amt * fee_factor;
            const dy = (ry * dx_fee) / (rx + dx_fee);
            return dy.toFixed(6);
        }
        else {
            // dx = (rx * dy * fee) / (ry + dy * fee)
            const dy_fee = amt * fee_factor;
            const dx = (rx * dy_fee) / (ry + dy_fee);
            return dx.toFixed(6);
        }
    };
    // Pre-fill slippage minimum output based on estimate
    useEffect(() => {
        const est = getEstimatedOutput();
        const slipPct = parseFloat(slippage) || 0;
        const minOut = parseFloat(est) * (1 - slipPct / 100);
        setMinAmountOut(minOut > 0 ? minOut.toFixed(6) : '0');
    }, [swapAmount, swapDirection, poolReserves, slippage]);
    const handleCreatePool = async () => {
        if (!account)
            return;
        setLoading(true);
        try {
            const tx = new Transaction();
            tx.moveCall({
                target: `${packageId}::swap::entry_create_pool`,
                typeArguments: [coinXType, coinYType],
                arguments: [tx.pure.u64(Number(feePct))],
            });
            const result = await signAndExecute({ transaction: tx });
            // Fetch transaction details to get object changes (wait until indexed)
            const txData = await client.waitForTransaction({
                digest: result.digest,
                options: { showObjectChanges: true }
            });
            // Parse created object IDs to find the Pool ID
            const poolObject = txData.objectChanges?.find((change) => change.type === 'created' &&
                change.objectType.includes('::swap::Pool<'));
            const newPoolId = poolObject?.type === 'created' ? poolObject.objectId : '';
            if (newPoolId) {
                setPoolId(newPoolId);
                addRecentPool(newPoolId);
            }
            onOutput({
                type: 'success',
                title: 'Create Pool Successful',
                data: JSON.stringify(result, null, 2),
                txDigest: result.digest,
            });
            setTimeout(syncAllData, 2000);
        }
        catch (error) {
            onOutput({
                type: 'error',
                title: 'Create Pool Failed',
                data: String(error),
            });
        }
        finally {
            setLoading(false);
        }
    };
    const handleAddLiquidity = async () => {
        if (!account || !poolId)
            return;
        setLoading(true);
        try {
            const isX_Sui = coinXType === '0x2::sui::SUI';
            const isY_Sui = coinYType === '0x2::sui::SUI';
            const scaleX = isX_Sui ? 1000000000n : 1000000n;
            const scaleY = isY_Sui ? 1000000000n : 1000000n;
            const amtXRaw = BigInt(Math.floor(parseFloat(addXAmount) * Number(scaleX)));
            const amtYRaw = BigInt(Math.floor(parseFloat(addYAmount) * Number(scaleY)));
            const tx = new Transaction();
            let coinXObject;
            let coinYObject;
            // 1. Prepare Coin X
            if (isX_Sui) {
                coinXObject = tx.splitCoins(tx.gas, [tx.pure.u64(amtXRaw)]);
            }
            else {
                const coins = await client.getCoins({ owner: account.address, coinType: coinXType });
                if (coins.data.length === 0)
                    throw new Error(`No ${coinXType} coins found in wallet`);
                const primary = tx.object(coins.data[0].coinObjectId);
                if (coins.data.length > 1) {
                    tx.mergeCoins(primary, coins.data.slice(1).map((c) => tx.object(c.coinObjectId)));
                }
                coinXObject = tx.splitCoins(primary, [tx.pure.u64(amtXRaw)]);
            }
            // 2. Prepare Coin Y
            if (isY_Sui) {
                coinYObject = tx.splitCoins(tx.gas, [tx.pure.u64(amtYRaw)]);
            }
            else {
                const coins = await client.getCoins({ owner: account.address, coinType: coinYType });
                if (coins.data.length === 0)
                    throw new Error(`No ${coinYType} coins found in wallet`);
                const primary = tx.object(coins.data[0].coinObjectId);
                if (coins.data.length > 1) {
                    tx.mergeCoins(primary, coins.data.slice(1).map((c) => tx.object(c.coinObjectId)));
                }
                coinYObject = tx.splitCoins(primary, [tx.pure.u64(amtYRaw)]);
            }
            // Call entry_add_liquidity
            tx.moveCall({
                target: `${packageId}::swap::entry_add_liquidity`,
                typeArguments: [coinXType, coinYType],
                arguments: [tx.object(poolId), coinXObject, coinYObject],
            });
            const result = await signAndExecute({ transaction: tx });
            onOutput({
                type: 'success',
                title: 'Add Liquidity Successful',
                data: JSON.stringify(result, null, 2),
                txDigest: result.digest,
            });
            setTimeout(syncAllData, 2000);
        }
        catch (error) {
            onOutput({
                type: 'error',
                title: 'Add Liquidity Failed',
                data: String(error),
            });
        }
        finally {
            setLoading(false);
        }
    };
    const handleRemoveLiquidity = async () => {
        if (!account || !poolId)
            return;
        setLoading(true);
        try {
            const lpCoinType = `${packageId}::swap::LP<${coinXType},${coinYType}>`;
            const lpAmtRaw = BigInt(Math.floor(parseFloat(removeLpAmount) * 1_000_000)); // LP tokens scale by 1e6
            const coins = await client.getCoins({ owner: account.address, coinType: lpCoinType });
            if (coins.data.length === 0)
                throw new Error('No LP tokens found in wallet for this pool');
            const tx = new Transaction();
            const primary = tx.object(coins.data[0].coinObjectId);
            if (coins.data.length > 1) {
                tx.mergeCoins(primary, coins.data.slice(1).map((c) => tx.object(c.coinObjectId)));
            }
            const splitLp = tx.splitCoins(primary, [tx.pure.u64(lpAmtRaw)]);
            tx.moveCall({
                target: `${packageId}::swap::entry_remove_liquidity`,
                typeArguments: [coinXType, coinYType],
                arguments: [tx.object(poolId), splitLp],
            });
            const result = await signAndExecute({ transaction: tx });
            onOutput({
                type: 'success',
                title: 'Remove Liquidity Successful',
                data: JSON.stringify(result, null, 2),
                txDigest: result.digest,
            });
            setTimeout(syncAllData, 2000);
        }
        catch (error) {
            onOutput({
                type: 'error',
                title: 'Remove Liquidity Failed',
                data: String(error),
            });
        }
        finally {
            setLoading(false);
        }
    };
    const handleSwap = async () => {
        if (!account || !poolId)
            return;
        setLoading(true);
        try {
            const isX_Sui = coinXType === '0x2::sui::SUI';
            const isY_Sui = coinYType === '0x2::sui::SUI';
            const scaleInput = swapDirection === 'x_to_y' ? (isX_Sui ? 1000000000n : 1000000n) : (isY_Sui ? 1000000000n : 1000000n);
            const scaleOutput = swapDirection === 'x_to_y' ? (isY_Sui ? 1000000000n : 1000000n) : (isX_Sui ? 1000000000n : 1000000n);
            const inputAmtRaw = BigInt(Math.floor(parseFloat(swapAmount) * Number(scaleInput)));
            const minOutRaw = BigInt(Math.floor(parseFloat(minAmountOut) * Number(scaleOutput)));
            const tx = new Transaction();
            let inputCoinObject;
            if (swapDirection === 'x_to_y') {
                // Swap X for Y
                if (isX_Sui) {
                    inputCoinObject = tx.splitCoins(tx.gas, [tx.pure.u64(inputAmtRaw)]);
                }
                else {
                    const coins = await client.getCoins({ owner: account.address, coinType: coinXType });
                    if (coins.data.length === 0)
                        throw new Error(`No ${coinXType} coins found in wallet`);
                    const primary = tx.object(coins.data[0].coinObjectId);
                    if (coins.data.length > 1) {
                        tx.mergeCoins(primary, coins.data.slice(1).map((c) => tx.object(c.coinObjectId)));
                    }
                    inputCoinObject = tx.splitCoins(primary, [tx.pure.u64(inputAmtRaw)]);
                }
                tx.moveCall({
                    target: `${packageId}::swap::entry_swap_x_for_y`,
                    typeArguments: [coinXType, coinYType],
                    arguments: [tx.object(poolId), inputCoinObject, tx.pure.u64(minOutRaw)],
                });
            }
            else {
                // Swap Y for X
                if (isY_Sui) {
                    inputCoinObject = tx.splitCoins(tx.gas, [tx.pure.u64(inputAmtRaw)]);
                }
                else {
                    const coins = await client.getCoins({ owner: account.address, coinType: coinYType });
                    if (coins.data.length === 0)
                        throw new Error(`No ${coinYType} coins found in wallet`);
                    const primary = tx.object(coins.data[0].coinObjectId);
                    if (coins.data.length > 1) {
                        tx.mergeCoins(primary, coins.data.slice(1).map((c) => tx.object(c.coinObjectId)));
                    }
                    inputCoinObject = tx.splitCoins(primary, [tx.pure.u64(inputAmtRaw)]);
                }
                tx.moveCall({
                    target: `${packageId}::swap::entry_swap_y_for_x`,
                    typeArguments: [coinXType, coinYType],
                    arguments: [tx.object(poolId), inputCoinObject, tx.pure.u64(minOutRaw)],
                });
            }
            const result = await signAndExecute({ transaction: tx });
            onOutput({
                type: 'success',
                title: 'Token Swap Successful',
                data: JSON.stringify(result, null, 2),
                txDigest: result.digest,
            });
            setTimeout(syncAllData, 2000);
        }
        catch (error) {
            onOutput({
                type: 'error',
                title: 'Swap Failed',
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
    return (_jsxs("div", { className: "space-y-6", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { children: [_jsx("h2", { className: "text-lg font-bold", children: "AMM Token Swap" }), _jsx("p", { className: "text-xs text-gray-400", children: "Create Pools, Swap tokens, and Add/Remove liquidity on Sui Testnet" })] }), _jsx("button", { onClick: syncAllData, disabled: poolLoading, className: "rounded-lg bg-gray-800 px-3 py-1.5 text-xs font-semibold hover:bg-gray-700 disabled:opacity-50", children: poolLoading ? '⏳ Syncing...' : '🔄 Sync data' })] }), _jsxs("div", { className: "rounded-xl border border-gray-800 bg-gray-950 p-4 space-y-3", children: [_jsx("h3", { className: "text-xs font-bold uppercase tracking-wider text-gray-400", children: "Configuration" }), _jsxs("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-4", children: [_jsxs("div", { children: [_jsx("label", { className: "block text-[10px] font-semibold text-gray-400 uppercase mb-1", children: "Swap Package ID" }), _jsx("input", { type: "text", value: packageId, onChange: (e) => setPackageId(e.target.value.trim()), placeholder: "0x...", className: "w-full rounded-lg bg-gray-900 px-3 py-1.5 text-xs border border-gray-800 focus:outline-none" })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-[10px] font-semibold text-gray-400 uppercase mb-1", children: "Pool Shared Object ID" }), _jsx("input", { type: "text", value: poolId, onChange: (e) => setPoolId(e.target.value.trim()), placeholder: "0x...", className: "w-full rounded-lg bg-gray-900 px-3 py-1.5 text-xs border border-gray-800 focus:outline-none" }), recentPools.length > 0 && (_jsx("div", { className: "mt-1.5", children: _jsxs("select", { value: poolId, onChange: (e) => setPoolId(e.target.value), className: "w-full rounded bg-gray-900 px-2 py-1 text-[10px] border border-gray-800 text-gray-400 focus:outline-none font-mono", children: [_jsx("option", { value: "", children: "\uD83D\uDCC1 Select recent pool..." }), recentPools.map((p) => (_jsxs("option", { value: p, children: [p.slice(0, 12), "...", p.slice(-8)] }, p)))] }) }))] })] }), _jsxs("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-4", children: [_jsxs("div", { children: [_jsx("label", { className: "block text-[10px] font-semibold text-gray-400 uppercase mb-1", children: "SUI Coin Type" }), _jsx("input", { type: "text", value: coinXType, onChange: (e) => setCoinXType(e.target.value.trim()), placeholder: "0x2::sui::SUI", className: "w-full rounded-lg bg-gray-900 px-3 py-1.5 text-xs border border-gray-800 focus:outline-none font-mono" })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-[10px] font-semibold text-gray-400 uppercase mb-1", children: "dUSDC Coin Type" }), _jsx("input", { type: "text", value: coinYType, onChange: (e) => setCoinYType(e.target.value.trim()), placeholder: "0x...", className: "w-full rounded-lg bg-gray-900 px-3 py-1.5 text-xs border border-gray-800 focus:outline-none font-mono" })] })] })] }), _jsxs("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-4", children: [_jsxs("div", { className: "rounded-xl border border-gray-800 bg-gray-950 p-4 space-y-3", children: [_jsx("span", { className: "text-xs font-bold uppercase tracking-wider text-gray-400", children: "Your Wallet Balances" }), _jsxs("div", { className: "grid grid-cols-3 gap-2 text-xs", children: [_jsxs("div", { className: "rounded-lg bg-gray-900/40 p-2 border border-gray-800/50", children: [_jsx("div", { className: "text-[10px] text-gray-400 mb-0.5 font-medium font-semibold uppercase tracking-wider", children: "SUI Balance" }), _jsx("div", { className: "text-xs font-bold text-gray-100 font-mono", children: walletXBal })] }), _jsxs("div", { className: "rounded-lg bg-gray-900/40 p-2 border border-gray-800/50", children: [_jsx("div", { className: "text-[10px] text-gray-400 mb-0.5 font-medium font-semibold uppercase tracking-wider", children: "dUSDC Balance" }), _jsx("div", { className: "text-xs font-bold text-gray-100 font-mono", children: walletYBal })] }), _jsxs("div", { className: "rounded-lg bg-gray-900/40 p-2 border border-gray-800/50", children: [_jsx("div", { className: "text-[10px] text-gray-400 mb-0.5 font-medium font-semibold uppercase tracking-wider", children: "LP Balance" }), _jsxs("div", { className: "text-xs font-bold text-blue-400 font-mono", children: [walletLpBal, " LP"] })] })] })] }), _jsxs("div", { className: "rounded-xl border border-gray-800 bg-gray-950 p-4 space-y-3", children: [_jsx("span", { className: "text-xs font-bold uppercase tracking-wider text-gray-400", children: "Live Pool Reserves" }), poolReserves ? (_jsxs("div", { className: "grid grid-cols-3 gap-2 text-xs", children: [_jsxs("div", { className: "rounded-lg bg-gray-900/40 p-2 border border-gray-800/50", children: [_jsx("div", { className: "text-[10px] text-gray-400 mb-0.5 font-medium font-semibold uppercase tracking-wider", children: "Reserves (SUI / dUSDC)" }), _jsxs("div", { className: "text-xs font-bold text-gray-100 font-mono", children: [poolReserves.reserveX, " / ", poolReserves.reserveY] })] }), _jsxs("div", { className: "rounded-lg bg-gray-900/40 p-2 border border-gray-800/50", children: [_jsx("div", { className: "text-[10px] text-gray-400 mb-0.5 font-medium font-semibold uppercase tracking-wider", children: "Spot Rate" }), _jsxs("div", { className: "text-xs font-bold text-green-400 font-mono", children: ["1 SUI = ", poolReserves.spotPrice, " dUSDC"] })] }), _jsxs("div", { className: "rounded-lg bg-gray-900/40 p-2 border border-gray-800/50", children: [_jsx("div", { className: "text-[10px] text-gray-400 mb-0.5 font-medium font-semibold uppercase tracking-wider", children: "Pool LP Supply" }), _jsxs("div", { className: "text-xs font-bold text-blue-400 font-mono", children: [poolReserves.lpSupply, " LP"] })] })] })) : (_jsx("div", { className: "text-xs text-gray-500 py-3 text-center", children: "\u26A0\uFE0F Pool reserves not loaded. Ensure Pool ID is set." }))] })] }), _jsxs("div", { className: "rounded-xl border border-gray-800 bg-gray-900/30 p-4 space-y-3", children: [_jsxs("div", { children: [_jsx("h3", { className: "font-semibold text-sm mb-1 text-gray-200", children: "Initialize New Pool" }), _jsx("p", { className: "text-xs text-gray-400", children: "Deploy a new shared swap pool for the configured token types." })] }), _jsxs("div", { className: "flex gap-4 items-end", children: [_jsxs("div", { className: "flex-1", children: [_jsx("label", { className: "block text-[10px] font-semibold text-gray-400 uppercase mb-1", children: "Fee (Basis Points)" }), _jsx("input", { type: "number", value: feePct, onChange: (e) => setFeePct(e.target.value), placeholder: "e.g. 30", className: "w-full rounded-lg bg-gray-950 px-3 py-1.5 text-xs border border-gray-800 focus:outline-none" })] }), _jsx("button", { onClick: handleCreatePool, disabled: loading || !packageId || !feePct, className: "rounded-lg bg-blue-600 px-5 py-2 text-xs font-semibold hover:bg-blue-700 disabled:opacity-50 transition", children: "Create Shared Pool" })] })] }), _jsxs("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-4", children: [_jsxs("div", { className: "rounded-xl border border-gray-800 bg-gray-900/30 p-4 space-y-3", children: [_jsx("h3", { className: "font-semibold text-sm text-gray-200", children: "Add Liquidity" }), _jsxs("div", { className: "grid grid-cols-2 gap-3", children: [_jsxs("div", { children: [_jsx("label", { className: "block text-[10px] text-gray-400 uppercase mb-1", children: "SUI Amount" }), _jsx("input", { type: "number", value: addXAmount, onChange: (e) => setAddXAmount(e.target.value), className: "w-full rounded-lg bg-gray-950 px-3 py-1.5 text-xs border border-gray-800 focus:outline-none" })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-[10px] text-gray-400 uppercase mb-1", children: "dUSDC Amount" }), _jsx("input", { type: "number", value: addYAmount, onChange: (e) => setAddYAmount(e.target.value), className: "w-full rounded-lg bg-gray-950 px-3 py-1.5 text-xs border border-gray-800 focus:outline-none" })] })] }), _jsx("button", { onClick: handleAddLiquidity, disabled: loading || !poolId, className: "w-full rounded-lg bg-blue-600 py-2 text-xs font-semibold hover:bg-blue-700 disabled:opacity-50 transition", children: "Supply Liquidity" })] }), _jsxs("div", { className: "rounded-xl border border-gray-800 bg-gray-900/30 p-4 space-y-3", children: [_jsx("h3", { className: "font-semibold text-sm text-gray-200", children: "Remove Liquidity" }), _jsxs("div", { children: [_jsx("label", { className: "block text-[10px] text-gray-400 uppercase mb-1", children: "LP Tokens to Burn" }), _jsx("input", { type: "number", value: removeLpAmount, onChange: (e) => setRemoveLpAmount(e.target.value), placeholder: "1.0", className: "w-full rounded-lg bg-gray-950 px-3 py-1.5 text-xs border border-gray-800 focus:outline-none" })] }), _jsx("button", { onClick: handleRemoveLiquidity, disabled: loading || !poolId, className: "w-full rounded-lg bg-purple-600 py-2 text-xs font-semibold hover:bg-purple-700 disabled:opacity-50 transition", children: "Withdraw Liquidity" })] })] }), _jsxs("div", { className: "rounded-xl border border-gray-800 bg-gray-900/30 p-5 space-y-4 max-w-lg mx-auto", children: [_jsx("div", { className: "flex justify-between items-center", children: _jsxs("div", { children: [_jsx("h3", { className: "font-semibold text-sm text-gray-200", children: "Execute Swap" }), _jsx("p", { className: "text-xs text-gray-400", children: "Trade SUI and dUSDC instantly using constant product pricing." })] }) }), _jsxs("div", { className: "space-y-1 relative", children: [_jsxs("div", { className: "rounded-xl bg-gray-950 p-4 border border-gray-800/80 hover:border-gray-700 transition", children: [_jsxs("div", { className: "flex justify-between items-center text-[10px] text-gray-400 mb-1.5", children: [_jsx("span", { className: "font-medium", children: "You Pay" }), _jsxs("span", { children: ["Balance:", ' ', _jsx("span", { className: "font-mono text-gray-200", children: swapDirection === 'x_to_y' ? walletXBal : walletYBal })] })] }), _jsxs("div", { className: "flex justify-between items-center", children: [_jsx("input", { type: "number", value: swapAmount, onChange: (e) => setSwapAmount(e.target.value), placeholder: "0.0", className: "w-full bg-transparent text-xl font-bold text-gray-100 focus:outline-none placeholder-gray-650 font-mono" }), _jsx("div", { className: "flex items-center gap-1.5 bg-gray-900 border border-gray-800 rounded-full px-3 py-1 text-xs font-semibold select-none text-gray-200", children: _jsx("span", { children: swapDirection === 'x_to_y' ? '💧 SUI' : '💵 dUSDC' }) })] })] }), _jsx("div", { className: "flex justify-center -my-3.5 relative z-10", children: _jsx("button", { onClick: () => setSwapDirection((prev) => (prev === 'x_to_y' ? 'y_to_x' : 'x_to_y')), className: "w-8 h-8 rounded-full bg-gray-850 border border-gray-700 hover:border-gray-500 flex items-center justify-center text-gray-300 hover:text-white transition active:scale-90 shadow-md shadow-black/40 cursor-pointer text-xs", title: "Switch Direction", children: "\uD83D\uDD04" }) }), _jsxs("div", { className: "rounded-xl bg-gray-950 p-4 border border-gray-800/80 hover:border-gray-700 transition", children: [_jsxs("div", { className: "flex justify-between items-center text-[10px] text-gray-400 mb-1.5", children: [_jsx("span", { className: "font-medium", children: "You Receive (estimated)" }), _jsxs("span", { children: ["Balance:", ' ', _jsx("span", { className: "font-mono text-gray-200", children: swapDirection === 'x_to_y' ? walletYBal : walletXBal })] })] }), _jsxs("div", { className: "flex justify-between items-center", children: [_jsx("div", { className: "w-full bg-transparent text-xl font-bold text-gray-100 font-mono select-all", children: getEstimatedOutput() }), _jsx("div", { className: "flex items-center gap-1.5 bg-gray-900 border border-gray-800 rounded-full px-3 py-1 text-xs font-semibold select-none text-gray-200", children: _jsx("span", { children: swapDirection === 'x_to_y' ? '💵 dUSDC' : '💧 SUI' }) })] })] })] }), _jsxs("div", { className: "rounded-lg bg-gray-950/60 p-3 border border-gray-800/40 space-y-2 text-xs", children: [_jsxs("div", { className: "flex justify-between items-center", children: [_jsx("span", { className: "text-[11px] text-gray-400", children: "Max Slippage Tolerance:" }), _jsxs("div", { className: "flex items-center gap-1", children: [_jsx("input", { type: "number", value: slippage, onChange: (e) => setSlippage(e.target.value), placeholder: "1.0", className: "w-12 text-center rounded bg-gray-900 border border-gray-800 text-xs font-semibold py-0.5 text-gray-200 focus:outline-none" }), _jsx("span", { className: "text-gray-400", children: "%" })] })] }), _jsxs("div", { className: "flex justify-between items-center border-t border-gray-900 pt-2 text-[11px]", children: [_jsx("span", { className: "text-gray-400", children: "Minimum output guaranteed:" }), _jsxs("span", { className: "font-mono text-green-400 font-semibold", children: [minAmountOut, " ", swapDirection === 'x_to_y' ? 'dUSDC' : 'SUI'] })] })] }), _jsx("button", { onClick: handleSwap, disabled: loading || !poolId || parseFloat(swapAmount) <= 0, className: "w-full rounded-xl bg-gradient-to-r from-green-600 to-emerald-600 py-3 text-xs font-bold uppercase tracking-wider text-white hover:from-green-500 hover:to-emerald-500 disabled:opacity-50 disabled:from-green-600 disabled:to-emerald-600 transition shadow-lg shadow-green-950/10 cursor-pointer", children: loading ? '⏳ Executing Swap...' : swapDirection === 'x_to_y' ? 'Swap SUI for dUSDC' : 'Swap dUSDC for SUI' })] })] }));
}
//# sourceMappingURL=SwapPanel.js.map