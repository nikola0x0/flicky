import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
export default function OutputPanel({ output }) {
    if (!output) {
        return (_jsxs("div", { className: "flex flex-col items-center justify-center p-6 h-full text-gray-400", children: [_jsx("div", { className: "text-4xl mb-2", children: "\uD83D\uDCCB" }), _jsx("div", { className: "text-sm text-center", children: "Output will appear here after you execute a function" })] }));
    }
    const colorClass = {
        success: 'border-green-800 bg-green-950',
        error: 'border-red-800 bg-red-950',
        info: 'border-blue-800 bg-blue-950',
    }[output.type];
    const titleColor = {
        success: 'text-green-200',
        error: 'text-red-200',
        info: 'text-blue-200',
    }[output.type];
    const copyToClipboard = () => {
        navigator.clipboard.writeText(output.data);
    };
    return (_jsxs("div", { className: "flex flex-col h-full", children: [_jsxs("div", { className: `border-b ${colorClass} px-4 py-3`, children: [_jsx("div", { className: `text-sm font-semibold ${titleColor}`, children: output.title }), output.txDigest && (_jsxs("div", { className: "mt-2 text-xs text-gray-300", children: [_jsx("div", { className: "text-gray-400", children: "Tx Digest:" }), _jsx("a", { href: `https://testnet.suiscan.xyz/txblock/${output.txDigest}`, target: "_blank", rel: "noreferrer", className: "font-mono text-blue-400 hover:text-blue-300 break-all", children: output.txDigest })] }))] }), _jsx("div", { className: "flex-1 overflow-auto p-4", children: _jsx("pre", { className: "text-xs text-gray-300 whitespace-pre-wrap break-words", children: output.data }) }), _jsx("div", { className: "border-t border-gray-800 p-2", children: _jsx("button", { onClick: copyToClipboard, className: "w-full rounded bg-gray-800 px-3 py-2 text-xs font-medium text-gray-300 hover:bg-gray-700", children: "\uD83D\uDCCB Copy" }) })] }));
}
//# sourceMappingURL=OutputPanel.js.map