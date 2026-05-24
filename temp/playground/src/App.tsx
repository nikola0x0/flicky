import { useState } from 'react'
import { useCurrentAccount } from '@mysten/dapp-kit'
import WalletBar from './components/WalletBar'
import OutputPanel from './components/OutputPanel'
import ManagerPanel from './components/panels/ManagerPanel'
import TradingPanel from './components/panels/TradingPanel'
import LPPanel from './components/panels/LPPanel'
import KeeperPanel from './components/panels/KeeperPanel'
import OraclePanel from './components/panels/OraclePanel'
import SwapPanel from './components/panels/SwapPanel'

type Panel = 'manager' | 'trading' | 'lp' | 'keeper' | 'oracle' | 'swap'

interface PanelOutput {
  type: 'success' | 'error' | 'info'
  title: string
  data: string
  txDigest?: string
}

export default function App() {
  const account = useCurrentAccount()
  const [activePanel, setActivePanel] = useState<Panel>('manager')
  const [output, setOutput] = useState<PanelOutput | null>(null)

  const panels: Record<Panel, { label: string; icon: string }> = {
    manager: { label: 'Manager', icon: '🗃️' },
    trading: { label: 'Trading', icon: '💹' },
    lp: { label: 'LP', icon: '💰' },
    keeper: { label: 'Keeper', icon: '🔧' },
    oracle: { label: 'Oracle', icon: '🔭' },
    swap: { label: 'Swap', icon: '🔄' },
  }

  return (
    <div className="flex h-screen flex-col bg-gray-950 text-gray-50">
      {/* Header */}
      <header className="border-b border-gray-800 bg-gray-900 px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">
              🔬 DeepBook Predict Playground
            </h1>
            <p className="mt-1 text-sm text-gray-400">
              Test all DeepBook Predict functions on testnet
            </p>
          </div>
          <WalletBar />
        </div>
      </header>

      {/* Main Content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside className="w-48 border-r border-gray-800 bg-gray-900 p-4">
          <nav className="space-y-2">
            {(Object.entries(panels) as [Panel, (typeof panels)[Panel]][]).map(
              ([key, { label, icon }]) => (
                <button
                  key={key}
                  onClick={() => setActivePanel(key)}
                  className={`w-full rounded px-3 py-2 text-left text-sm font-medium transition ${
                    activePanel === key
                      ? 'bg-blue-600 text-white'
                      : 'text-gray-300 hover:bg-gray-800'
                  }`}
                >
                  {icon} {label}
                </button>
              )
            )}
          </nav>

          {!account && (
            <div className="mt-8 rounded bg-red-950 p-3 text-xs text-red-200">
              ⚠️ Connect your wallet to use these functions
            </div>
          )}
        </aside>

        {/* Content Area */}
        <div className="flex flex-1 gap-4 overflow-hidden p-6">
          {/* Left Panel: Function Inputs */}
          <div className="flex-1 overflow-y-auto rounded border border-gray-800 bg-gray-900 p-6">
            {activePanel === 'manager' && (
              <ManagerPanel onOutput={setOutput} />
            )}
            {activePanel === 'trading' && (
              <TradingPanel onOutput={setOutput} />
            )}
            {activePanel === 'lp' && <LPPanel onOutput={setOutput} />}
            {activePanel === 'keeper' && <KeeperPanel onOutput={setOutput} />}
            {activePanel === 'oracle' && <OraclePanel onOutput={setOutput} />}
            {activePanel === 'swap' && <SwapPanel onOutput={setOutput} />}
          </div>

          {/* Right Panel: Output */}
          <div className="w-96 overflow-hidden rounded border border-gray-800 bg-gray-900">
            <OutputPanel output={output} />
          </div>
        </div>
      </div>
    </div>
  )
}
