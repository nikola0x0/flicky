# zkLogin + Sponsored Gas — integration plan

> Status: **not yet implemented**. This doc describes the wiring needed
> to satisfy PRD §Identity, wallet, money flow ("zkLogin + sponsored gas
> — load-bearing, not optional").

Two PRD requirements are coupled:

1. **zkLogin** — player signs in with Google/Apple OAuth; the OIDC token
   is exchanged for a zk proof that lets a derived Sui address sign txns
   without an extension wallet.
2. **Sponsored gas** — the player's wallet only ever holds dUSDC.
   Every PTB they sign (create_duel, join_duel, swipe, etc.) is gas-paid
   by a server-held sponsor wallet, so they never need SUI.

Both are blocked on external setup the developer has to do once.

## What's missing

| Piece | Owner | Blocker |
|---|---|---|
| Google OAuth client id | dev | register at <https://console.cloud.google.com/apis/credentials>, allowed redirect = your dev URL |
| Mysten Enoki app registration | dev | sign in at <https://portal.enoki.mystenlabs.com>, create an app, copy the API key. Enoki is free for testnet, paid for mainnet at scale. |
| Sponsor wallet on testnet | dev | generate a new Ed25519 keypair, fund with ~5 SUI from the testnet faucet |
| Web zkLogin UI | code | replace `<ConnectButton />` with `<EnokiConnectButton />` and pass the Enoki API key + Google client id through `EnokiFlowProvider` |
| Server `/sponsor` endpoint | code | accepts a player-built PTB (unsigned), uses the sponsor wallet to sign the gas portion, returns the sponsor signature + serialized payload |
| Web sponsored-tx flow | code | client wraps every signing call: build PTB → POST to `/sponsor` → receive sponsor signature → ask player to sign sender part → submit the combined tx |

## Sketch — server `/sponsor`

```ts
// apps/server/src/index.ts (additions)
import { Transaction } from "@mysten/sui/transactions"
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"

const sponsor = (() => {
  const key = process.env.SPONSOR_SECRET_KEY
  if (!key) return null
  const { secretKey } = decodeSuiPrivateKey(key)
  return Ed25519Keypair.fromSecretKey(secretKey)
})()

// POST /sponsor  { txBytes: base64, sender: address }
//   → { sponsorSignature, txBytes (with gas set) }
if (url.pathname === "/sponsor" && req.method === "POST") {
  if (!sponsor) return json({ error: "sponsor not configured" }, 503)
  const { txBytes, sender } = await req.json()
  const tx = Transaction.from(Buffer.from(txBytes, "base64"))
  tx.setSender(sender)
  tx.setGasOwner(sponsor.toSuiAddress())
  // ...select gas coins owned by sponsor, set gas budget, then sign
  const built = await tx.build({ client })
  const sig = await sponsor.signTransaction(built)
  return json({
    sponsorSignature: sig.signature,
    txBytes: Buffer.from(built).toString("base64"),
  })
}
```

The player then signs `built` with their zkLogin keypair and submits both
signatures together to a fullnode.

## Sketch — web `lib/sponsor.ts`

```ts
export async function sponsoredSignAndExecute(
  tx: Transaction,
  client: SuiJsonRpcClient,
  signer: Signer, // zkLogin signer from @mysten/enoki
) {
  const txBytes = await tx.build({ client, onlyTransactionKind: true })
  const res = await fetch(`${SPONSOR_URL}/sponsor`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      txBytes: btoa(String.fromCharCode(...new Uint8Array(txBytes))),
      sender: signer.toSuiAddress(),
    }),
  })
  const { sponsorSignature, txBytes: sponsoredBytes } = await res.json()
  const decoded = Uint8Array.from(atob(sponsoredBytes), c => c.charCodeAt(0))
  const senderSig = await signer.signTransaction(decoded)
  return client.executeTransactionBlock({
    transactionBlock: decoded,
    signature: [sponsorSignature, senderSig.signature],
  })
}
```

## Sketch — web zkLogin UI

```tsx
// apps/web/src/main.tsx
import { EnokiFlowProvider } from "@mysten/enoki/react"

createRoot(...).render(
  <EnokiFlowProvider apiKey={import.meta.env.VITE_ENOKI_API_KEY}>
    <SuiClientProvider ...>
      <WalletProvider zkLogin={{
        providers: ["google"],
        clientIds: { google: import.meta.env.VITE_GOOGLE_CLIENT_ID },
      }} autoConnect>
        ...
```

The existing `<ConnectButton />` automatically offers "Sign in with
Google" when zkLogin providers are configured.

## Env additions when wired

```bash
# apps/web/.env.local
VITE_ENOKI_API_KEY=enoki_apikey_…
VITE_GOOGLE_CLIENT_ID=…apps.googleusercontent.com
VITE_SPONSOR_URL=http://localhost:3001

# apps/server/.env.local
SPONSOR_SECRET_KEY=suiprivkey1q…
```

## Why this isn't shipped yet

The actual code changes are bounded (~150 LOC across two files + one
new lib file). The blocker is the external account setup: registering
the Enoki app + Google OAuth client takes about 15 minutes but needs
the dev to be the one signing into Google's console.

To ship: the user provides the env values above, then I can wire the
last 150 LOC + verify end-to-end. Until then, the existing dapp-kit
`<ConnectButton />` flow with browser wallet extensions covers the
demo.
