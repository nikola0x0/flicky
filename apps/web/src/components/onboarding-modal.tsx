import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react"
import { createPortal } from "react-dom"
import { useCurrentAccount, useCurrentClient } from "@mysten/dapp-kit-react"
import { useFlickySign } from "@/lib/use-flicky-sign"
import {
  buildCreateAccountTx,
  buildDepositDusdcTx,
  fetchAccountState,
  fmtDusdc,
  getWalletDusdcBalance,
  waitForCreatedWrapper,
} from "@/lib/deepbook"
import { DepositModal } from "@/components/deposit-modal"
import { PixelButton } from "@/components/pixel-button"

const ORANGE_BRAND_STYLE = {
  "--btn-bg": "#e08a2b",
  "--btn-highlight": "#f4b966",
} as CSSProperties

const BLUE_BRAND_STYLE = {
  "--btn-bg": "#4094fb",
  "--btn-highlight": "#7eb6ff",
} as CSSProperties

/**
 * Per-swipe Predict position size (dUSDC micro-units). Fixed at 1 dUSDC
 * in v1 — worst-case 5-card exposure = 5 * SWIPE_QUANTITY, matching
 * MIN_MANAGER_BALANCE below. Keep these two constants in lockstep.
 */
export const SWIPE_QUANTITY = 1_000_000n

/**
 * Minimum dUSDC the AccountWrapper must hold before entering the queue
 * — covers worst-case 5-card exposure at SWIPE_QUANTITY = 1 dUSDC.
 */
export const MIN_MANAGER_BALANCE = 5n * SWIPE_QUANTITY

interface Props {
  open: boolean
  /** The duel-entry stake the user picked (dUSDC micro-units). The
   *  modal verifies the wallet holds at least `stake + (topup needed)`
   *  before letting the player into the queue. */
  stake: bigint
  onClose: () => void
  /** Called once the wallet AND manager balances are both sufficient. */
  onReady: (managerId: string) => void
}

type Phase =
  /** Reading balances. */
  | { kind: "checking" }
  /** Wallet doesn't have enough dUSDC for stake + manager top-up. */
  | {
      kind: "needs_wallet"
      needed: bigint
      current: bigint
    }
  /** Wallet OK; no AccountWrapper yet. */
  | { kind: "needs_manager" }
  /** Wallet OK; manager exists but balance < 5 dUSDC. */
  | { kind: "needs_manager_deposit"; managerId: string; current: bigint }
  /** Both checks passed. */
  | { kind: "ready"; managerId: string }
  | { kind: "error"; message: string }

export function OnboardingModal({ open, stake, onClose, onReady }: Props) {
  const account = useCurrentAccount()
  const client = useCurrentClient()
  const sign = useFlickySign()
  const [phase, setPhase] = useState<Phase>({ kind: "checking" })
  const [walletDusdc, setWalletDusdc] = useState<bigint>(0n)
  const [walletTopupOpen, setWalletTopupOpen] = useState(false)

  /**
   * Single source of truth for "what state are we in?". Reads wallet
   * + (optional) manager balances and computes the next phase. Idempotent —
   * safe to call after each tx or whenever the DepositModal closes.
   */
  const recheck = useCallback(async () => {
    if (!account) return
    setPhase({ kind: "checking" })
    try {
      const wallet = await getWalletDusdcBalance(client, account.address)
      setWalletDusdc(wallet)
      const { wrapperId, balance: wrapperBal } = await fetchAccountState(
        account.address
      )
      // How much MORE dUSDC must move from wallet into the account.
      const topup =
        wrapperBal >= MIN_MANAGER_BALANCE
          ? 0n
          : MIN_MANAGER_BALANCE - wrapperBal
      // Wallet must cover both the stake escrow AND the account top-up.
      const walletNeeded = stake + topup
      if (wallet < walletNeeded) {
        setPhase({
          kind: "needs_wallet",
          needed: walletNeeded,
          current: wallet,
        })
        return
      }
      if (!wrapperId) {
        setPhase({ kind: "needs_manager" })
        return
      }
      if (wrapperBal < MIN_MANAGER_BALANCE) {
        setPhase({
          kind: "needs_manager_deposit",
          managerId: wrapperId,
          current: wrapperBal,
        })
        return
      }
      setPhase({ kind: "ready", managerId: wrapperId })
    } catch (e) {
      setPhase({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      })
    }
  }, [account, client, stake])

  useEffect(() => {
    if (open) void recheck()
  }, [open, recheck])

  // Fire onReady at most ONCE per modal-open cycle. Without this guard
  // the effect re-runs whenever the parent re-renders (inline `onReady`
  // callback → new ref → effect deps change) and StrictMode double-
  // invokes it in dev — both paths cause duplicate `queue_join` sends
  // and a benign rate_limit error toast.
  const firedRef = useRef(false)
  useEffect(() => {
    if (!open) firedRef.current = false
  }, [open])
  useEffect(() => {
    if (phase.kind !== "ready") return
    if (firedRef.current) return
    firedRef.current = true
    onReady(phase.managerId)
  }, [phase, onReady])

  // Escape-to-close + body-scroll lock, matching DepositModal/WithdrawModal.
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

  // Portal to body so the backdrop covers the header + bottom-nav too.
  // Rendering inline would anchor to the ancestor route-transition div
  // (which uses transform), confining the overlay to <main>.
  return createPortal(
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-[2px]"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-lg rounded-md border-2 border-black/55 bg-[#1b2548] p-5 font-pixel text-white shadow-[0_6px_0_rgba(0,0,0,0.45)]"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="close"
          className="absolute top-3 right-3 grid size-7 place-items-center text-base text-white/55 hover:text-white"
        >
          ✕
        </button>
        <h2 className="mb-3 text-center text-xl tracking-[0.2em] uppercase">
          Prepare to duel
        </h2>

        {phase.kind === "checking" && (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
            <span className="size-2 animate-pulse rounded-full bg-white/55" />
            <p className="text-base tracking-wider text-white/70 uppercase">
              checking your balances&hellip;
            </p>
          </div>
        )}

        {phase.kind === "needs_wallet" && (
          <NeedsWalletStep
            needed={phase.needed}
            current={phase.current}
            stake={stake}
            onTopup={() => setWalletTopupOpen(true)}
          />
        )}

        {phase.kind === "needs_manager" && (
          <NeedsManagerStep
            walletDusdc={walletDusdc}
            onCreate={async () => {
              if (!account) return
              try {
                const tx = buildCreateAccountTx()
                const res = (await sign.mutateAsync({ transaction: tx })) as {
                  digest: string
                }
                // Sponsored-gas path returns only { digest }; the wrapper
                // address is deterministic but needs the tx to land before
                // the server can resolve it.
                const wrapperId = await waitForCreatedWrapper(
                  client,
                  res.digest,
                  account.address
                )
                // New account always has 0 balance — go straight to deposit.
                setPhase({
                  kind: "needs_manager_deposit",
                  managerId: wrapperId,
                  current: 0n,
                })
              } catch (e) {
                setPhase({
                  kind: "error",
                  message: e instanceof Error ? e.message : String(e),
                })
              }
            }}
          />
        )}

        {phase.kind === "needs_manager_deposit" && (
          <NeedsDepositStep
            current={phase.current}
            onDeposit={async () => {
              if (!account) return
              const needed = MIN_MANAGER_BALANCE - phase.current
              try {
                const tx = buildDepositDusdcTx(phase.managerId, needed)
                await sign.mutateAsync({ transaction: tx })
                setPhase({ kind: "ready", managerId: phase.managerId })
              } catch (e) {
                setPhase({
                  kind: "error",
                  message: e instanceof Error ? e.message : String(e),
                })
              }
            }}
          />
        )}

        {phase.kind === "ready" && (
          <p className="text-base text-green-400">
            Ready &mdash; joining queue&hellip;
          </p>
        )}

        {phase.kind === "error" && (
          <div className="space-y-2">
            <p className="text-base text-red-400">{phase.message}</p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void recheck()}
                className="rounded border border-white/30 bg-white/5 px-3 py-1 text-base hover:bg-white/10"
              >
                Retry
              </button>
              <button
                type="button"
                onClick={onClose}
                className="rounded border border-white/30 bg-white/5 px-3 py-1 text-base hover:bg-white/10"
              >
                Close
              </button>
            </div>
          </div>
        )}
      </div>

      {account && (
        <DepositModal
          open={walletTopupOpen}
          address={account.address}
          onClose={() => {
            setWalletTopupOpen(false)
            // Refresh balances — if the user funded the wallet, the
            // gate advances automatically.
            void recheck()
          }}
        />
      )}
    </div>,
    document.body
  )
}

function WalletToManagerFlow() {
  // Small visual: [dUSDC icon] → [manager icon].
  return (
    <div className="flex items-center justify-center gap-3 py-1">
      <div className="flex flex-col items-center gap-1">
        <img
          src="/tokens/usdc-icon.png"
          alt="dUSDC"
          className="size-10 [image-rendering:pixelated]"
        />
        <span className="text-[10px] tracking-wider text-white/55 uppercase">
          wallet
        </span>
      </div>
      <span className="text-2xl text-white/55">&rarr;</span>
      <div className="flex flex-col items-center gap-1">
        <img
          src="/tokens/manager-usdc.png"
          alt="manager dUSDC"
          className="size-10 [image-rendering:pixelated]"
        />
        <span className="text-[10px] tracking-wider text-white/55 uppercase">
          manager
        </span>
      </div>
    </div>
  )
}

function OneTimeNote() {
  return (
    <p className="rounded bg-white/5 px-3 py-2 text-xs tracking-wider text-white/55 uppercase">
      one-time setup. withdraw from manager anytime via profile.
    </p>
  )
}

function NeedsWalletStep({
  needed,
  current,
  stake,
  onTopup,
}: {
  needed: bigint
  current: bigint
  stake: bigint
  onTopup: () => void
}) {
  const short = needed - current
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-center gap-2 py-1">
        <img
          src="/tokens/usdc-icon.png"
          alt="dUSDC"
          className="size-10 [image-rendering:pixelated]"
        />
        <span className="text-xs tracking-wider text-white/55 uppercase">
          wallet dUSDC
        </span>
      </div>
      <p className="text-base text-white/80">
        Your wallet needs <strong>{fmtDusdc(needed)}</strong> total to play this
        stake: {fmtDusdc(stake)} for the duel escrow plus the manager top-up to{" "}
        {fmtDusdc(MIN_MANAGER_BALANCE)}.
      </p>
      <p className="text-sm text-white/55">
        Have: {fmtDusdc(current)} &nbsp;&middot;&nbsp; need {fmtDusdc(short)}{" "}
        more
      </p>
      <PixelButton
        onClick={onTopup}
        style={BLUE_BRAND_STYLE}
        className="h-12 w-full"
      >
        Get dUSDC
      </PixelButton>
    </div>
  )
}

function NeedsManagerStep({
  walletDusdc,
  onCreate,
}: {
  walletDusdc: bigint
  onCreate: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  return (
    <div className="space-y-3">
      <WalletToManagerFlow />
      <p className="text-base text-white/80">
        You need a manager to swipe. We&rsquo;ll create one, then deposit{" "}
        {fmtDusdc(MIN_MANAGER_BALANCE)} from your wallet.
      </p>
      <p className="text-sm text-white/55">
        Wallet balance: {fmtDusdc(walletDusdc)}
      </p>
      <OneTimeNote />
      <PixelButton
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          try {
            await onCreate()
          } finally {
            setBusy(false)
          }
        }}
        style={ORANGE_BRAND_STYLE}
        className="h-12 w-full"
      >
        {busy ? "creating…" : "create manager"}
      </PixelButton>
    </div>
  )
}

function NeedsDepositStep({
  current,
  onDeposit,
}: {
  current: bigint
  onDeposit: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const needed = MIN_MANAGER_BALANCE - current
  return (
    <div className="space-y-3">
      <WalletToManagerFlow />
      <p className="text-base text-white/80">
        Your manager has {fmtDusdc(current)}. Depositing {fmtDusdc(needed)}{" "}
        brings it to {fmtDusdc(MIN_MANAGER_BALANCE)} for the 5-card duel.
      </p>
      <OneTimeNote />
      <PixelButton
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          try {
            await onDeposit()
          } finally {
            setBusy(false)
          }
        }}
        style={ORANGE_BRAND_STYLE}
        className="h-12 w-full"
      >
        {busy ? "depositing…" : `deposit ${fmtDusdc(needed)}`}
      </PixelButton>
    </div>
  )
}
