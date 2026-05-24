import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc'

const client = new SuiJsonRpcClient({
  url: 'https://rpc.testnet.sui.io',
})

async function main() {
  const evts = await client.queryEvents({
    query: {
      MoveEventType: `0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138::registry::OracleCreated`,
    },
    limit: 2,
    order: 'descending',
  })
  console.log(JSON.stringify(evts.data, null, 2))
}

main()
