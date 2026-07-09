import { useEffect } from "react"
import { useCurrentClient } from "@mysten/dapp-kit-react"
import { registerEnokiWallets } from "@mysten/enoki"

/**
 * Registers Enoki-backed zkLogin wallets (Google, etc.) into the
 * wallet-standard registry so they appear in dapp-kit's useWallets().
 * Lives inside <DAppKitProvider> so it has access to the active gRPC
 * client via useCurrentClient(). Renders nothing.
 *
 * No-op when env vars are missing — keeps the build from breaking in
 * environments without the Enoki keys.
 */
export function EnokiWalletsRegistrar() {
  const client = useCurrentClient()
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
