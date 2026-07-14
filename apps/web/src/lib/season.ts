/**
 * Season 0 leaderboard-prize config from the server's `GET /season`.
 * Display-only — payout is manual ops at season end (no escrow contract).
 */
import { CONFIG } from "./config"

/** Ranks `rankStart..rankEnd` (inclusive, 1-based) each pay `amount`. */
export interface PrizeTier {
  rankStart: number
  rankEnd: number
  amount: number
}

export interface Season {
  id: string
  name: string
  /** ISO instant the season ends (countdown target). */
  endsAt: string
  prizePool: { total: number; currency: string }
  prizeSplit: PrizeTier[]
  minStakedDuels: number
  eligibilityNote: string
}

/** Fetch the season config, or `null` if the server is unreachable / has none. */
export async function fetchSeason(): Promise<Season | null> {
  try {
    const res = await fetch(`${CONFIG.serverHttpUrl}/season`)
    if (!res.ok) return null
    const body = (await res.json()) as { season?: Season }
    return body.season ?? null
  } catch {
    return null
  }
}

/** A player's own rank card from `GET /leaderboard/me` (works outside top-N). */
export interface MyRank {
  rank: number
  rating: number
  wins: number
  losses: number
  ties: number
  stakedDuels: number
  eligible: boolean
}

/**
 * Fetch a player's own leaderboard position, or `null` if they aren't ranked
 * yet (no completed duel) or the server is unreachable. Lets the rank screen
 * show "YOUR RANK #N" even when the player sits outside the fetched top-N.
 */
export async function fetchMyRank(address: string): Promise<MyRank | null> {
  try {
    const res = await fetch(
      `${CONFIG.serverHttpUrl}/leaderboard/me?address=${address}`
    )
    if (!res.ok) return null
    const body = (await res.json()) as
      | { ranked: false }
      | ({ ranked: true } & MyRank)
    return body.ranked ? body : null
  } catch {
    return null
  }
}

/** The prize amount for a 1-based leaderboard position, or `null` if that rank wins nothing. */
export function prizeForRank(
  split: PrizeTier[],
  position: number
): number | null {
  for (const tier of split) {
    if (position >= tier.rankStart && position <= tier.rankEnd)
      return tier.amount
  }
  return null
}
