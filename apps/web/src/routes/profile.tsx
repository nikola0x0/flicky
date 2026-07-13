import { useState } from "react"
import type { CSSProperties } from "react"
import { Navigate, useLocation, useNavigate } from "react-router"
import { setPendingSwipe } from "@/lib/nav-transition"
import { DeviceFrame } from "@/components/device-frame"
import { useCurrentAccount } from "@mysten/dapp-kit-react"

import { AvatarPickerModal } from "@/components/avatar-picker-modal"
import { BalanceChip } from "@/components/balance-chip"
import { DepositModal } from "@/components/deposit-modal"
import { WithdrawModal } from "@/components/withdraw-modal"
import { MenuButton } from "@/components/menu-button"
import { PixelButton } from "@/components/pixel-button"
import { PlayerAvatar } from "@/components/player-avatar"
import {
  useDusdcBalance,
  useManagerBalance,
  useSuiBalance,
} from "@/hooks/use-wallet-balances"

const BLUE_BRAND_STYLE = {
  "--btn-bg": "#4094fb",
  "--btn-highlight": "#7eb6ff",
} as CSSProperties

/**
 * Player profile screen — same mobile-frame shell as the game routes,
 * but with its own header (back arrow + balance chips) and no bottom
 * nav. Reached by clicking the avatar in the game header.
 *
 * Layout mirrors the reference: avatar + identity, divider, 3 stats,
 * 3 action buttons, then a 1v1 history list with an empty state.
 */
export default function Profile() {
  const account = useCurrentAccount()
  const navigate = useNavigate()
  const location = useLocation()
  // Where the avatar was clicked from, so "back" returns to that exact tab
  // (and animates) instead of a bare history pop.
  const backTo =
    (location.state as { from?: string } | null)?.from ?? "/game/home"
  const { data: suiBalance = 0 } = useSuiBalance()
  const { data: dusdcBalance = 0 } = useDusdcBalance()
  const { data: managerInfo } = useManagerBalance()
  const managerBalance = managerInfo?.balance ?? 0
  const [depositOpen, setDepositOpen] = useState(false)
  const [withdrawOpen, setWithdrawOpen] = useState(false)
  const [avatarOpen, setAvatarOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  const handleCopyAddress = async () => {
    if (!account) return
    try {
      await navigator.clipboard.writeText(account.address)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* ignore */
    }
  }

  // Signed out (e.g. logout from the menu while on this page) — bounce
  // to /game/home rather than render a stripped-down fallback.
  if (!account) {
    return <Navigate to="/game/home" replace />
  }

  const address = account.address
  const short = shortAddress(address)

  return (
    <>
      <DeviceFrame className="bg-[#1b2548]">
        <ProfileHeader
          onBack={() => {
            // Tell the game outlet to swipe in from the left on its next mount.
            setPendingSwipe("route-swipe-from-left")
            navigate(backTo)
          }}
          onAdd={() => setDepositOpen(true)}
          dusdc={dusdcBalance}
          managerDusdc={managerBalance}
        />

        <main className="route-swipe-from-right flex-1 overflow-y-auto px-4 pb-6">
          <section className="flex items-start gap-4 pt-2">
            <div className="relative">
              <PlayerAvatar address={address} size={108} />
              <button
                type="button"
                aria-label="change avatar"
                onClick={() => setAvatarOpen(true)}
                className="absolute -right-1 -bottom-1 grid size-8 place-items-center rounded-full bg-black text-white shadow-[0_0_0_2px_#1b2548]"
              >
                <img
                  src="/icons/camera_edit.png"
                  alt=""
                  aria-hidden
                  className="size-4 [image-rendering:pixelated]"
                />
              </button>
            </div>

            <div className="flex flex-1 flex-col gap-2 pt-1">
              <div className="flex items-center gap-2">
                <h1 className="text-2xl tracking-wider">{short}</h1>
                <button
                  type="button"
                  aria-label="info"
                  className="text-white/55 hover:text-white"
                >
                  ⓘ
                </button>
              </div>
              <button
                type="button"
                onClick={() => void handleCopyAddress()}
                aria-label="copy address"
                className={`inline-flex items-center gap-2 text-lg transition-colors duration-200 ${
                  copied ? "text-emerald-300" : "text-white/70 hover:text-white"
                }`}
              >
                <span className="tabular-nums">{short}</span>
                <span className="text-2xl leading-none">
                  {copied ? "✓" : "⎘"}
                </span>
                {copied && (
                  <span className="text-xs tracking-[0.18em] uppercase">
                    copied
                  </span>
                )}
              </button>
              <p className="text-sm tracking-[0.18em] text-white/55 uppercase">
                connected via google
              </p>
            </div>
          </section>

          <div className="my-5 h-px bg-white/10" />

          <section className="grid grid-cols-2 gap-3 text-center">
            <Stat
              icon="/tokens/usdc-icon.png"
              label="dusdc"
              value={dusdcBalance.toFixed(2)}
            />
            <Stat
              icon="/tokens/manager-usdc.png"
              label="manager dusdc"
              value={managerBalance.toFixed(2)}
            />
          </section>

          <section className="mt-3">
            <div className="flex items-center justify-between rounded-2xl bg-white/5 px-5 py-4">
              <div className="flex items-center gap-3">
                <img
                  src="/tokens/sui.png"
                  alt=""
                  aria-hidden
                  className="size-10 [image-rendering:pixelated]"
                />
                <span className="text-lg tracking-[0.18em] text-white/55 uppercase">
                  sui
                </span>
              </div>
              <span className="text-3xl text-white tabular-nums">
                {suiBalance.toFixed(4)}
              </span>
            </div>
          </section>

          <section className="mt-5 grid grid-cols-2 gap-2">
            <ActionTile
              label="deposit"
              icon="/icons/disk_save.png"
              onClick={() => setDepositOpen(true)}
            />
            <ActionTile
              label="withdraw"
              icon="/icons/disk_load.png"
              onClick={() => setWithdrawOpen(true)}
            />
          </section>

          <section className="mt-6">
            <button
              type="button"
              style={BLUE_BRAND_STYLE}
              className="default-btn-green-container flex w-full items-center justify-between px-4 py-3 text-base text-lg tracking-wider text-white uppercase"
            >
              <span className="flex items-center gap-2">
                <img
                  src="/icons/swords.png"
                  alt=""
                  aria-hidden
                  className="size-5 [image-rendering:pixelated]"
                />
                pvp history
              </span>
              <span className="text-base">▾</span>
            </button>

            <div className="mt-10 text-center text-base text-white/55">
              no 1v1 history yet
            </div>
          </section>

          {/* Required by the Uppbeat free-tier license for bgm.mp3 — see
              apps/web/public/sounds/SOURCES.md. Keep visible somewhere. */}
          <p className="mt-10 text-center text-[10px] leading-relaxed tracking-[0.05em] text-white/25">
            Music from{" "}
            <a
              href="https://uppbeat.io/t/pecan-pie/boogie"
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              #Uppbeat
            </a>{" "}
            (free for Creators!) — License code: 7JEHN7VMRUTPZCDU
          </p>
        </main>
      </DeviceFrame>

      <DepositModal
        open={depositOpen}
        address={address}
        onClose={() => setDepositOpen(false)}
      />
      <WithdrawModal
        open={withdrawOpen}
        address={address}
        onClose={() => setWithdrawOpen(false)}
      />
      <AvatarPickerModal
        open={avatarOpen}
        address={address}
        onClose={() => setAvatarOpen(false)}
      />
    </>
  )
}

function ProfileHeader({
  onBack,
  onAdd,
  dusdc,
  managerDusdc,
}: {
  onBack: () => void
  onAdd: () => void
  dusdc: number
  managerDusdc: number
}) {
  return (
    <header className="flex items-center justify-between gap-2 px-3 py-3">
      <div className="flex items-center gap-5">
        <div className="flex size-14 items-center justify-center">
          <PixelButton
            onClick={onBack}
            style={BLUE_BRAND_STYLE}
            aria-label="back"
            className="-ml-8 h-8 w-16 !p-0"
          >
            <img
              src="/icons/arrow_blue_left.png"
              alt=""
              aria-hidden
              className="size-5 [image-rendering:pixelated]"
            />
          </PixelButton>
        </div>
        <div className="flex items-center gap-4">
          <BalanceChip
            icon="/tokens/usdc-icon.png"
            amount={dusdc.toFixed(2)}
            label="wallet"
            onClick={onAdd}
          />
          <BalanceChip
            icon="/tokens/manager-usdc.png"
            amount={managerDusdc.toFixed(2)}
            label="manager"
            onClick={onAdd}
          />
        </div>
      </div>
      <MenuButton />
    </header>
  )
}

function Stat({
  icon,
  label,
  value,
}: {
  icon: string
  label: string
  value: string
}) {
  return (
    <div className="flex flex-col items-center gap-1.5 rounded-2xl bg-white/5 py-3">
      <img
        src={icon}
        alt=""
        aria-hidden
        className="size-8 [image-rendering:pixelated]"
      />
      <span className="text-lg tracking-wider text-white/55 uppercase">
        {label}
      </span>
      <span className="text-3xl tabular-nums">{value}</span>
    </div>
  )
}

function ActionTile({
  icon,
  label,
  onClick,
}: {
  icon: string
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={BLUE_BRAND_STYLE}
      className="default-btn-green-container flex h-16 items-center justify-between gap-1 px-3 text-lg tracking-wider text-white uppercase"
    >
      <span>{label}</span>
      <img
        src={icon}
        alt=""
        aria-hidden
        className="size-7 [image-rendering:pixelated]"
      />
    </button>
  )
}

function shortAddress(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}
