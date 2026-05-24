interface PanelOutput {
    type: 'success' | 'error' | 'info';
    title: string;
    data: string;
    txDigest?: string;
}
interface DuelPanelProps {
    onOutput: (output: PanelOutput) => void;
}
export default function DuelPanel({ onOutput }: DuelPanelProps): import("react/jsx-runtime").JSX.Element;
export {};
