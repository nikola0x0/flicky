/**
 * Season results — the manual-payout readout for season end.
 *
 * Ranks players by MMR, keeps only prize-ELIGIBLE ones (≥ SEASON_MIN_STAKED_DUELS
 * completed staked duels), and assigns the prize split down that eligible list.
 * Ineligible players who'd otherwise place in the money are listed separately so
 * ops can apply the "team discretion" line transparently.
 *
 * DISPLAY/OPS ONLY — payout is manual (no escrow). Reads the same data the
 * /leaderboard + /season endpoints serve. Point DATABASE_URL at the same DB the
 * live server uses (public proxy for local runs).
 *
 *   bun run season:results
 */
import { env, type PrizeTier } from "../env"
import { leaderboard, stakedDuelCounts, closeDb } from "../db"
import { seasonPrizePoolTotal } from "../season"

function prizeForRank(split: PrizeTier[], position: number): number {
  for (const t of split) {
    if (position >= t.rankStart && position <= t.rankEnd) return t.amount
  }
  return 0
}

function short(a: string): string {
  return a.length < 12 ? a : `${a.slice(0, 6)}…${a.slice(-4)}`
}

const split = env.seasonPrizeSplit
const maxRank = Math.max(...split.map((t) => t.rankEnd))

console.log(`\n${env.seasonName} (${env.seasonId}) — payout readout`)
console.log(`ends: ${env.seasonEndsAt}`)
console.log(
  `pool: ${seasonPrizePoolTotal()} ${env.seasonPrizeCurrency} · eligibility: ≥${env.seasonMinStakedDuels} staked duels\n`
)

const ranked = await leaderboard(1000)
const staked = await stakedDuelCounts()

const withStaked = ranked.map((p) => ({
  ...p,
  stakedDuels: staked.get(p.address) ?? 0,
  eligible: (staked.get(p.address) ?? 0) >= env.seasonMinStakedDuels,
}))

const eligible = withStaked.filter((p) => p.eligible)

console.log("── PAYOUT (eligible players, in rating order) ──")
console.log("rank  address              rating  staked  prize")
let total = 0
eligible.slice(0, maxRank).forEach((p, i) => {
  const rank = i + 1
  const prize = prizeForRank(split, rank)
  total += prize
  console.log(
    `${String(rank).padStart(2)}    ${short(p.address).padEnd(18)}  ${String(p.rating).padStart(5)}   ${String(p.stakedDuels).padStart(4)}   ${prize} ${env.seasonPrizeCurrency}`
  )
})
console.log(`\ntotal to pay: ${total} ${env.seasonPrizeCurrency}\n`)

// Transparency: players in the top `maxRank` by overall rating who are
// excluded purely for failing the staked-duel gate.
const excludedInMoney = withStaked.slice(0, maxRank).filter((p) => !p.eligible)
if (excludedInMoney.length > 0) {
  console.log("── EXCLUDED (ineligible — team discretion) ──")
  for (const p of excludedInMoney) {
    console.log(
      `      ${short(p.address).padEnd(18)}  ${String(p.rating).padStart(5)}   ${p.stakedDuels}/${env.seasonMinStakedDuels} staked`
    )
  }
  console.log("")
}

await closeDb()
