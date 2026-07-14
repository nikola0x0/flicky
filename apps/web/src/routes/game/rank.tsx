import { useEffect, useState } from "react"
import { Link } from "react-router"
import { useCurrentAccount } from "@mysten/dapp-kit-react"
import { CONFIG } from "@/lib/config"
import { prefetchAvatarIcons } from "@/lib/avatar-store"
import { PlayerAvatar } from "@/components/player-avatar"
import { SeasonBanner } from "@/components/season-banner"
import { ratingToTier, TIER_STYLES } from "@/lib/rank-tier"
import {
  fetchSeason,
  fetchMyRank,
  prizeForRank,
  type Season,
  type MyRank,
} from "@/lib/season"
import { fmtCountdown } from "@/lib/countdown"
import { useNow } from "@/lib/use-now"
import { playSfx } from "@/lib/sound"

/** Wire shape from GET /leaderboard (top players by MMR rating). */
interface RankEntry {
  address: string
  rating: number
  gamesPlayed: number
  wins: number
  losses: number
  ties: number
  /** Completed staked duels — for Season prize eligibility. */
  stakedDuels: number
  /** `stakedDuels >= season.minStakedDuels` (server-computed). */
  eligible: boolean
}

const POLL_MS = 10_000
const FETCH_LIMIT = 100

/**
 * /game/rank — global leaderboard, ranked by MMR, with the Season 0 prize
 * overlay: a live countdown + prize pool in the header, a per-rank prize
 * breakdown, and each top-10 row annotated with its prize and whether the
 * player is prize-eligible (≥ N staked duels). Ranking itself is unchanged —
 * all-tier rating; eligibility only gates prizes. Read-only over
 * `/leaderboard` + `/season`; payout is manual ops at season end.
 */
export default function GameRank() {
  const account = useCurrentAccount()
  const me = account?.address
  const [players, setPlayers] = useState<RankEntry[] | null>(null)
  const [season, setSeason] = useState<Season | null>(null)
  const [myRankInfo, setMyRankInfo] = useState<MyRank | null>(null)
  const now = useNow(1000)

  useEffect(() => {
    let cancelled = false
    void fetchSeason().then((s) => {
      if (!cancelled) setSeason(s)
    })
    return () => {
      cancelled = true
    }
  }, [])

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

  // My own rank card — fetched by address so it's accurate even when I sit
  // outside the fetched top-N. When signed out the card is hidden by the
  // render gate below, so no explicit clear is needed here.
  useEffect(() => {
    if (!me) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      const info = await fetchMyRank(me)
      if (cancelled) return
      setMyRankInfo(info)
      timer = setTimeout(tick, POLL_MS)
    }
    void tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [me])

  const remaining = season ? Date.parse(season.endsAt) - now : 0

  return (
    <div className="relative isolate flex h-full flex-col gap-2 overflow-y-auto px-4 py-4 font-pixel text-white [mask-image:linear-gradient(to_bottom,transparent_0%,black_6%,black_100%)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {/* Season 0 promo banner (same as home). */}
      <SeasonBanner />
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
            className="h-32 w-auto max-w-none [image-rendering:pixelated]"
          />
        </div>
        <h1 className="-mt-3 text-4xl tracking-[0.2em] uppercase">
          leaderboard
        </h1>
        {season && remaining > 0 && (
          <p className="mt-1 text-base tracking-[0.14em] text-[#ffd27e] uppercase tabular-nums">
            {season.prizePool.total} {season.prizePool.currency} pool · ends in{" "}
            {fmtCountdown(remaining)}
          </p>
        )}
      </header>

      {me && myRankInfo && <MyRankCard info={myRankInfo} season={season} />}

      {season && <PrizePanel season={season} />}

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
              season={season}
            />
          ))}
        </ul>
      )}

      {players !== null && players.length > 0 && !myRankInfo && (
        <p className="px-1 pt-1 text-center text-sm tracking-[0.18em] text-white/45 uppercase">
          {me ? "finish a duel to enter the ranks" : "sign in to see your rank"}
        </p>
      )}
    </div>
  )
}

// Medal emoji for the top-3 prize tiers; a bullet otherwise.
const RANK_ICON: Record<number, string> = { 1: "🥇", 2: "🥈", 3: "🥉" }

/**
 * Per-rank prize breakdown, derived entirely from `season.prizeSplit`, so it
 * can't drift from the server config. Each tier is rendered as one row
 * (single ranks show a medal; a range like 4th–10th shows "each").
 */
function PrizePanel({ season }: { season: Season }) {
  const { prizePool, prizeSplit, minStakedDuels, eligibilityNote } = season
  return (
    <div className="space-y-2 rounded bg-black/30 px-3 py-3 backdrop-blur-sm">
      <div className="flex items-center justify-between">
        <span className="text-sm tracking-[0.18em] text-white/55 uppercase">
          {season.name} prizes
        </span>
        <span className="text-base text-[#ffd27e] tabular-nums">
          {prizePool.total} {prizePool.currency}
        </span>
      </div>
      <ul className="space-y-1">
        {prizeSplit.map((tier) => (
          <li
            key={`${tier.rankStart}-${tier.rankEnd}`}
            className="flex items-center justify-between text-sm"
          >
            <span className="tracking-wider text-white/80 uppercase">
              {tier.rankStart === tier.rankEnd
                ? `${RANK_ICON[tier.rankStart] ?? ""} ${ordinal(tier.rankStart)}`
                : `${ordinal(tier.rankStart)}–${ordinal(tier.rankEnd)}`}
            </span>
            <span className="text-white/90 tabular-nums">
              {tier.amount} {prizePool.currency}
              {tier.rankStart !== tier.rankEnd && (
                <span className="text-white/40"> each</span>
              )}
            </span>
          </li>
        ))}
      </ul>
      <p className="border-t border-white/10 pt-2 text-[10px] leading-relaxed tracking-wider text-white/40 uppercase">
        eligible: {minStakedDuels}+ staked duels · {eligibilityNote}
      </p>
    </div>
  )
}

/**
 * The connected player's own standing, pinned above the board so they never
 * have to scroll to find themselves — accurate even when they sit outside the
 * fetched top-N (fed by `GET /leaderboard/me`). Shows the prize + eligibility
 * chip when their rank is in the money.
 */
function MyRankCard({ info, season }: { info: MyRank; season: Season | null }) {
  const prize = season ? prizeForRank(season.prizeSplit, info.rank) : null
  return (
    <div className="flex items-center gap-3 rounded bg-[#4094fb]/20 px-3 py-2.5 ring-1 ring-[#7eb6ff]/50 backdrop-blur-sm">
      <span className="pixel-tile grid size-9 shrink-0 place-items-center bg-[#7eb6ff]/25 text-base text-white tabular-nums">
        {info.rank}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-sm tracking-[0.18em] text-[#bcd8ff] uppercase">
          your rank
        </span>
        {prize !== null && season && (
          <PrizeChip
            prize={prize}
            currency={season.prizePool.currency}
            eligible={info.eligible}
            stakedDuels={info.stakedDuels}
            minStaked={season.minStakedDuels}
          />
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end">
        <span className="text-2xl text-white tabular-nums">{info.rating}</span>
        <span className="text-sm tracking-[0.12em] text-white/45 uppercase tabular-nums">
          {info.wins}W {info.losses}L {info.ties}T
        </span>
      </div>
    </div>
  )
}

function RankRow({
  entry,
  position,
  isMe,
  season,
}: {
  entry: RankEntry
  position: number
  isMe: boolean
  season: Season | null
}) {
  const tier = ratingToTier(entry.rating)
  const tierStyle = TIER_STYLES[tier]
  const prize = season ? prizeForRank(season.prizeSplit, position) : null
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
        <span className="flex flex-wrap items-center gap-1.5">
          <span
            className={`w-fit rounded px-2 py-0.5 text-sm tracking-[0.18em] uppercase ring-1 ring-inset ${tierStyle.ring} ${tierStyle.text}`}
          >
            {tierStyle.label}
          </span>
          {prize !== null && season && (
            <PrizeChip
              prize={prize}
              currency={season.prizePool.currency}
              eligible={entry.eligible}
              stakedDuels={entry.stakedDuels}
              minStaked={season.minStakedDuels}
            />
          )}
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

/**
 * The prize a top-10 row would win, with its eligibility state:
 *   eligible   → gold chip ("🏆 200 SUI")
 *   ineligible → muted chip + how many more staked duels are needed
 *                ("200 SUI · 1/10 staked"), so it's clear the prize is locked.
 */
function PrizeChip({
  prize,
  currency,
  eligible,
  stakedDuels,
  minStaked,
}: {
  prize: number
  currency: string
  eligible: boolean
  stakedDuels: number
  minStaked: number
}) {
  if (eligible) {
    return (
      <span className="w-fit rounded bg-[#ffd27e]/15 px-2 py-0.5 text-sm tracking-[0.12em] text-[#ffd27e] uppercase tabular-nums ring-1 ring-[#ffd27e]/40 ring-inset">
        🏆 {prize} {currency}
      </span>
    )
  }
  return (
    <span className="w-fit rounded bg-white/5 px-2 py-0.5 text-sm tracking-[0.12em] text-white/40 uppercase tabular-nums ring-1 ring-white/10 ring-inset">
      {prize} {currency} · {stakedDuels}/{minStaked} staked
    </span>
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

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"]
  const v = n % 100
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`
}
