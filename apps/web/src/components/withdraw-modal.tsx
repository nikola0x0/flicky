import { useEffect, useState, type CSSProperties } from "react"
import { createPortal } from "react-dom"

import {
  useInvalidateWalletBalances,
  useManagerBalance,
} from "@/hooks/use-wallet-balances"
import { buildWithdrawDusdcTx } from "@/lib/deepbook"
import { useFlickySign } from "@/lib/use-flicky-sign"

const BLUE_BRAND_STYLE = {
  "--btn-bg": "#4094fb",
  "--btn-highlight": "#7eb6ff",
} as CSSProperties

export interface WithdrawModalProps {
  open: boolean
  address: string
  onClose: () => void
}

/**
 * Withdraw modal — moves dUSDC from the player's PredictManager back
 * into their zk-wallet. Mirror of DepositModal's MANAGER tab, but in
 * the opposite direction. Signed by the user (sponsored via
 * useFlickySign); no-op if the player has no PredictManager (the
 * action button stays disabled).
 */
export function WithdrawModal({ open, address, onClose }: WithdrawModalProps) {
  const sign = useFlickySign()
  const invalidateBalances = useInvalidateWalletBalances()
  const { data: managerInfo, refetch: refetchManager } = useManagerBalance()
  const managerBalance = managerInfo?.balance ?? 0
  const managerId = managerInfo?.managerId ?? null
  const [amount, setAmount] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<number | null>(null)

  // Reset transient state every time the modal opens.
  useEffect(() => {
    if (!open) return
    setAmount("")
    setError(null)
    setSuccess(null)
  }, [open])

  // Esc-to-close + body-scroll lock.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.body.style.overflow = "hidden"
    window.addEventListener("keydown", onKey)
    return () => {
      document.body.style.overflow = ""
      window.removeEventListener("keydown", onKey)
    }
  }, [open, onClose])

  if (!open) return null

  const parsed = parseFloat(amount)
  const validAmount = isFinite(parsed) && parsed > 0
  const insufficient = validAmount && parsed > managerBalance + 1e-9
  const noManager = managerId === null

  const doWithdraw = async () => {
    if (!managerId) return
    setBusy(true)
    setError(null)
    setSuccess(null)
    try {
      const microAmount = BigInt(Math.floor(parsed * 1e6))
      const tx = buildWithdrawDusdcTx(managerId, microAmount, address)
      await sign.mutateAsync({ transaction: tx })
      setSuccess(parsed)
      setAmount("")
      void refetchManager()
      invalidateBalances()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="withdraw-title"
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
            id="withdraw-title"
            className="text-lg tracking-[0.18em] uppercase"
          >
            withdraw
          </h2>
          <p className="mt-1 text-[10px] tracking-wider text-white/55 uppercase">
            manager &rarr; wallet
          </p>
        </header>

        <div className="space-y-4 px-6 pb-6">
          <div className="rounded-2xl bg-black/35 px-4 py-3 ring-1 ring-white/5">
            <div className="text-[10px] tracking-[0.18em] text-white/55 uppercase">
              amount
            </div>
            <div className="mt-1 flex items-center gap-3">
              <input
                type="number"
                value={amount}
                onChange={(e) => {
                  const v = e.target.value
                  if (v === "" || parseFloat(v) >= 0) setAmount(v)
                }}
                placeholder="0.0"
                inputMode="decimal"
                min={0}
                step="any"
                className="w-full bg-transparent text-2xl tabular-nums text-white focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setAmount(managerBalance.toString())}
                className="rounded-full bg-white/10 px-3 py-1 text-[10px] tracking-wider uppercase text-white/70 hover:text-white"
              >
                max
              </button>
              <div className="flex w-20 shrink-0 items-center justify-center gap-1 rounded-full bg-white/10 py-1 pl-1.5 pr-2">
                <img
                  src="/tokens/manager-usdc.png"
                  alt=""
                  aria-hidden
                  className="size-6 [image-rendering:pixelated]"
                />
                <span className="text-sm tracking-wider text-white uppercase">
                  mgr
                </span>
              </div>
            </div>
          </div>

          <div className="rounded-xl bg-white/5 px-3 py-2 text-[10px] tracking-wider text-white/55 uppercase">
            <div className="flex justify-between">
              <span>manager dUSDC</span>
              <span className="text-sm tabular-nums text-white">
                {managerBalance.toFixed(4)}
              </span>
            </div>
          </div>

          <button
            type="button"
            disabled={busy || !validAmount || insufficient || noManager}
            onClick={() => void doWithdraw()}
            style={BLUE_BRAND_STYLE}
            className="w-full rounded-xl bg-[#4094fb] px-4 py-3 text-lg font-bold tracking-wider uppercase text-white disabled:opacity-50"
          >
            {busy
              ? "withdrawing…"
              : noManager
                ? "no manager"
                : insufficient
                  ? "insufficient manager balance"
                  : `withdraw ${validAmount ? parsed.toFixed(2) : "—"} dUSDC`}
          </button>

          {error && <p className="text-xs text-red-400">{error}</p>}
          {success !== null && (
            <div className="rounded-xl bg-emerald-500/15 px-3 py-2 text-center text-xs text-emerald-200">
              withdrew +{success.toFixed(4)} dUSDC to wallet
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
