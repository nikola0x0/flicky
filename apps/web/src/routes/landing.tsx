import { useState, type ReactNode } from "react"
import { Link, useNavigate, type NavigateFunction } from "react-router"
import { PixelButton } from "@/components/pixel-button"
import { CONFIG } from "@/lib/config"

/**
 * Public homepage at `/`. A judge opens this first: it has to say "what is
 * Flicky" in one glance and route into the game. Hybrid direction — a
 * readable explainer structure wearing the game's pixel/arcade skin
 * (checker-navy ground, hard black borders + bevels, `font-pixel` headers,
 * the green `<PixelButton>` cabinet CTA, pixel-art icons).
 *
 * Layout fills the viewport: the root is a full-height flex column and the
 * hero grows (`flex-1`) so header → hero → how-it-works → footer occupy one
 * screen with no dead space. Type, art and the content column all scale up
 * through `lg` → `xl` → `2xl` so the page reads big on 2K/ultrawide instead
 * of a small block marooned in a sea of navy.
 *
 * Hero art slots (`/home/shot-swipe.png`, `/home/keyart-card.png`) and the
 * badge/step icons all degrade to styled placeholders if the file is
 * missing, so a fresh checkout without the art never renders broken.
 *
 * The button mascot (`/mascot/hero.png`, `/mascot/button-idle.png`) follows
 * the same rule — `AssetImage`'s fallback is `null`, so until that art
 * exists the wrapper just renders the bare CTA with no layout shift.
 */

// CSS gates the CRT power-on keyframes behind `html[data-crt]` so the
// effect fires only for this intentional forward navigation — not when the
// browser replays the view transition on back/forward across the boundary.
// Set the flag, navigate, then retire it once the ~620ms animation is done.
const CRT_DURATION_MS = 800
function enterGameWithCrt(navigate: NavigateFunction) {
  document.documentElement.dataset.crt = ""
  navigate("/game/home", { viewTransition: true })
  window.setTimeout(() => {
    delete document.documentElement.dataset.crt
  }, CRT_DURATION_MS)
}

const GITHUB_URL = "https://github.com/nikola0x0/flicky"
const DEEPBOOK_URL = "https://deepbook.tech"
const contractUrl = `https://suiscan.xyz/testnet/object/${CONFIG.packageId}/tx-blocks`

// Bevelled pixel panel — hard black outline, top highlight + offset drop,
// matching the in-game tile treatment.
const PIXEL_PANEL =
  "border-2 border-black shadow-[inset_0_3px_0_rgba(255,255,255,0.10),3px_3px_0_rgba(0,0,0,0.45)]"

// Shared content-column width: roomy on desktop, much wider on 2K so the
// hero/how-it-works don't shrink into the middle of a large display.
const CONTENT_W = "mx-auto w-full max-w-6xl 2xl:max-w-[1680px]"

export default function Landing() {
  return (
    <div className="flex min-h-dvh w-full flex-col overflow-x-hidden bg-[#1b2548] font-pixel text-white">
      <TopBar />
      <Hero />
      <HowItWorks />
      <SiteFooter />
    </div>
  )
}

/** <img> that swaps to `fallback` if the source 404s (art not dropped yet). */
function AssetImage({
  src,
  alt,
  className,
  fallback = null,
}: {
  src: string
  alt: string
  className?: string
  fallback?: ReactNode
}) {
  const [failed, setFailed] = useState(false)
  if (failed) return <>{fallback}</>
  return (
    <img
      src={src}
      alt={alt}
      className={className}
      onError={() => setFailed(true)}
    />
  )
}

function TopBar() {
  return (
    <header className="flex shrink-0 items-center justify-between gap-3 border-b-2 border-black bg-[#151837] px-4 py-2.5 shadow-[0_2px_0_#3a4f8a] sm:px-8 lg:px-12 lg:py-3 2xl:px-20 2xl:py-4">
      <Link to="/" aria-label="flicky home" className="flex items-center">
        <AssetImage
          src="/logo-mark.png"
          alt="flicky"
          className="h-12 w-auto [image-rendering:pixelated] sm:h-14 lg:h-20 2xl:h-24"
          fallback={
            <span className="text-4xl font-bold [text-shadow:2px_2px_0_#000,4px_4px_0_#00ad45] sm:text-5xl lg:text-6xl 2xl:text-7xl">
              flicky
            </span>
          }
        />
      </Link>
      <div className="flex items-center gap-3 sm:gap-5 2xl:gap-8">
        <span className="bg-[#0f1430] px-2.5 py-1 text-[10px] tracking-[0.12em] text-[#8fb4ff] uppercase sm:text-xs 2xl:px-4 2xl:py-2 2xl:text-base">
          Sui testnet
        </span>
        <Link
          to="/game/home"
          className="text-sm text-white/70 transition-colors hover:text-white lg:text-base 2xl:text-xl"
        >
          enter the game →
        </Link>
      </div>
    </header>
  )
}

function Hero() {
  const navigate = useNavigate()
  return (
    <section className="relative isolate flex flex-1 flex-col justify-center overflow-hidden">
      {/* Decorative ground (full-bleed): faint animated checker + a blue glow,
          faded into the navy base so hero copy stays readable. Lives on the
          full-width section so the checker reaches both screen edges. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="bg-checker-dark absolute inset-0 opacity-30" />
        <div className="absolute inset-0 bg-[radial-gradient(55%_70%_at_72%_30%,rgba(64,148,251,0.16),transparent_70%)]" />
        <div className="absolute inset-0 bg-gradient-to-b from-[#1b2548]/40 via-transparent to-[#1b2548]" />
      </div>

      <div
        className={`flex w-full flex-col gap-10 px-5 py-10 sm:px-8 md:flex-row md:items-center md:gap-12 lg:gap-20 lg:px-12 2xl:gap-28 2xl:px-20 ${CONTENT_W}`}
      >
        {/* Left — pitch */}
        <div className="min-w-0 flex-[1.1]">
          <span className="inline-block bg-[#0f1430] px-3 py-1.5 text-[10px] tracking-[0.14em] text-[#7ec8e3] uppercase sm:text-xs 2xl:px-4 2xl:py-2 2xl:text-base">
            The Prediction Arena
          </span>
          <h1 className="mt-5 text-[1.85rem] leading-[1.12] break-words [text-shadow:2px_2px_0_#000] sm:text-4xl md:text-5xl lg:text-[3.4rem] xl:text-[4rem] 2xl:mt-7 2xl:text-[5rem]">
            Prediction markets, turned into a{" "}
            <span className="text-[#5de890]">game</span> you play with your
            thumb.
          </h1>
          <p className="mt-5 max-w-md font-pixel text-sm leading-loose text-[#c8cee2] sm:text-base lg:max-w-xl lg:text-lg 2xl:mt-7 2xl:max-w-2xl 2xl:text-xl">
            Two players go face-to-face, swiping YES or NO through a deck of
            real market predictions. Read it better than your opponent — take
            the pot.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-4 2xl:mt-11 2xl:gap-6">
            <EnterGameButton onClick={() => enterGameWithCrt(navigate)} />
          </div>
          <div className="mt-9 flex flex-wrap gap-3 2xl:mt-12 2xl:gap-4">
            <Badge
              icon="/assets/landing/deepbook.png"
              label="Powered by DeepBook Predict"
            />
            <Badge icon="/tokens/sui.png" label="Built on Sui" />
          </div>
        </div>

        {/* Right — game preview */}
        <div className="flex min-w-0 flex-1 items-center justify-center">
          <HeroPreview />
        </div>
      </div>
    </section>
  )
}

/**
 * The "enter the game" CTA plus its climbing mascot, perched on the
 * button's top-left corner. `pointer-events-none` so the fox never steals
 * the click from the button underneath. Missing art (pre-asset-drop) just
 * means an invisible slot; see the file-level doc comment.
 */
function EnterGameButton({ onClick }: { onClick: () => void }) {
  return (
    <div className="relative inline-block">
      <PixelButton
        onClick={onClick}
        className="h-12 px-7 text-base lg:h-14 lg:px-9 lg:text-lg 2xl:h-[68px] 2xl:px-12 2xl:text-2xl"
      >
        ▶ enter the game
      </PixelButton>
      <AssetImage
        src="/mascot/button-idle.png"
        alt=""
        className="pointer-events-none absolute -top-6 left-0 w-11 -rotate-6 [image-rendering:pixelated] lg:-top-8 lg:w-14 2xl:-top-11 2xl:w-20"
      />
    </div>
  )
}

function Badge({ icon, label }: { icon: string; label: string }) {
  return (
    <span className="flex items-center gap-2 border-2 border-black bg-[#0f1430] px-3 py-2 text-[11px] text-[#dfe4f2] shadow-[2px_2px_0_rgba(0,0,0,0.45)] sm:text-xs lg:gap-2.5 lg:px-4 lg:py-2.5 2xl:gap-3 2xl:px-5 2xl:py-3.5 2xl:text-lg">
      {/* w-auto + object-contain: some badge icons (deepbook.png) are wide
          marks, not square glyphs — a fixed square box would squash them. */}
      <AssetImage
        src={icon}
        alt=""
        className="h-4 w-auto object-contain [image-rendering:pixelated] lg:h-5 2xl:h-7"
        fallback={<span className="h-2 w-2 rounded-full bg-[#4094fb]" />}
      />
      {label}
    </span>
  )
}

function HeroPreview() {
  // The real screenshot already includes the game's own phone frame/border, so
  // when it loads we drop the device chrome (border + inner bevel + bg) and show
  // just the image — rounded with a soft offset shadow for depth. The styled
  // placeholder still needs the frame because it has no border of its own.
  const [shotFailed, setShotFailed] = useState(false)
  const sizing =
    "h-[400px] w-[248px] rounded-[20px] lg:h-[540px] lg:w-[332px] lg:rounded-[26px] 2xl:h-[700px] 2xl:w-[432px] 2xl:rounded-[32px]"
  return (
    <div className="relative">
      {shotFailed ? (
        // Placeholder — keep the pixel device frame.
        <div
          className={`flex items-center justify-center overflow-hidden border-2 border-black bg-[#10162e] shadow-[inset_0_0_0_3px_#3a4f8a,5px_5px_0_rgba(0,0,0,0.5)] ${sizing}`}
        >
          <DevicePlaceholder />
        </div>
      ) : (
        // Real screenshot — rendered raw (it already carries the game's own
        // phone frame), so no border, bevel or drop shadow is added here.
        <img
          src="/home/shot-swipe.png"
          alt="Flicky duel — swiping YES or NO through a deck of market predictions"
          onError={() => setShotFailed(true)}
          className={`block object-contain ${sizing}`}
        />
      )}
      {/* Floating key-art swipe card accent. */}
      <div className="absolute -right-5 bottom-9 rotate-[8deg] lg:-right-8 lg:bottom-12 2xl:-right-10 2xl:bottom-16">
        <AssetImage
          src="/home/keyart-card.png"
          alt=""
          className="w-20 drop-shadow-[4px_4px_0_rgba(0,0,0,0.5)] [image-rendering:pixelated] lg:w-28 2xl:w-36"
          fallback={
            <div className="flex h-24 w-[72px] items-end rounded-lg border-2 border-black bg-gradient-to-b from-[#1f7a3d] to-[#124d27] p-2 text-xs font-bold text-[#cffadc] shadow-[4px_4px_0_rgba(0,0,0,0.5)] lg:h-32 lg:w-24 lg:p-3 lg:text-sm 2xl:h-44 2xl:w-32 2xl:text-xl">
              YES
            </div>
          }
        />
      </div>
      {/* Flicky mascot, mirroring the keyart-card accent on the opposite
          corner, flicking a YES card toward the phone. Stays small and
          tucked close on mobile (stacked layout only has the phone's own
          centering margin to bleed into) and grows/moves outward once the
          hero switches to a two-column layout at `md`. */}
      <div className="pointer-events-none absolute -left-8 bottom-1 w-16 -rotate-6 sm:-left-12 sm:w-20 md:-left-14 md:w-24 lg:-left-24 lg:bottom-4 lg:w-44 2xl:-left-32 2xl:w-56">
        <AssetImage
          src="/mascot/hero.png"
          alt=""
          className="w-full drop-shadow-[4px_4px_0_rgba(0,0,0,0.35)] [image-rendering:pixelated]"
        />
      </div>
    </div>
  )
}

/** Styled stand-in shown until a real screenshot is dropped in /home. */
function DevicePlaceholder() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-3 text-center lg:gap-5 2xl:gap-7">
      <span className="text-[10px] tracking-[0.18em] text-[#7ec8e3] uppercase lg:text-xs 2xl:text-base">
        BTC · binary
      </span>
      <div className="flex h-40 w-32 flex-col justify-between rounded-lg border-2 border-black bg-gradient-to-b from-[#27407a] to-[#16224a] p-3 shadow-[3px_3px_0_rgba(0,0,0,0.5)] lg:h-52 lg:w-40 lg:p-4 2xl:h-72 2xl:w-52 2xl:p-6">
        <span className="text-left font-pixel text-[11px] leading-snug text-white/80 lg:text-sm 2xl:text-xl">
          Will BTC settle above strike?
        </span>
        <div className="flex justify-between text-[11px] font-bold lg:text-sm 2xl:text-xl">
          <span className="text-[#f7c9cf]">◀ NO</span>
          <span className="text-[#bdf7cf]">YES ▶</span>
        </div>
      </div>
    </div>
  )
}

function HowItWorks() {
  return (
    <section className="shrink-0 border-t-2 border-black bg-[#151a36] shadow-[inset_0_2px_0_#3a4f8a]">
      <div
        className={`px-5 py-10 sm:px-8 lg:px-12 lg:py-12 2xl:px-20 2xl:py-16 ${CONTENT_W}`}
      >
        <div className="mb-6 text-center text-[11px] tracking-[0.16em] text-[#7ec8e3] uppercase sm:text-xs lg:mb-8 2xl:mb-12 2xl:text-base">
          — how it works —
        </div>
        <div className="grid gap-4 md:grid-cols-3 lg:gap-6 2xl:gap-10">
          <Step
            n={1}
            icon="/icons/boolean.png"
            title="Swipe the deck"
            body="YES or NO on real binary market predictions. Each swipe is a live on-chain position."
          />
          <Step
            n={2}
            icon="/icons/swords.png"
            title="Go head-to-head"
            body="You and your rival swipe the same deck. Faster, sharper reads score more."
          />
          <Step
            n={3}
            icon="/icons/coins.png"
            title="Winner takes the pot"
            body="Higher score wins the escrowed stake — settled trustlessly, paid out automatically."
          />
        </div>
      </div>
    </section>
  )
}

function Step({
  n,
  icon,
  title,
  body,
}: {
  n: number
  icon: string
  title: string
  body: string
}) {
  return (
    <div className={`bg-[#1b2548] p-5 ${PIXEL_PANEL} lg:p-7 2xl:p-10`}>
      <div className="mb-3 flex items-center gap-3 lg:mb-4 2xl:mb-6 2xl:gap-4">
        <span className="flex h-7 w-7 items-center justify-center border-2 border-black bg-[#00ad45] text-sm font-bold text-white shadow-[inset_0_2px_0_#5de890] lg:h-8 lg:w-8 lg:text-base 2xl:h-11 2xl:w-11 2xl:text-2xl">
          {n}
        </span>
        <AssetImage
          src={icon}
          alt=""
          className="h-6 w-6 [image-rendering:pixelated] lg:h-7 lg:w-7 2xl:h-10 2xl:w-10"
        />
      </div>
      <h3 className="text-base lg:text-lg 2xl:text-3xl">{title}</h3>
      <p className="mt-1.5 font-pixel text-xs leading-loose text-[#aab2cf] sm:text-[13px] lg:text-sm 2xl:mt-3 2xl:text-lg">
        {body}
      </p>
    </div>
  )
}

function SiteFooter() {
  return (
    <footer className="shrink-0 border-t-2 border-black bg-[#151837] shadow-[0_-2px_0_#3a4f8a]">
      <div
        className={`flex flex-col items-center justify-between gap-2 px-5 py-4 text-[11px] text-[#8b93b4] sm:flex-row sm:px-8 sm:text-xs lg:px-12 lg:py-5 2xl:px-20 2xl:py-8 2xl:text-lg ${CONTENT_W}`}
      >
        <span>flicky · the prediction arena on Sui</span>
        <div className="flex items-center gap-4 lg:gap-6 2xl:gap-10">
          <a
            href={DEEPBOOK_URL}
            target="_blank"
            rel="noreferrer"
            className="transition-colors hover:text-white"
          >
            DeepBook Predict ↗
          </a>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="transition-colors hover:text-white"
          >
            GitHub ↗
          </a>
          <a
            href={contractUrl}
            target="_blank"
            rel="noreferrer"
            className="transition-colors hover:text-white"
          >
            contract ↗
          </a>
        </div>
      </div>
    </footer>
  )
}
