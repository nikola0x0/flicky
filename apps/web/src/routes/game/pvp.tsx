import { useEffect, useRef, useState } from "react"
import type { CSSProperties } from "react"
import { useNavigate } from "react-router"
import { useCurrentAccount } from "@mysten/dapp-kit-react"

import { MatchButton } from "@/components/match-button"
import { ModeModal } from "@/components/mode-modal"
import { OnboardingModal } from "@/components/onboarding-modal"
import { PixelButton } from "@/components/pixel-button"
import { WsErrorBanner } from "@/components/ws-error-banner"
import { useFlickySocket } from "@/hooks/use-flicky-socket"
import { ActiveDuel } from "./active-duel"
import { STAKE_TIERS, type Tier } from "@/lib/protocol"
import { playSfx } from "@/lib/sound"

const STAKES = [1, 3, 5, 10] as const
type Stake = (typeof STAKES)[number]

const MODE_BRAND_STYLE = {
  "--btn-bg": "#e08a2b",
  "--btn-highlight": "#f4b966",
} as CSSProperties

const RED_BRAND_STYLE = {
  "--btn-bg": "#d94646",
  "--btn-highlight": "#f08585",
} as CSSProperties

// Secondary/navigation styling — blue so "my duels" reads as a way out to
// history, distinct from the orange primary CTAs.
const HISTORY_BRAND_STYLE = {
  "--btn-bg": "#3a6ea5",
  "--btn-highlight": "#6ea0d8",
} as CSSProperties

const TIER_LABEL: Record<Tier, string> = {
  practice: "practice",
  starter: "starter",
  casual: "casual",
  standard: "standard",
  high_roller: "high roller",
}

export default function GamePvp() {
  const account = useCurrentAccount()
  const navigate = useNavigate()
  const [stake, setStake] = useState<Stake>(1)
  const [modeOpen, setModeOpen] = useState(false)
  const [onboardingOpen, setOnboardingOpen] = useState(false)
  const [managerId, setManagerId] = useState<string | null>(null)

  const { wsOpen, send, onMessage } = useFlickySocket(account?.address)

  const [queueSize, setQueueSize] = useState<number | null>(null)
  const [matched, setMatched] = useState<{
    role: "creator" | "challenger"
    opponent: string
    deckHash: string
  } | null>(null)

  const tier: Tier =
    stake === 1
      ? "starter"
      : stake === 3
        ? "casual"
        : stake === 5
          ? "standard"
          : "high_roller"

  useEffect(() => {
    return onMessage((msg) => {
      if (msg.type === "queue_status") setQueueSize(msg.size)
      else if (msg.type === "queue_left") setQueueSize(null)
      else if (msg.type === "match_found") {
        playSfx("match-found")
        setMatched({
          role: msg.role,
          opponent: msg.opponent,
          deckHash: msg.deckHash,
        })
      }
    })
  }, [onMessage])

  const onQueueMatch = () => {
    if (!account) {
      alert("Please sign in first")
      return
    }
    if (!wsOpen) {
      alert("Connecting to server... Please wait.")
      return
    }
    if (queueSize !== null) {
      send({ type: "queue_leave" })
      // Snap UI back immediately — don't wait for the server's queue_left
      // echo. If the server hasn't acked yet, leaving the chip in the
      // "queueing" state makes the button feel broken/unresponsive.
      setQueueSize(null)
      return
    }
    // Open the onboarding gate — it checks wallet + manager balances
    // and only fires onReady when both are sufficient.
    setOnboardingOpen(true)
  }

  // Single render path so the WS error banner stays mounted across
  // queue → match transitions and never loses its subscription.
  let content: React.ReactNode
  if (matched && managerId) {
    content = (
      <ActiveDuel
        role={matched.role}
        tier={tier}
        managerId={managerId}
        deckHash={matched.deckHash}
        wsOpen={wsOpen}
        send={send}
        onMessage={onMessage}
        // Create/join lands → hand off to the deep-linkable play route so
        // the live session has a real, reload-safe URL.
        onDuelReady={(duelId) => navigate(`/game/play/${duelId}`)}
        onExit={() => {
          setMatched(null)
          setQueueSize(null)
        }}
      />
    )
  } else if (queueSize !== null) {
    content = <QueueScreen tier={tier} stake={stake} onCancel={onQueueMatch} />
  } else {
    content = (
      <StandbyView
        stake={stake}
        setStake={setStake}
        onQueueMatch={onQueueMatch}
        onOpenMode={() => setModeOpen(true)}
        onViewDuels={() => navigate("/game/history")}
      />
    )
  }

  return (
    <>
      <WsErrorBanner onMessage={onMessage} />
      {content}
      <ModeModal open={modeOpen} onClose={() => setModeOpen(false)} />
      <OnboardingModal
        open={onboardingOpen}
        stake={STAKE_TIERS[tier]}
        onClose={() => setOnboardingOpen(false)}
        onReady={(mgrId) => {
          setManagerId(mgrId)
          setOnboardingOpen(false)
          send({ type: "queue_join", tier })
        }}
      />
    </>
  )
}

function StandbyView({
  stake,
  setStake,
  onQueueMatch,
  onOpenMode,
  onViewDuels,
}: {
  stake: Stake
  setStake: (s: Stake) => void
  onQueueMatch: () => void
  onOpenMode: () => void
  onViewDuels: () => void
}) {
  return (
    <div className="flex h-full flex-col gap-5 px-4 py-4">
      <img
        src="/banners/pvp-banner.webp"
        alt="pvp duel"
        className="mt-4 block aspect-video w-full object-cover [image-rendering:pixelated]"
      />

      <header className="flex items-center justify-center gap-3">
        <img
          src="/icons/swords.png"
          alt=""
          aria-hidden
          className="size-5 opacity-55 [image-rendering:pixelated]"
        />
        <h2 className="text-2xl tracking-[0.2em] text-white uppercase">duel</h2>
        <img
          src="/icons/swords.png"
          alt=""
          aria-hidden
          className="size-5 -scale-x-100 opacity-55 [image-rendering:pixelated]"
        />
      </header>

      <div className="flex flex-col gap-2">
        <div className="flex items-stretch gap-2">
          <div id="stake-selector">
            <StakeSelector value={stake} onChange={setStake} />
          </div>
          <div id="queue-match-btn" className="flex-1">
            <MatchButton
              className="flex-1"
              label={<span className="text-2xl">queue match</span>}
              onClick={onQueueMatch}
            />
          </div>
        </div>
        <div id="game-mode-btn">
          <MatchButton
            label={<span className="text-2xl">game mode</span>}
            style={MODE_BRAND_STYLE}
            onClick={onOpenMode}
          />
        </div>
        {/* Separate the primary "start a duel" actions above from the
            navigation button below so they don't read as one crowded stack.
            Recessed groove line matches the buttons' pixel bevel. */}
        <div
          aria-hidden
          className="my-1.5 h-0.5 w-full bg-black/45 shadow-[0_1px_0_rgba(255,255,255,0.08)]"
        />
        <div id="my-duels-btn">
          <MatchButton
            label={<span className="text-2xl">my duels</span>}
            style={HISTORY_BRAND_STYLE}
            onClick={onViewDuels}
          />
        </div>
      </div>

      <p className="text-center text-xs tracking-[0.18em] text-white/45 uppercase">
        match starts when an opponent joins
      </p>
    </div>
  )
}

function StakeSelector({
  value,
  onChange,
  disabled,
}: {
  value: Stake
  onChange: (s: Stake) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", onDown)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`stake ${value} dUSDC`}
        className="flex h-14 shrink-0 items-center gap-2 rounded-md border-2 border-black/55 bg-[#1b2548] px-3 shadow-[inset_0_-2px_0_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.08)] transition-colors hover:bg-[#243364] disabled:opacity-50"
      >
        <img
          src="/tokens/usdc-icon.png"
          alt=""
          aria-hidden
          className="size-6 [image-rendering:pixelated]"
        />
        <span className="w-[2.5ch] text-right text-2xl leading-none font-black text-white tabular-nums">
          {value}
        </span>
        <ChevronDown open={open} />
      </button>

      {open && (
        <ul
          role="listbox"
          className="absolute top-full left-0 z-20 mt-1 min-w-full overflow-hidden rounded-md border-2 border-black/55 bg-[#1b2548] shadow-[0_4px_0_rgba(0,0,0,0.45)]"
        >
          {STAKES.map((s) => {
            const selected = s === value
            return (
              <li key={s} role="option" aria-selected={selected}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(s)
                    setOpen(false)
                  }}
                  className={`flex w-full items-center justify-between gap-3 px-3 py-2.5 text-white transition-colors ${selected ? "bg-white/10" : "hover:bg-white/5"} `}
                >
                  <span className="flex items-center gap-2">
                    <img
                      src="/tokens/usdc-icon.png"
                      alt=""
                      aria-hidden
                      className="size-5 [image-rendering:pixelated]"
                    />
                    <span className="text-lg leading-none font-black tabular-nums">
                      {s}
                    </span>
                  </span>
                  <span className="text-sm tracking-[0.18em] text-white/55 uppercase">
                    dUSDC
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/**
 * Full-frame "searching for opponent" screen rendered while the player
 * is in the matchmaking queue. Mirrors the layout/aesthetic of the
 * standby PvP view (banner up top, tier+stake echoed, action button at
 * the bottom) but with a single red cancel CTA instead of the queue
 * controls.
 */
function QueueScreen({
  tier,
  stake,
  onCancel,
}: {
  tier: Tier
  stake: Stake
  onCancel: () => void
}) {
  return (
    <div className="queue-enter flex h-full flex-col gap-5 px-4 pb-4">
      {/* Banner bleeds to the frame edges and softly fades into the
          background at the bottom so it reads as part of the screen
          rather than a postcard pasted on top. A stationary rounded
          border breathes in opacity/glow to give a subtle "active"
          feel — no scale, no expanding pings. */}
      <div className="relative -mx-4">
        <img
          src="/banners/searching.webp"
          alt="searching for opponent"
          className="block aspect-video w-full [mask-image:linear-gradient(to_bottom,transparent_0%,black_8%,black_78%,transparent_100%)] object-cover [image-rendering:pixelated]"
        />
        <span
          aria-hidden
          className="border-glow pointer-events-none absolute inset-2 rounded-2xl [mask-image:linear-gradient(to_bottom,transparent_0%,black_12%,black_85%,transparent_100%)]"
        />
        <AnimatedDots className="absolute bottom-3 left-1/2 -translate-x-1/2 text-3xl tracking-[0.3em] text-white drop-shadow-[0_2px_0_rgba(0,0,0,0.6)]" />
      </div>

      <header className="-mt-2 flex flex-col items-center gap-1">
        <p className="text-xs tracking-[0.18em] text-white/55 uppercase">
          finding a duelist for you
        </p>
      </header>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between rounded-md border-2 border-black/55 bg-[#1b2548] px-4 py-3 shadow-[inset_0_-2px_0_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.08)]">
          <div className="flex flex-col">
            <span className="text-xs tracking-[0.18em] text-white/55 uppercase">
              tier
            </span>
            <span className="text-lg tracking-wider text-white uppercase">
              {TIER_LABEL[tier]}
            </span>
          </div>
          <div className="flex flex-col items-end">
            <span className="text-xs tracking-[0.18em] text-white/55 uppercase">
              stake
            </span>
            <span className="flex items-center gap-1.5 text-lg leading-none font-black text-white tabular-nums">
              <img
                src="/tokens/usdc-icon.png"
                alt=""
                aria-hidden
                className="size-5 [image-rendering:pixelated]"
              />
              {stake}
            </span>
          </div>
        </div>
      </div>

      <div className="mt-auto">
        <PixelButton
          onClick={onCancel}
          style={RED_BRAND_STYLE}
          className="h-14 w-full !text-2xl"
        >
          cancel
        </PixelButton>
      </div>
    </div>
  )
}

function AnimatedDots({ className = "" }: { className?: string }) {
  return (
    <span aria-hidden className={`inline-flex gap-0.5 ${className}`}>
      <span className="animate-bounce [animation-delay:-0.3s]">.</span>
      <span className="animate-bounce [animation-delay:-0.15s]">.</span>
      <span className="animate-bounce">.</span>
    </span>
  )
}

function ChevronDown({ open }: { open: boolean }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`ml-0.5 size-3 text-white/70 transition-transform ${
        open ? "rotate-180" : ""
      }`}
      aria-hidden
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}
