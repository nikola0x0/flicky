import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react"
import { createPortal } from "react-dom"
import { createPaymentTransactionUri } from "@mysten/payment-kit"

import {
  useDusdcBalance,
  useInvalidateWalletBalances,
  useSuiBalance,
} from "@/hooks/use-wallet-balances"
import {
  DUSDC_COIN_TYPE,
  DUSDC_DECIMALS,
  SUI_COIN_TYPE,
  SUI_DECIMALS,
} from "@/lib/swap"

const BLUE_BRAND_STYLE = {
  "--btn-bg": "#4094fb",
  "--btn-highlight": "#7eb6ff",
} as CSSProperties

type Token = "SUI" | "DUSDC"

const TOKEN_META: Record<
  Token,
  { label: string; icon: string; coinType: string; decimals: number }
> = {
  SUI: {
    label: "SUI",
    icon: "/tokens/sui.png",
    coinType: SUI_COIN_TYPE,
    decimals: SUI_DECIMALS,
  },
  DUSDC: {
    label: "dUSDC",
    icon: "/tokens/usdc-icon.png",
    coinType: DUSDC_COIN_TYPE,
    decimals: DUSDC_DECIMALS,
  },
}

export interface DepositModalProps {
  open: boolean
  address: string
  onClose: () => void
}

/**
 * Deposit modal — lets the player top up their zkLogin address with
 * SUI or dUSDC. Two paths:
 *
 *   1) Scan the QR with a wallet that supports Sui Payment URIs
 *      (Slush, Suiet). The URI is built via @mysten/payment-kit so
 *      the wallet prefills coin type + amount + receiver.
 *   2) Copy the raw address and transfer manually from any wallet
 *      or exchange withdrawal.
 *
 * Polls the chain every 3s while the modal is open and shows a
 * success state when the chosen token's balance grows.
 */
export function DepositModal({ open, address, onClose }: DepositModalProps) {
  const invalidateBalances = useInvalidateWalletBalances()
  const { data: suiBalance = 0 } = useSuiBalance()
  const { data: dusdcBalance = 0 } = useDusdcBalance()
  const [token, setToken] = useState<Token>("SUI")
  const [amount, setAmount] = useState("1")
  const [copied, setCopied] = useState(false)
  const [received, setReceived] = useState<number | null>(null)

  const meta = TOKEN_META[token]
  const currentBalance = token === "SUI" ? suiBalance : dusdcBalance

  // Snapshot the balance for the active token when the modal opens
  // (or when the user switches token tabs). Subsequent positive
  // deltas from this baseline are treated as a deposit. Skipping
  // setState here keeps initial deterministic — based on the value
  // present at snapshot time, not a later refetch.
  const initialBalanceRef = useRef<number | null>(null)

  // Build the Sui Payment URI. Returns null when the amount is
  // missing/invalid so the QR block can render a placeholder instead
  // of a misleading address-only QR (which also renders chunkier
  // because of the shorter encoded payload).
  const paymentUri = useMemo<string | null>(() => {
    const parsed = parseFloat(amount)
    if (!isFinite(parsed) || parsed <= 0) return null
    try {
      const raw = BigInt(Math.floor(parsed * 10 ** meta.decimals))
      return createPaymentTransactionUri({
        amount: raw,
        coinType: meta.coinType,
        nonce: Date.now().toString(),
        receiverAddress: address,
      })
    } catch (err) {
      console.error("payment uri build failed", err)
      return null
    }
  }, [amount, address, meta])

  // Reset state when the modal opens/closes. Snapshot the current
  // balance the first time the modal opens (or when the user changes
  // tokens) so subsequent positive deltas can be celebrated.
  useEffect(() => {
    if (!open) {
      initialBalanceRef.current = null
      setReceived(null)
      setCopied(false)
      return
    }
    initialBalanceRef.current = currentBalance
    setReceived(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, token])

  // Watch the live (polled) balance and surface deposits the moment
  // they cross the snapshot baseline.
  useEffect(() => {
    const initial = initialBalanceRef.current
    if (!open || initial === null) return
    if (currentBalance > initial + 1e-9) {
      setReceived(currentBalance - initial)
      invalidateBalances()
    }
  }, [currentBalance, open, invalidateBalances])

  // Escape-to-close + body-scroll lock.
  useEffect(() => {
    if (!open) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.body.style.overflow = "hidden"
    window.addEventListener("keydown", handleKey)
    return () => {
      document.body.style.overflow = ""
      window.removeEventListener("keydown", handleKey)
    }
  }, [open, onClose])

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(address)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* ignore */
    }
  }

  if (!open) return null

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="deposit-title"
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-[2px]"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="pixel-frame relative w-full max-w-sm rounded-3xl bg-[#1b2548] font-pixel text-white"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="close"
          className="absolute right-3 top-3 grid size-7 place-items-center text-base text-white/55 hover:text-white"
        >
          ✕
        </button>

        <header className="px-6 pb-2 pt-7 text-center">
          <h2
            id="deposit-title"
            className="text-lg tracking-[0.18em] uppercase"
          >
            deposit
          </h2>
        </header>

        <div className="space-y-4 px-6 pb-6">
          <TokenTabs value={token} onChange={setToken} />

          <AmountField
            token={meta}
            value={amount}
            onChange={setAmount}
          />

          <QRBlock data={paymentUri} />

          <AddressRow
            address={address}
            copied={copied}
            onCopy={handleCopy}
          />

          <p className="text-center text-[10px] tracking-wider text-white/55 uppercase">
            scan with slush, or send directly to the address
          </p>

          {received !== null ? (
            <div className="rounded-xl bg-emerald-500/15 px-3 py-2 text-center text-xs text-emerald-200">
              received +{received.toFixed(4)} {meta.label}
            </div>
          ) : (
            <div className="flex items-center justify-center gap-2 text-[10px] tracking-wider text-white/55 uppercase">
              <span className="size-1.5 animate-pulse rounded-full bg-white/55" />
              waiting for deposit
            </div>
          )}

          <div className="flex items-center justify-between text-[10px] tracking-wider text-white/55 uppercase">
            <span>current balance</span>
            <span className="text-sm tabular-nums text-white">
              {currentBalance.toFixed(4)} {meta.label}
            </span>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function TokenTabs({
  value,
  onChange,
}: {
  value: Token
  onChange: (t: Token) => void
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {(Object.keys(TOKEN_META) as Token[]).map((t) => {
        const meta = TOKEN_META[t]
        const active = value === t
        return (
          <button
            key={t}
            type="button"
            onClick={() => onChange(t)}
            className={`flex items-center justify-center gap-2 rounded-xl px-3 py-2 text-sm tracking-wider uppercase transition ${
              active
                ? "bg-white/15 text-white"
                : "bg-white/5 text-white/55 hover:text-white"
            }`}
          >
            <img
              src={meta.icon}
              alt=""
              aria-hidden
              className="size-5 [image-rendering:pixelated]"
            />
            {meta.label}
          </button>
        )
      })}
    </div>
  )
}

function AmountField({
  token,
  value,
  onChange,
}: {
  token: { icon: string; label: string }
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div className="rounded-2xl bg-black/35 px-4 py-3 ring-1 ring-white/5">
      <div className="text-[10px] tracking-[0.18em] text-white/55 uppercase">
        amount
      </div>
      <div className="mt-1 flex items-center gap-3">
        <input
          type="number"
          value={value}
          onChange={(e) => {
            const v = e.target.value
            if (v === "" || parseFloat(v) >= 0) onChange(v)
          }}
          placeholder="0.0"
          inputMode="decimal"
          min={0}
          step="any"
          className="w-full bg-transparent text-2xl tabular-nums text-white focus:outline-none"
        />
        <div className="flex w-20 shrink-0 items-center justify-center gap-1 rounded-full bg-white/10 py-1 pl-1.5 pr-2">
          <img
            src={token.icon}
            alt=""
            aria-hidden
            className="size-6 [image-rendering:pixelated]"
          />
          <span className="text-sm tracking-wider text-white uppercase">
            {token.label}
          </span>
        </div>
      </div>
    </div>
  )
}

function QRBlock({ data }: { data: string | null }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!data || !containerRef.current) {
      setReady(false)
      if (containerRef.current) containerRef.current.innerHTML = ""
      return
    }
    let mounted = true
    setReady(false)

    void (async () => {
      const QRCodeStyling = (await import("qr-code-styling")).default
      if (!mounted || !containerRef.current) return

      const containerWidth = containerRef.current.parentElement?.clientWidth
      const size = Math.min((containerWidth || 240) - 24, 320)

      containerRef.current.innerHTML = ""
      const qr = new QRCodeStyling({
        width: size,
        height: size,
        data,
        margin: 6,
        qrOptions: {
          typeNumber: 0,
          mode: "Byte",
          errorCorrectionLevel: "M",
        },
        dotsOptions: { type: "square", color: "#0b1228" },
        backgroundOptions: { color: "#ffffff" },
        cornersSquareOptions: { type: "square", color: "#0b1228" },
        cornersDotOptions: { type: "square", color: "#0b1228" },
      })
      qr.append(containerRef.current)
      const svg = containerRef.current.querySelector("svg")
      const canvas = containerRef.current.querySelector("canvas")
      if (svg) {
        svg.style.width = "100%"
        svg.style.height = "100%"
      }
      if (canvas) {
        canvas.style.width = "100%"
        canvas.style.height = "100%"
        canvas.style.imageRendering = "pixelated"
      }
      if (mounted) setReady(true)
    })()

    return () => {
      mounted = false
    }
  }, [data])

  return (
    <div className="relative mx-auto aspect-square w-56 rounded-2xl bg-white p-2">
      {!data && (
        <div className="absolute inset-0 grid place-items-center px-4 text-center text-xs tracking-wider text-neutral-500 uppercase">
          enter amount to generate QR
        </div>
      )}
      {data && !ready && (
        <div className="absolute inset-0 grid place-items-center text-xs text-neutral-500">
          generating…
        </div>
      )}
      <div ref={containerRef} className="size-full" />
    </div>
  )
}

function AddressRow({
  address,
  copied,
  onCopy,
}: {
  address: string
  copied: boolean
  onCopy: () => void
}) {
  const short = `${address.slice(0, 10)}…${address.slice(-8)}`
  return (
    <button
      type="button"
      onClick={onCopy}
      style={BLUE_BRAND_STYLE}
      className="flex w-full items-center justify-between gap-2 rounded-xl bg-black/35 px-3 py-2 text-left ring-1 ring-white/5 transition hover:bg-black/45"
    >
      <span className="font-mono text-xs tabular-nums text-white/80">
        {short}
      </span>
      <span className="text-[10px] tracking-wider text-white/55 uppercase">
        {copied ? "copied" : "copy"}
      </span>
    </button>
  )
}

