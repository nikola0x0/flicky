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
import { MAX_PREMIUM_BUDGET, requiredManagerBalance } from "@/lib/funding"

const ORANGE_BRAND_STYLE = {
  "--btn-bg": "#e08a2b",
  "--btn-highlight": "#f4b966",
} as CSSProperties

const BLUE_BRAND_STYLE = {
  "--btn-bg": "#4094fb",
  "--btn-highlight": "#7eb6ff",
} as CSSProperties

// `SWIPE_QUANTITY`, `MIN_MANAGER_BALANCE`, `MAX_PREMIUM_BUDGET`, and
// `requiredManagerBalance` now live in `@/lib/funding` — the web's single
// source for duel funding economics, mirrored server-side in `predict.ts`, so
// the pure math is unit-tested and can't drift out of the component.

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
  /** Wallet OK; manager exists but balance < requiredManagerBalance(stake). */
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
      // Both the stake AND every swipe premium are withdrawn from the
      // AccountWrapper (`account::withdraw_funds`, see buildCreateDuelDusdcTx),
      // so the account — not the wallet — must hold `stake + premium budget`.
      // The wallet's only job is to fund that account deposit; it does NOT pay
      // the stake on top. Mirrors the server's `requiredQueueBalance` gate.
      const target = requiredManagerBalance(stake)
      // How much MORE dUSDC must move from wallet into the account.
      const topup = wrapperBal >= target ? 0n : target - wrapperBal
      if (wallet < topup) {
        setPhase({
          kind: "needs_wallet",
          needed: topup,
          current: wallet,
        })
        return
      }
      if (!wrapperId) {
        setPhase({ kind: "needs_manager" })
        return
      }
      if (wrapperBal < target) {
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
  // Reset to a clean slate on close so a re-open never inherits a stale
  // `ready` phase or a tripped fire-once guard — either would strand the
  // modal on "joining queue…" with `onReady` never re-firing.
  useEffect(() => {
    if (!open) {
      firedRef.current = false
      setPhase({ kind: "checking" })
    }
  }, [open])
  useEffect(() => {
    if (phase.kind !== "ready") return
    if (firedRef.current) return
    firedRef.current = true
    onReady(phase.managerId)
  }, [phase, onReady])

  // Backstop against a stuck "joining queue…": the parent closes us on
  // `onReady`, so reaching `ready` should unmount this modal within a frame.
  // If we're still on `ready` after a grace period, the queue-join stalled —
  // surface the recoverable error (Retry/Close) instead of hanging forever.
  useEffect(() => {
    if (!open || phase.kind !== "ready") return
    const t = setTimeout(() => {
      setPhase({
        kind: "error",
        message: "Joining is taking longer than expected — try again.",
      })
    }, 8_000)
    return () => clearTimeout(t)
  }, [open, phase])

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
            target={requiredManagerBalance(stake)}
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
            stake={stake}
            onDeposit={async () => {
              if (!account) return
              const needed = requiredManagerBalance(stake) - phase.current
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
        Your manager needs <strong>{fmtDusdc(requiredManagerBalance(stake))}</strong>{" "}
        for this stake — the {fmtDusdc(stake)} stake plus the{" "}
        {fmtDusdc(MAX_PREMIUM_BUDGET)} swipe-premium budget both come out of it.
        Funding it takes {fmtDusdc(needed)} from your wallet.
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
  target,
  onCreate,
}: {
  walletDusdc: bigint
  target: bigint
  onCreate: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  return (
    <div className="space-y-3">
      <WalletToManagerFlow />
      <p className="text-base text-white/80">
        You need a manager to swipe. We&rsquo;ll create one, then deposit{" "}
        {fmtDusdc(target)} from your wallet — enough for this duel&rsquo;s stake
        and swipe premiums, which both draw from the manager.
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
  stake,
  onDeposit,
}: {
  current: bigint
  stake: bigint
  onDeposit: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const target = requiredManagerBalance(stake)
  const needed = target - current
  return (
    <div className="space-y-3">
      <WalletToManagerFlow />
      <p className="text-base text-white/80">
        Your manager has {fmtDusdc(current)}. Depositing {fmtDusdc(needed)}{" "}
        brings it to {fmtDusdc(target)} — enough for this duel&rsquo;s{" "}
        {fmtDusdc(stake)} stake plus its swipe premiums, which both draw from
        the manager.
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
