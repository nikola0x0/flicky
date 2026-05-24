import { useState, useEffect } from 'react'
import { useCurrentAccount } from '@mysten/dapp-kit'
import WalletBar from './components/WalletBar'
import OutputPanel from './components/OutputPanel'
import ManagerPanel from './components/panels/ManagerPanel'
import TradingPanel from './components/panels/TradingPanel'
import LPPanel from './components/panels/LPPanel'
import KeeperPanel from './components/panels/KeeperPanel'
import OraclePanel from './components/panels/OraclePanel'
import SwapPanel from './components/panels/SwapPanel'
import DuelPanel from './components/panels/DuelPanel'
import ChatPanel from './components/panels/ChatPanel'
import E2EFlowPanel from './components/panels/E2EFlowPanel'

type Panel = 'e2e' | 'manager' | 'trading' | 'lp' | 'keeper' | 'oracle' | 'swap' | 'chat'

interface PanelOutput {
  type: 'success' | 'error' | 'info'
  title: string
  data: string
  txDigest?: string
}

export default function App() {
  const account = useCurrentAccount()
  const [activePanel, setActivePanel] = useState<Panel>('e2e')
  const [output, setOutput] = useState<PanelOutput | null>(null)

  // Custom router state
  const [pathname, setPathname] = useState(window.location.pathname)

  useEffect(() => {
    const handlePopState = () => {
      setPathname(window.location.pathname)
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  const navigate = (to: string) => {
    window.history.pushState({}, '', to)
    setPathname(to)
  }

  const panels: Record<Panel, { label: string; icon: string }> = {
    e2e: { label: 'E2E Demo', icon: '🎯' },
    manager: { label: 'Manager', icon: '🗃️' },
    trading: { label: 'Trading', icon: '💹' },
    lp: { label: 'LP', icon: '💰' },
    keeper: { label: 'Keeper', icon: '🔧' },
    oracle: { label: 'Oracle', icon: '🔭' },
    swap: { label: 'Swap', icon: '🔄' },
    chat: { label: 'Chat / WS', icon: '💬' },
  }

  const isDuelPage = pathname === '/duel' || pathname.endsWith('/duel')

  if (isDuelPage) {
    return (
      <div className="flex h-screen flex-col bg-gray-950 text-gray-50">
        {/* Header */}
        <header className="border-b border-gray-800 bg-gray-900 px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <button
                onClick={() => navigate('/')}
                className="rounded bg-gray-850 border border-gray-700 px-3 py-1.5 text-xs font-semibold text-gray-300 hover:bg-gray-850 hover:text-white transition cursor-pointer"
              >
                ⬅️ Back to Playground
              </button>
              <div>
                <h1 className="text-xl font-bold flex items-center gap-2">
                  ⚔️ Flicky Duel Arena
                </h1>
                <p className="mt-0.5 text-xs text-gray-400">
                  Test dUSDC Staked 5-Card Duels
                </p>
              </div>
            </div>
            <WalletBar />
          </div>
        </header>

        {/* Main Content */}
        <div className="flex flex-1 overflow-hidden p-6 gap-4">
          {/* Main Panel */}
          <div className="flex-1 overflow-y-auto rounded border border-gray-800 bg-gray-900 p-6">
            <DuelPanel onOutput={setOutput} />
          </div>

          {/* Right Console */}
          <div className="w-96 overflow-hidden rounded border border-gray-800 bg-gray-900">
            <OutputPanel output={output} />
          </div>
        </div>
      </div>
    )
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
          <div className="flex items-center gap-4">
            <button
              onClick={() => navigate('/duel')}
              className="rounded bg-red-700 hover:bg-red-600 border border-red-500 text-white px-4 py-2 text-sm font-semibold flex items-center gap-1.5 shadow-lg shadow-red-950/20 transition cursor-pointer"
            >
              ⚔️ Enter Duel Arena
            </button>
            <WalletBar />
          </div>
        </div>
      </header>

      {/* Main Content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside className="w-48 border-r border-gray-800 bg-gray-900 p-4 flex flex-col justify-between">
          <nav className="space-y-2">
            {(Object.entries(panels) as [Panel, (typeof panels)[Panel]][]).map(
              ([key, { label, icon }]) => (
                <button
                  key={key}
                  onClick={() => setActivePanel(key)}
                  className={`w-full rounded px-3 py-2 text-left text-sm font-medium transition cursor-pointer ${
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

          <div className="space-y-4">
            <button
              onClick={() => navigate('/duel')}
              className="w-full rounded bg-red-950/50 border border-red-800 text-red-200 px-3 py-2 text-left text-sm font-medium hover:bg-red-900/40 transition flex items-center gap-1.5 cursor-pointer"
            >
              ⚔️ Duel Arena
            </button>
            {!account && (
              <div className="rounded bg-red-950 p-3 text-xs text-red-200">
                ⚠️ Connect your wallet to use these functions
              </div>
            )}
          </div>
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
            {activePanel === 'chat' && <ChatPanel onOutput={setOutput} />}
            {activePanel === 'e2e' && <E2EFlowPanel onOutput={setOutput} />}
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
