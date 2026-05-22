import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { SuiClientProvider, WalletProvider } from "@mysten/dapp-kit"
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc"
import { registerEnokiWallets } from "@mysten/enoki"

import "@workspace/ui/globals.css"
import "@mysten/dapp-kit/dist/index.css"
import App from "./App.tsx"
import { ThemeProvider } from "@/components/theme-provider.tsx"

const queryClient = new QueryClient()

const networks = {
  testnet: new SuiJsonRpcClient({
    url: getJsonRpcFullnodeUrl("testnet"),
    network: "testnet",
  }),
  mainnet: new SuiJsonRpcClient({
    url: getJsonRpcFullnodeUrl("mainnet"),
    network: "mainnet",
  }),
}

// Register Enoki zkLogin wallets into the wallet-standard registry so they
// surface in dapp-kit's `useWallets()` alongside extension wallets. Gated
// by VITE_ENOKI_API_KEY — without it, the app just shows native wallets.
//
// VITE_GOOGLE_CLIENT_ID / VITE_FACEBOOK_CLIENT_ID configure which OAuth
// providers appear. Each requires a registered OAuth client (Google
// console, etc.) with this app's URL in the allowed redirect list.
const enokiApiKey = import.meta.env.VITE_ENOKI_API_KEY
if (enokiApiKey) {
  const providers: Record<string, { clientId: string }> = {}
  const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID
  const facebookClientId = import.meta.env.VITE_FACEBOOK_CLIENT_ID
  if (googleClientId) providers.google = { clientId: googleClientId }
  if (facebookClientId) providers.facebook = { clientId: facebookClientId }
  if (Object.keys(providers).length > 0) {
    registerEnokiWallets({
      apiKey: enokiApiKey,
      providers,
      clients: [networks.testnet, networks.mainnet],
      getCurrentNetwork: () => "testnet",
    })
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider defaultTheme="dark">
      <QueryClientProvider client={queryClient}>
        <SuiClientProvider networks={networks} defaultNetwork="testnet">
          <WalletProvider autoConnect>
            <App />
          </WalletProvider>
        </SuiClientProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
)
