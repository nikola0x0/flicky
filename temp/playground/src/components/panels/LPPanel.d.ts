interface PanelOutput {
    type: 'success' | 'error' | 'info';
    title: string;
    data: string;
    txDigest?: string;
}
interface LPPanelProps {
    onOutput: (output: PanelOutput) => void;
}
export default function LPPanel({ onOutput }: LPPanelProps): import("react/jsx-runtime").JSX.Element;
export {};
