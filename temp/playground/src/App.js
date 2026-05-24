import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { useCurrentAccount } from '@mysten/dapp-kit';
import WalletBar from './components/WalletBar';
import OutputPanel from './components/OutputPanel';
import ManagerPanel from './components/panels/ManagerPanel';
import TradingPanel from './components/panels/TradingPanel';
import LPPanel from './components/panels/LPPanel';
import KeeperPanel from './components/panels/KeeperPanel';
import OraclePanel from './components/panels/OraclePanel';
import SwapPanel from './components/panels/SwapPanel';
export default function App() {
    const account = useCurrentAccount();
    const [activePanel, setActivePanel] = useState('manager');
    const [output, setOutput] = useState(null);
    const panels = {
        manager: { label: 'Manager', icon: '🗃️' },
        trading: { label: 'Trading', icon: '💹' },
        lp: { label: 'LP', icon: '💰' },
        keeper: { label: 'Keeper', icon: '🔧' },
        oracle: { label: 'Oracle', icon: '🔭' },
        swap: { label: 'Swap', icon: '🔄' },
    };
    return (_jsxs("div", { className: "flex h-screen flex-col bg-gray-950 text-gray-50", children: [_jsx("header", { className: "border-b border-gray-800 bg-gray-900 px-6 py-4", children: _jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { children: [_jsx("h1", { className: "text-2xl font-bold", children: "\uD83D\uDD2C DeepBook Predict Playground" }), _jsx("p", { className: "mt-1 text-sm text-gray-400", children: "Test all DeepBook Predict functions on testnet" })] }), _jsx(WalletBar, {})] }) }), _jsxs("div", { className: "flex flex-1 overflow-hidden", children: [_jsxs("aside", { className: "w-48 border-r border-gray-800 bg-gray-900 p-4", children: [_jsx("nav", { className: "space-y-2", children: Object.entries(panels).map(([key, { label, icon }]) => (_jsxs("button", { onClick: () => setActivePanel(key), className: `w-full rounded px-3 py-2 text-left text-sm font-medium transition ${activePanel === key
                                        ? 'bg-blue-600 text-white'
                                        : 'text-gray-300 hover:bg-gray-800'}`, children: [icon, " ", label] }, key))) }), !account && (_jsx("div", { className: "mt-8 rounded bg-red-950 p-3 text-xs text-red-200", children: "\u26A0\uFE0F Connect your wallet to use these functions" }))] }), _jsxs("div", { className: "flex flex-1 gap-4 overflow-hidden p-6", children: [_jsxs("div", { className: "flex-1 overflow-y-auto rounded border border-gray-800 bg-gray-900 p-6", children: [activePanel === 'manager' && (_jsx(ManagerPanel, { onOutput: setOutput })), activePanel === 'trading' && (_jsx(TradingPanel, { onOutput: setOutput })), activePanel === 'lp' && _jsx(LPPanel, { onOutput: setOutput }), activePanel === 'keeper' && _jsx(KeeperPanel, { onOutput: setOutput }), activePanel === 'oracle' && _jsx(OraclePanel, { onOutput: setOutput }), activePanel === 'swap' && _jsx(SwapPanel, { onOutput: setOutput })] }), _jsx("div", { className: "w-96 overflow-hidden rounded border border-gray-800 bg-gray-900", children: _jsx(OutputPanel, { output: output }) })] })] })] }));
}
//# sourceMappingURL=App.js.map