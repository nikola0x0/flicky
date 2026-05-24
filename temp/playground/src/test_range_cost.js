import { Transaction } from '@mysten/sui/transactions';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
const network = 'testnet';
const rpcUrl = 'https://rpc.testnet.sui.io';
const predictPackageId = '0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138';
const predictObjectId = '0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a';
const client = new SuiJsonRpcClient({ url: rpcUrl, network });
const parseU64 = (bytes) => {
    let val = 0n;
    for (let i = bytes.length - 1; i >= 0; i--) {
        val = (val << 8n) | BigInt(bytes[i]);
    }
    return val;
};
async function simulateRange(oracleId, expiryMs, lower, higher) {
    const lowerStrike = BigInt(lower) * 1000000000n;
    const higherStrike = BigInt(higher) * 1000000000n;
    const quantity = 1000000n; // 1.0 contract
    const tx = new Transaction();
    const rangeKey = tx.moveCall({
        target: `${predictPackageId}::range_key::new`,
        arguments: [
            tx.pure.id(oracleId),
            tx.pure.u64(expiryMs),
            tx.pure.u64(lowerStrike),
            tx.pure.u64(higherStrike),
        ],
    });
    tx.moveCall({
        target: `${predictPackageId}::predict::get_range_trade_amounts`,
        arguments: [
            tx.object(predictObjectId),
            tx.object(oracleId),
            rangeKey,
            tx.pure.u64(quantity),
            tx.object('0x6'),
        ],
    });
    const result = await client.devInspectTransactionBlock({
        sender: '0x30587ef36b6a19d78e752a374a5f67a140d6a5b5471ee3ed91ff953cdb9fb0fe',
        transactionBlock: tx,
    });
    const returnValues = result.results?.[1]?.returnValues;
    if (returnValues && returnValues.length >= 2) {
        const mintCostRaw = parseU64(returnValues[0][0]);
        const mintCost = Number(mintCostRaw) / 1e6;
        return mintCost;
    }
    throw new Error(`Failed to simulate range ${lower} - ${higher}`);
}
async function main() {
    try {
        const events = await client.queryEvents({
            query: {
                MoveEventType: `${predictPackageId}::oracle::OracleActivated`
            },
            order: 'descending',
            limit: 5
        });
        const oracleIds = Array.from(new Set(events.data.map(e => e.parsedJson.oracle_id)));
        const oracleId = oracleIds[0];
        const txInfo = new Transaction();
        txInfo.moveCall({
            target: `${predictPackageId}::oracle::spot_price`,
            arguments: [txInfo.object(oracleId)],
        });
        txInfo.moveCall({
            target: `${predictPackageId}::oracle::expiry`,
            arguments: [txInfo.object(oracleId)],
        });
        const infoResult = await client.devInspectTransactionBlock({
            sender: '0x30587ef36b6a19d78e752a374a5f67a140d6a5b5471ee3ed91ff953cdb9fb0fe',
            transactionBlock: txInfo,
        });
        const spotRaw = infoResult.results?.[0]?.returnValues?.[0]?.[0];
        const expiryRaw = infoResult.results?.[1]?.returnValues?.[0]?.[0];
        if (!spotRaw || !expiryRaw)
            return;
        const spotPrice = Number(parseU64(spotRaw)) / 1e9;
        const expiryMs = parseU64(expiryRaw);
        console.log(`Current Spot Price: $${spotPrice.toFixed(2)}`);
        console.log(`Expiry Date: ${new Date(Number(expiryMs)).toLocaleString()}`);
        // Ranges to test
        const testRanges = [
            { name: 'Narrow Range ($75,400 - $75,500)', lower: 75400, higher: 75500 },
            { name: 'Medium Range ($75,000 - $76,000)', lower: 75000, higher: 76000 },
            { name: 'Wide Range ($73,000 - $78,000)', lower: 73000, higher: 78000 }
        ];
        console.log('\nSimulating costs for multiple ranges on the active oracle on-chain...');
        for (const r of testRanges) {
            const cost = await simulateRange(oracleId, expiryMs, r.lower, r.higher);
            const netProfit = 1.0 - cost;
            const roi = (netProfit / cost) * 100;
            console.log(`\n=== ${r.name} ===`);
            console.log(`Mint Cost: ${cost.toFixed(6)} dUSDC`);
            console.log(`Net Profit: ${netProfit.toFixed(6)} dUSDC`);
            console.log(`ROI if won: ${roi.toFixed(2)}%`);
        }
    }
    catch (error) {
        console.error(error);
    }
}
main();
//# sourceMappingURL=test_range_cost.js.map