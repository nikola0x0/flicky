import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc'
import { CONFIG } from '../config'

export const client = new SuiJsonRpcClient({
  url: CONFIG.rpcUrl,
  network: CONFIG.network,
})

export const getSuiClient = () => client

export const parseResult = (
  returnValues: Array<Array<number>> | null | undefined
): string | null => {
  if (!returnValues || returnValues.length === 0) {
    return null
  }

  try {
    const bytes = new Uint8Array(returnValues[0])
    const decoder = new TextDecoder()
    return decoder.decode(bytes)
  } catch {
    return null
  }
}
