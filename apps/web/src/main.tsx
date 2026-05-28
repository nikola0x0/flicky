import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { createBrowserRouter, RouterProvider, Navigate } from "react-router"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { SuiClientProvider, WalletProvider } from "@mysten/dapp-kit"
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc"

import "@workspace/ui/globals.css"
import "@mysten/dapp-kit/dist/index.css"
import { ThemeProvider } from "@/components/theme-provider.tsx"
import { EnokiWalletsRegistrar } from "@/components/enoki-wallets-registrar.tsx"
import Landing from "@/routes/landing.tsx"
import AuthCallback from "@/routes/auth-callback.tsx"
import Profile from "@/routes/profile.tsx"
import GameLayout from "@/routes/game/layout.tsx"
import GameHome from "@/routes/game/home.tsx"
import GamePvp from "@/routes/game/pvp.tsx"
import DuelView from "@/routes/game/duel-view.tsx"
import GameShop from "@/routes/game/shop.tsx"
import GameComingSoon from "@/routes/game/coming-soon.tsx"

const router = createBrowserRouter([
  { path: "/", element: <Landing /> },
  { path: "/auth/callback", element: <AuthCallback /> },
  { path: "/profile", element: <Profile /> },
  {
    path: "/game",
    element: <GameLayout />,
    children: [
      { index: true, element: <Navigate to="/game/home" replace /> },
      { path: "home", element: <GameHome /> },
      { path: "pvp", element: <GamePvp /> },
      { path: "duel/:duelId", element: <DuelView /> },
      { path: "practice", element: <GameComingSoon /> },
      { path: "shop", element: <GameShop /> },
      { path: "rank", element: <GameComingSoon /> },
      { path: "inventory", element: <GameComingSoon /> },
    ],
  },
])

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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider defaultTheme="dark">
      <QueryClientProvider client={queryClient}>
        <SuiClientProvider networks={networks} defaultNetwork="testnet">
          <EnokiWalletsRegistrar />
          <WalletProvider autoConnect>
            <RouterProvider router={router} />
          </WalletProvider>
        </SuiClientProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
)
