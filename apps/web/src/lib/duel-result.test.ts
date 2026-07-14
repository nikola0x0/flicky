import { expect, test } from "bun:test"
import { summarizeDuelResult } from "./duel-result"

// [p0Pnl, p1Pnl]; swiped[side]=false ⇒ that side skipped the card.
const outcome = (
  pnl: [string | null, string | null],
  swiped: [boolean, boolean] = [true, true]
) => ({
  p0Pnl: pnl[0],
  p1Pnl: pnl[1],
  p0Swipe: swiped[0] ? { isUp: true } : null,
  p1Swipe: swiped[1] ? { isUp: false } : null,
})

// p0: 3 hits (cards 1,2,4), skipped card 5, net +7, odds 12/5 = 2.4×.
// p1: 2 hits (cards 3,5), net −2, odds 3/5 = 0.6×.
const staked = {
  creator: "0xaaa",
  p0Payout: "12000000",
  p0Premium: "5000000",
  p1Payout: "3000000",
  p1Premium: "5000000",
  cardCount: 5,
  cardOutcomes: [
    outcome(["1000000", "-1000000"]),
    outcome(["2000000", "-2000000"]),
    outcome(["-500000", "500000"]),
    outcome(["4000000", "-4000000"]),
    outcome([null, "1500000"], [false, true]),
  ],
}

test("staked duel from the winner's side", () => {
  const s = summarizeDuelResult(staked, true)
  expect(s.outcome).toBe("win")
  expect(s.hits).toBe(3)
  expect(s.totalCards).toBe(5)
  expect(s.freeDuel).toBe(false)
  expect(s.oddsLabel).toBe("2.4×")
  expect(s.netLabel).toBe("+7")
  expect(s.returnPctLabel).toBe("+140%")
  expect(s.shareText).toBe(
    "flicky duel — 3/5 hits · 2.4× odds · +7 dUSDC — watch:"
  )
})

test("same duel from the loser's side", () => {
  const s = summarizeDuelResult(staked, false)
  expect(s.outcome).toBe("loss")
  expect(s.hits).toBe(2)
  expect(s.oddsLabel).toBe("0.6×")
  expect(s.netLabel).toBe("-2")
  expect(s.returnPctLabel).toBe("-40%")
})

test("authoritative winner field overrides the net comparison", () => {
  const s = summarizeDuelResult({ ...staked, winner: "p1" }, true)
  expect(s.outcome).toBe("loss")
})

test("zero pnl counts as a hit (card-tile badge parity)", () => {
  const s = summarizeDuelResult(
    { ...staked, cardOutcomes: [outcome(["0", "0"])] },
    true
  )
  expect(s.hits).toBe(1)
})

test("free duel: no odds/net, hits-only share text", () => {
  const s = summarizeDuelResult(
    {
      ...staked,
      p0Payout: "0",
      p0Premium: "0",
      p1Payout: "0",
      p1Premium: "0",
      winner: "p0",
    },
    true
  )
  expect(s.outcome).toBe("win")
  expect(s.freeDuel).toBe(true)
  expect(s.oddsLabel).toBeNull()
  expect(s.netLabel).toBeNull()
  expect(s.returnPctLabel).toBeNull()
  expect(s.shareText).toBe("flicky duel — 3/5 hits — watch:")
})

test("fractional net trims trailing zeros", () => {
  const s = summarizeDuelResult({ ...staked, p0Payout: "11500000" }, true)
  expect(s.netLabel).toBe("+6.5")
  expect(s.returnPctLabel).toBe("+130%")
})
