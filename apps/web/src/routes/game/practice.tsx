/**
 * Practice mode — solo vs. bot, no queue, no chain. The whole match runs
 * client-side off `usePracticeSession`; the server only supplies the
 * synthetic deck and the live `spot_tick` stream. Flow:
 *   INTRO → SWIPING (untimed, bot reveals its pick 1–3s behind you)
 *         → LOCKUP (45s: live chart + strike lines, cards flip as they
 *           expire against real Pyth spot)
 *         → RESULT (PnL verdict + 1/p × speed points recap).
 */
import { useEffect, useState } from "react"
import { Link, useNavigate } from "react-router"
import { useCurrentAccount } from "@mysten/dapp-kit-react"
import { useFlickySocket } from "@/hooks/use-flicky-socket"
import {
  BOT_ADDRESS,
  BOT_NAME,
  usePracticeSession,
  type PracticeCard,
  type PracticeResult,
} from "@/hooks/use-practice-session"
import type { RoomState } from "@/lib/room-state"
import { fmtDusdcSigned } from "@/lib/pnl"
import { SwipeScreen, CardLedger, fmtUsd } from "@/components/swipe-screen"
import { BtcSpotChart, type StrikeLine } from "@/components/btc-spot-chart"
import { StreamingPnlChart } from "@/components/streaming-pnl-chart"
import { PlayerAvatar } from "@/components/player-avatar"
import { WsErrorBanner } from "@/components/ws-error-banner"

export default function GamePractice() {
  const account = useCurrentAccount()
  const navigate = useNavigate()
  const { wsOpen, send, onMessage } = useFlickySocket(account?.address)
  const practice = usePracticeSession({
    address: account?.address,
    send,
    onMessage,
  })
  const { phase } = practice

  return (
    <div className="flex h-full flex-col gap-4 px-4 py-4 text-white">
      <WsErrorBanner onMessage={onMessage} />
      <div className="flex items-center justify-between">
        <h2 className="text-3xl tracking-[0.2em] uppercase">Practice</h2>
        <button
          type="button"
          onClick={() => navigate("/game/home")}
          className="rounded border border-white/25 bg-black/40 px-3 py-1 text-lg backdrop-blur-md hover:bg-black/55"
        >
          Exit
        </button>
      </div>

      {phase.kind !== "INTRO" && phase.kind !== "ERROR" && (
        <BotStrip
          botRevealed={practice.botRevealed}
          total={practice.cards.length}
        />
      )}

      {phase.kind === "INTRO" && (
        <IntroView
          canStart={wsOpen && !!account?.address}
          youAddress={account?.address}
          onStart={practice.start}
        />
      )}
      {phase.kind === "STARTING" && (
        <p className="flex flex-1 items-center justify-center text-base text-white/55">
          dealing a practice deck…
        </p>
      )}
      {phase.kind === "SWIPING" && practice.roomState && account && (
        <SwipeScreen
          roomState={practice.roomState}
          cardIdx={phase.cardIdx}
          ticks={practice.ticks}
          myAddress={account.address}
          opponentAddress={BOT_ADDRESS}
          busyLabel="locking pick…"
          settleLabel={settleLabelFor(practice.cards, phase.cardIdx)}
          onSwipe={async (isUp) => practice.swipe(isUp)}
          deckExhausted={null}
        />
      )}
      {phase.kind === "LOCKUP" && practice.roomState && account && (
        <LockupView
          roomState={practice.roomState}
          cards={practice.cards}
          ticks={practice.ticks}
          lockupStartMs={phase.lockupStartMs}
          lockupEndMs={phase.lockupEndMs}
          youAddress={account.address}
        />
      )}
      {phase.kind === "RESULT" && practice.roomState && practice.result && (
        <ResultView
          roomState={practice.roomState}
          result={practice.result}
          ticks={practice.ticks}
          onPlayAgain={() => {
            practice.reset()
            // reset() lands on INTRO; immediately deal the next hand.
            setTimeout(practice.start, 0)
          }}
        />
      )}
      {phase.kind === "ERROR" && (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
          <p className="max-w-xs text-base text-red-400">{phase.message}</p>
          <button
            type="button"
            onClick={practice.start}
            className="pixel-tile bg-emerald-600 px-4 py-3 font-pixel text-sm uppercase"
          >
            retry
          </button>
        </div>
      )}
    </div>
  )
}

/** "settles Ns after lock" — the practice stand-in for the live countdown
 *  (pre-lock there's no absolute expiry yet). */
function settleLabelFor(cards: PracticeCard[], cardIdx: number): string {
  const offset = cards[cardIdx]?.expiryOffsetMs ?? 0
  return `settles ${Math.round(offset / 1000)}s after lock`
}

/** Who you're playing: the bot, plus how many picks it has locked so far. */
function BotStrip({
  botRevealed,
  total,
}: {
  botRevealed: boolean[]
  total: number
}) {
  const locked = botRevealed.filter(Boolean).length
  return (
    <div className="flex items-center gap-2.5 border-2 border-black/55 bg-[#1b2548] px-3 py-2">
      <PlayerAvatar address={BOT_ADDRESS} size={28} />
      <span className="font-pixel text-sm tracking-[0.18em] text-white/80 uppercase">
        {BOT_NAME}
      </span>
      <span className="ml-auto font-pixel text-xs tracking-[0.18em] text-white/45 uppercase tabular-nums">
        {total > 0 ? `bot locked ${locked}/${total}` : "warming up"}
      </span>
    </div>
  )
}

function IntroView({
  canStart,
  youAddress,
  onStart,
}: {
  canStart: boolean
  youAddress: string | undefined
  onStart: () => void
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-5 px-4 text-center">
      <img
        src="/banners/mode-practice.png"
        alt=""
        aria-hidden
        className="pixel-tile no-hover w-full max-w-xs [image-rendering:pixelated]"
      />
      <div className="flex items-center gap-4">
        <PlayerAvatar address={youAddress} size={44} />
        <span className="font-pixel text-xl text-amber-300">vs</span>
        <PlayerAvatar address={BOT_ADDRESS} size={44} />
      </div>
      <div className="max-w-xs space-y-1.5 text-left text-sm leading-relaxed text-white/70">
        <p>· swipe 5 cards — YES if BTC settles above the strike, NO if not</p>
        <p>· then watch the live chart: every card resolves within 45s</p>
        <p>· riskier calls + faster swipes = more points. no stakes, no gas</p>
      </div>
      <button
        type="button"
        onClick={onStart}
        disabled={!canStart}
        className="pixel-tile w-full max-w-xs bg-emerald-600 px-4 py-3 font-pixel text-sm uppercase disabled:opacity-50"
      >
        {canStart ? "start practice" : "connecting…"}
      </button>
    </div>
  )
}

function LockupView({
  roomState,
  cards,
  ticks,
  lockupStartMs,
  lockupEndMs,
  youAddress,
}: {
  roomState: RoomState
  cards: PracticeCard[]
  ticks: Record<string, { spot: string; expiry: string }>
  lockupStartMs: number
  lockupEndMs: number
  youAddress: string
}) {
  // 4 Hz wall-clock: smooth per-card countdowns + the lockup bar.
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 250)
    return () => clearInterval(id)
  }, [])

  const totalMs = lockupEndMs - lockupStartMs
  const remainingMs = Math.max(0, lockupEndMs - nowMs)
  const frac = totalMs > 0 ? remainingMs / totalMs : 0
  const settledByIdx = new Map(
    roomState.cardOutcomes.map((o) => [o.cardIdx, o])
  )

  // Strike guides for the cards still in flight; settled ones drop off.
  const strikeLines: StrikeLine[] = cards.flatMap((c, i) =>
    settledByIdx.has(i)
      ? []
      : [
          {
            price: Number(BigInt(c.strike)) / 1e9,
            label: `#${i + 1}`,
            color: "#ffd24a",
          },
        ]
  )

  return (
    <div className="flex flex-1 flex-col gap-3 overflow-y-auto">
      {/* 45s lockup bar */}
      <div>
        <div className="flex items-center justify-between pb-1">
          <span className="font-pixel text-xs tracking-[0.2em] text-white/55 uppercase">
            picks locked — cards settling
          </span>
          <span className="font-pixel text-sm text-cyan-300 tabular-nums">
            {Math.ceil(remainingMs / 1000)}s
          </span>
        </div>
        <div className="h-2 border-2 border-black/55 bg-[#0e1530]">
          <div
            className="h-full bg-cyan-400 transition-[width] duration-200 ease-linear"
            style={{ width: `${frac * 100}%` }}
          />
        </div>
      </div>

      <BtcSpotChart
        ticks={ticks}
        cards={roomState.cards}
        strikeLines={strikeLines}
      />

      {/* per-card flip strip */}
      <div className="grid grid-cols-5 gap-1.5">
        {cards.map((c, i) => {
          const outcome = settledByIdx.get(i)
          const my = roomState.swipes[i]?.p0Swipe ?? null
          const bot = roomState.swipes[i]?.p1Swipe ?? null
          const dueMs = lockupStartMs + c.expiryOffsetMs
          const hit = outcome && my ? outcome.upWon === my.isUp : null
          return (
            <div
              key={i}
              className={`border-2 border-black/55 px-1 py-1.5 text-center transition-colors ${
                outcome
                  ? hit
                    ? "bg-emerald-900/60"
                    : "bg-rose-900/60"
                  : "bg-[#0e1530]"
              }`}
            >
              <p className="font-pixel text-[10px] text-white/45 uppercase">
                {fmtUsd(c.strike)}
              </p>
              <p className="font-pixel text-sm text-white">
                {my ? (my.isUp ? "↑" : "↓") : "—"}
                <span className="px-0.5 text-white/30">·</span>
                <span className="text-white/60">
                  {bot ? (bot.isUp ? "↑" : "↓") : "…"}
                </span>
              </p>
              <p
                className={`font-pixel text-[10px] uppercase tabular-nums ${
                  outcome
                    ? hit
                      ? "text-emerald-300"
                      : "text-rose-300"
                    : "text-cyan-300"
                }`}
              >
                {outcome
                  ? hit
                    ? "hit"
                    : "miss"
                  : `${Math.max(0, Math.ceil((dueMs - nowMs) / 1000))}s`}
              </p>
            </div>
          )
        })}
      </div>

      <StreamingPnlChart
        duel={{
          id: roomState.duelId,
          settledCount: roomState.settledCount,
          cards: roomState.cards,
          swipes: roomState.swipes,
          cardOutcomes: roomState.cardOutcomes,
        }}
        ticks={ticks}
        myIsP0={true}
        youAddress={youAddress}
        oppAddress={BOT_ADDRESS}
      />
    </div>
  )
}

function ResultView({
  roomState,
  result,
  ticks,
  onPlayAgain,
}: {
  roomState: RoomState
  result: PracticeResult
  ticks: Record<string, { spot: string; expiry: string }>
  onPlayAgain: () => void
}) {
  return (
    <div className="flex flex-1 flex-col gap-3 overflow-y-auto">
      <div className="rounded border-2 border-black/55 bg-[#1b2548] p-4 text-center">
        <h3 className="text-2xl tracking-[0.2em] uppercase">
          {result.tied ? "Tie" : result.youWon ? "Victory" : "Defeat"}
        </h3>
        <p className="mt-2 text-base text-white/70">
          you {fmtDusdcSigned(result.yourPnl)} · bot{" "}
          {fmtDusdcSigned(result.botPnl)}
        </p>
        <p className="mt-1 font-pixel text-xs tracking-[0.15em] text-amber-300/80 uppercase">
          points (1/p × speed): you {result.yourPoints.toFixed(2)} · bot{" "}
          {result.botPoints.toFixed(2)}
        </p>
        <p className="mt-1 text-xs text-white/45">
          practice runs off-chain — nothing was staked, nothing is recorded
        </p>
      </div>
      <CardLedger roomState={roomState} myIsP0={true} ticks={ticks} />
      <div className="mt-auto flex flex-col gap-2">
        <button
          type="button"
          onClick={onPlayAgain}
          className="pixel-tile bg-emerald-600 px-4 py-3 font-pixel text-sm uppercase"
        >
          play again
        </button>
        <Link
          to="/game/pvp"
          className="pixel-tile no-hover bg-[#3a4d8a] px-4 py-3 text-center font-pixel text-sm uppercase"
        >
          find a real match
        </Link>
        <Link
          to="/game/home"
          className="pixel-tile no-hover bg-[#1b2548] px-4 py-3 text-center font-pixel text-sm uppercase"
        >
          back to home
        </Link>
      </div>
    </div>
  )
}
