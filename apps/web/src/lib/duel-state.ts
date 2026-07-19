/**
 * Duel-liveness helpers shared by the duel view and home tiles.
 *
 * The keeper only settles a duel once BOTH players completed EVERY swipe
 * (`tryClose`'s bothDone gate in apps/server) — partial duels are left to
 * the players' own `refund_duel`. A swipe can only be placed while its
 * card's market is still live (the staked mint fails on an expired
 * market), so the moment any market settles with either player's swipe
 * missing, the deck can never be completed and settlement will never run.
 */

export interface SwipeRowLite {
  cardIdx: number
  p0Swipe: unknown | null
  p1Swipe: unknown | null
}

/**
 * True when this ACTIVE duel is permanently un-settleable: some card's
 * market already settled without both players' swipes in. Such a duel
 * stays "ACTIVE" on chain forever unless a player claims `refund_duel`
 * (open 1h after start — see `refundEligibility` in lib/flicky.ts).
 *
 * `settledMarkets` — market ids the oracle tick stream reports settled.
 */
export function duelUnsettleable(
  duel: {
    status: string
    cards: Array<{ expiry_market_id: string }>
    swipes: SwipeRowLite[]
  },
  settledMarkets: ReadonlySet<string>
): boolean {
  if (duel.status !== "ACTIVE") return false
  return duel.cards.some((card, i) => {
    if (!settledMarkets.has(card.expiry_market_id)) return false
    const row = duel.swipes.find((s) => s.cardIdx === i)
    return !row || row.p0Swipe == null || row.p1Swipe == null
  })
}

/**
 * Which side abandoned the deck (has a missing swipe on a settled
 * market), for the dead-duel banner's wording. Both can be true.
 */
export function missingSides(
  duel: {
    cards: Array<{ expiry_market_id: string }>
    swipes: SwipeRowLite[]
  },
  settledMarkets: ReadonlySet<string>
): { p0: boolean; p1: boolean } {
  let p0 = false
  let p1 = false
  duel.cards.forEach((card, i) => {
    if (!settledMarkets.has(card.expiry_market_id)) return
    const row = duel.swipes.find((s) => s.cardIdx === i)
    if (!row || row.p0Swipe == null) p0 = true
    if (!row || row.p1Swipe == null) p1 = true
  })
  return { p0, p1 }
}
