import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { SuiClientProvider, WalletProvider } from "@mysten/dapp-kit"
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client"

import "@workspace/ui/globals.css"
import "@mysten/dapp-kit/dist/index.css"
import App from "./App.tsx"
import { ThemeProvider } from "@/components/theme-provider.tsx"

const queryClient = new QueryClient()

const networks = {
  testnet: new SuiClient({
    url: getFullnodeUrl("testnet"),
  }),
  mainnet: new SuiClient({
    url: getFullnodeUrl("mainnet"),
  }),
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
