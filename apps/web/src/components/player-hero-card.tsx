/**
 * Compact "who am I" card for the home page. Pulls public read endpoints
 * the server already exposes:
 *
 *   - GET /leaderboard?limit=500     → find self → rating + W/L/T counts
 *   - GET /duels/recent?player=…     → walk newest → oldest → streak
 *
 * Renders avatar, short address, rank tier (derived from rating),
 * rating number, and three stat chips (wins / losses / current streak).
 *
 * Stats poll every 10 s. Streak polls every 10 s. Both are best-effort
 * with silent retries — the home tile keeps working even if one fails.
 */
import { useEffect, useState } from "react"
import { CONFIG } from "@/lib/config"
import { PlayerAvatar } from "@/components/player-avatar"

interface LeaderboardEntry {
  address: string
  rating: number
  gamesPlayed: number
  wins: number
  losses: number
  ties: number
}

interface DuelLite {
  status: "PENDING" | "ACTIVE" | "COMPLETE"
  creator: string
  challenger: string
  p0Payout: string
  p0Premium: string
  p1Payout: string
  p1Premium: string
  startedAtMs: number
}

const POLL_MS = 10_000

type Tier = "unranked" | "bronze" | "silver" | "gold" | "platinum"

function ratingToTier(rating: number | null): Tier {
  if (rating === null) return "unranked"
  if (rating < 1100) return "bronze"
  if (rating < 1300) return "silver"
  if (rating < 1500) return "gold"
  return "platinum"
}

const TIER_STYLES: Record<Tier, { label: string; text: string; ring: string }> =
  {
    unranked: {
      label: "unranked",
      text: "text-white/55",
      ring: "ring-white/15",
    },
    bronze: {
      label: "bronze",
      text: "text-amber-600",
      ring: "ring-amber-700/40",
    },
    silver: {
      label: "silver",
      text: "text-slate-300",
      ring: "ring-slate-400/40",
    },
    gold: {
      label: "gold",
      text: "text-yellow-300",
      ring: "ring-yellow-400/50",
    },
    platinum: {
      label: "platinum",
      text: "text-cyan-300",
      ring: "ring-cyan-400/50",
    },
  }

function usePlayerStats(address: string | undefined): LeaderboardEntry | null {
  const [stats, setStats] = useState<LeaderboardEntry | null>(null)
  useEffect(() => {
    if (!address) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      try {
        const res = await fetch(
          `${CONFIG.serverHttpUrl}/leaderboard?limit=500`,
        )
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const body = (await res.json()) as { players: LeaderboardEntry[] }
        const self =
          body.players.find(
            (p) => p.address.toLowerCase() === address.toLowerCase(),
          ) ?? null
        if (!cancelled) setStats(self)
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
  }, [address])
  return stats
}

function usePlayerStreak(address: string | undefined): number | null {
  const [streak, setStreak] = useState<number | null>(null)
  useEffect(() => {
    if (!address) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      try {
        const res = await fetch(
          `${CONFIG.serverHttpUrl}/duels/recent?player=${encodeURIComponent(address)}&limit=20&status=COMPLETE`,
        )
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const body = (await res.json()) as { duels: DuelLite[] }
        // Walk newest → oldest, count consecutive wins until a loss/tie.
        let count = 0
        for (const d of body.duels) {
          const myIsP0 = d.creator.toLowerCase() === address.toLowerCase()
          const payout = BigInt(myIsP0 ? d.p0Payout : d.p1Payout)
          const premium = BigInt(myIsP0 ? d.p0Premium : d.p1Premium)
          if (payout > premium) count++
          else break
        }
        if (!cancelled) setStreak(count)
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
  }, [address])
  return streak
}

export function PlayerHeroCard({ address }: { address: string }) {
  const stats = usePlayerStats(address)
  const streak = usePlayerStreak(address)
  const tier = ratingToTier(stats?.rating ?? null)
  const tierStyle = TIER_STYLES[tier]

  return (
    <section className="w-full rounded-xl border-2 border-black/55 bg-black/35 p-3 font-pixel text-white shadow-[inset_0_-2px_0_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.06)] backdrop-blur-md">
      <div className="flex items-center gap-3">
        <PlayerAvatar address={address} size={56} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate text-sm tracking-[0.18em] uppercase">
            {shortAddr(address)}
          </span>
          <div className="flex items-center gap-2 text-xs tracking-[0.18em] uppercase">
            <span
              className={`rounded px-2 py-0.5 ring-1 ring-inset ${tierStyle.ring} ${tierStyle.text}`}
            >
              {tierStyle.label}
            </span>
            <span className="tabular-nums text-white/85">
              {stats?.rating ?? "—"}
            </span>
          </div>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs tracking-[0.18em] uppercase">
        <StatChip
          label="wins"
          value={stats ? stats.wins.toString() : "—"}
          valueClass="text-emerald-300"
        />
        <StatChip
          label="losses"
          value={stats ? stats.losses.toString() : "—"}
          valueClass="text-rose-300"
        />
        <StatChip
          label="streak"
          value={streak === null ? "—" : streak.toString()}
          valueClass={
            streak && streak > 0 ? "text-amber-300" : "text-white/60"
          }
        />
      </div>
    </section>
  )
}

function StatChip({
  label,
  value,
  valueClass,
}: {
  label: string
  value: string
  valueClass: string
}) {
  return (
    <div className="flex flex-col gap-0.5 rounded bg-black/25 px-2 py-1.5">
      <span className="text-[10px] text-white/55">{label}</span>
      <span className={`text-lg tabular-nums ${valueClass}`}>{value}</span>
    </div>
  )
}

function shortAddr(a: string): string {
  if (a.length < 12) return a
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}
