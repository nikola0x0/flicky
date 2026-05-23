interface PanelOutput {
    type: 'success' | 'error' | 'info';
    title: string;
    data: string;
    txDigest?: string;
}
interface ManagerPanelProps {
    onOutput: (output: PanelOutput) => void;
}
export default function ManagerPanel({ onOutput }: ManagerPanelProps): import("react/jsx-runtime").JSX.Element;
export {};
