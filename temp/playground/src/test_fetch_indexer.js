import { client } from './lib/client';
async function testFetchIndexer() {
    const pkgId = '0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138';
    try {
        console.log('Querying PredictManagerCreated events...');
        const events = await client.queryEvents({
            query: {
                MoveEventType: `${pkgId}::predict_manager::PredictManagerCreated`,
            },
            order: 'descending',
            limit: 10,
        });
        console.log(`Found ${events.data.length} managers.`);
        for (const evt of events.data) {
            const managerId = evt.parsedJson?.manager_id;
            const owner = evt.parsedJson?.owner;
            if (!managerId)
                continue;
            console.log(`\nManager: ${managerId} (Owner: ${owner})`);
            const url = `https://predict-server.testnet.mystenlabs.com/managers/${managerId}/positions/summary`;
            try {
                const res = await fetch(url);
                if (res.ok) {
                    const data = await res.json();
                    console.log(`Indexer Response for ${managerId}:`);
                    console.log(JSON.stringify(data, null, 2));
                }
                else {
                    console.log(`Indexer returned ${res.status} for ${managerId}`);
                }
            }
            catch (err) {
                console.error(`Failed to fetch from indexer for ${managerId}:`, err.message);
            }
        }
    }
    catch (err) {
        console.error('Error:', err.message);
    }
}
testFetchIndexer();
//# sourceMappingURL=test_fetch_indexer.js.map