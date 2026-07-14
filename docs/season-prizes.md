# Season prizes — leaderboard, eligibility, payout & receipts

How the seasonal prize layer works end to end: what's off-chain vs on-chain, who
gets on the leaderboard, who is eligible for a prize, who can pay out, how the
payout runs, and how a winner keeps and re-checks their receipt.

TL;DR:

- **Leaderboard = off-chain** (a Postgres `player_rating` table derived from
  on-chain duel events). **Payout rail = on-chain** (`season::prize_pool`).
- **Getting ranked needs 1 duel of any tier.** It is _not_ gated by the staked
  count.
- **Prize eligibility** needs `SEASON_MIN_STAKED_DUELS` completed _staked_
  duels (default **1**). Set it to `0` to drop the gate entirely.
- **Only the `SPONSOR_SECRET_KEY` wallet can distribute** (it holds the
  `AdminCap`). Funding the pool is permissionless.
- **The distribution transaction is the receipt** — SUI lands in each winner's
  wallet and a `Distributed` event is emitted; both are permanent and publicly
  verifiable.

---

## 1. Off-chain leaderboard, on-chain payout

The leaderboard is **not** read from chain on every request. It's a derived
projection:

```
on-chain Duel settles → emits DuelFinalized
  → server indexer (indexer.ts) picks it up
  → mmr.applyDuelOutcome runs one ELO step
  → writes player_rating (rating, W/L/T) in Postgres
GET /leaderboard = SELECT … FROM player_rating ORDER BY rating DESC
```

Because the rating is a pure function of the completed duels, it can be rebuilt
at any time from the duel mirror (`bun run backfill:ratings` →
`recomputeRatingsFromMirror`), so a DB reset never loses standings.

The **prize layer is display-only config** (`GET /season`, served from env) plus
one **on-chain escrow contract** (`apps/contracts/season`, `season::prize_pool`)
that is the actual payout rail. The pool total shown to players is _derived_ from
the prize split, so the headline number and the per-rank breakdown can never
drift apart.

## 2. Ranking (MMR)

- Standard ELO, K-factor 32 (`MMR_K_FACTOR`), new players start at 1000
  (`MMR_INITIAL_RATING`).
- Rating is **all-tier**: Free (SUI) and Staked (dUSDC) duels both move the same
  MMR. MMR is also the matchmaking signal.
- **Leaderboard entry = `games_played > 0`** — a single completed duel of any
  tier puts you on the board. Nothing else is required to _appear_.

## 3. Eligibility ≠ entry

This is the part that's easy to conflate:

|                               | Requirement                    | Controlled by                             |
| ----------------------------- | ------------------------------ | ----------------------------------------- |
| **Appear on the leaderboard** | ≥ 1 completed duel (any tier)  | fixed (`games_played > 0`)                |
| **Be eligible for a prize**   | ≥ N completed **staked** duels | `SEASON_MIN_STAKED_DUELS` (default **1**) |

Why a staked gate at all: prizes are **real SUI**, so a winner should have put
real money (dUSDC) on the line at least once — otherwise the payout could be
farmed with free duels. The default of **1** keeps that "skin in the game"
property while imposing essentially no barrier.

- Lower/raise it via `SEASON_MIN_STAKED_DUELS` (no redeploy — it's env).
- **Set it to `0` to remove the gate**: every ranked player becomes
  prize-eligible.

Ranking itself is untouched by this — eligibility only decides who the prize is
_paid_ to. On the leaderboard, an ineligible top-N player shows a muted
`0/1 staked` chip; an eligible one shows the gold `🏆 4 SUI` chip.

Server plumbing: `GET /leaderboard` annotates each row with `stakedDuels` +
`eligible`; the staked count comes from the `duel` mirror
(`stake_coin_type = dUSDC` ⇒ staked, `0x2::sui::SUI` ⇒ free).

## 4. "Your rank" — always visible

`GET /leaderboard/me?address=0x…` returns a single player's 1-based position,
rating, W/L/T, and prize eligibility — **even when they sit outside the fetched
top-N**, computed as `1 + (count of ranked players with a strictly higher
rating)`. Response is `{ ranked: false }` when the address has no completed duel
yet.

The rank screen (`apps/web/src/routes/game/rank.tsx`) polls it for the connected
wallet and pins a **YOUR RANK #N** card above the board, showing the prize chip
when that rank is in the money.

## 5. Who can pay out

The escrow's `AdminCap` — minted to the publisher at deploy time and held by the
**`SPONSOR_SECRET_KEY`** wallet (the unified keeper/sponsor/deployer key,
`0x9c08a74c…`) — gates every fund-moving admin action:

| Action                    | Auth       | Notes                                   |
| ------------------------- | ---------- | --------------------------------------- |
| `deposit` (fund the pool) | **anyone** | funding is always safe                  |
| `create_pool`             | AdminCap   | one shared pool per season              |
| `distribute`              | AdminCap   | single-shot; pays all winners in one tx |
| `withdraw_remainder`      | AdminCap   | recovery hatch — funds never stuck      |

`distribute` is **single-shot** (a `distributed` lock blocks a replay) and
asserts matched winner/amount lengths and `sum(amounts) ≤ balance`, so it can
neither be re-run nor over-spend the pool. Any unpaid remainder (e.g. fewer
eligible winners than prize ranks) stays in the pool and is recoverable.

## 6. Ops runbook — fund and pay out

All amounts are SUI; the scripts convert to MIST (1 SUI = 1e9). Requires the
season env vars set (see §8) and `DATABASE_URL` pointed at the live DB.

```bash
# 1. Fund the pool (permissionless; funder = SPONSOR_SECRET_KEY wallet).
bun --filter server season:deposit 10        # deposit 10 SUI

# 2. Preview the payout — reads the live DB, prints the winner list. No chain
#    writes, no --execute → safe to run anytime.
bun --filter server season:distribute

# 3. Submit the payout for real (needs SEASON_ADMIN_CAP_ID set).
bun --filter server season:distribute --execute
```

`season:distribute` computes the **same** winner list as `season:results`
(eligible players in MMR order, top N by the prize split), then calls
`distribute`. It is **dry-run by default** — real funds move only with
`--execute`. On success it writes a receipt JSON to
`apps/contracts/season/distributions/<seasonId>-<txDigest>.json` and prints the
tx + per-winner explorer links.

`season:results` remains the read-only readout (eligible list + an "excluded
(ineligible)" list for the team-discretion call) if you want to eyeball before
funding.

## 7. Receipts — how a winner keeps & re-checks their prize

The payout is designed so **the chain itself is the receipt** — no app account,
login, or server record is needed to prove a prize was paid.

When `distribute` runs, for each winner it:

1. **Transfers the SUI directly to the winner's wallet** — it just shows up in
   their balance.
2. **Emits a `Distributed` event** (`pool_id`, `season_id`, `total`, `winners`)
   on the same transaction.

A winner (or anyone) can verify, permanently, in three independent ways:

- **Wallet balance** — the SUI is simply there.
- **Explorer** — open your address on
  `https://suiscan.xyz/testnet/account/<your-address>` (or Suivision) and find
  the incoming SUI transfer and its **transaction digest**. That digest is the
  canonical receipt; it never expires and doesn't depend on Flicky staying
  online.
- **The transaction / event** — the distribute tx lists every winner and amount
  and carries the `Distributed` event, so the whole payout is auditable from one
  digest.

For the team's records, the `season:distribute` run also writes the receipt JSON
above (season, tx digest, pool id, and every `{rank, address, prize, amountMist,
account-link}`). Commit it alongside the contract or archive it — it's the
human-readable index into the on-chain truth.

> **Optional next step (not built):** surface the receipt in-app — after
> distribution, publish the receipt JSON and have the rank screen show the
> connected wallet a "You won X SUI in {season} — view transaction" banner
> linking the digest. The on-chain receipt above already stands on its own; this
> is only a convenience.

## 8. Settings (all env, override without a redeploy)

| Env                         | Meaning                                         | Default                              |
| --------------------------- | ----------------------------------------------- | ------------------------------------ |
| `SEASON_ID` / `SEASON_NAME` | id + display name                               | `season-1` / `Season 1`              |
| `SEASON_ENDS_AT`            | ISO end instant (countdown target)              | `2026-07-31T23:59:59Z`               |
| `SEASON_PRIZE_SPLIT`        | `start:end:amount,…`; pool total is derived     | `1:1:4,2:2:2,3:3:1,4:9:0.5` → 10 SUI |
| `SEASON_PRIZE_CURRENCY`     | display unit                                    | `SUI`                                |
| `SEASON_MIN_STAKED_DUELS`   | prize-eligibility gate (0 = off)                | `1`                                  |
| `SEASON_ELIGIBILITY_NOTE`   | fine-print under the breakdown                  | "Final prizes at team discretion."   |
| `SEASON_PACKAGE_ID`         | published escrow package                        | (set)                                |
| `SEASON_POOL_ID`            | shared `PrizePool` object                       | (set)                                |
| `SEASON_ADMIN_CAP_ID`       | `AdminCap` object — needed only to `distribute` | (set for payout)                     |

## 9. Next season & history — current gap

Rolling to a new season today is just **changing the env** (`SEASON_ID`,
`SEASON_NAME`, `SEASON_ENDS_AT`, `SEASON_PRIZE_SPLIT`): the banner, countdown,
and prize breakdown update immediately.

**But be aware of two limitations by design:**

- `player_rating` (MMR) is **cumulative all-time and does not reset per season**
  — intentionally, because MMR is the matchmaking signal and resetting it would
  wreck pairing. So "Season 2's leaderboard" is really the same ever-growing
  board.
- There is **no per-season snapshot / history** — past standings aren't stored.

A proper multi-season model would add a **separate per-season metric**
(e.g. `season_points` that resets each season, or a per-season duel filter) plus
a **snapshot table** written at season end for history. That is not built yet —
if multi-season with history is a real requirement, design that metric rather
than resetting MMR.

## 10. Deployed (testnet)

Published from the deploy/admin wallet `0x9c08a74c…`; canonical record in
`apps/contracts/season/deployed.json`.

|           |                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------ |
| packageId | `0x11c92f8fec8f75c2b0649cbfe45a844df4a34a51457d42ed1aac46b370a75990`                             |
| AdminCap  | `0x7bcfe7ad000649f4dcc658aa56ec12d1984b294d61886aac75e516d35cdd6f04` (owned by the admin wallet) |
| PrizePool | `0xd3b8c7fb0a129f16e193187cc3ee1067d600bceea5d7f01d6b1ebda61edf4d1a` (shared)                    |

See `apps/contracts/season/README.md` for the raw `sui client` equivalents and
the safety model.
