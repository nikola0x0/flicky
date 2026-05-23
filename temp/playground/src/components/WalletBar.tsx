import { useCurrentAccount, useDisconnectWallet } from '@mysten/dapp-kit'
import { ConnectButton } from '@mysten/dapp-kit'

export default function WalletBar() {
  const account = useCurrentAccount()
  const { mutate: disconnect } = useDisconnectWallet()

  if (!account) {
    return <ConnectButton />
  }

  return (
    <div className="flex items-center gap-4">
      <div className="rounded bg-gray-800 px-3 py-2 text-sm">
        <div className="text-gray-400">Connected as</div>
        <div className="font-mono text-xs">
          {account.address.slice(0, 6)}...
          {account.address.slice(-4)}
        </div>
      </div>
      <button
        onClick={() => disconnect()}
        className="rounded bg-red-600 px-3 py-2 text-sm font-medium hover:bg-red-700"
      >
        Disconnect
      </button>
    </div>
  )
}
