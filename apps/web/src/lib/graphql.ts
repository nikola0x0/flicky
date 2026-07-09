/**
 * GraphQL RPC client for filtered event queries (DuelCreated,
 * PredictManagerCreated, registry::OracleCreated). gRPC has no
 * filtered/paginated event API yet, so reads that used the deprecated
 * `client.queryEvents` go through GraphQL instead.
 *
 * Kept standalone (not in `lib/dapp-kit.ts`) so the read helpers that
 * import it stay free of the React provider — `dapp-kit.ts` calls
 * `createDAppKit` at module load, which touches browser-only wallet APIs
 * and would break `bun test src/lib`. This module only pulls in
 * `@mysten/sui/graphql`.
 *
 * Memoized — one client shared across the app. Override the endpoint via
 * `VITE_SUI_GRAPHQL_URL`.
 */
import { SuiGraphQLClient } from "@mysten/sui/graphql"

type Network = "testnet" | "mainnet"

const NETWORK: Network = (import.meta.env.VITE_SUI_NETWORK ??
  "testnet") as Network

const GRAPHQL_URLS: Record<Network, string> = {
  testnet:
    import.meta.env.VITE_SUI_GRAPHQL_URL ??
    "https://graphql.testnet.sui.io/graphql",
  mainnet: "https://graphql.mainnet.sui.io/graphql",
}

let _gql: SuiGraphQLClient | null = null

export function getGraphQLClient(): SuiGraphQLClient {
  if (_gql) return _gql
  _gql = new SuiGraphQLClient({ url: GRAPHQL_URLS[NETWORK], network: NETWORK })
  return _gql
}
