import { Fragment, useEffect, useRef, useState } from "react"
import { Link, NavLink, Outlet, useLocation } from "react-router"
import type { CSSProperties } from "react"
import { useCurrentAccount } from "@mysten/dapp-kit"

import { BalanceChip } from "@/components/balance-chip"
import { LoginModal } from "@/components/login-modal"
import { MenuButton } from "@/components/menu-button"
import { PixelButton } from "@/components/pixel-button"
import { PlayerAvatar } from "@/components/player-avatar"
import { useDusdcBalance } from "@/hooks/use-wallet-balances"

const SIGN_IN_BRAND_STYLE = {
  "--btn-bg": "#4094fb",
  "--btn-highlight": "#7eb6ff",
} as CSSProperties

const NAV_TABS = [
  { to: "/game/home", label: "home", icon: "/icons/main_menu.png" },
  { to: "/game/rank", label: "rank", icon: "/icons/star.png" },
  {
    to: "/game/pvp",
    label: "pvp",
    icon: "/icons/swords.png",
    featured: true,
  },
  { to: "/game/shop", label: "shop", icon: "/icons/coins.png" },
  { to: "/game/inventory", label: "inv", icon: "/icons/inventory.png" },
] as const

const BEVEL_GRADIENT =
  "bg-[linear-gradient(rgb(90,122,191),rgb(58,79,138),rgb(29,43,83))]"

/**
 * Game shell — outer checkered cream background, centered mobile-shaped
 * frame, persistent header + bottom-nav. Routed game pages render into
 * the <Outlet />. Inside the frame, font-pixel is the default typeface.
 */
export default function GameLayout() {
  const [loginOpen, setLoginOpen] = useState(false)
  const location = useLocation()
  const isPvp = location.pathname === "/game/pvp"

  return (
    <>
      <div className="bg-checker flex min-h-dvh w-full items-center justify-center px-3 py-1 sm:px-6">
        <div
          className={`pixel-frame flex h-[calc(100dvh-0.5rem)] w-full max-w-[440px] flex-col overflow-hidden rounded-3xl font-pixel text-white sm:max-h-[900px] ${isPvp ? "bg-checker-dark" : "bg-[#1b2548]"}`}
        >
          <FrameHeader onSignInClick={() => setLoginOpen(true)} />
          <main className="flex-1 overflow-hidden">
            <GameOutletTransition />
          </main>
          <FrameBottomNav />
        </div>
      </div>

      <LoginModal open={loginOpen} onClose={() => setLoginOpen(false)} />
    </>
  )
}

/**
 * Wraps the routed game-page <Outlet /> with a horizontal swipe
 * transition. Direction is computed from NAV_TABS order: moving to a
 * tab further right slides in from the right; moving left slides from
 * the left. Tabs not in NAV_TABS (initial mount, deep links) get no
 * transition. Inner div is keyed on pathname to force remount per
 * navigation so the CSS keyframe replays.
 */
function GameOutletTransition() {
  const location = useLocation()
  const prevPathRef = useRef<string | null>(null)

  const tabIndex = (path: string) => NAV_TABS.findIndex((t) => t.to === path)
  const prevIdx = prevPathRef.current ? tabIndex(prevPathRef.current) : -1
  const currIdx = tabIndex(location.pathname)

  let animClass = ""
  if (prevPathRef.current && prevIdx !== -1 && currIdx !== -1) {
    animClass =
      currIdx > prevIdx
        ? "route-swipe-from-right"
        : currIdx < prevIdx
          ? "route-swipe-from-left"
          : ""
  }

  useEffect(() => {
    prevPathRef.current = location.pathname
  }, [location.pathname])

  return (
    <div
      key={location.pathname}
      className={`h-full overflow-y-auto ${animClass}`}
    >
      <Outlet />
    </div>
  )
}

function FrameHeader({ onSignInClick }: { onSignInClick: () => void }) {
  const account = useCurrentAccount()
  const location = useLocation()
  const isShop = location.pathname === "/game/shop"

  return (
    <header
      className={`flex justify-between gap-2 px-3 py-3 ${
        isShop
          ? "min-h-[128px] items-start bg-[url('/decorations/top-decor.png')] bg-[length:auto_100%] bg-repeat-x [image-rendering:pixelated]"
          : "items-center"
      } `}
    >
      {account ? (
        <HeaderBalances address={account.address} />
      ) : (
        <PixelButton
          onClick={onSignInClick}
          style={SIGN_IN_BRAND_STYLE}
          className="h-10 px-3 text-sm"
        >
          <span className="flex items-center gap-2">
            <img
              src="/icons/portrait.png"
              alt=""
              aria-hidden
              className="size-5 [image-rendering:pixelated]"
            />
            sign in
          </span>
        </PixelButton>
      )}
      {!isShop && <MenuButton />}
    </header>
  )
}

function HeaderBalances({ address }: { address: string }) {
  const { data: dusdc } = useDusdcBalance()
  return (
    <div className="flex items-center gap-5">
      <Link
        to="/profile"
        aria-label="open profile"
        className="transition-opacity hover:opacity-85"
      >
        <PlayerAvatar address={address} size={56} />
      </Link>
      <div className="flex items-center gap-4">
        <BalanceChip
          icon="/tokens/usdc-icon.png"
          amount={(dusdc ?? 0).toFixed(2)}
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
  )
}

function FrameBottomNav() {
  return (
    <div className="bg-[#1b2548]">
      <div
        className={`h-1 ${BEVEL_GRADIENT} shadow-[0_-2px_0_rgba(0,0,0,0.35)]`}
      />
      <nav className="flex items-stretch px-2 py-2">
        {NAV_TABS.map((tab, i) => (
          <Fragment key={tab.to}>
            {i > 0 && (
              <div aria-hidden className="w-px self-stretch bg-black/40" />
            )}
            {"featured" in tab && tab.featured ? (
              <FeaturedNavTab to={tab.to} label={tab.label} icon={tab.icon} />
            ) : (
              <NavTab to={tab.to} label={tab.label} icon={tab.icon} />
            )}
          </Fragment>
        ))}
      </nav>
    </div>
  )
}

function NavTab({
  to,
  label,
  icon,
}: {
  to: string
  label: string
  icon: string
}) {
  return (
    <NavLink
      to={to}
      aria-label={label}
      className={({ isActive }) =>
        `relative flex flex-1 items-center justify-center px-1 py-2 transition-opacity ${
          isActive ? "opacity-100" : "opacity-55 hover:opacity-85"
        }`
      }
    >
      {({ isActive }) => (
        <>
          {isActive && (
            <div
              aria-hidden
              className="absolute inset-x-[20%] -top-2 h-[3px] bg-[#7ec8e3] shadow-[0_0_0_1px_#000,0_1px_0_#3f7a9a]"
            />
          )}
          <img
            src={icon}
            alt={label}
            className={`size-12 transition-transform duration-100 [image-rendering:pixelated] ${
              isActive ? "-translate-y-1" : ""
            }`}
          />
        </>
      )}
    </NavLink>
  )
}

/**
 * The "headline" nav tab — used for the primary action (PvP). Renders
 * the icon inside a gold-bordered cabinet tile that lifts above the
 * nav baseline so it reads as the dominant CTA in the bottom bar.
 *
 * Self-contained: doesn't share the top-strip / opacity-dim selection
 * cues used by <NavTab>. The frame itself is the indicator that this
 * tab is special.
 */
function FeaturedNavTab({
  to,
  label,
  icon,
}: {
  to: string
  label: string
  icon: string
}) {
  return (
    <NavLink
      to={to}
      aria-label={label}
      className="relative flex flex-1 items-center justify-center"
    >
      {({ isActive }) => (
        <div
          className={`featured-nav-tile flex size-16 items-center justify-center transition-transform duration-150 ${isActive ? "-translate-y-5" : "is-inactive -translate-y-2"} `}
        >
          <img
            src={icon}
            alt={label}
            className="size-12 [image-rendering:pixelated]"
          />
        </div>
      )}
    </NavLink>
  )
}
