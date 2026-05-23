"use strict";
async function fetchMoveFunction(moduleName, functionName) {
    const rpcUrl = 'https://rpc.testnet.sui.io';
    const predictPackageId = '0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138';
    const body = {
        jsonrpc: '2.0',
        id: 1,
        method: 'sui_getNormalizedMoveFunction',
        params: [predictPackageId, moduleName, functionName],
    };
    const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const json = await response.json();
    if (json.error) {
        console.error(`Error for ${moduleName}::${functionName}:`, json.error);
    }
    else {
        console.log(`\n=== Signature for ${moduleName}::${functionName} ===`);
        console.log(JSON.stringify(json.result, null, 2));
    }
}
async function main() {
    await fetchMoveFunction('predict', 'redeem_permissionless');
    await fetchMoveFunction('predict', 'redeem_compacted_permissionless');
}
main();
//# sourceMappingURL=inspect_package.js.map