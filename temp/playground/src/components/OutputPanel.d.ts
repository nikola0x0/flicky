interface PanelOutput {
    type: 'success' | 'error' | 'info';
    title: string;
    data: string;
    txDigest?: string;
}
interface OutputPanelProps {
    output: PanelOutput | null;
}
export default function OutputPanel({ output }: OutputPanelProps): import("react/jsx-runtime").JSX.Element;
export {};
