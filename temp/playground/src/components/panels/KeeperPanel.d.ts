interface PanelOutput {
    type: 'success' | 'error' | 'info';
    title: string;
    data: string;
    txDigest?: string;
}
interface KeeperPanelProps {
    onOutput: (output: PanelOutput) => void;
}
export default function KeeperPanel({ onOutput }: KeeperPanelProps): import("react/jsx-runtime").JSX.Element;
export {};
