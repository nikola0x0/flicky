import { StrictMode, useEffect } from "react"
import { createRoot } from "react-dom/client"
import { createBrowserRouter, RouterProvider, Navigate } from "react-router"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  SuiClientProvider,
  WalletProvider,
  useSuiClient,
} from "@mysten/dapp-kit"
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc"
import { registerEnokiWallets } from "@mysten/enoki"

import "@workspace/ui/globals.css"
import "@mysten/dapp-kit/dist/index.css"
import { ThemeProvider } from "@/components/theme-provider.tsx"
import Landing from "@/routes/landing.tsx"
import AuthCallback from "@/routes/auth-callback.tsx"
import Profile from "@/routes/profile.tsx"
import GameLayout from "@/routes/game/layout.tsx"
import GameHome from "@/routes/game/home.tsx"
import GamePvp from "@/routes/game/pvp.tsx"
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

/**
 * Registers Enoki-backed zkLogin wallets (Google, etc.) into the
 * wallet-standard registry so they appear in dapp-kit's useWallets().
 * Lives inside <SuiClientProvider> so it has access to the SuiClient
 * via useSuiClient(). Renders nothing.
 *
 * No-op when env vars are missing — keeps the build from breaking in
 * environments without the Enoki keys.
 */
function EnokiWalletsRegistrar() {
  const client = useSuiClient()
  useEffect(() => {
    const apiKey = import.meta.env.VITE_ENOKI_API_KEY
    const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID
    if (!apiKey || !googleClientId) return
    const { unregister } = registerEnokiWallets({
      apiKey,
      providers: {
        google: {
          clientId: googleClientId,
          // Pin every OAuth flow to one callback URL regardless of which
          // route the user clicked "Sign In" from. The popup briefly
          // lands here after Google redirects, then Enoki reads the
          // response from popup.location and closes it — the parent
          // tab never navigates.
          redirectUrl: `${window.location.origin}/auth/callback`,
        },
      },
      client,
      network: "testnet",
    })
    return unregister
  }, [client])
  return null
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
