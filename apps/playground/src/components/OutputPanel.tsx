interface PanelOutput {
  type: 'success' | 'error' | 'info'
  title: string
  data: string
  txDigest?: string
}

interface OutputPanelProps {
  output: PanelOutput | null
}

export default function OutputPanel({ output }: OutputPanelProps) {
  if (!output) {
    return (
      <div className="flex flex-col items-center justify-center p-6 h-full text-gray-400">
        <div className="text-4xl mb-2">📋</div>
        <div className="text-sm text-center">
          Output will appear here after you execute a function
        </div>
      </div>
    )
  }

  const colorClass = {
    success: 'border-green-800 bg-green-950',
    error: 'border-red-800 bg-red-950',
    info: 'border-blue-800 bg-blue-950',
  }[output.type]

  const titleColor = {
    success: 'text-green-200',
    error: 'text-red-200',
    info: 'text-blue-200',
  }[output.type]

  const copyToClipboard = () => {
    navigator.clipboard.writeText(output.data)
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className={`border-b ${colorClass} px-4 py-3`}>
        <div className={`text-sm font-semibold ${titleColor}`}>
          {output.title}
        </div>
        {output.txDigest && (
          <div className="mt-2 text-xs text-gray-300">
            <div className="text-gray-400">Tx Digest:</div>
            <a
              href={`https://testnet.suiscan.xyz/txblock/${output.txDigest}`}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-blue-400 hover:text-blue-300 break-all"
            >
              {output.txDigest}
            </a>
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4">
        <pre className="text-xs text-gray-300 whitespace-pre-wrap break-words">
          {output.data}
        </pre>
      </div>

      {/* Footer */}
      <div className="border-t border-gray-800 p-2">
        <button
          onClick={copyToClipboard}
          className="w-full rounded bg-gray-800 px-3 py-2 text-xs font-medium text-gray-300 hover:bg-gray-700"
        >
          📋 Copy
        </button>
      </div>
    </div>
  )
}
