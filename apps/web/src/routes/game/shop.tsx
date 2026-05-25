import { useCallback, useEffect, useMemo, useState } from "react"
import type { CSSProperties } from "react"
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClient,
} from "@mysten/dapp-kit"

import { PixelButton } from "@/components/pixel-button"
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
  buildSwapTx,
  estimateSwapOutput,
  fetchPoolReserves,
  isSwapConfigured,
  toRawAmount,
  type PoolReserves,
  type SwapDirection,
} from "@/lib/swap"

const BLUE_BRAND_STYLE = {
  "--btn-bg": "#4094fb",
  "--btn-highlight": "#7eb6ff",
} as CSSProperties

const SUI_ICON = "/tokens/sui.png"
const DUSDC_ICON = "/tokens/usdc-icon.png"

interface TokenMeta {
  symbol: string
  icon: string
  coinType: string
  decimals: number
}

const SUI_TOKEN: TokenMeta = {
  symbol: "SUI",
  icon: SUI_ICON,
  coinType: SUI_COIN_TYPE,
  decimals: SUI_DECIMALS,
}
const DUSDC_TOKEN: TokenMeta = {
  symbol: "dUSDC",
  icon: DUSDC_ICON,
  coinType: DUSDC_COIN_TYPE,
  decimals: DUSDC_DECIMALS,
}

/**
 * /game/shop — pixel-art AMM swap card for SUI ↔ dUSDC. The Predict
 * deck stakes are dUSDC, but zkLogin wallets only hold SUI from the
 * faucet, so this screen is the bridge. Constant-product pricing,
 * reserves live-read on mount and after each swap.
 */
export default function GameShop() {
  const account = useCurrentAccount()
  const client = useSuiClient()
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction()

  const [direction, setDirection] = useState<SwapDirection>("sui_to_dusdc")
  const [inputAmount, setInputAmount] = useState("1")
  const [slippagePct, setSlippagePct] = useState("1")
  const [pool, setPool] = useState<PoolReserves | null>(null)
  const { data: walletSui = 0 } = useSuiBalance()
  const { data: walletDusdc = 0 } = useDusdcBalance()
  const invalidateBalances = useInvalidateWalletBalances()
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{
    kind: "ok" | "err"
    msg: string
  } | null>(null)

  const fromToken = direction === "sui_to_dusdc" ? SUI_TOKEN : DUSDC_TOKEN
  const toToken = direction === "sui_to_dusdc" ? DUSDC_TOKEN : SUI_TOKEN
  const fromBalance = direction === "sui_to_dusdc" ? walletSui : walletDusdc
  const toBalance = direction === "sui_to_dusdc" ? walletDusdc : walletSui

  const inputNum = parseFloat(inputAmount) || 0
  const slipNum = Math.max(0, parseFloat(slippagePct) || 0)

  const estimatedOut = useMemo(() => {
    if (!pool) return 0
    return estimateSwapOutput(pool, direction, inputNum)
  }, [pool, direction, inputNum])
  const minOut = estimatedOut * (1 - slipNum / 100)

  const refreshPool = useCallback(async () => {
    if (!isSwapConfigured()) return
    try {
      const p = await fetchPoolReserves(client, account?.address)
      setPool(p)
    } catch (err) {
      console.error("pool refresh failed", err)
    }
  }, [client, account])

  useEffect(() => {
    refreshPool()
  }, [refreshPool])

  const handleSwap = async () => {
    if (!account || !pool || inputNum <= 0 || busy) return
    setBusy(true)
    setStatus(null)
    try {
      const inputRaw = toRawAmount(inputNum, fromToken.decimals)
      const minOutRaw = toRawAmount(minOut, toToken.decimals)
      const tx = await buildSwapTx(
        client,
        account.address,
        direction,
        inputRaw,
        minOutRaw,
      )
      const result = await signAndExecute({ transaction: tx })
      setStatus({
        kind: "ok",
        msg: `swap complete — ${result.digest.slice(0, 10)}…`,
      })
      setTimeout(() => {
        refreshPool()
        invalidateBalances()
      }, 1500)
    } catch (err) {
      setStatus({ kind: "err", msg: String((err as Error).message || err) })
    } finally {
      setBusy(false)
    }
  }

  if (!isSwapConfigured()) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <img
          src="/icons/clear.png"
          alt=""
          aria-hidden
          className="size-14 [image-rendering:pixelated]"
        />
        <p className="text-base tracking-[0.15em] text-white uppercase">
          swap unavailable
        </p>
        <p className="text-xs text-white/55">
          set VITE_SWAP_POOL_ID in .env.local
        </p>
      </div>
    )
  }

  if (!account) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-base tracking-[0.15em] text-white uppercase">
          sign in to swap
        </p>
        <p className="text-xs text-white/55">
          use the sign-in button in the header
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4 px-4 py-4">
      <header className="flex items-center justify-between">
        <h2 className="text-2xl tracking-[0.2em] text-white uppercase">
          swap
        </h2>
        <button
          type="button"
          onClick={() => {
            refreshPool()
            invalidateBalances()
          }}
          aria-label="refresh"
          className="grid size-8 place-items-center rounded-md text-white/55 hover:text-white"
        >
          <img
            src="/icons/arrow_refresh.png"
            alt=""
            aria-hidden
            className="size-5 [image-rendering:pixelated]"
          />
        </button>
      </header>

      <div className="relative flex flex-col gap-1">
        <TokenInputCard
          label="you pay"
          token={fromToken}
          balance={fromBalance}
          value={inputAmount}
          onChange={setInputAmount}
          onMax={() => setInputAmount(fromBalance.toString())}
        />
        <DirectionToggle
          disabled={busy}
          onClick={() =>
            setDirection((d) =>
              d === "sui_to_dusdc" ? "dusdc_to_sui" : "sui_to_dusdc",
            )
          }
        />
        <TokenInputCard
          label="you receive"
          token={toToken}
          balance={toBalance}
          value={estimatedOut > 0 ? estimatedOut.toFixed(6) : "0.0"}
          readOnly
        />
      </div>

      <div className="rounded-xl bg-white/5 px-4 py-3">
        <div className="flex items-center justify-between text-xs">
          <span className="tracking-wider text-white/55 uppercase">
            slippage
          </span>
          <div className="flex items-center gap-1.5">
            <input
              type="number"
              value={slippagePct}
              onChange={(e) => {
                const v = e.target.value
                if (v === "" || parseFloat(v) >= 0) setSlippagePct(v)
              }}
              min={0}
              step="any"
              className="w-14 rounded-md bg-black/30 px-2 py-1 text-right text-sm text-white tabular-nums focus:outline-none"
            />
            <span className="text-sm text-white/55">%</span>
          </div>
        </div>
        <div className="mt-2 flex items-center justify-between border-t border-white/5 pt-2 text-xs">
          <span className="tracking-wider text-white/55 uppercase">
            min received
          </span>
          <span className="tabular-nums text-white">
            {minOut > 0 ? minOut.toFixed(6) : "0.000000"} {toToken.symbol}
          </span>
        </div>
      </div>

      <PixelButton
        onClick={handleSwap}
        disabled={busy || !pool || inputNum <= 0 || inputNum > fromBalance}
        className="h-12 w-full text-base"
      >
        {busy
          ? "swapping…"
          : inputNum > fromBalance
            ? `not enough ${fromToken.symbol.toLowerCase()}`
            : `swap ${fromToken.symbol} → ${toToken.symbol}`}
      </PixelButton>

      {status && (
        <div
          className={`rounded-lg px-3 py-2 text-xs ${
            status.kind === "ok"
              ? "bg-emerald-500/15 text-emerald-200"
              : "bg-rose-500/15 text-rose-200"
          }`}
        >
          {status.msg}
        </div>
      )}

      {pool && (
        <div className="rounded-xl bg-white/5 px-4 py-3 text-xs">
          <div className="mb-2 tracking-[0.18em] text-white/45 uppercase">
            pool
          </div>
          <PoolRow label="spot" value={`1 SUI = ${pool.spotPrice.toFixed(4)} dUSDC`} />
          <PoolRow label="fee" value={`${(pool.feeBps / 100).toFixed(2)}%`} />
          <PoolRow
            label="reserves"
            value={`${pool.reserveSui.toFixed(2)} / ${pool.reserveDusdc.toFixed(2)}`}
          />
        </div>
      )}
    </div>
  )
}

function TokenInputCard({
  label,
  token,
  balance,
  value,
  onChange,
  onMax,
  readOnly,
}: {
  label: string
  token: TokenMeta
  balance: number
  value: string
  onChange?: (v: string) => void
  onMax?: () => void
  readOnly?: boolean
}) {
  return (
    <div className="rounded-2xl bg-black/35 px-4 py-3 ring-1 ring-white/5">
      <div className="flex items-center justify-between">
        <span className="text-[10px] tracking-[0.18em] text-white/55 uppercase">
          {label}
        </span>
        {!readOnly && (
          <button
            type="button"
            onClick={onMax}
            disabled={!onMax}
            className="flex items-center gap-1.5 text-white/70 hover:text-white disabled:cursor-default disabled:hover:text-white/70"
          >
            <span className="text-[10px] tracking-wider uppercase">bal</span>
            <span className="text-sm tabular-nums text-white">
              {balance.toFixed(4)}
            </span>
            {onMax && (
              <span className="ml-1 rounded bg-white/10 px-1.5 py-0.5 text-[10px] tracking-wider text-white uppercase">
                max
              </span>
            )}
          </button>
        )}
      </div>
      <div className="mt-1 flex items-center gap-3">
        <input
          type="number"
          value={value}
          onChange={(e) => {
            const v = e.target.value
            if (v === "" || parseFloat(v) >= 0) onChange?.(v)
          }}
          placeholder="0.0"
          readOnly={readOnly}
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
            {token.symbol}
          </span>
        </div>
      </div>
    </div>
  )
}

function DirectionToggle({
  onClick,
  disabled,
}: {
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <div className="relative h-0">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label="switch direction"
        style={BLUE_BRAND_STYLE}
        className="default-btn-green-container with-border absolute left-1/2 top-0 grid size-9 -translate-x-1/2 -translate-y-1/2 place-items-center !p-0"
      >
        <img
          src="/icons/arrow_switch.png"
          alt=""
          aria-hidden
          className="size-4 [image-rendering:pixelated]"
        />
      </button>
    </div>
  )
}

function PoolRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className="tracking-wider text-white/55 uppercase">{label}</span>
      <span className="tabular-nums text-white">{value}</span>
    </div>
  )
}
