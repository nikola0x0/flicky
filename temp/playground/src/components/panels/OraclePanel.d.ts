interface PanelOutput {
    type: 'success' | 'error' | 'info';
    title: string;
    data: string;
}
interface OraclePanelProps {
    onOutput: (output: PanelOutput) => void;
}
export default function OraclePanel({ onOutput }: OraclePanelProps): import("react/jsx-runtime").JSX.Element;
export {};
