import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCurrentAccount, useDisconnectWallet } from '@mysten/dapp-kit';
import { ConnectButton } from '@mysten/dapp-kit';
export default function WalletBar() {
    const account = useCurrentAccount();
    const { mutate: disconnect } = useDisconnectWallet();
    if (!account) {
        return _jsx(ConnectButton, {});
    }
    return (_jsxs("div", { className: "flex items-center gap-4", children: [_jsxs("div", { className: "rounded bg-gray-800 px-3 py-2 text-sm", children: [_jsx("div", { className: "text-gray-400", children: "Connected as" }), _jsxs("div", { className: "font-mono text-xs", children: [account.address.slice(0, 6), "...", account.address.slice(-4)] })] }), _jsx("button", { onClick: () => disconnect(), className: "rounded bg-red-600 px-3 py-2 text-sm font-medium hover:bg-red-700", children: "Disconnect" })] }));
}
//# sourceMappingURL=WalletBar.js.map