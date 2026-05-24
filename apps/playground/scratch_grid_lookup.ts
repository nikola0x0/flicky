import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc'

const client = new SuiJsonRpcClient({
  url: 'https://rpc.testnet.sui.io',
})

async function main() {
  const tableId = '0x14902bc703f699b81095b43009fa35f26206a9ad8a181ef1fd67d464e1bceb49'
  const oracleId = '0x067d16dcb437d09045dfb7b671b16341b03c16358331fac5b5a8614856fa1c33'

  try {
    const res = await client.getDynamicFieldObject({
      parentId: tableId,
      name: {
        type: '0x2::object::ID',
        value: oracleId
      }
    })
    console.log(JSON.stringify(res.data, null, 2))
  } catch (err) {
    console.error(err)
  }
}

main()
