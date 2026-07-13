import { Fragment, useEffect, useRef, useState } from "react"
import { Link, NavLink, Outlet, useLocation } from "react-router"
import type { CSSProperties } from "react"
import { useCurrentAccount } from "@mysten/dapp-kit-react"

/**
 * Game-route context, passed through react-router's <Outlet />. Lets
 * children open the layout-owned login modal — needed by routes that
 * are visible while signed out (e.g. /game/shop) so their CTAs can
 * prompt sign-in without each route owning its own modal.
 */
export interface GameOutletContext {
  openLogin: () => void
}

// Routes that render even when signed out — used to showcase features
// (e.g. the swap) before login. Everything else falls back to the
// unified <SignedOutPrompt>.
const PUBLIC_ROUTES = new Set<string>(["/game/shop", "/game/rank"])

import { BalanceChip } from "@/components/balance-chip"
import { DepositModal } from "@/components/deposit-modal"
import { LoginModal } from "@/components/login-modal"
import { MenuButton } from "@/components/menu-button"
import { PixelButton } from "@/components/pixel-button"
import { PlayerAvatar } from "@/components/player-avatar"
import { useDusdcBalance, useManagerBalance } from "@/hooks/use-wallet-balances"
import { clearPendingSwipe, peekPendingSwipe } from "@/lib/nav-transition"
import { DeviceFrame } from "@/components/device-frame"

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
  const [depositOpen, setDepositOpen] = useState(false)
  const account = useCurrentAccount()
  const location = useLocation()
  const isPublicRoute = PUBLIC_ROUTES.has(location.pathname)
  const showOutlet = Boolean(account) || isPublicRoute
  // Route-specific chrome (shop's tall top-decor header, pvp's checker
  // background) only kicks in when the routed page is actually
  // rendering — otherwise the unified <SignedOutPrompt> would sit at
  // different y-positions across routes because the header height
  // varies.
  const isPvp = showOutlet && location.pathname === "/game/pvp"
  // The active-match screen gets a full-frame battle backdrop (behind the
  // header too), so the art isn't clipped to the <main> area below the bar.
  const isPlay = showOutlet && location.pathname.startsWith("/game/play")

  const outletContext: GameOutletContext = {
    openLogin: () => setLoginOpen(true),
  }

  return (
    <>
      <DeviceFrame className={isPvp ? "bg-checker-dark" : "bg-[#1b2548]"}>
        {isPlay && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 -z-10 bg-cover bg-top bg-no-repeat [image-rendering:pixelated]"
            style={{
              backgroundImage:
                "linear-gradient(180deg, rgba(10,14,30,0.6) 0%, rgba(16,20,40,0.32) 22%, rgba(16,22,46,0.45) 62%, #10162e 100%), url(/duel/duel-bg.png)",
            }}
          />
        )}
        {/* On the signed-out empty state the header's only control is a
            sign-in button, now redundant with the centered CTA below — so
            drop the header there and let the prompt own the full area. */}
        {showOutlet && (
          <FrameHeader
            onSignInClick={() => setLoginOpen(true)}
            onAddClick={() => setDepositOpen(true)}
            signedOut={!account && !isPublicRoute}
          />
        )}
        <main className="flex-1 overflow-hidden">
          {showOutlet ? (
            <GameOutletTransition context={outletContext} />
          ) : (
            <SignedOutPrompt onSignIn={() => setLoginOpen(true)} />
          )}
        </main>
        <FrameBottomNav />
      </DeviceFrame>

      <LoginModal open={loginOpen} onClose={() => setLoginOpen(false)} />
      {account && (
        <DepositModal
          open={depositOpen}
          address={account.address}
          onClose={() => setDepositOpen(false)}
        />
      )}
    </>
  )
}

/**
 * Unified empty-state for signed-out, non-public game routes. Instead of
 * telling the user to hunt for the header button, it shows a pixel-cartoon
 * hero and a big centered "sign in to play" CTA that opens the same login
 * modal. The hero image (`/game/sign-in-hero.png`) self-hides if missing,
 * so a checkout without the art still renders a clean, working prompt.
 */
function SignedOutPrompt({ onSignIn }: { onSignIn: () => void }) {
  const [artFailed, setArtFailed] = useState(false)
  return (
    <div className="flex h-full flex-col items-center justify-center gap-8 px-6 pb-32 text-center">
      <div className="flex flex-col items-center gap-0">
        {!artFailed && (
          <img
            src="/game/sign-in-hero.png"
            alt=""
            aria-hidden
            onError={() => setArtFailed(true)}
            className="-mb-10 w-72 max-w-[88%] drop-shadow-[0_8px_0_rgba(0,0,0,0.35)] [image-rendering:pixelated]"
          />
        )}
        <p className="text-3xl tracking-[0.15em] text-white uppercase">
          ready to duel?
        </p>
        <p className="text-lg leading-relaxed text-white/60">
          sign in to swipe, stake, and take the pot.
        </p>
      </div>
      <PixelButton onClick={onSignIn} className="h-16 px-12 text-xl">
        <span className="flex items-center gap-2.5">
          <img
            src="/icons/portrait.png"
            alt=""
            aria-hidden
            className="size-7 [image-rendering:pixelated]"
          />
          sign in to play
        </span>
      </PixelButton>
    </div>
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
function GameOutletTransition({ context }: { context: GameOutletContext }) {
  const location = useLocation()
  const prevPathRef = useRef<string | null>(null)
  // Swipe direction handed over from a sibling top-level route (returning from
  // /profile), applied only to this component's very first render.
  const [crossRouteSwipe] = useState(peekPendingSwipe)

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
  } else if (!prevPathRef.current && crossRouteSwipe) {
    // First mount arriving from another route tree (e.g. back from /profile).
    animClass = crossRouteSwipe
  }

  useEffect(() => {
    prevPathRef.current = location.pathname
  }, [location.pathname])

  useEffect(() => {
    // Retire the cross-route signal after mount so a later game mount (the
    // landing→game CRT) doesn't inherit it. The delay clears it past React
    // StrictMode's dev remount, which would otherwise consume it too early.
    const t = setTimeout(clearPendingSwipe, 500)
    return () => clearTimeout(t)
  }, [])

  return (
    <div
      key={location.pathname}
      // overflow-x-hidden: a swiped card flies off at translateX(160%); without
      // this the page becomes horizontally scrollable (and shows a scrollbar).
      // Scrollbar hidden so a transient content-height bump (e.g. the play
      // screen's "minting position…" state) doesn't pop a bar that reflows
      // the whole frame width — content stays scrollable, just no visible bar.
      className={`h-full overflow-x-hidden overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${animClass}`}
    >
      <Outlet context={context} />
    </div>
  )
}

function FrameHeader({
  onSignInClick,
  onAddClick,
  signedOut,
}: {
  onSignInClick: () => void
  onAddClick: () => void
  signedOut: boolean
}) {
  const account = useCurrentAccount()
  const location = useLocation()
  // When signed out we render the unified empty-state prompt in <main>,
  // so suppress the shop's tall decor header (it'd push the prompt
  // around route-to-route).
  const isShop = !signedOut && location.pathname === "/game/shop"
  const isHome = location.pathname === "/game/home"

  return (
    <header
      className={`flex justify-between gap-2 px-3 py-3 ${
        isShop
          ? "min-h-[128px] items-start bg-[url('/decorations/top-decor.png')] bg-[length:auto_100%] bg-repeat-x [image-rendering:pixelated]"
          : isHome
            ? "items-center bg-[#151837]"
            : "items-center"
      } `}
    >
      {account ? (
        <HeaderBalances address={account.address} onAddClick={onAddClick} />
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
      {!isShop && account && <MenuButton />}
    </header>
  )
}

function HeaderBalances({
  address,
  onAddClick,
}: {
  address: string
  onAddClick: () => void
}) {
  const { data: dusdc } = useDusdcBalance()
  const { data: managerInfo } = useManagerBalance()
  const managerBalance = managerInfo?.balance ?? 0
  const location = useLocation()
  return (
    <div className="flex items-center gap-5">
      <Link
        to="/profile"
        aria-label="open profile"
        state={{ from: location.pathname }}
        className="transition-opacity hover:opacity-85"
      >
        <PlayerAvatar address={address} size={56} />
      </Link>
      <div className="flex items-center gap-4">
        <BalanceChip
          icon="/tokens/usdc-icon.png"
          amount={(dusdc ?? 0).toFixed(2)}
          label="wallet"
          onClick={onAddClick}
        />
        <BalanceChip
          icon="/tokens/manager-usdc.png"
          amount={managerBalance.toFixed(2)}
          label="manager"
          onClick={onAddClick}
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
