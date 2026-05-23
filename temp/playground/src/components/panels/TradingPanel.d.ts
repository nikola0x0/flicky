interface PanelOutput {
    type: 'success' | 'error' | 'info';
    title: string;
    data: string;
    txDigest?: string;
}
interface TradingPanelProps {
    onOutput: (output: PanelOutput) => void;
}
export default function TradingPanel({ onOutput }: TradingPanelProps): import("react/jsx-runtime").JSX.Element;
export {};
