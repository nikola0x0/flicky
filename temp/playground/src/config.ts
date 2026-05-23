/// <reference types="vite/client" />

export const CONFIG = {
  // Network
  network: (import.meta.env.VITE_NETWORK as 'testnet' | 'mainnet') || 'testnet',
  rpcUrl:
    import.meta.env.VITE_RPC_URL ||
    'https://rpc.testnet.sui.io',

  // DeepBook Predict
  predictPackageId: import.meta.env.VITE_PREDICT_PACKAGE_ID || '',
  registryId: import.meta.env.VITE_REGISTRY_ID || '',
  predictObjectId: import.meta.env.VITE_PREDICT_OBJECT_ID || '',

  // Oracle & Pyth
  marketOracleId: import.meta.env.VITE_MARKET_ORACLE_ID || '',
  pythSourceId: import.meta.env.VITE_PYTH_SOURCE_ID || '',

  // dUSDC
  dusdcPackageId: import.meta.env.VITE_DUSDC_PACKAGE_ID || '',

  // Constants
  CLOCK_ID: '0x6',
  ONE_E9: 1_000_000_000n,
  U64_MAX: 18446744073709551615n,

  // NEG_INF and POS_INF for RangeKey
  NEG_INF_STRIKE: 0n,
  POS_INF_STRIKE: 18446744073709551615n,
} as const

export const DUSDC_TYPE = (packageId: string) => {
  if (packageId.includes('::')) return packageId
  return `${packageId}::dusdc::DUSDC`
}

export const PLPCoin = (packageId: string) => {
  if (packageId.includes('::')) return packageId
  return `${packageId}::plp::PLP`
}

export const getModuleAddress = (target: string) => {
  const parts = target.split('::')
  return parts[0]
}
