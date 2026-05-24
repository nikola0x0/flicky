import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc'

const client = new SuiJsonRpcClient({
  url: 'https://rpc.testnet.sui.io',
})

async function main() {
  const obj = await client.getObject({
    id: '0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a',
    options: { showContent: true }
  })
  console.log(JSON.stringify(obj.data, null, 2))
}

main()
