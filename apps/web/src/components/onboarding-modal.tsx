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

/**
 * Per-swipe Predict position size (dUSDC micro-units). Fixed at 1 dUSDC
 * in v1 — worst-case 5-card exposure = 5 * SWIPE_QUANTITY, matching the
 * PredictManager minimum below. Keep these two constants in lockstep.
 */
export const SWIPE_QUANTITY = 1_000_000n

/**
 * Minimum dUSDC the PredictManager must hold before entering the queue
 * — covers worst-case 5-card exposure at SWIPE_QUANTITY = 1 dUSDC.
 */
export const MIN_MANAGER_BALANCE = 5n * SWIPE_QUANTITY

interface Props {
  open: boolean
  onClose: () => void
  /** Called once the wallet has a manager funded to ≥ MIN_MANAGER_BALANCE. */
  onReady: (managerId: string) => void
}

type Phase =
  | { kind: "checking" }
  | { kind: "needs_manager" }
  | { kind: "needs_deposit"; managerId: string; current: bigint }
  | { kind: "ready"; managerId: string }
  | { kind: "error"; message: string }

export function OnboardingModal({ open, onClose, onReady }: Props) {
  const account = useCurrentAccount()
  const client = useSuiClient()
  const sign = useFlickySign()
  const [phase, setPhase] = useState<Phase>({ kind: "checking" })
  const [walletDusdc, setWalletDusdc] = useState<bigint>(0n)

  const recheck = useCallback(async () => {
    if (!account) return
    setPhase({ kind: "checking" })
    try {
      const wallet = await getWalletDusdcBalance(client, account.address)
      setWalletDusdc(wallet)
      const mgr = await findPredictManager(client, account.address)
      if (!mgr) {
        setPhase({ kind: "needs_manager" })
        return
      }
      const bal = await getManagerDusdcBalance(client, mgr.id)
      if (bal >= MIN_MANAGER_BALANCE) {
        setPhase({ kind: "ready", managerId: mgr.id })
        return
      }
      setPhase({ kind: "needs_deposit", managerId: mgr.id, current: bal })
    } catch (e) {
      setPhase({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      })
    }
  }, [account, client])

  // Re-check whenever the modal opens or the account changes.
  useEffect(() => {
    if (open) void recheck()
  }, [open, recheck])

  // Notify caller exactly once when we reach `ready`.
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
          <p className="text-sm text-white/70">
            Checking your Predict account&hellip;
          </p>
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
                const bal = await getManagerDusdcBalance(client, mgrId)
                if (bal >= MIN_MANAGER_BALANCE) {
                  setPhase({ kind: "ready", managerId: mgrId })
                } else {
                  setPhase({
                    kind: "needs_deposit",
                    managerId: mgrId,
                    current: bal,
                  })
                }
              } catch (e) {
                setPhase({
                  kind: "error",
                  message: e instanceof Error ? e.message : String(e),
                })
              }
            }}
          />
        )}

        {phase.kind === "needs_deposit" && (
          <NeedsDepositStep
            current={phase.current}
            walletDusdc={walletDusdc}
            onDeposit={async () => {
              if (!account) return
              const needed = MIN_MANAGER_BALANCE - phase.current
              if (walletDusdc < needed) {
                setPhase({
                  kind: "error",
                  message: `Wallet has ${fmtDusdc(walletDusdc)} but needs ${fmtDusdc(needed)} to top up to 5 dUSDC.`,
                })
                return
              }
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
          <p className="text-sm text-green-400">Ready — joining queue&hellip;</p>
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
        You need a Predict account to swipe. We&rsquo;ll create one, then deposit
        5 dUSDC.
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
  walletDusdc,
  onDeposit,
}: {
  current: bigint
  walletDusdc: bigint
  onDeposit: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const needed = MIN_MANAGER_BALANCE - current
  const insufficient = walletDusdc < needed
  return (
    <div className="space-y-3">
      <p className="text-sm text-white/80">
        Your Predict account has {fmtDusdc(current)}. We need{" "}
        {fmtDusdc(MIN_MANAGER_BALANCE)} for a worst-case 5-card duel.
      </p>
      <p className="text-xs text-white/55">
        Wallet balance: {fmtDusdc(walletDusdc)} · deposit needed:{" "}
        {fmtDusdc(needed)}
      </p>
      <button
        type="button"
        disabled={busy || insufficient}
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
        {busy
          ? "Depositing…"
          : insufficient
            ? "Insufficient dUSDC in wallet"
            : `Deposit ${fmtDusdc(needed)}`}
      </button>
    </div>
  )
}
