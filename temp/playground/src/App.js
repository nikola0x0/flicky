import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect } from 'react';
import { useCurrentAccount } from '@mysten/dapp-kit';
import WalletBar from './components/WalletBar';
import OutputPanel from './components/OutputPanel';
import ManagerPanel from './components/panels/ManagerPanel';
import TradingPanel from './components/panels/TradingPanel';
import LPPanel from './components/panels/LPPanel';
import KeeperPanel from './components/panels/KeeperPanel';
import OraclePanel from './components/panels/OraclePanel';
import SwapPanel from './components/panels/SwapPanel';
import DuelPanel from './components/panels/DuelPanel';
export default function App() {
    const account = useCurrentAccount();
    const [activePanel, setActivePanel] = useState('manager');
    const [output, setOutput] = useState(null);
    // Custom router state
    const [pathname, setPathname] = useState(window.location.pathname);
    useEffect(() => {
        const handlePopState = () => {
            setPathname(window.location.pathname);
        };
        window.addEventListener('popstate', handlePopState);
        return () => window.removeEventListener('popstate', handlePopState);
    }, []);
    const navigate = (to) => {
        window.history.pushState({}, '', to);
        setPathname(to);
    };
    const panels = {
        manager: { label: 'Manager', icon: '🗃️' },
        trading: { label: 'Trading', icon: '💹' },
        lp: { label: 'LP', icon: '💰' },
        keeper: { label: 'Keeper', icon: '🔧' },
        oracle: { label: 'Oracle', icon: '🔭' },
        swap: { label: 'Swap', icon: '🔄' },
    };
    const isDuelPage = pathname === '/duel' || pathname.endsWith('/duel');
    if (isDuelPage) {
        return (_jsxs("div", { className: "flex h-screen flex-col bg-gray-950 text-gray-50", children: [_jsx("header", { className: "border-b border-gray-800 bg-gray-900 px-6 py-4", children: _jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { className: "flex items-center gap-4", children: [_jsx("button", { onClick: () => navigate('/'), className: "rounded bg-gray-850 border border-gray-700 px-3 py-1.5 text-xs font-semibold text-gray-300 hover:bg-gray-850 hover:text-white transition cursor-pointer", children: "\u2B05\uFE0F Back to Playground" }), _jsxs("div", { children: [_jsx("h1", { className: "text-xl font-bold flex items-center gap-2", children: "\u2694\uFE0F Flicky Duel Arena" }), _jsx("p", { className: "mt-0.5 text-xs text-gray-400", children: "Test dUSDC Staked 5-Card Duels" })] })] }), _jsx(WalletBar, {})] }) }), _jsxs("div", { className: "flex flex-1 overflow-hidden p-6 gap-4", children: [_jsx("div", { className: "flex-1 overflow-y-auto rounded border border-gray-800 bg-gray-900 p-6", children: _jsx(DuelPanel, { onOutput: setOutput }) }), _jsx("div", { className: "w-96 overflow-hidden rounded border border-gray-800 bg-gray-900", children: _jsx(OutputPanel, { output: output }) })] })] }));
    }
    return (_jsxs("div", { className: "flex h-screen flex-col bg-gray-950 text-gray-50", children: [_jsx("header", { className: "border-b border-gray-800 bg-gray-900 px-6 py-4", children: _jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { children: [_jsx("h1", { className: "text-2xl font-bold", children: "\uD83D\uDD2C DeepBook Predict Playground" }), _jsx("p", { className: "mt-1 text-sm text-gray-400", children: "Test all DeepBook Predict functions on testnet" })] }), _jsxs("div", { className: "flex items-center gap-4", children: [_jsx("button", { onClick: () => navigate('/duel'), className: "rounded bg-red-700 hover:bg-red-600 border border-red-500 text-white px-4 py-2 text-sm font-semibold flex items-center gap-1.5 shadow-lg shadow-red-950/20 transition cursor-pointer", children: "\u2694\uFE0F Enter Duel Arena" }), _jsx(WalletBar, {})] })] }) }), _jsxs("div", { className: "flex flex-1 overflow-hidden", children: [_jsxs("aside", { className: "w-48 border-r border-gray-800 bg-gray-900 p-4 flex flex-col justify-between", children: [_jsx("nav", { className: "space-y-2", children: Object.entries(panels).map(([key, { label, icon }]) => (_jsxs("button", { onClick: () => setActivePanel(key), className: `w-full rounded px-3 py-2 text-left text-sm font-medium transition cursor-pointer ${activePanel === key
                                        ? 'bg-blue-600 text-white'
                                        : 'text-gray-300 hover:bg-gray-800'}`, children: [icon, " ", label] }, key))) }), _jsxs("div", { className: "space-y-4", children: [_jsx("button", { onClick: () => navigate('/duel'), className: "w-full rounded bg-red-950/50 border border-red-800 text-red-200 px-3 py-2 text-left text-sm font-medium hover:bg-red-900/40 transition flex items-center gap-1.5 cursor-pointer", children: "\u2694\uFE0F Duel Arena" }), !account && (_jsx("div", { className: "rounded bg-red-950 p-3 text-xs text-red-200", children: "\u26A0\uFE0F Connect your wallet to use these functions" }))] })] }), _jsxs("div", { className: "flex flex-1 gap-4 overflow-hidden p-6", children: [_jsxs("div", { className: "flex-1 overflow-y-auto rounded border border-gray-800 bg-gray-900 p-6", children: [activePanel === 'manager' && (_jsx(ManagerPanel, { onOutput: setOutput })), activePanel === 'trading' && (_jsx(TradingPanel, { onOutput: setOutput })), activePanel === 'lp' && _jsx(LPPanel, { onOutput: setOutput }), activePanel === 'keeper' && _jsx(KeeperPanel, { onOutput: setOutput }), activePanel === 'oracle' && _jsx(OraclePanel, { onOutput: setOutput }), activePanel === 'swap' && _jsx(SwapPanel, { onOutput: setOutput })] }), _jsx("div", { className: "w-96 overflow-hidden rounded border border-gray-800 bg-gray-900", children: _jsx(OutputPanel, { output: output }) })] })] })] }));
}
//# sourceMappingURL=App.js.map