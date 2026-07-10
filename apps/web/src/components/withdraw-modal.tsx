import { useEffect, useState, type CSSProperties } from "react"
import { createPortal } from "react-dom"
import { useCurrentClient } from "@mysten/dapp-kit-react"
import { Transaction } from "@mysten/sui/transactions"

import {
  useDusdcBalance,
  useInvalidateWalletBalances,
  useManagerBalance,
  useSuiBalance,
} from "@/hooks/use-wallet-balances"
import { buildWithdrawDusdcTx } from "@/lib/deepbook"
import { useFlickySign } from "@/lib/use-flicky-sign"
import {
  DUSDC_COIN_TYPE,
  DUSDC_DECIMALS,
  SUI_COIN_TYPE,
  SUI_DECIMALS,
} from "@/lib/swap"
import { PixelButton } from "@/components/pixel-button"

const BLUE_BRAND_STYLE = {
  "--btn-bg": "#4094fb",
  "--btn-highlight": "#7eb6ff",
} as CSSProperties

export interface WithdrawModalProps {
  open: boolean
  address: string
  onClose: () => void
}

type Tab = "MANAGER" | "SEND"

/**
 * Withdraw modal — two related "money out" flows under one roof:
 *
 *   - MANAGER tab: account::withdraw_funds, wrapper → zk-wallet.
 *     Recipient is implicit (the caller).
 *   - SEND    tab: zk-wallet → arbitrary address, SUI or dUSDC, with
 *     an inline confirm step before signing.
 *
 * Both go through the sponsor service via useFlickySign.
 */
export function WithdrawModal({ open, address, onClose }: WithdrawModalProps) {
  const [tab, setTab] = useState<Tab>("MANAGER")

  // Reset to the default tab whenever the modal opens.
  useEffect(() => {
    if (open) setTab("MANAGER")
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
          className="absolute top-3 right-3 grid size-7 place-items-center text-base text-white/55 hover:text-white"
        >
          ✕
        </button>

        <header className="px-6 pt-7 pb-2 text-center">
          <h2
            id="withdraw-title"
            className="text-lg tracking-[0.18em] uppercase"
          >
            withdraw
          </h2>
        </header>

        <div className="space-y-4 px-6 pb-6">
          <TabRow value={tab} onChange={setTab} />
          {tab === "MANAGER" && <ManagerWithdrawTab address={address} />}
          {tab === "SEND" && <SendTab address={address} />}
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
    { id: "MANAGER", label: "from manager", icon: "/tokens/manager-usdc.png" },
    { id: "SEND", label: "to external", icon: "/icons/disk_load.png" },
  ]
  return (
    <div className="grid grid-cols-2 gap-2">
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

/* ────────────────────────────────────────────────────────────────────
 * MANAGER tab — account::withdraw_funds, wrapper → zk-wallet.
 * ─────────────────────────────────────────────────────────────────── */

function ManagerWithdrawTab({ address }: { address: string }) {
  const sign = useFlickySign()
  const invalidateBalances = useInvalidateWalletBalances()
  const { data: managerInfo, refetch: refetchManager } = useManagerBalance()
  const managerBalance = managerInfo?.balance ?? 0
  const managerId = managerInfo?.managerId ?? null
  const [amount, setAmount] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<number | null>(null)

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

  return (
    <div className="space-y-3">
      <p className="text-xs tracking-wider text-white/55 uppercase">
        manager &rarr; wallet
      </p>
      <AmountField
        amount={amount}
        onAmount={setAmount}
        onMax={() => setAmount(managerBalance.toString())}
        token={{ icon: "/tokens/manager-usdc.png", label: "mgr" }}
      />
      <div className="rounded-xl bg-white/5 px-3 py-2 text-xs tracking-wider text-white/55 uppercase">
        <div className="flex justify-between">
          <span>manager dUSDC</span>
          <span className="text-base text-white tabular-nums">
            {managerBalance.toFixed(4)}
          </span>
        </div>
      </div>
      <PixelButton
        disabled={busy || !validAmount || insufficient || noManager}
        onClick={() => void doWithdraw()}
        style={BLUE_BRAND_STYLE}
        className="h-12 w-full !text-2xl"
      >
        {busy
          ? "withdrawing…"
          : noManager
            ? "no manager"
            : insufficient
              ? "insufficient manager balance"
              : `withdraw ${validAmount ? parsed.toFixed(2) : "—"} dUSDC`}
      </PixelButton>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {success !== null && (
        <div className="rounded-xl bg-emerald-500/15 px-3 py-2 text-center text-sm text-emerald-200">
          withdrew +{success.toFixed(4)} dUSDC to wallet
        </div>
      )}
    </div>
  )
}

/* ────────────────────────────────────────────────────────────────────
 * SEND tab — zk-wallet → arbitrary address. SUI or dUSDC.
 * ─────────────────────────────────────────────────────────────────── */

type SendToken = "DUSDC" | "SUI"

const SEND_META: Record<
  SendToken,
  { label: string; icon: string; coinType: string; decimals: number }
> = {
  DUSDC: {
    label: "dUSDC",
    icon: "/tokens/usdc-icon.png",
    coinType: DUSDC_COIN_TYPE,
    decimals: DUSDC_DECIMALS,
  },
  SUI: {
    label: "SUI",
    icon: "/tokens/sui.png",
    coinType: SUI_COIN_TYPE,
    decimals: SUI_DECIMALS,
  },
}

function SendTab({ address }: { address: string }) {
  const client = useCurrentClient()
  const sign = useFlickySign()
  const invalidateBalances = useInvalidateWalletBalances()
  const { data: dusdcBalance = 0 } = useDusdcBalance()
  const { data: suiBalance = 0 } = useSuiBalance()
  const [token, setToken] = useState<SendToken>("DUSDC")
  const [recipient, setRecipient] = useState("")
  const [amount, setAmount] = useState("")
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<{
    amount: number
    token: SendToken
  } | null>(null)

  const meta = SEND_META[token]
  const balance = token === "DUSDC" ? dusdcBalance : suiBalance

  const validAddress =
    /^0x[0-9a-fA-F]{64}$/.test(recipient.trim()) &&
    recipient.trim().toLowerCase() !== address.toLowerCase()
  const parsed = parseFloat(amount)
  const validAmount = isFinite(parsed) && parsed > 0
  const insufficient = validAmount && parsed > balance + 1e-9

  const submit = async () => {
    setBusy(true)
    setError(null)
    setSuccess(null)
    try {
      const microAmount = BigInt(Math.floor(parsed * 10 ** meta.decimals))
      const tx = await buildExternalTransferTx(
        client,
        address,
        recipient.trim(),
        meta.coinType,
        microAmount
      )
      await sign.mutateAsync({ transaction: tx })
      setSuccess({ amount: parsed, token })
      setAmount("")
      setRecipient("")
      setConfirming(false)
      invalidateBalances()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setConfirming(false)
    } finally {
      setBusy(false)
    }
  }

  // Confirm step intercepts before signing.
  if (confirming) {
    return (
      <div className="space-y-3">
        <p className="text-xs tracking-wider text-white/55 uppercase">
          confirm transfer
        </p>
        <div className="space-y-2 rounded-xl bg-white/5 px-3 py-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-white/55 uppercase">amount</span>
            <span className="font-bold tabular-nums">
              {parsed.toFixed(4)} {meta.label}
            </span>
          </div>
          <div>
            <div className="text-white/55 uppercase">to</div>
            <div className="mt-1 font-mono text-xs break-all text-white">
              {recipient.trim()}
            </div>
          </div>
          <p className="rounded bg-amber-500/15 px-2 py-1 text-xs text-amber-200">
            double-check the address — funds sent to a wrong address are
            unrecoverable
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirming(false)}
            className="rounded-xl bg-white/10 px-4 py-3 text-base tracking-wider text-white/80 uppercase hover:bg-white/15 disabled:opacity-50"
          >
            cancel
          </button>
          <PixelButton
            disabled={busy}
            onClick={() => void submit()}
            style={BLUE_BRAND_STYLE}
            className="h-12 !text-xl"
          >
            {busy ? "sending…" : "yes, send"}
          </PixelButton>
        </div>
        {error && <p className="text-sm text-red-400">{error}</p>}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <p className="text-xs tracking-wider text-white/55 uppercase">
        wallet &rarr; external address
      </p>
      <TokenToggle value={token} onChange={setToken} />
      <div className="rounded-2xl bg-black/35 px-4 py-3 ring-1 ring-white/5">
        <div className="text-xs tracking-[0.18em] text-white/55 uppercase">
          recipient address
        </div>
        <input
          type="text"
          spellCheck={false}
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          placeholder="0x…"
          className="mt-1 w-full bg-transparent font-mono text-base text-white placeholder-white/30 focus:outline-none"
        />
        {recipient && !validAddress && (
          <p className="mt-1 text-xs text-amber-300">
            must be a 0x-prefixed 32-byte Sui address (not your own)
          </p>
        )}
      </div>
      <AmountField
        amount={amount}
        onAmount={setAmount}
        onMax={() => setAmount(balance.toString())}
        token={{ icon: meta.icon, label: meta.label.toLowerCase() }}
      />
      <div className="rounded-xl bg-white/5 px-3 py-2 text-xs tracking-wider text-white/55 uppercase">
        <div className="flex justify-between">
          <span>wallet {meta.label}</span>
          <span className="text-base text-white tabular-nums">
            {balance.toFixed(4)}
          </span>
        </div>
      </div>
      <PixelButton
        disabled={!validAddress || !validAmount || insufficient}
        onClick={() => setConfirming(true)}
        style={BLUE_BRAND_STYLE}
        className="h-12 w-full !text-2xl"
      >
        {!validAddress
          ? "enter recipient"
          : !validAmount
            ? "enter amount"
            : insufficient
              ? `insufficient ${meta.label}`
              : `review send`}
      </PixelButton>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {success && (
        <div className="rounded-xl bg-emerald-500/15 px-3 py-2 text-center text-sm text-emerald-200">
          sent {success.amount.toFixed(4)} {SEND_META[success.token].label}
        </div>
      )}
    </div>
  )
}

function TokenToggle({
  value,
  onChange,
}: {
  value: SendToken
  onChange: (t: SendToken) => void
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {(Object.keys(SEND_META) as SendToken[]).map((t) => {
        const meta = SEND_META[t]
        const active = value === t
        return (
          <button
            key={t}
            type="button"
            onClick={() => onChange(t)}
            className={`flex items-center justify-center gap-2 rounded-xl px-3 py-2 text-base tracking-wider uppercase transition ${
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
  amount,
  onAmount,
  onMax,
  token,
}: {
  amount: string
  onAmount: (v: string) => void
  onMax: () => void
  token: { icon: string; label: string }
}) {
  return (
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
            if (v === "" || parseFloat(v) >= 0) onAmount(v)
          }}
          placeholder="0.0"
          inputMode="decimal"
          min={0}
          step="any"
          className="w-full bg-transparent text-2xl text-white tabular-nums focus:outline-none"
        />
        <button
          type="button"
          onClick={onMax}
          className="rounded-full bg-white/10 px-3 py-1 text-xs tracking-wider text-white/70 uppercase hover:text-white"
        >
          max
        </button>
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

/* ────────────────────────────────────────────────────────────────────
 * PTB builder — external transfer.
 * ─────────────────────────────────────────────────────────────────── */

/**
 * Build a vanilla coin transfer PTB. Sources coins of `coinType` owned
 * by `owner`, merges if multiple, splits the exact `amount`, and
 * transfers it to `recipient`. Works for both SUI and dUSDC.
 *
 * For SUI specifically, we deliberately do NOT use `tx.gas` as the
 * source — when sponsored gas is in play, `tx.gas` is the sponsor's
 * gas object, not the user's SUI. Sourcing from owned coins keeps
 * this correct regardless of the gas-payment path.
 */
async function buildExternalTransferTx(
  client: ReturnType<typeof useCurrentClient>,
  owner: string,
  recipient: string,
  coinType: string,
  amount: bigint
): Promise<Transaction> {
  const coins = await client.core.listCoins({ owner, coinType })
  if (coins.objects.length === 0) {
    throw new Error(`no ${coinType} coins in wallet`)
  }
  const tx = new Transaction()
  const [primary, ...rest] = coins.objects.map((c) => tx.object(c.objectId))
  if (rest.length > 0) tx.mergeCoins(primary, rest)
  const [out] = tx.splitCoins(primary, [tx.pure.u64(amount)])
  tx.transferObjects([out], tx.pure.address(recipient))
  return tx
}
