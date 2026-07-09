/**
 * dApp Kit v2 instance — the single source of the Sui client for the whole
 * app. Built on gRPC (`SuiGrpcClient`), NOT the deprecated JSON-RPC transport:
 * testnet's public JSON-RPC endpoint was decommissioned in the Sui gRPC
 * migration (full sunset ~July 2026), so `client.core.*` over gRPC is the only
 * working read/tx path. GraphQL RPC (added separately) handles filtered event
 * queries.
 *
 * `createClient` is called lazily once per network and the instances are
 * cached inside dApp Kit — never construct a `SuiGrpcClient` in component code;
 * read it via `useCurrentClient()` so network switching keeps working.
 *
 * gRPC + GraphQL share the same testnet host that 404s JSON-RPC (different
 * protocol on `:443`). Override per-deploy via `VITE_SUI_GRPC_URL`.
 */
import { createDAppKit } from "@mysten/dapp-kit-react"
import { SuiGrpcClient } from "@mysten/sui/grpc"
import { enokiWalletsInitializer } from "@mysten/enoki"

const GRPC_URLS: Record<string, string> = {
  testnet:
    import.meta.env.VITE_SUI_GRPC_URL ?? "https://fullnode.testnet.sui.io:443",
  mainnet: "https://fullnode.mainnet.sui.io:443",
}

// Register the Enoki zkLogin wallets (Google, …) as a dApp Kit wallet
// initializer — NOT in a post-mount useEffect. Initializers run as part of
// createDAppKit, so the Enoki wallet exists BEFORE autoConnect fires; a
// useEffect registers too late and autoConnect can't restore the session,
// which is why reloads were logging the user out. dApp Kit hands the
// initializer the active network + gRPC client via `initialize`, so no
// client/network is passed here. No-op when the Enoki keys are absent.
const enokiApiKey = import.meta.env.VITE_ENOKI_API_KEY
const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID
const walletInitializers =
  enokiApiKey && googleClientId
    ? [
        enokiWalletsInitializer({
          apiKey: enokiApiKey,
          providers: {
            google: {
              clientId: googleClientId,
              // One fixed callback URL regardless of which route "Sign In"
              // was clicked from. The popup lands here, Enoki reads the
              // response, then closes it — the parent tab never navigates.
              redirectUrl: `${window.location.origin}/auth/callback`,
            },
          },
        }),
      ]
    : []

export const dAppKit = createDAppKit({
  networks: ["testnet", "mainnet"],
  defaultNetwork: "testnet",
  autoConnect: true,
  walletInitializers,
  createClient: (network) =>
    new SuiGrpcClient({ network, baseUrl: GRPC_URLS[network] }),
})

// Hooks (useCurrentClient, useDAppKit, …) infer the instance type from this
// augmentation — no need to pass `dAppKit` to each hook. React-only.
declare module "@mysten/dapp-kit-react" {
  interface Register {
    dAppKit: typeof dAppKit
  }
}
