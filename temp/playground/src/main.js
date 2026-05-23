import { jsx as _jsx } from "react/jsx-runtime";
import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SuiClientProvider, WalletProvider } from '@mysten/dapp-kit';
import '@mysten/dapp-kit/dist/index.css';
import './index.css';
import App from './App';
const queryClient = new QueryClient();
const networks = {
    testnet: { url: 'https://fullnode.testnet.sui.io:443', network: 'testnet' },
    mainnet: { url: 'https://fullnode.mainnet.sui.io:443', network: 'mainnet' },
};
ReactDOM.createRoot(document.getElementById('root')).render(_jsx(React.StrictMode, { children: _jsx(QueryClientProvider, { client: queryClient, children: _jsx(SuiClientProvider, { networks: networks, defaultNetwork: "testnet", children: _jsx(WalletProvider, { autoConnect: true, children: _jsx(App, {}) }) }) }) }));
//# sourceMappingURL=main.js.map