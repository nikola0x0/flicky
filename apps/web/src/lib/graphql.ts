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
 * Memoized — one client shared across the app. The endpoint follows the
 * active network (`CONFIG.graphqlUrl`), overridable per network via
 * `VITE_SUI_GRAPHQL_URL` / `VITE_SUI_GRAPHQL_URL_MAINNET`.
 */
import { SuiGraphQLClient } from "@mysten/sui/graphql"

import { CONFIG } from "@/lib/config"

let _gql: SuiGraphQLClient | null = null

export function getGraphQLClient(): SuiGraphQLClient {
  if (_gql) return _gql
  _gql = new SuiGraphQLClient({
    url: CONFIG.graphqlUrl,
    network: CONFIG.network,
  })
  return _gql
}
