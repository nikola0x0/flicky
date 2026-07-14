import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import { createPortal } from "react-dom"
import { createPaymentTransactionUri } from "@mysten/payment-kit"
import { useCurrentClient } from "@mysten/dapp-kit-react"

import {
  useDusdcBalance,
  useInvalidateWalletBalances,
  useManagerBalance,
  useSuiBalance,
} from "@/hooks/use-wallet-balances"
import {
  DUSDC_COIN_TYPE,
  DUSDC_DECIMALS,
  SUI_COIN_TYPE,
  SUI_DECIMALS,
} from "@/lib/swap"
import {
  buildCreateAccountTx,
  buildDepositDusdcTx,
  fetchAccountState,
  waitForCreatedWrapper,
  waitForManagerBalance,
} from "@/lib/deepbook"
import { useFlickySign } from "@/lib/use-flicky-sign"
import { useModalSfx } from "@/lib/sound"
import { PixelButton } from "@/components/pixel-button"

const BLUE_BRAND_STYLE = {
  "--btn-bg": "#4094fb",
  "--btn-highlight": "#7eb6ff",
} as CSSProperties

const ORANGE_BRAND_STYLE = {
  "--btn-bg": "#e08a2b",
  "--btn-highlight": "#f4b966",
} as CSSProperties

type Tab = "SUI" | "DUSDC" | "MANAGER"

const RECEIVE_META: Record<
  "SUI" | "DUSDC",
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

const MANAGER_TAB_META = {
  label: "manager",
  icon: "/tokens/manager-usdc.png",
}

export interface DepositModalProps {
  open: boolean
  address: string
  onClose: () => void
  /** Pre-select a tab and amount when the caller already knows exactly how
   *  much is needed (e.g. the onboarding gate's wallet-funding step).
   *  Omitted by generic callers (profile, header), which keep the plain
   *  SUI-tab / "1" defaults. Re-applied every time the modal opens, since
   *  it stays mounted (just hidden) between opens in callers like
   *  OnboardingModal — a useState initializer alone would only ever see
   *  the props from first mount. */
  defaultTab?: Tab
  defaultDusdcAmount?: bigint
}

/** Bare decimal string (not currency-formatted) for seeding the amount
 *  input from a known dUSDC micro-unit shortfall — exact since dUSDC's
 *  6 decimals match the micro-unit scale 1:1. */
function dusdcMicroToInput(micro: bigint): string {
  return (Number(micro) / 10 ** DUSDC_DECIMALS).toString()
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
export function DepositModal({
  open,
  address,
  onClose,
  defaultTab,
  defaultDusdcAmount,
}: DepositModalProps) {
  useModalSfx(open)
  const invalidateBalances = useInvalidateWalletBalances()
  const { data: suiBalance = 0 } = useSuiBalance()
  const { data: dusdcBalance = 0 } = useDusdcBalance()
  const [tab, setTab] = useState<Tab>(defaultTab ?? "SUI")
  const [amount, setAmount] = useState(
    defaultDusdcAmount !== undefined
      ? dusdcMicroToInput(defaultDusdcAmount)
      : "1"
  )
  const [copied, setCopied] = useState(false)
  const [received, setReceived] = useState<number | null>(null)

  // Re-seed from the caller's known amount/tab every time the modal opens.
  // The useState initializers above only fire on first mount, but a caller
  // like OnboardingModal keeps this component mounted (just hidden) across
  // opens, so a later-known shortfall needs an explicit re-seed here.
  useEffect(() => {
    if (!open) return
    if (defaultTab) setTab(defaultTab)
    if (defaultDusdcAmount !== undefined) {
      setAmount(dusdcMicroToInput(defaultDusdcAmount))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Resolve the receive-flow metadata when we're on SUI/DUSDC tabs.
  // The MANAGER tab is a different UX (signed deposit, no QR) and
  // doesn't use this — it has its own render branch below.
  const receiveMeta = tab === "MANAGER" ? null : RECEIVE_META[tab]
  const currentBalance =
    tab === "SUI" ? suiBalance : tab === "DUSDC" ? dusdcBalance : 0

  // Snapshot the balance for the active token when the modal opens
  // (or when the user switches token tabs). Subsequent positive
  // deltas from this baseline are treated as a deposit. Skipping
  // setState here keeps initial deterministic — based on the value
  // present at snapshot time, not a later refetch.
  const initialBalanceRef = useRef<number | null>(null)

  // Build the Sui Payment URI for the SUI/DUSDC receive flow. Null
  // when amount is missing/invalid OR when we're on the MANAGER tab
  // (which has its own UX, no QR).
  const paymentUri = useMemo<string | null>(() => {
    if (!receiveMeta) return null
    const parsed = parseFloat(amount)
    if (!isFinite(parsed) || parsed <= 0) return null
    try {
      const raw = BigInt(Math.floor(parsed * 10 ** receiveMeta.decimals))
      return createPaymentTransactionUri({
        amount: raw,
        coinType: receiveMeta.coinType,
        nonce: Date.now().toString(),
        receiverAddress: address,
      })
    } catch (err) {
      console.error("payment uri build failed", err)
      return null
    }
  }, [amount, address, receiveMeta])

  // Reset state when the modal opens/closes. Snapshot the current
  // balance the first time the modal opens (or when the user changes
  // tabs) so subsequent positive deltas can be celebrated.
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
  }, [open, tab])

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
          className="absolute top-3 right-3 grid size-7 place-items-center text-base text-white/55 hover:text-white"
        >
          ✕
        </button>

        <header className="px-6 pt-7 pb-2 text-center">
          <h2
            id="deposit-title"
            className="text-lg tracking-[0.18em] uppercase"
          >
            deposit
          </h2>
        </header>

        <div className="space-y-4 px-6 pb-6">
          <TabRow value={tab} onChange={setTab} />

          {receiveMeta && (
            <>
              <AmountField
                token={receiveMeta}
                value={amount}
                onChange={setAmount}
              />

              <QRBlock data={paymentUri} />

              <AddressRow
                address={address}
                copied={copied}
                onCopy={handleCopy}
              />

              <p className="text-center text-xs tracking-wider text-white/55 uppercase">
                scan with slush, or send directly to the address
              </p>

              {received !== null ? (
                <div className="rounded-xl bg-emerald-500/15 px-3 py-2 text-center text-sm text-emerald-200">
                  received +{received.toFixed(4)} {receiveMeta.label}
                </div>
              ) : (
                <div className="flex items-center justify-center gap-2 text-xs tracking-wider text-white/55 uppercase">
                  <span className="size-1.5 animate-pulse rounded-full bg-white/55" />
                  waiting for deposit
                </div>
              )}

              <div className="flex items-center justify-between text-xs tracking-wider text-white/55 uppercase">
                <span>current balance</span>
                <span className="text-base text-white tabular-nums">
                  {currentBalance.toFixed(4)} {receiveMeta.label}
                </span>
              </div>
            </>
          )}

          {tab === "MANAGER" && (
            <ManagerDepositTab address={address} walletDusdc={dusdcBalance} />
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}

function TabRow({
  value,
  onChange,
}: {
  value: Tab
  onChange: (t: Tab) => void
}) {
  const tabs: Array<{ id: Tab; label: string; icon: string }> = [
    { id: "SUI", label: RECEIVE_META.SUI.label, icon: RECEIVE_META.SUI.icon },
    {
      id: "DUSDC",
      label: RECEIVE_META.DUSDC.label,
      icon: RECEIVE_META.DUSDC.icon,
    },
    {
      id: "MANAGER",
      label: MANAGER_TAB_META.label,
      icon: MANAGER_TAB_META.icon,
    },
  ]
  return (
    <div className="grid grid-cols-3 gap-2">
      {tabs.map((t) => {
        const active = value === t.id
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onChange(t.id)}
            className={`flex items-center justify-center gap-2 rounded-xl px-2 py-2 text-sm tracking-wider uppercase transition ${
              active
                ? "bg-white/15 text-white"
                : "bg-white/5 text-white/55 hover:text-white"
            }`}
          >
            <img
              src={t.icon}
              alt=""
              aria-hidden
              className="size-5 [image-rendering:pixelated]"
            />
            {t.label}
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
      <div className="text-xs tracking-[0.18em] text-white/55 uppercase">
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
          className="w-full bg-transparent text-2xl text-white tabular-nums focus:outline-none"
        />
        <div className="flex w-20 shrink-0 items-center justify-center gap-1 rounded-full bg-white/10 py-1 pr-2 pl-1.5">
          <img
            src={token.icon}
            alt=""
            aria-hidden
            className="size-6 [image-rendering:pixelated]"
          />
          <span className="text-base tracking-wider text-white uppercase">
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
        <div className="absolute inset-0 grid place-items-center px-4 text-center text-sm tracking-wider text-neutral-500 uppercase">
          enter amount to generate QR
        </div>
      )}
      {data && !ready && (
        <div className="absolute inset-0 grid place-items-center text-sm text-neutral-500">
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
      <span className="font-mono text-sm text-white/80 tabular-nums">
        {short}
      </span>
      <span className="text-xs tracking-wider text-white/55 uppercase">
        {copied ? "copied" : "copy"}
      </span>
    </button>
  )
}

/**
 * On-chain deposit from the zk-wallet dUSDC into the player's
 * AccountWrapper. Different UX from the receive-into-wallet flow:
 * amount input + signed deposit tx (sponsored via useFlickySign).
 * Creates the wrapper on-the-fly if the user doesn't have one yet.
 */
function ManagerDepositTab({
  address,
  walletDusdc,
}: {
  address: string
  walletDusdc: number
}) {
  const client = useCurrentClient()
  const sign = useFlickySign()
  const invalidateBalances = useInvalidateWalletBalances()
  const { data: managerInfo, refetch: refetchManager } = useManagerBalance()
  const managerBalance = managerInfo?.balance ?? 0
  const managerId = managerInfo?.managerId ?? null
  const [amount, setAmount] = useState("5")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<number | null>(null)

  const parsed = parseFloat(amount)
  const validAmount = isFinite(parsed) && parsed > 0
  const insufficient = validAmount && parsed > walletDusdc + 1e-9

  const doDeposit = async () => {
    setBusy(true)
    setError(null)
    setSuccess(null)
    try {
      // 1. Resolve wrapper id + current micro balance fresh (not from the
      //    possibly-stale, float-rounded react-query cache) — the post-
      //    deposit poll below needs an exact pre-deposit baseline.
      //    Creates the AccountWrapper if missing; a new wrapper starts at
      //    0 dUSDC, so we then deposit in step 2.
      let wrapperId = managerId
      let baseBalance = BigInt(Math.round(managerBalance * 1e6))
      if (!wrapperId) {
        const createTx = buildCreateAccountTx()
        const res = (await sign.mutateAsync({ transaction: createTx })) as {
          digest: string
        }
        // Sponsored-gas path returns only { digest }; the wrapper address
        // is deterministic but needs the tx to land before the server can
        // resolve it.
        wrapperId = await waitForCreatedWrapper(client, res.digest, address)
        baseBalance = 0n
      } else {
        baseBalance = (await fetchAccountState(address)).balance
      }
      // 2. Build + sign the deposit. `buildDepositDusdcTx` sources the
      //    dUSDC coin from the player's owned coins via `coinWithBalance`.
      const microAmount = BigInt(Math.floor(parsed * 1e6))
      const depositTx = buildDepositDusdcTx(wrapperId, microAmount)
      const depositRes = (await sign.mutateAsync({
        transaction: depositTx,
      })) as { digest: string }
      // Don't refetch the instant signing resolves — wait for finality AND
      // for the server's own balance read to catch up, or callers that
      // gate on this balance (e.g. queueing) can still see the pre-deposit
      // amount.
      await waitForManagerBalance(
        client,
        depositRes.digest,
        address,
        baseBalance + microAmount
      )
      setSuccess(parsed)
      setAmount("0")
      void refetchManager()
      invalidateBalances()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="rounded-2xl bg-black/35 px-4 py-3 ring-1 ring-white/5">
        <div className="text-xs tracking-[0.18em] text-white/55 uppercase">
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
            className="w-full bg-transparent text-2xl text-white tabular-nums focus:outline-none"
          />
          <div className="flex w-20 shrink-0 items-center justify-center gap-1 rounded-full bg-white/10 py-1 pr-2 pl-1.5">
            <img
              src="/tokens/manager-usdc.png"
              alt=""
              aria-hidden
              className="size-6 [image-rendering:pixelated]"
            />
            <span className="text-base tracking-wider text-white uppercase">
              mgr
            </span>
          </div>
        </div>
      </div>

      <div className="rounded-xl bg-white/5 px-3 py-2 text-xs tracking-wider text-white/55 uppercase">
        <div className="flex justify-between">
          <span>wallet dUSDC</span>
          <span className="text-base text-white tabular-nums">
            {walletDusdc.toFixed(4)}
          </span>
        </div>
        <div className="flex justify-between">
          <span>manager dUSDC</span>
          <span className="text-base text-white tabular-nums">
            {managerBalance.toFixed(4)}
          </span>
        </div>
      </div>

      <PixelButton
        disabled={busy || !validAmount || insufficient}
        onClick={() => void doDeposit()}
        style={ORANGE_BRAND_STYLE}
        className="h-12 w-full !text-2xl"
      >
        {busy
          ? "depositing…"
          : insufficient
            ? "insufficient dUSDC in wallet"
            : `deposit ${validAmount ? parsed.toFixed(2) : "—"} dUSDC`}
      </PixelButton>

      {error && <p className="text-sm text-red-400">{error}</p>}
      {success !== null && (
        <div className="rounded-xl bg-emerald-500/15 px-3 py-2 text-center text-sm text-emerald-200">
          deposited +{success.toFixed(4)} dUSDC into manager
        </div>
      )}

      <button
        type="button"
        onClick={() => {
          void refetchManager()
          invalidateBalances()
        }}
        className="text-xs tracking-wider text-white/40 uppercase hover:text-white/70"
      >
        refresh
      </button>
    </div>
  )
}
