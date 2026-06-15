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
import { ratingToTier, TIER_STYLES } from "@/lib/rank-tier"
import { playerDuelResult } from "@/lib/duel-result"

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
  winner?: "p0" | "p1" | "tie" | null
  startedAtMs: number
}

const POLL_MS = 10_000

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

interface PlayerRecord {
  wins: number
  losses: number
  ties: number
  /** Consecutive wins counted from the most recent finished duel. */
  streak: number
}

/**
 * W/L/T record + current win-streak derived from the player's COMPLETE
 * duels in the indexer's duel mirror — the same source the history list
 * reads. Deliberately NOT the `/leaderboard` (player_rating) table: that
 * is only written live from `DuelFinalized` events and is not
 * reconstructable, so after any rating-DB reset it can be empty even when
 * the player has finished duels. Deriving from the mirror keeps the home
 * card consistent with what history shows.
 */
function usePlayerRecord(address: string | undefined): PlayerRecord | null {
  const [record, setRecord] = useState<PlayerRecord | null>(null)
  useEffect(() => {
    if (!address) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      try {
        const res = await fetch(
          `${CONFIG.serverHttpUrl}/duels/recent?player=${encodeURIComponent(address)}&limit=100&status=COMPLETE`,
        )
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const body = (await res.json()) as { duels: DuelLite[] }
        // Server returns newest → oldest. Tally W/L/T over all finished
        // duels; the streak counts consecutive wins from the newest until
        // the first non-win. `playerDuelResult` uses the same win rule as
        // the leaderboard so the two surfaces always agree.
        let wins = 0
        let losses = 0
        let ties = 0
        let streak = 0
        let streakOpen = true
        for (const d of body.duels) {
          const result = playerDuelResult(d, address)
          if (result === "win") wins++
          else if (result === "loss") losses++
          else ties++
          if (streakOpen) {
            if (result === "win") streak++
            else streakOpen = false
          }
        }
        if (!cancelled) setRecord({ wins, losses, ties, streak })
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
  return record
}

export function PlayerHeroCard({ address }: { address: string }) {
  const stats = usePlayerStats(address)
  const record = usePlayerRecord(address)
  const tier = ratingToTier(stats?.rating ?? null)
  const tierStyle = TIER_STYLES[tier]

  return (
    <section className="w-full rounded-xl border-2 border-black/55 bg-black/35 p-3 font-pixel text-white shadow-[inset_0_-2px_0_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.06)] backdrop-blur-md">
      <div className="flex items-center gap-3">
        <PlayerAvatar address={address} size={56} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate text-base tracking-[0.18em] uppercase">
            {shortAddr(address)}
          </span>
          <div className="flex items-center gap-2 text-sm tracking-[0.18em] uppercase">
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

      <div className="mt-3 grid grid-cols-3 gap-2 text-center text-sm tracking-[0.18em] uppercase">
        <StatChip
          label="wins"
          value={record ? record.wins.toString() : "—"}
          valueClass="text-emerald-300"
        />
        <StatChip
          label="losses"
          value={record ? record.losses.toString() : "—"}
          valueClass="text-rose-300"
        />
        <StatChip
          label="streak"
          value={record ? record.streak.toString() : "—"}
          valueClass={
            record && record.streak > 0 ? "text-amber-300" : "text-white/60"
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
      <span className="text-xs text-white/55">{label}</span>
      <span className={`text-xl tabular-nums ${valueClass}`}>{value}</span>
    </div>
  )
}

function shortAddr(a: string): string {
  if (a.length < 12) return a
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}
