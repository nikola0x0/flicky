import { useEffect, useRef, useState } from "react"
import type { CSSProperties } from "react"
import { useCurrentAccount } from "@mysten/dapp-kit"

import { MatchButton } from "@/components/match-button"
import { ModeModal } from "@/components/mode-modal"
import { OnboardingModal } from "@/components/onboarding-modal"
import { useFlickySocket } from "@/hooks/use-flicky-socket"
import { ActiveDuel } from "./active-duel"
import { STAKE_TIERS, type Tier } from "@/lib/protocol"

const STAKES = [1, 3, 5, 10] as const
type Stake = (typeof STAKES)[number]

const MODE_BRAND_STYLE = {
  "--btn-bg": "#e08a2b",
  "--btn-highlight": "#f4b966",
} as CSSProperties

export default function GamePvp() {
  const account = useCurrentAccount()
  const [stake, setStake] = useState<Stake>(3)
  const [modeOpen, setModeOpen] = useState(false)
  const [onboardingOpen, setOnboardingOpen] = useState(false)
  const [managerId, setManagerId] = useState<string | null>(null)

  const { wsOpen, send, onMessage } = useFlickySocket(account?.address)

  const [queueSize, setQueueSize] = useState<number | null>(null)
  const [matched, setMatched] = useState<{
    role: "creator" | "challenger"
    opponent: string
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
      else if (msg.type === "match_found")
        setMatched({ role: msg.role, opponent: msg.opponent })
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
      return
    }
    // Open the onboarding gate — it checks wallet + manager balances
    // and only fires onReady when both are sufficient.
    setOnboardingOpen(true)
  }

  // If a match is found, render the Active Duel phase.
  if (matched && managerId) {
    return (
      <ActiveDuel
        role={matched.role}
        tier={tier}
        managerId={managerId}
        wsOpen={wsOpen}
        send={send}
        onMessage={onMessage}
        onExit={() => {
          setMatched(null)
          setQueueSize(null)
        }}
      />
    )
  }

  return (
    <div className="flex h-full flex-col gap-5 px-4 py-4">
      <img
        src="/banners/pvp-banner.png"
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
          <StakeSelector value={stake} onChange={setStake} disabled={queueSize !== null} />
          <MatchButton
            className="flex-1"
            label={
              <span className="text-2xl">
                {queueSize !== null ? `queueing (${queueSize})` : "queue match"}
              </span>
            }
            onClick={onQueueMatch}
          />
        </div>
        <MatchButton
          label={<span className="text-2xl">game mode</span>}
          style={MODE_BRAND_STYLE}
          onClick={() => setModeOpen(true)}
        />
      </div>

      <p className="text-center text-[10px] tracking-[0.18em] text-white/45 uppercase">
        match starts when an opponent joins
      </p>

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
    </div>
  )
}

function StakeSelector({
  value,
  onChange,
  disabled
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
                  <span className="text-xs tracking-[0.18em] text-white/55 uppercase">
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
