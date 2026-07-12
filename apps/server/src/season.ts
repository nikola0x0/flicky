/**
 * GET /season — Season 0 leaderboard-prize config, for the rank-screen
 * display. Static (env-driven). The per-player staked-duel count + prize
 * eligibility ride on `/leaderboard` (they need the duel mirror).
 *
 * DISPLAY-ONLY: payout is manual ops at season end — there is no escrow
 * contract. The pool total is DERIVED from the split so the headline number
 * and per-rank breakdown can't drift.
 */
import { env } from "./env"
import { json } from "./lib/http"

/** Sum of every rank's prize across the configured tiers (the headline pool). */
export function seasonPrizePoolTotal(): number {
  return env.seasonPrizeSplit.reduce(
    (sum, t) => sum + t.amount * (t.rankEnd - t.rankStart + 1),
    0
  )
}

export function handleSeasonRequest(req: Request, url: URL): Response | null {
  if (url.pathname !== "/season" || req.method !== "GET") return null
  return json({
    season: {
      id: env.seasonId,
      name: env.seasonName,
      endsAt: env.seasonEndsAt,
      prizePool: {
        total: seasonPrizePoolTotal(),
        currency: env.seasonPrizeCurrency,
      },
      prizeSplit: env.seasonPrizeSplit,
      minStakedDuels: env.seasonMinStakedDuels,
      eligibilityNote: env.seasonEligibilityNote,
      // On-chain prize escrow, present once the season package is published
      // (and its pool created). Lets the UI show funds are escrowed on-chain.
      escrow: env.seasonPackageId
        ? { packageId: env.seasonPackageId, poolId: env.seasonPoolId ?? null }
        : null,
    },
  })
}
