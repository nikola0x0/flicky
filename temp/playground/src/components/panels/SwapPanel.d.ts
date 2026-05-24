interface PanelOutput {
    type: 'success' | 'error' | 'info';
    title: string;
    data: string;
    txDigest?: string;
}
interface SwapPanelProps {
    onOutput: (output: PanelOutput) => void;
}
export default function SwapPanel({ onOutput }: SwapPanelProps): import("react/jsx-runtime").JSX.Element;
export {};
