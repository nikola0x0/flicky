import { useEffect, useMemo, useState } from "react"
import { Link } from "react-router"
import { useCurrentAccount } from "@mysten/dapp-kit-react"
import { CONFIG } from "@/lib/config"
import { prefetchAvatarIcons } from "@/lib/avatar-store"
import { PlayerAvatar } from "@/components/player-avatar"
import { PixelButton } from "@/components/pixel-button"
import { ratingToTier, TIER_STYLES } from "@/lib/rank-tier"
import { playSfx } from "@/lib/sound"
import type { CSSProperties } from "react"

const BLUE_BRAND_STYLE = {
  "--btn-bg": "#4094fb",
  "--btn-highlight": "#7eb6ff",
} as CSSProperties

/** Wire shape from GET /leaderboard (top players by MMR rating). */
interface RankEntry {
  address: string
  rating: number
  gamesPlayed: number
  wins: number
  losses: number
  ties: number
}

const POLL_MS = 10_000
const FETCH_LIMIT = 100

/**
 * /game/rank — global leaderboard, ranked by MMR. Read-only over the
 * server's `/leaderboard` endpoint (the `player_rating` table). Each row:
 * position medal, avatar, address, tier badge, rating, and W/L/T. The
 * signed-in player's row is highlighted; if they're not in the top list a
 * small note explains why (unranked / outside the top 100).
 *
 * No bespoke art beyond the trophy banner — tier badges and the top-3
 * medals are derived from the in-game pixel palette.
 */
export default function GameRank() {
  const account = useCurrentAccount()
  const me = account?.address
  const [players, setPlayers] = useState<RankEntry[] | null>(null)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      try {
        const res = await fetch(
          `${CONFIG.serverHttpUrl}/leaderboard?limit=${FETCH_LIMIT}`
        )
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const body = (await res.json()) as { players: RankEntry[] }
        if (!cancelled) {
          setPlayers(body.players)
          // Warm the avatar cache so the rows paint with icons, not a flash.
          prefetchAvatarIcons(body.players.map((p) => p.address))
        }
      } catch {
        // Silent — next poll retries.
      } finally {
        if (!cancelled) timer = setTimeout(tick, POLL_MS)
      }
    }
    void tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [])

  const myRank = useMemo(() => {
    if (!players || !me) return null
    const i = players.findIndex(
      (p) => p.address.toLowerCase() === me.toLowerCase()
    )
    return i === -1 ? null : i + 1
  }, [players, me])

  return (
    <div className="relative isolate flex h-full flex-col gap-3 overflow-y-auto px-4 py-4 font-pixel text-white [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <header className="flex flex-col items-center">
        {/* Trophy-podium banner. The radial glow behind it gives the art
            an arcade "spotlight" without needing a baked-in background. */}
        <div className="relative flex justify-center">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 -z-10"
            style={{
              background:
                "radial-gradient(60% 60% at 50% 45%, rgba(126,200,227,0.18) 0%, rgba(27,37,72,0) 70%)",
            }}
          />
          <img
            src="/banners/rank-header.png"
            alt=""
            aria-hidden
            className="h-56 w-auto max-w-none [image-rendering:pixelated]"
          />
        </div>
        <h1 className="-mt-4 text-4xl tracking-[0.2em] uppercase">
          leaderboard
        </h1>
        {myRank !== null && (
          <p className="mt-1 text-base tracking-[0.18em] text-white/55 uppercase">
            you're ranked #{myRank}
          </p>
        )}
      </header>

      {players === null ? (
        <p className="px-1 py-6 text-center text-base tracking-[0.18em] text-white/55 uppercase">
          loading…
        </p>
      ) : players.length === 0 ? (
        <Empty />
      ) : (
        <ul className="flex flex-col gap-2">
          {players.map((p, i) => (
            <RankRow
              key={p.address}
              entry={p}
              position={i + 1}
              isMe={!!me && p.address.toLowerCase() === me.toLowerCase()}
            />
          ))}
        </ul>
      )}

      {players !== null && players.length > 0 && myRank === null && (
        <p className="px-1 pt-1 text-center text-sm tracking-[0.18em] text-white/45 uppercase">
          {me ? "finish a duel to enter the ranks" : "sign in to see your rank"}
        </p>
      )}

      <footer className="mt-auto pt-2">
        <Link to="/game/home" className="block">
          <PixelButton style={BLUE_BRAND_STYLE} className="h-12 w-full text-lg">
            back to home
          </PixelButton>
        </Link>
      </footer>
    </div>
  )
}

function RankRow({
  entry,
  position,
  isMe,
}: {
  entry: RankEntry
  position: number
  isMe: boolean
}) {
  const tier = ratingToTier(entry.rating)
  const tierStyle = TIER_STYLES[tier]
  return (
    <li
      className={`flex items-center gap-3 rounded px-3 py-2.5 backdrop-blur-sm ${
        isMe ? "bg-[#4094fb]/20 ring-1 ring-[#7eb6ff]/50" : "bg-black/30"
      }`}
    >
      <RankMedal position={position} />
      <PlayerAvatar address={entry.address} size={44} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex items-center gap-2 truncate text-lg tracking-wider uppercase">
          {shortAddr(entry.address)}
          {isMe && (
            <span className="rounded bg-[#7eb6ff]/25 px-1.5 py-0.5 text-xs tracking-[0.18em] text-[#bcd8ff]">
              you
            </span>
          )}
        </span>
        <span
          className={`w-fit rounded px-2 py-0.5 text-sm tracking-[0.18em] uppercase ring-1 ring-inset ${tierStyle.ring} ${tierStyle.text}`}
        >
          {tierStyle.label}
        </span>
      </div>
      <div className="flex shrink-0 flex-col items-end">
        <span className="text-2xl text-white tabular-nums">{entry.rating}</span>
        <span className="text-sm tracking-[0.12em] text-white/45 uppercase tabular-nums">
          {entry.wins}W {entry.losses}L {entry.ties}T
        </span>
      </div>
    </li>
  )
}

// Gold / silver / bronze pixel medallions for the top 3; a plain numbered
// tile otherwise. All CSS — no art assets.
const MEDAL_STYLES: Record<number, string> = {
  1: "bg-gradient-to-b from-yellow-300 to-amber-500 text-black shadow-[0_0_8px_rgba(250,204,21,0.5)]",
  2: "bg-gradient-to-b from-slate-200 to-slate-400 text-black",
  3: "bg-gradient-to-b from-amber-600 to-amber-800 text-white",
}

function RankMedal({ position }: { position: number }) {
  const medal = MEDAL_STYLES[position]
  return (
    <span
      className={`pixel-tile grid size-9 shrink-0 place-items-center text-base tabular-nums ${
        medal ?? "bg-white/10 text-white/70"
      }`}
    >
      {position}
    </span>
  )
}

function Empty() {
  return (
    <div className="flex flex-col items-center gap-3 rounded bg-black/30 px-6 py-10 text-center backdrop-blur-sm">
      <img
        src="/icons/star.png"
        alt=""
        aria-hidden
        className="size-12 opacity-60 [image-rendering:pixelated]"
      />
      <p className="max-w-[28ch] text-base leading-relaxed tracking-wider text-white/55 uppercase">
        no ranked players yet — finish a duel to claim the top spot.
      </p>
      <Link
        to="/game/pvp"
        onClick={() => playSfx("click")}
        className="mt-1 rounded border border-white/30 bg-white/5 px-3 py-1 text-sm tracking-wider uppercase hover:bg-white/10"
      >
        find a duel
      </Link>
    </div>
  )
}

function shortAddr(a: string): string {
  if (!a || a.length < 12) return a
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}
