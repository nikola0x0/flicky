import { useCallback, useEffect, useState } from "react"
import { useCurrentAccount, useSuiClient } from "@mysten/dapp-kit"
import { useFlickySign } from "@/lib/use-flicky-sign"
import {
  buildCreateManagerTx,
  buildDepositDusdcTx,
  findPredictManager,
  fmtDusdc,
  getManagerDusdcBalance,
  getWalletDusdcBalance,
  writeManagerCache,
  extractManagerIdFromChanges,
} from "@/lib/deepbook"
import { DepositModal } from "@/components/deposit-modal"

/**
 * Per-swipe Predict position size (dUSDC micro-units). Fixed at 1 dUSDC
 * in v1 — worst-case 5-card exposure = 5 * SWIPE_QUANTITY, matching
 * MIN_MANAGER_BALANCE below. Keep these two constants in lockstep.
 */
export const SWIPE_QUANTITY = 1_000_000n

/**
 * Minimum dUSDC the PredictManager must hold before entering the queue
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
  /** Wallet OK; no PredictManager yet. */
  | { kind: "needs_manager" }
  /** Wallet OK; manager exists but balance < 5 dUSDC. */
  | { kind: "needs_manager_deposit"; managerId: string; current: bigint }
  /** Both checks passed. */
  | { kind: "ready"; managerId: string }
  | { kind: "error"; message: string }

export function OnboardingModal({ open, stake, onClose, onReady }: Props) {
  const account = useCurrentAccount()
  const client = useSuiClient()
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
      const mgr = await findPredictManager(client, account.address)
      const mgrBal = mgr
        ? await getManagerDusdcBalance(client, mgr.id)
        : 0n
      // How much MORE dUSDC must move from wallet into the manager.
      const topup =
        mgrBal >= MIN_MANAGER_BALANCE ? 0n : MIN_MANAGER_BALANCE - mgrBal
      // Wallet must cover both the stake escrow AND the manager top-up.
      const walletNeeded = stake + topup
      if (wallet < walletNeeded) {
        setPhase({
          kind: "needs_wallet",
          needed: walletNeeded,
          current: wallet,
        })
        return
      }
      if (!mgr) {
        setPhase({ kind: "needs_manager" })
        return
      }
      if (mgrBal < MIN_MANAGER_BALANCE) {
        setPhase({
          kind: "needs_manager_deposit",
          managerId: mgr.id,
          current: mgrBal,
        })
        return
      }
      setPhase({ kind: "ready", managerId: mgr.id })
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

  useEffect(() => {
    if (phase.kind === "ready") onReady(phase.managerId)
  }, [phase, onReady])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-md border-2 border-black/55 bg-[#1b2548] p-5 text-white shadow-[0_6px_0_rgba(0,0,0,0.45)]">
        <h2 className="mb-3 text-xl tracking-[0.2em] uppercase">
          Prepare to duel
        </h2>

        {phase.kind === "checking" && (
          <p className="text-sm text-white/70">Checking your balances&hellip;</p>
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
                const tx = buildCreateManagerTx()
                const res = await sign.mutateAsync({ transaction: tx })
                const mgrId = extractManagerIdFromChanges(
                  (
                    res as {
                      objectChanges?: Array<{
                        type: string
                        objectType?: string
                        objectId?: string
                      }>
                    }
                  ).objectChanges ?? [],
                )
                if (!mgrId) {
                  throw new Error(
                    "create_manager tx succeeded but PredictManager id not in objectChanges",
                  )
                }
                writeManagerCache(account.address, mgrId)
                // New manager always has 0 balance — go straight to deposit.
                setPhase({
                  kind: "needs_manager_deposit",
                  managerId: mgrId,
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
                const tx = await buildDepositDusdcTx(
                  client,
                  account.address,
                  phase.managerId,
                  needed,
                )
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
          <p className="text-sm text-green-400">
            Ready &mdash; joining queue&hellip;
          </p>
        )}

        {phase.kind === "error" && (
          <div className="space-y-2">
            <p className="text-sm text-red-400">{phase.message}</p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void recheck()}
                className="rounded border border-white/30 bg-white/5 px-3 py-1 text-sm hover:bg-white/10"
              >
                Retry
              </button>
              <button
                type="button"
                onClick={onClose}
                className="rounded border border-white/30 bg-white/5 px-3 py-1 text-sm hover:bg-white/10"
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
    </div>
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
      <p className="text-sm text-white/80">
        Your zkLogin wallet needs <strong>{fmtDusdc(needed)}</strong> total to
        play this stake: {fmtDusdc(stake)} for the duel escrow plus enough to
        top your Predict account to {fmtDusdc(MIN_MANAGER_BALANCE)}.
      </p>
      <p className="text-xs text-white/55">
        Have: {fmtDusdc(current)} &nbsp;·&nbsp; need {fmtDusdc(short)} more
      </p>
      <button
        type="button"
        onClick={onTopup}
        className="w-full rounded-md bg-[#4094fb] px-4 py-2 text-lg font-bold text-white"
      >
        Get dUSDC
      </button>
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
      <p className="text-sm text-white/80">
        You need a Predict account to swipe. We&rsquo;ll create one, then
        deposit {fmtDusdc(MIN_MANAGER_BALANCE)}.
      </p>
      <p className="text-xs text-white/55">
        Wallet balance: {fmtDusdc(walletDusdc)}
      </p>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          try {
            await onCreate()
          } finally {
            setBusy(false)
          }
        }}
        className="w-full rounded-md bg-[#e08a2b] px-4 py-2 text-lg font-bold text-white disabled:opacity-50"
      >
        {busy ? "Creating…" : "Create Predict account"}
      </button>
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
      <p className="text-sm text-white/80">
        Your Predict account has {fmtDusdc(current)}. Depositing{" "}
        {fmtDusdc(needed)} brings it to {fmtDusdc(MIN_MANAGER_BALANCE)} for the
        5-card duel.
      </p>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          try {
            await onDeposit()
          } finally {
            setBusy(false)
          }
        }}
        className="w-full rounded-md bg-[#e08a2b] px-4 py-2 text-lg font-bold text-white disabled:opacity-50"
      >
        {busy ? "Depositing…" : `Deposit ${fmtDusdc(needed)}`}
      </button>
    </div>
  )
}
