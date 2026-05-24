import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect } from 'react';
import { useCurrentAccount, useSignAndExecuteTransaction } from '@mysten/dapp-kit';
import { Transaction } from '@mysten/sui/transactions';
import { CONFIG, DUSDC_TYPE } from '../../config';
import { client } from '../../lib/client';
import { txCreateDuel, txJoinDuel, txRevealDeck, txSettleCard, txFinalizeDuel } from '../../lib/duel-txb';
import { buildMarketKey, txMint, readGetTradeAmounts } from '../../lib/predict-txb';
const getBalanceValue = (balanceField) => {
    if (balanceField === null || balanceField === undefined)
        return 0;
    if (typeof balanceField === 'string' || typeof balanceField === 'number') {
        return Number(balanceField);
    }
    if (typeof balanceField === 'object') {
        const val = balanceField.fields?.value ?? balanceField.value ?? 0;
        return Number(val);
    }
    return 0;
};
const getCoinDetails = (coinType) => {
    if (!coinType)
        return { symbol: 'COIN', decimals: 6 };
    if (coinType.endsWith('::SUI') || coinType === '0x2::sui::SUI') {
        return { symbol: 'SUI', decimals: 9 };
    }
    if (coinType.includes('::dusdc::DUSDC') || coinType.includes('DUSDC')) {
        return { symbol: 'dUSDC', decimals: 6 };
    }
    const parts = coinType.split('::');
    const symbol = parts[parts.length - 1] || 'COIN';
    return { symbol, decimals: 6 };
};
const snapToTick = (strike, minStrike, tickSize) => {
    if (strike < minStrike)
        return minStrike;
    return minStrike + ((strike - minStrike) / tickSize) * tickSize;
};
const parseU64 = (bytes) => {
    let val = 0n;
    for (let i = bytes.length - 1; i >= 0; i--) {
        val = (val << 8n) | BigInt(bytes[i]);
    }
    return val;
};
// BCS serialization helper for vector<Card>
function serializeDeck(cards) {
    const bytes = new Uint8Array(1 + cards.length * 40);
    bytes[0] = cards.length; // vector length prefix
    let offset = 1;
    for (const card of cards) {
        // Write oracleId (32 bytes)
        const cleanHex = card.oracleId.replace(/^0x/, '').padStart(64, '0');
        for (let i = 0; i < 32; i++) {
            bytes[offset + i] = parseInt(cleanHex.slice(i * 2, i * 2 + 2), 16);
        }
        offset += 32;
        // Write strike (u64 little-endian, 8 bytes)
        let temp = card.strike;
        for (let i = 0; i < 8; i++) {
            bytes[offset + i] = Number(temp & 0xffn);
            temp = temp >> 8n;
        }
        offset += 8;
    }
    return bytes;
}
async function computeSha256(bytes) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hashBuffer));
}
function toHex(bytes) {
    return '0x' + bytes.map(b => b.toString(16).padStart(2, '0')).join('');
}
export default function DuelPanel({ onOutput }) {
    const account = useCurrentAccount();
    const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
    // IDs
    const [duelId, setDuelId] = useState(() => {
        return localStorage.getItem('flicky_active_duel_id') || '';
    });
    const [duelCoinType, setDuelCoinType] = useState(() => {
        return DUSDC_TYPE(CONFIG.dusdcPackageId);
    });
    const [oracleId, setOracleId] = useState(CONFIG.marketOracleId);
    const [managerId, setManagerId] = useState(() => {
        return localStorage.getItem('flicky_predict_manager_id') || '';
    });
    // Staking
    const [stakeAmount, setStakeAmount] = useState('3'); // in dUSDC
    // Deck generation state
    const [generatedCards, setGeneratedCards] = useState([]);
    const [generatedHash, setGeneratedHash] = useState([]);
    // Duel on-chain state
    const [duelDetails, setDuelDetails] = useState(null);
    const [detailsLoading, setDetailsLoading] = useState(false);
    const [loading, setLoading] = useState(false);
    const [oraclesInfo, setOraclesInfo] = useState({});
    // Swipe inputs
    const [swipeCardIdx, setSwipeCardIdx] = useState(0);
    const [swipeIsUp, setSwipeIsUp] = useState(true);
    const [swipeQty, setSwipeQty] = useState('1'); // e.g. 1 contract (1,000,000 micro-dUSDC)
    // Settle & Finalize inputs
    const [settleCardIdx, setSettleCardIdx] = useState(0);
    // Save active duelId in localStorage
    useEffect(() => {
        localStorage.setItem('flicky_active_duel_id', duelId);
        if (duelId) {
            fetchDuelDetails();
        }
        else {
            setDuelDetails(null);
        }
    }, [duelId]);
    // Sync manager ID if changed in other panels
    useEffect(() => {
        const handleStorageChange = () => {
            setManagerId(localStorage.getItem('flicky_predict_manager_id') || '');
        };
        window.addEventListener('storage', handleStorageChange);
        return () => window.removeEventListener('storage', handleStorageChange);
    }, []);
    // Helper to query and filter 5 nearest active BTC oracles > 10 min out
    const findLatest5Oracles = async () => {
        const evts = await client.queryEvents({
            query: {
                MoveEventType: `${CONFIG.predictPackageId}::registry::OracleCreated`,
            },
            limit: 50,
            order: 'descending',
        });
        const candidates = [];
        const uniqueIds = new Set();
        const oracleGridMap = new Map();
        for (const e of evts.data) {
            const p = e.parsedJson;
            if (p.underlying_asset === 'BTC') {
                const id = p.oracle_id;
                if (!uniqueIds.has(id)) {
                    uniqueIds.add(id);
                    candidates.push(id);
                    oracleGridMap.set(id, {
                        minStrike: BigInt(p.min_strike ?? '0'),
                        tickSize: BigInt(p.tick_size ?? '1000000000') // default 1.0 (scaled by 1e9)
                    });
                }
            }
        }
        if (candidates.length === 0) {
            throw new Error('No BTC OracleCreated events found on Testnet.');
        }
        // Load candidate object details in batch
        const top = candidates.slice(0, 15);
        const objs = await client.multiGetObjects({
            ids: top,
            options: { showContent: true },
        });
        const nowMs = BigInt(Date.now());
        const eligible = [];
        for (let i = 0; i < objs.length; i++) {
            const obj = objs[i];
            if (obj.data?.content?.dataType !== 'moveObject')
                continue;
            const f = obj.data.content.fields;
            // Check if settled
            const settled = (typeof f.settlement_price === 'string' && f.settlement_price !== '0') ||
                (typeof f.settlement_price === 'object' &&
                    f.settlement_price !== null &&
                    (f.settlement_price.fields?.vec?.length ?? 0) > 0);
            const spot = BigInt(f.prices?.fields?.spot ?? '0');
            const forward = BigInt(f.prices?.fields?.forward ?? '0');
            const expiry = BigInt(f.expiry ?? '0');
            // Filter: active, priced, not settled, and expiry > now + 10 mins (600_000 ms)
            if (settled || !f.active || spot === 0n || forward === 0n)
                continue;
            if (expiry - nowMs < 600000n)
                continue;
            const objId = obj.data?.objectId;
            if (!objId)
                continue;
            const grid = oracleGridMap.get(objId) || { minStrike: 0n, tickSize: 1000000000n };
            eligible.push({
                id: objId,
                expiry,
                spot,
                minStrike: grid.minStrike,
                tickSize: grid.tickSize
            });
        }
        // Sort by expiry ascending (nearest first)
        eligible.sort((a, b) => (a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1 : 0));
        if (eligible.length < 5) {
            throw new Error(`Only found ${eligible.length} eligible oracles expiring >10 minutes from now (requires 5). Try waiting for DeepBook operator to publish new slots.`);
        }
        return eligible.slice(0, 5);
    };
    // Helper to retrieve and split staking coins
    const getStakeCoin = async (tx, amount, targetCoinType) => {
        if (!account)
            throw new Error('Wallet not connected');
        if (targetCoinType === '0x2::sui::SUI' || targetCoinType.endsWith('::SUI')) {
            const [splitSui] = tx.splitCoins(tx.gas, [tx.pure.u64(amount)]);
            return splitSui;
        }
        const coins = await client.getCoins({
            owner: account.address,
            coinType: targetCoinType
        });
        if (coins.data.length === 0) {
            const coinInfo = getCoinDetails(targetCoinType);
            throw new Error(`No ${coinInfo.symbol} coins found in your wallet. Please top up your wallet with ${coinInfo.symbol} first.`);
        }
        const totalBalance = coins.data.reduce((acc, c) => acc + BigInt(c.balance), 0n);
        if (totalBalance < amount) {
            const coinInfo = getCoinDetails(targetCoinType);
            throw new Error(`Insufficient ${coinInfo.symbol} balance. Required: ${Number(amount) / (10 ** coinInfo.decimals)} ${coinInfo.symbol}, Available: ${Number(totalBalance) / (10 ** coinInfo.decimals)} ${coinInfo.symbol}`);
        }
        const [primary, ...rest] = coins.data.map(c => tx.object(c.coinObjectId));
        if (rest.length > 0) {
            tx.mergeCoins(primary, rest);
        }
        const [stakeCoin] = tx.splitCoins(primary, [tx.pure.u64(amount)]);
        return stakeCoin;
    };
    // Generate 5-card deck strikes from 5 different active oracles
    const handleGenerateDeck = async () => {
        setLoading(true);
        try {
            const oracles = await findLatest5Oracles();
            const cards = oracles.map(o => {
                const snappedStrike = snapToTick(o.spot, o.minStrike, o.tickSize);
                return {
                    oracleId: o.id,
                    strike: snappedStrike,
                    expiry: o.expiry
                };
            });
            const serialized = serializeDeck(cards);
            const hash = await computeSha256(serialized);
            setGeneratedCards(cards);
            setGeneratedHash(hash);
            // Save generated deck in localStorage (stringified to prevent BigInt serialization issues)
            const deckToStore = cards.map(c => ({
                oracleId: c.oracleId,
                strike: c.strike.toString(),
                expiry: c.expiry ? c.expiry.toString() : undefined
            }));
            localStorage.setItem(`flicky_generated_deck_${hash.join(',')}`, JSON.stringify(deckToStore));
            onOutput({
                type: 'success',
                title: 'Deck Generated Successfully',
                data: `Deck Hash: ${toHex(hash)}\n\nSerialized bytes (BCS): ${Array.from(serialized).join(', ')}\n\nCards Selected:\n` +
                    cards.map((c, i) => `Card ${i}: Oracle ${c.oracleId.slice(0, 10)}... (Strike: ${Number(c.strike) / 1e9}, Expiry: ${new Date(Number(c.expiry)).toLocaleTimeString()})`).join('\n')
            });
        }
        catch (err) {
            onOutput({
                type: 'error',
                title: 'Failed to Generate Deck',
                data: err.message || String(err)
            });
        }
        finally {
            setLoading(false);
        }
    };
    // Fetch Duel Details from on-chain
    const fetchDuelDetails = async () => {
        if (!duelId || !duelId.startsWith('0x'))
            return;
        setDetailsLoading(true);
        try {
            const res = await client.getObject({
                id: duelId,
                options: { showContent: true }
            });
            const content = res.data?.content;
            if (content && content.fields) {
                setDuelDetails(content.fields);
                const objType = res.data?.type || '';
                const match = objType.match(/::duel::Duel<([^>]+)>/);
                const extractedCoinType = match ? match[1] : DUSDC_TYPE(CONFIG.dusdcPackageId);
                setDuelCoinType(extractedCoinType);
                // If stake details exist, update state
                if (content.fields.p0_stake) {
                    const coinInfo = getCoinDetails(extractedCoinType);
                    const rawVal = getBalanceValue(content.fields.p0_stake);
                    const val = rawVal / (10 ** coinInfo.decimals);
                    setStakeAmount(val.toString());
                }
                // Fetch oracle objects for each card
                if (content.fields.cards && content.fields.cards.length > 0) {
                    const oracleIds = content.fields.cards.map((c) => c.fields.oracle_id);
                    const oracleObjects = await client.multiGetObjects({
                        ids: oracleIds,
                        options: { showContent: true }
                    });
                    const infoMap = {};
                    oracleObjects.forEach((obj) => {
                        if (obj.data && obj.data.content) {
                            const fields = obj.data.content.fields;
                            const isSettled = fields.settlement_price?.fields?.vec?.length > 0 || fields.settlement_price?.fields?.vec?.[0] !== undefined;
                            let settlementPrice = null;
                            if (fields.settlement_price?.fields?.vec && fields.settlement_price.fields.vec.length > 0) {
                                settlementPrice = (Number(fields.settlement_price.fields.vec[0]) / 1e9).toFixed(2);
                            }
                            const spotPrice = fields.prices?.fields?.spot ? (Number(fields.prices.fields.spot) / 1e9).toFixed(2) : '0';
                            const expiry = Number(fields.expiry || 0);
                            const isActive = fields.active;
                            let statusText = 'Active';
                            if (isSettled) {
                                statusText = 'Settled';
                            }
                            else if (Date.now() >= expiry) {
                                statusText = 'Pending Settlement';
                            }
                            else if (!isActive) {
                                statusText = 'Inactive';
                            }
                            infoMap[obj.data.objectId] = {
                                isSettled,
                                settlementPrice,
                                spotPrice,
                                expiry,
                                status: statusText
                            };
                        }
                    });
                    setOraclesInfo(infoMap);
                }
            }
            else {
                setDuelDetails(null);
            }
        }
        catch (err) {
            console.error('Failed to fetch duel details:', err);
            setDuelDetails(null);
        }
        finally {
            setDetailsLoading(false);
        }
    };
    // Action: Create Duel
    const handleCreateDuel = async () => {
        if (!account)
            return;
        setLoading(true);
        try {
            const coinType = DUSDC_TYPE(CONFIG.dusdcPackageId);
            const coinInfo = getCoinDetails(coinType);
            const parsedStake = BigInt(Math.floor(parseFloat(stakeAmount) * (10 ** coinInfo.decimals)));
            const tx = new Transaction();
            const stakeCoin = await getStakeCoin(tx, parsedStake, coinType);
            txCreateDuel(tx, stakeCoin, generatedHash, coinType);
            const result = await signAndExecute({
                transaction: tx,
            });
            // Fetch transaction details to get object changes (wait until indexed)
            const txData = await client.waitForTransaction({
                digest: result.digest,
                options: { showObjectChanges: true }
            });
            // Extract new Duel object ID from effects
            const objectChanges = txData.objectChanges || [];
            const createdObj = objectChanges.find((change) => change.type === 'created' &&
                change.objectType.includes('::duel::Duel<'));
            if (createdObj) {
                setDuelId(createdObj.objectId);
                // Store current deck under this duel ID
                const deckToStore = generatedCards.map(c => ({
                    oracleId: c.oracleId,
                    strike: c.strike.toString(),
                    expiry: c.expiry ? c.expiry.toString() : undefined
                }));
                localStorage.setItem(`flicky_duel_deck_${createdObj.objectId}`, JSON.stringify(deckToStore));
            }
            onOutput({
                type: 'success',
                title: 'Duel Created Successfully',
                data: `Created Duel Object ID: ${createdObj?.objectId || 'Not found in tx effects'}\n\nStaked: ${stakeAmount} ${coinInfo.symbol}\nDeck Hash: ${toHex(generatedHash)}`,
                txDigest: result.digest
            });
            setTimeout(fetchDuelDetails, 1500);
        }
        catch (err) {
            onOutput({
                type: 'error',
                title: 'Create Duel Failed',
                data: err.message || String(err)
            });
        }
        finally {
            setLoading(false);
        }
    };
    // Action: Join Duel
    const handleJoinDuel = async () => {
        if (!account || !duelId)
            return;
        setLoading(true);
        try {
            const coinType = duelCoinType;
            const coinInfo = getCoinDetails(coinType);
            const parsedStake = BigInt(Math.floor(parseFloat(stakeAmount) * (10 ** coinInfo.decimals)));
            const tx = new Transaction();
            const stakeCoin = await getStakeCoin(tx, parsedStake, coinType);
            txJoinDuel(tx, duelId, stakeCoin, coinType);
            const result = await signAndExecute({
                transaction: tx,
            });
            onOutput({
                type: 'success',
                title: 'Joined Duel Successfully',
                data: `Successfully joined duel ${duelId} with stake ${stakeAmount} ${coinInfo.symbol}`,
                txDigest: result.digest
            });
            setTimeout(fetchDuelDetails, 1500);
        }
        catch (err) {
            onOutput({
                type: 'error',
                title: 'Join Duel Failed',
                data: err.message || String(err)
            });
        }
        finally {
            setLoading(false);
        }
    };
    // Action: Reveal Deck
    const handleRevealDeck = async () => {
        if (!account || !duelId)
            return;
        setLoading(true);
        try {
            // Attempt to load cards from state or localStorage
            let cards = generatedCards;
            if (cards.length === 0) {
                // Fallback: look up using saved keys
                const localDeck = localStorage.getItem(`flicky_duel_deck_${duelId}`);
                if (localDeck) {
                    const parsed = JSON.parse(localDeck);
                    cards = parsed.map(c => ({
                        oracleId: c.oracleId,
                        strike: BigInt(c.strike),
                        expiry: c.expiry ? BigInt(c.expiry) : undefined
                    }));
                }
                else if (duelDetails?.deck_hash) {
                    // Look up by deck hash
                    const hashString = duelDetails.deck_hash.join(',');
                    const hashDeck = localStorage.getItem(`flicky_generated_deck_${hashString}`);
                    if (hashDeck) {
                        const parsed = JSON.parse(hashDeck);
                        cards = parsed.map(c => ({
                            oracleId: c.oracleId,
                            strike: BigInt(c.strike),
                            expiry: c.expiry ? BigInt(c.expiry) : undefined
                        }));
                    }
                }
            }
            if (cards.length === 0) {
                throw new Error('No locally saved deck coordinates found for this duel. Generate a new deck or make sure you are using the same browser session.');
            }
            const tx = new Transaction();
            txRevealDeck(tx, duelId, cards, duelCoinType);
            const result = await signAndExecute({
                transaction: tx,
            });
            onOutput({
                type: 'success',
                title: 'Deck Revealed Successfully',
                data: `Revealed deck to duel ${duelId}:\n` +
                    cards.map((c, i) => `Card ${i}: Oracle ${c.oracleId.slice(0, 10)}..., Strike: ${Number(c.strike) / 1e9}`).join('\n'),
                txDigest: result.digest
            });
            setTimeout(fetchDuelDetails, 1500);
        }
        catch (err) {
            onOutput({
                type: 'error',
                title: 'Reveal Deck Failed',
                data: err.message || String(err)
            });
        }
        finally {
            setLoading(false);
        }
    };
    // Action: Record Swipe
    const handleRecordSwipe = async () => {
        if (!account || !duelId)
            return;
        if (!managerId) {
            onOutput({
                type: 'error',
                title: 'Validation Error',
                data: 'PredictManager ID is missing. Build one in the Manager tab first.',
            });
            return;
        }
        setLoading(true);
        try {
            const parsedQty = BigInt(Math.floor(parseFloat(swipeQty) * 1_000_000)); // Scaled quantity
            // Find the card to swipe
            let activeOracle = oracleId;
            let activeStrike = 1000n;
            if (duelDetails && duelDetails.cards && duelDetails.cards[swipeCardIdx]) {
                activeOracle = duelDetails.cards[swipeCardIdx].fields.oracle_id;
                activeStrike = BigInt(duelDetails.cards[swipeCardIdx].fields.strike);
            }
            else {
                const localCard = generatedCards[swipeCardIdx];
                if (localCard) {
                    activeOracle = localCard.oracleId;
                    activeStrike = localCard.strike;
                }
            }
            // 1. Fetch oracle details to get expiry if not locally available
            let expiryVal = 0n;
            const cardObj = generatedCards.find(c => c.oracleId === activeOracle);
            if (cardObj && cardObj.expiry) {
                expiryVal = cardObj.expiry;
            }
            else {
                const obj = await client.getObject({
                    id: activeOracle,
                    options: { showContent: true }
                });
                const expStr = obj.data?.content?.fields?.expiry;
                if (!expStr) {
                    throw new Error(`Failed to read expiry from oracle object ${activeOracle}`);
                }
                expiryVal = BigInt(expStr);
            }
            // 2. Estimate premium cost via get_trade_amounts devInspect
            onOutput({
                type: 'info',
                title: 'Pricing Preview',
                data: 'Querying on-chain premium price for swipe...'
            });
            const inspectTx = new Transaction();
            const mkInspect = buildMarketKey(inspectTx, activeOracle, expiryVal, activeStrike, swipeIsUp);
            readGetTradeAmounts(inspectTx, activeOracle, mkInspect, parsedQty);
            const inspectResult = await client.devInspectTransactionBlock({
                sender: account.address,
                transactionBlock: inspectTx,
            });
            if (inspectResult.error) {
                throw new Error(`devInspect failed: ${inspectResult.error}`);
            }
            if (inspectResult.effects?.status?.status === 'failure') {
                throw new Error(`On-chain dry-run reverted: ${inspectResult.effects.status.error}`);
            }
            const returnValues = inspectResult.results?.[1]?.returnValues;
            if (!returnValues || returnValues.length === 0) {
                throw new Error('Failed to query estimated premium from DeepBook Predict on-chain pricing (empty return values)');
            }
            const mintCostRaw = parseU64(returnValues[0][0]);
            const premiumVal = mintCostRaw;
            // 3. Build and execute atomic PTB
            const realTx = new Transaction();
            const mkReal = buildMarketKey(realTx, activeOracle, expiryVal, activeStrike, swipeIsUp);
            txMint(realTx, managerId, activeOracle, mkReal, parsedQty, DUSDC_TYPE(CONFIG.dusdcPackageId));
            realTx.moveCall({
                target: `${CONFIG.flickyPackageId}::duel::record_swipe`,
                typeArguments: [duelCoinType],
                arguments: [
                    realTx.object(duelId),
                    realTx.object(managerId),
                    realTx.object(activeOracle),
                    realTx.pure.u64(BigInt(swipeCardIdx)),
                    realTx.pure.bool(swipeIsUp),
                    realTx.pure.u64(parsedQty),
                    realTx.pure.u64(premiumVal),
                    realTx.object(CONFIG.CLOCK_ID)
                ]
            });
            const result = await signAndExecute({
                transaction: realTx,
            });
            onOutput({
                type: 'success',
                title: 'Swipe Recorded Successfully',
                data: `Recorded swipe for Card ${swipeCardIdx}:\nDirection: ${swipeIsUp ? 'UP' : 'DOWN'}\nQuantity: ${swipeQty} contracts\nPremium Paid: ${Number(premiumVal) / 1e6} dUSDC`,
                txDigest: result.digest
            });
            setTimeout(fetchDuelDetails, 1500);
        }
        catch (err) {
            onOutput({
                type: 'error',
                title: 'Record Swipe Failed',
                data: err.message || String(err)
            });
        }
        finally {
            setLoading(false);
        }
    };
    // Action: Settle Card
    const handleSettleCard = async () => {
        if (!account || !duelId)
            return;
        setLoading(true);
        try {
            // Find the card oracle to settle
            let activeOracle = oracleId;
            if (duelDetails && duelDetails.cards && duelDetails.cards[settleCardIdx]) {
                activeOracle = duelDetails.cards[settleCardIdx].fields.oracle_id;
            }
            const tx = new Transaction();
            txSettleCard(tx, duelId, activeOracle, settleCardIdx, duelCoinType);
            const result = await signAndExecute({
                transaction: tx,
            });
            onOutput({
                type: 'success',
                title: `Card ${settleCardIdx} Settled Successfully`,
                data: `Successfully settled card ${settleCardIdx} utilizing Oracle ${activeOracle}`,
                txDigest: result.digest
            });
            setTimeout(fetchDuelDetails, 1500);
        }
        catch (err) {
            onOutput({
                type: 'error',
                title: 'Settle Card Failed',
                data: err.message || String(err)
            });
        }
        finally {
            setLoading(false);
        }
    };
    // Action: Finalize Duel
    const handleFinalizeDuel = async () => {
        if (!account || !duelId)
            return;
        setLoading(true);
        try {
            const tx = new Transaction();
            txFinalizeDuel(tx, duelId, duelCoinType);
            const result = await signAndExecute({
                transaction: tx,
            });
            onOutput({
                type: 'success',
                title: 'Duel Finalized Successfully',
                data: `Duel ${duelId} finalized. Payouts distributed and complete.`,
                txDigest: result.digest
            });
            setTimeout(fetchDuelDetails, 1500);
        }
        catch (err) {
            onOutput({
                type: 'error',
                title: 'Finalize Duel Failed',
                data: err.message || String(err)
            });
        }
        finally {
            setLoading(false);
        }
    };
    // Render status helper
    const getStatusText = (status) => {
        switch (status) {
            case 1: return _jsx("span", { className: "rounded bg-yellow-950 px-2.5 py-1 text-xs font-semibold text-yellow-300", children: "PENDING JOIN" });
            case 2: return _jsx("span", { className: "rounded bg-blue-950 px-2.5 py-1 text-xs font-semibold text-blue-300", children: "ACTIVE PLAY" });
            case 3: return _jsx("span", { className: "rounded bg-green-950 px-2.5 py-1 text-xs font-semibold text-green-300", children: "COMPLETE" });
            default: return _jsx("span", { className: "rounded bg-gray-800 px-2.5 py-1 text-xs font-semibold text-gray-400", children: "UNKNOWN" });
        }
    };
    return (_jsxs("div", { className: "space-y-6", children: [_jsxs("div", { children: [_jsx("h2", { className: "text-xl font-bold text-gray-50 flex items-center gap-2", children: "\u2694\uFE0F Flicky Duel Panel" }), _jsx("p", { className: "mt-1 text-sm text-gray-400", children: "Create, play, settle, and finalize 5-card prediction matches" })] }), !account && (_jsx("div", { className: "rounded border border-red-900 bg-red-950/30 p-4 text-sm text-red-200", children: "Please connect your wallet to start testing the Duel functions." })), _jsxs("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-4", children: [_jsxs("div", { className: "space-y-4 rounded-lg border border-gray-800 bg-gray-900/50 p-4", children: [_jsx("h3", { className: "text-sm font-semibold text-gray-300 border-b border-gray-800 pb-2", children: "Configurations" }), _jsxs("div", { children: [_jsx("label", { className: "block text-xs font-medium text-gray-400", children: "Duel ID" }), _jsx("input", { type: "text", value: duelId, onChange: (e) => setDuelId(e.target.value.trim()), placeholder: "0x...", className: "mt-1 w-full rounded border border-gray-800 bg-gray-950 px-3 py-2 text-sm focus:border-blue-600 focus:outline-none" })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-xs font-medium text-gray-400", children: "PredictManager ID (Staker)" }), _jsx("input", { type: "text", value: managerId, onChange: (e) => {
                                            setManagerId(e.target.value.trim());
                                            localStorage.setItem('flicky_predict_manager_id', e.target.value.trim());
                                        }, placeholder: "0x...", className: "mt-1 w-full rounded border border-gray-800 bg-gray-950 px-3 py-2 text-sm focus:border-blue-600 focus:outline-none" })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-xs font-medium text-gray-400", children: "Oracle ID (For Deck Gen)" }), _jsx("input", { type: "text", value: oracleId, onChange: (e) => setOracleId(e.target.value.trim()), placeholder: "0x...", className: "mt-1 w-full rounded border border-gray-800 bg-gray-950 px-3 py-2 text-sm focus:border-blue-600 focus:outline-none" })] })] }), _jsxs("div", { className: "space-y-3 rounded-lg border border-gray-800 bg-gray-900/50 p-4", children: [_jsxs("div", { className: "flex items-center justify-between border-b border-gray-800 pb-2", children: [_jsx("h3", { className: "text-sm font-semibold text-gray-300", children: "Active Duel Status" }), _jsx("button", { onClick: fetchDuelDetails, disabled: detailsLoading || !duelId, className: "rounded bg-gray-800 px-2 py-1 text-xs font-medium text-gray-200 hover:bg-gray-700 disabled:opacity-50", children: detailsLoading ? 'Refreshing...' : '🔄 Refresh' })] }), duelDetails ? (_jsxs("div", { className: "space-y-2 text-xs", children: [_jsxs("div", { className: "flex justify-between", children: [_jsx("span", { className: "text-gray-400", children: "Status:" }), _jsx("span", { children: getStatusText(duelDetails.status) })] }), _jsxs("div", { className: "flex justify-between", children: [_jsx("span", { className: "text-gray-400", children: "Creator (P0):" }), _jsxs("span", { className: "font-mono text-[10px]", title: duelDetails.creator, children: [duelDetails.creator.slice(0, 10), "..."] })] }), _jsxs("div", { className: "flex justify-between", children: [_jsx("span", { className: "text-gray-400", children: "Challenger (P1):" }), _jsx("span", { className: "font-mono text-[10px]", title: duelDetails.challenger, children: duelDetails.challenger === '0x0000000000000000000000000000000000000000000000000000000000000000' ? 'None yet' : `${duelDetails.challenger.slice(0, 10)}...` })] }), _jsxs("div", { className: "flex justify-between", children: [_jsx("span", { className: "text-gray-400", children: "P0 Stake:" }), _jsxs("span", { children: [getBalanceValue(duelDetails.p0_stake) / (10 ** getCoinDetails(duelCoinType).decimals), ' ', getCoinDetails(duelCoinType).symbol] })] }), _jsxs("div", { className: "flex justify-between", children: [_jsx("span", { className: "text-gray-400", children: "P1 Stake:" }), _jsxs("span", { children: [getBalanceValue(duelDetails.p1_stake) / (10 ** getCoinDetails(duelCoinType).decimals), ' ', getCoinDetails(duelCoinType).symbol] })] }), _jsxs("div", { className: "flex justify-between", children: [_jsx("span", { className: "text-gray-400", children: "Swipes Progress:" }), _jsxs("span", { children: ["P0: ", duelDetails.p0_next_card_idx, "/5 | P1: ", duelDetails.p1_next_card_idx, "/5"] })] }), _jsxs("div", { className: "flex justify-between", children: [_jsx("span", { className: "text-gray-400", children: "Settled count:" }), _jsxs("span", { children: [duelDetails.settled_count, "/5 cards"] })] }), duelDetails.cards && duelDetails.cards.length > 0 && (_jsxs("div", { className: "border-t border-gray-800 pt-2 mt-2 space-y-2", children: [_jsx("span", { className: "text-gray-400 block mb-1 font-medium", children: "Deck Cards & Oracle Status:" }), _jsx("div", { className: "space-y-2", children: duelDetails.cards.map((c, i) => {
                                                    const oracleId = c.fields.oracle_id;
                                                    const strike = (Number(c.fields.strike) / 1e9).toFixed(2);
                                                    const settled = duelDetails.card_settlements[i] && duelDetails.card_settlements[i].fields?.vec?.length > 0;
                                                    const info = oraclesInfo[oracleId];
                                                    const expiryTime = info?.expiry ? new Date(info.expiry).toLocaleString() : 'Loading...';
                                                    const status = info?.status || 'Loading...';
                                                    const settlementPrice = info?.settlementPrice ? `$${info.settlementPrice}` : 'N/A';
                                                    const spotPrice = info?.spotPrice ? `$${info.spotPrice}` : 'N/A';
                                                    let statusBadge = (_jsx("span", { className: "rounded bg-gray-850 px-1.5 py-0.5 text-[9px] font-mono text-gray-400", children: status }));
                                                    if (settled || status === 'Settled') {
                                                        statusBadge = (_jsxs("span", { className: "rounded bg-green-950 px-1.5 py-0.5 text-[9px] font-mono text-green-400 border border-green-900", children: ["Settled (", settlementPrice, ")"] }));
                                                    }
                                                    else if (status === 'Pending Settlement') {
                                                        statusBadge = (_jsxs("span", { className: "rounded bg-yellow-950 px-1.5 py-0.5 text-[9px] font-mono text-yellow-400 border border-yellow-900 animate-pulse", children: ["Awaiting Settle (Spot: ", spotPrice, ")"] }));
                                                    }
                                                    else if (status === 'Active') {
                                                        statusBadge = (_jsxs("span", { className: "rounded bg-blue-950 px-1.5 py-0.5 text-[9px] font-mono text-blue-400 border border-blue-900", children: ["Active (Spot: ", spotPrice, ")"] }));
                                                    }
                                                    return (_jsxs("div", { className: "flex flex-col sm:flex-row sm:items-center justify-between p-2.5 rounded border border-gray-800 bg-gray-950/40 gap-2", children: [_jsxs("div", { className: "flex items-center gap-3", children: [_jsx("span", { className: "flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gray-800 text-[10px] font-bold text-gray-300", children: i }), _jsxs("div", { className: "space-y-0.5 text-left", children: [_jsxs("div", { className: "flex flex-wrap items-center gap-2", children: [_jsxs("span", { className: "font-semibold text-gray-200", children: ["Card ", i, " (Strike: $", strike, ")"] }), statusBadge] }), _jsxs("span", { className: "block text-[10px] text-gray-500 font-mono truncate max-w-[280px]", title: oracleId, children: ["Oracle: ", oracleId] })] })] }), _jsxs("div", { className: "text-left sm:text-right text-[10px] text-gray-400 font-mono", children: [_jsx("span", { className: "block text-gray-500 text-[9px] uppercase tracking-wider font-bold", children: "Expiry" }), _jsx("span", { children: expiryTime })] })] }, i));
                                                }) })] }))] })) : (_jsx("div", { className: "flex h-32 items-center justify-center text-xs text-gray-500", children: "No active duel object loaded. Put a Duel ID above to fetch." }))] })] }), _jsxs("div", { className: "space-y-4", children: [_jsxs("div", { className: "rounded-lg border border-gray-800 bg-gray-900/30 p-4 space-y-4", children: [_jsxs("div", { className: "flex items-center gap-2 border-b border-gray-800 pb-2", children: [_jsx("span", { className: "flex h-5 w-5 items-center justify-center rounded-full bg-blue-600 text-xs font-bold text-white", children: "1" }), _jsx("h4", { className: "text-sm font-semibold text-gray-200", children: "Start Duel (Create or Join)" })] }), _jsxs("div", { className: "grid grid-cols-1 sm:grid-cols-2 gap-4", children: [_jsxs("div", { className: "space-y-3", children: [_jsxs("span", { className: "text-xs font-medium text-gray-400 block", children: ["Staking Amount (", getCoinDetails(duelCoinType).symbol, ")"] }), _jsx("input", { type: "number", step: "1", value: stakeAmount, onChange: (e) => setStakeAmount(e.target.value), className: "w-full rounded border border-gray-800 bg-gray-950 px-3 py-1.5 text-sm focus:border-blue-600 focus:outline-none" }), _jsxs("div", { className: "flex gap-2", children: [_jsx("button", { onClick: handleGenerateDeck, disabled: loading, className: "flex-1 rounded bg-blue-700 px-3 py-2 text-xs font-medium text-white hover:bg-blue-600 disabled:opacity-50 transition", children: "\uD83C\uDFB2 Generate Deck Hash" }), _jsx("button", { onClick: handleCreateDuel, disabled: loading || generatedHash.length === 0, className: "flex-1 rounded bg-green-700 px-3 py-2 text-xs font-medium text-white hover:bg-green-600 disabled:opacity-50 transition", children: "\u2694\uFE0F Create Duel" })] })] }), _jsxs("div", { className: "flex flex-col justify-end", children: [_jsx("div", { className: "rounded bg-gray-950 p-3 text-xs text-gray-400 border border-gray-850 h-[84px] overflow-y-auto mb-2", children: generatedHash.length > 0 ? (_jsxs("div", { children: [_jsx("span", { className: "text-green-400 font-semibold", children: "Deck ready!" }), _jsxs("span", { className: "block truncate mt-1", children: ["Hash: ", toHex(generatedHash)] }), _jsxs("span", { className: "block mt-0.5 text-[10px]", children: ["Strikes: ", generatedCards.map(c => (Number(c.strike) / 1e9).toFixed(2)).join(', ')] })] })) : (_jsx("span", { children: "Click \"Generate Deck Hash\" to create a fresh 5-card deck of strikes based on the selected Oracle's price." })) }), _jsx("button", { onClick: handleJoinDuel, disabled: loading || !duelId, className: "w-full rounded bg-gray-800 px-3 py-2 text-xs font-medium text-gray-100 hover:bg-gray-700 disabled:opacity-50 border border-gray-700 transition", children: "\uD83E\uDD1D Join Existing Duel" })] })] })] }), _jsxs("div", { className: "rounded-lg border border-gray-800 bg-gray-900/30 p-4 space-y-3", children: [_jsxs("div", { className: "flex items-center gap-2 border-b border-gray-800 pb-2", children: [_jsx("span", { className: "flex h-5 w-5 items-center justify-center rounded-full bg-blue-600 text-xs font-bold text-white", children: "2" }), _jsx("h4", { className: "text-sm font-semibold text-gray-200", children: "Reveal Deck (Active State)" })] }), _jsxs("p", { className: "text-xs text-gray-400", children: ["Once both players have joined, the duel status becomes ", _jsx("span", { className: "text-blue-400 font-semibold", children: "ACTIVE" }), ". The creator must reveal the card coordinates matching the deck hash submitted in Step 1."] }), _jsx("button", { onClick: handleRevealDeck, disabled: loading || !duelId || (duelDetails && duelDetails.status !== 2) || (duelDetails && duelDetails.cards && duelDetails.cards.length > 0), className: "w-full rounded bg-indigo-700 px-3 py-2 text-xs font-medium text-white hover:bg-indigo-600 disabled:opacity-50 transition", children: "\uD83D\uDD13 Reveal Generated Deck to On-chain Duel" })] }), _jsxs("div", { className: "rounded-lg border border-gray-800 bg-gray-900/30 p-4 space-y-3", children: [_jsxs("div", { className: "flex items-center gap-2 border-b border-gray-800 pb-2", children: [_jsx("span", { className: "flex h-5 w-5 items-center justify-center rounded-full bg-blue-600 text-xs font-bold text-white", children: "3" }), _jsx("h4", { className: "text-sm font-semibold text-gray-200", children: "Submit Player Swipes" })] }), _jsx("p", { className: "text-xs text-gray-400", children: "Submit a prediction for a card. The active wallet context acts as the player. You must own a PredictManager holding enough contracts." }), _jsxs("div", { className: "grid grid-cols-2 sm:grid-cols-4 gap-3", children: [_jsxs("div", { children: [_jsx("label", { className: "block text-[10px] font-medium text-gray-400", children: "Card Index (0-4)" }), _jsxs("select", { value: swipeCardIdx, onChange: (e) => setSwipeCardIdx(Number(e.target.value)), className: "mt-1 w-full rounded border border-gray-800 bg-gray-950 px-2 py-1 text-xs focus:border-blue-600 focus:outline-none", children: [_jsx("option", { value: 0, children: "Card 0" }), _jsx("option", { value: 1, children: "Card 1" }), _jsx("option", { value: 2, children: "Card 2" }), _jsx("option", { value: 3, children: "Card 3" }), _jsx("option", { value: 4, children: "Card 4" })] })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-[10px] font-medium text-gray-400", children: "Prediction" }), _jsxs("select", { value: swipeIsUp ? 'up' : 'down', onChange: (e) => setSwipeIsUp(e.target.value === 'up'), className: "mt-1 w-full rounded border border-gray-800 bg-gray-950 px-2 py-1 text-xs focus:border-blue-600 focus:outline-none", children: [_jsx("option", { value: "up", children: "\uD83D\uDFE2 UP" }), _jsx("option", { value: "down", children: "\uD83D\uDD34 DOWN" })] })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-[10px] font-medium text-gray-400", children: "Quantity (Contracts)" }), _jsx("input", { type: "number", value: swipeQty, onChange: (e) => setSwipeQty(e.target.value), className: "mt-1 w-full rounded border border-gray-800 bg-gray-950 px-2 py-1 text-xs focus:border-blue-600 focus:outline-none" })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-[10px] font-medium text-gray-400", children: "Premium Cost (dUSDC)" }), _jsx("input", { type: "text", value: "Auto-Calculated", disabled: true, className: "mt-1 w-full rounded border border-gray-800 bg-gray-900 px-2 py-1 text-xs text-gray-400 cursor-not-allowed font-medium focus:outline-none" })] })] }), _jsx("button", { onClick: handleRecordSwipe, disabled: loading || !duelId || !managerId || (duelDetails && duelDetails.status !== 2), className: "w-full rounded bg-cyan-700 px-3 py-2 text-xs font-medium text-white hover:bg-cyan-600 disabled:opacity-50 transition", children: "\u270D\uFE0F Record Swipe" })] }), _jsxs("div", { className: "rounded-lg border border-gray-800 bg-gray-900/30 p-4 space-y-3", children: [_jsxs("div", { className: "flex items-center gap-2 border-b border-gray-800 pb-2", children: [_jsx("span", { className: "flex h-5 w-5 items-center justify-center rounded-full bg-blue-600 text-xs font-bold text-white", children: "4" }), _jsx("h4", { className: "text-sm font-semibold text-gray-200", children: "Settle & Finalize" })] }), _jsx("p", { className: "text-xs text-gray-400", children: "After the oracle expiry timestamp, individual cards can be settled. Once all 5 cards are settled, finalize the duel to trigger payouts." }), _jsxs("div", { className: "grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1", children: [_jsxs("div", { className: "flex gap-2 items-end", children: [_jsxs("div", { className: "flex-1", children: [_jsx("label", { className: "block text-[10px] font-medium text-gray-400", children: "Card to Settle (0-4)" }), _jsx("select", { value: settleCardIdx, onChange: (e) => setSettleCardIdx(Number(e.target.value)), className: "mt-1 w-full rounded border border-gray-800 bg-gray-950 px-2 py-1.5 text-xs focus:border-blue-600 focus:outline-none", children: [0, 1, 2, 3, 4].map((idx) => {
                                                            const card = duelDetails?.cards?.[idx];
                                                            const oId = card?.fields?.oracle_id;
                                                            const info = oId ? oraclesInfo[oId] : null;
                                                            const statusStr = info?.status ? ` (${info.status})` : '';
                                                            return (_jsxs("option", { value: idx, children: ["Card ", idx, statusStr] }, idx));
                                                        }) })] }), _jsx("button", { onClick: handleSettleCard, disabled: loading || !duelId || (duelDetails && duelDetails.status !== 2), className: "rounded bg-teal-700 px-4 py-1.5 text-xs font-medium text-white hover:bg-teal-600 disabled:opacity-50 transition", children: "\u2696\uFE0F Settle Card" })] }), _jsx("div", { className: "flex items-end", children: _jsx("button", { onClick: handleFinalizeDuel, disabled: loading || !duelId || (duelDetails && duelDetails.status !== 2) || (duelDetails && duelDetails.settled_count < 5), className: "w-full rounded bg-purple-700 px-3 py-2 text-xs font-medium text-white hover:bg-purple-600 disabled:opacity-50 transition", children: "\uD83C\uDFC6 Finalize Payouts (Requires 5 settled cards)" }) })] })] })] })] }));
}
//# sourceMappingURL=DuelPanel.js.map