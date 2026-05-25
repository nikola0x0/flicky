import { useState } from "react"
import type { CSSProperties } from "react"
import { Link, useNavigate } from "react-router"
import { useCurrentAccount } from "@mysten/dapp-kit"

import { BalanceChip } from "@/components/balance-chip"
import { DepositModal } from "@/components/deposit-modal"
import { MenuButton } from "@/components/menu-button"
import { PixelButton } from "@/components/pixel-button"
import { PlayerAvatar } from "@/components/player-avatar"
import {
  useDusdcBalance,
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
  const { data: suiBalance = 0 } = useSuiBalance()
  const { data: dusdcBalance = 0 } = useDusdcBalance()
  const [depositOpen, setDepositOpen] = useState(false)

  // Signed out — bounce back to /game/home where they can sign in.
  if (!account) {
    return (
      <Link to="/game/home" className="text-white underline">
        go back
      </Link>
    )
  }

  const address = account.address
  const short = shortAddress(address)

  return (
    <div className="bg-checker flex min-h-dvh w-full items-center justify-center px-3 py-1 sm:px-6">
      <div className="pixel-frame flex h-[calc(100dvh-0.5rem)] w-full max-w-[440px] flex-col overflow-hidden rounded-3xl bg-[#1b2548] font-pixel text-white sm:max-h-[900px]">
        <ProfileHeader
          onBack={() => navigate(-1)}
          dusdc={dusdcBalance}
        />

        <main className="flex-1 overflow-y-auto px-4 pb-6">
          <section className="flex items-start gap-4 pt-2">
            <div className="relative">
              <PlayerAvatar address={address} size={108} />
              <button
                type="button"
                aria-label="change avatar"
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
                <h1 className="text-lg tracking-wider">{short}</h1>
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
                onClick={() => navigator.clipboard.writeText(address)}
                aria-label="copy address"
                className="inline-flex items-center gap-1.5 text-sm text-white/70 hover:text-white"
              >
                <span className="tabular-nums">{short}</span>
                <span className="text-base">⎘</span>
              </button>
              <p className="text-xs tracking-[0.18em] text-white/55 uppercase">
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
              value="0.00"
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

          <section className="mt-5 grid grid-cols-3 gap-2">
            <ActionTile
              label="deposit"
              icon="/icons/disk_save.png"
              onClick={() => setDepositOpen(true)}
            />
            <ActionTile
              label="withdraw"
              icon="/icons/disk_load.png"
              onClick={() => {}}
            />
            <ActionTile
              label="export pk"
              icon="/icons/key_t.png"
              onClick={() => {}}
            />
          </section>

          <section className="mt-6">
            <button
              type="button"
              style={BLUE_BRAND_STYLE}
              className="default-btn-green-container flex w-full items-center justify-between px-4 py-3 text-base tracking-wider text-white uppercase"
            >
              <span className="flex items-center gap-2">
                <img
                  src="/icons/swords.png"
                  alt=""
                  aria-hidden
                  className="size-5 [image-rendering:pixelated]"
                />
                PvP Match History
              </span>
              <span className="text-sm">▾</span>
            </button>

            <div className="mt-10 text-center text-base text-white/55">
              no 1v1 history yet
            </div>
          </section>
        </main>
      </div>

      <DepositModal
        open={depositOpen}
        address={address}
        onClose={() => setDepositOpen(false)}
      />
    </div>
  )
}

function ProfileHeader({
  onBack,
  dusdc,
}: {
  onBack: () => void
  dusdc: number
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
            to="/game/shop"
          />
          <BalanceChip
            icon="/tokens/manager-usdc.png"
            amount="0.00"
            label="manager"
            to="/game/shop"
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
      <span className="text-sm tracking-wider text-white/55 uppercase">
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
      className="default-btn-green-container flex h-16 items-center justify-between gap-1 px-3 text-sm tracking-wider text-white uppercase"
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
