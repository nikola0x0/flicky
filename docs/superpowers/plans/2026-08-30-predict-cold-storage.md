# Cold storage: be ready the day DeepBook Predict comes back

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Do everything that can be done and *verified* while DeepBook Predict is dark, so that the day Mysten revives it the game comes back on its own — no scramble, no code change, ideally no deploy. And along the way, unstick the four duels that are already stuck.

> ## STATUS 2026-08-30: EXECUTED — all tasks complete
>
> Tasks 1, 2, 5, 6, 7 implemented and verified. Tasks 3+4 resolved with a
> corrected premise (see below): the four duels are abandoned games, not a
> bug, and only their players can reclaim — which the UI already supports.
>
> **The keeper now settles with zero HTTP calls to any Mysten host.**

**Decision this plan operates under (2026-08-30):** we are **not** adopting a new price oracle. No Pyth key, no CEX median. We wait for Predict. This plan is therefore strictly *preparation* — every task must be completable and testable with Predict still dark, or it doesn't belong here.

---

## The finding that makes this worth doing now

While checking whether the four stranded duels could be rescued, I read an
expired `ExpiryMarket` object directly:

```
0xc4b094e765e36bb8… expiry_market::ExpiryMarket
  settlement_price:               64493721012300
  settled_liability_materialized: true
0x93bc42bfc83dc9c78… expiry_market::ExpiryMarket
  settlement_price:               64506717955110
```

`64493721012300` is **exactly** the `settlementPrice` recorded on card 0 of
stranded duel `0xf950887b…`. So:

> **The keeper never needed the HTTP indexer to settle a card. The settlement
> price is a readable field on the market object, and expired markets are
> still on-chain.**

This does **not** contradict the keeper-fed architecture in CLAUDE.md. That
invariant says there is no Move *view function* to call inside the swipe PTB,
so the keeper supplies the price as an argument — still true. What changes is
only where the keeper *sources* that argument: a `getObject` read instead of a
dead HTTP endpoint.

Which means a large part of "resilience work" is not blocked on Mysten at all,
and can be proven today against real historical data.

---

## Evidence (measured 2026-08-30)

| Fact | Value |
|---|---|
| Last completed duel in prod | **2026-07-19** (41 days ago) |
| Duels stuck ACTIVE with unsettled cards | **4**, all `DUSDC` staked, all revealed |
| Stuck since | 2026-07-18 / 07-19 — **before** the Predict outage |
| Their markets on-chain | **still exist**, carry `settlement_price` |
| Last `MarketCreated` on 6-24 | 2026-08-17T21:03Z |
| DeepBook `propbook::pyth_feed` mirror | stale since 2026-08-05 |
| Predict read APIs (`-beta`, `-server`, `propbook.api`) | all NXDOMAIN |
| Sui GraphQL `events` page size | **max 50** — larger silently returns null |

Two things worth internalising from that table. The game had **no players for
two weeks before the outage** — so "12 days of downtime" overstates the user
impact and understates how long nobody was looking. And the four duels got
stuck *before* Predict died, which means there is a keeper bug here
independent of the outage.

---

## Non-goals

- Do **not** adopt a new price oracle. That decision was made and this plan
  does not relitigate it.
- Do **not** change the Move contract.
- Do **not** build anything that can only be tested once Predict returns. If
  it can't be verified now, it goes in the resume-plan, not here.
- Do **not** enable the staked tier on a network without Predict.

---

## Global constraints

- `bun` only. Prettier: no semicolons, double quotes, 2-space, trailing comma
  `es5`, width 80. TS `strict`.
- Preserve the CLAUDE.md invariants, including keeper-fed settlement. This
  plan changes the keeper's *data source*, never the trust model.
- **Verification baseline (2026-08-30, `1e20cf4`):** `bun typecheck` clean
  across 5 workspaces. Web 107 pass / 0 fail. Server **187 pass / 84 skip /
  0 fail**. Server lint 1 pre-existing problem (`_ttl`), web lint 44
  pre-existing. Bar is *no new* failures.
- DB-backed suites need `TEST_DATABASE_URL` (see `apps/server/.env.example`).

---

## Task 1: read settlement price from the chain, not from HTTP

The highest-value task in this plan, and it is not blocked on anything.

- [x] Rewrite `keeper.ts::readMarketSettlement` (`:250`) to `getObject` the
      `ExpiryMarket` with `include: { json: true }` and read
      `settlement_price` / `settled_liability_materialized`, instead of
      fetching `{predictIndexerUrl}/markets/{id}/state`.
- [x] **Keep the fail-closed contract.** The current function returns
      `{ settled: false }` on any error so a hiccup never becomes a garbage
      settlement. That property is why nothing was mis-settled during the
      outage — preserve it exactly.
- [x] Treat "object missing" as unsettled-and-retry, not as settled-with-zero.
- [x] Keep the HTTP path only as an optional override behind
      `PREDICT_INDEXER_URL`, never as the default.
- [x] **Verify against real data:** market `0xc4b094e765e36bb8…` must read
      back `64493721012300`, matching what card 0 of duel `0xf950887b…`
      actually settled at. That is a regression test with a known answer.

## Task 2: premium from events, not from HTTP

- [x] `keeper.ts::readOrderPremium` (`:310`) fetches
      `/positions/{orderId}/cashflow`. The `OrderMinted` event already carries
      `net_premium`, and `DuelIndexer::drainOrderMinted` **already writes it**
      to `order_premiums`. Read that table first.
- [x] ~~Confirm the four stranded duels' order ids resolve.~~ **N/A** — those
      duels are abandoned (neither player finished the deck), so they resolve
      via `refund_duel`, never `settle_card`. Their premiums are never read.
      The **50-event page cap** is honoured everywhere regardless
      (`drainEvents` pages at `first: 50`); a naive `last: 200` returns null
      rather than erroring, which is exactly the bug class that hides for
      weeks.
- [x] Preserve today's documented fallback (`premium = 0`, `resolved: false`)
      when a premium genuinely cannot be resolved, and make sure that path is
      logged loudly rather than silently.
- [x] **Verified differently:** `0xf950887b…` has 0 cards settled on chain
      (the DB mirror's "2/5" is stale) and both players abandoned at card 4,
      so there is nothing to settle. Premium reads are covered by the mirror
      path instead.

## Task 3 + 4: the four stranded duels — RESOLVED, premise was wrong

**Finding (2026-08-30): they are not stuck by a bug. Both players abandoned
mid-deck.** On-chain swipe counts:

| Duel | p0 | p1 | of |
|---|---|---|---|
| `0xbaf5bdec…` | 1 | 5 | 5 |
| `0xf950887b…` | 4 | 4 | 5 |
| `0x7f8cfc1e…` | 3 | 4 | 5 |
| `0x0ebe1183…` | 1 | 2 | 5 |

The keeper's `if (!bothDone) return` is **working as designed** — it refuses to
settle an incomplete duel, which is correct: `settle_card` would score cards
nobody swiped.

And these are already recoverable, by the only party allowed to:
`duel.move::refund_duel` (`:755`) on an ACTIVE duel requires
`now > started_at_ms + 1h` (42 days ✓), `!both_done` (✓), and
`sender == p0 || sender == p1` — **player-signed, by design**. The server
cannot and should not sign it.

The path already exists end to end: `refundEligibility` + `buildRefundDuelTx`
in `lib/flicky.ts`, surfaced in `routes/game/history.tsx` and
`duel-view.tsx`, and `duel::refund_duel` is already in the sponsor allowlist —
so a player reclaims with zero SUI. Verified against live data: all four
return `refundable = true` for both participants.

- [x] Root cause identified — abandoned decks, not a keeper fault.
- [x] Confirmed the stake is not lost and the reclaim path works.
- [x] Regression test pinning all four shapes (`flicky.test.ts`,
      "real abandoned duels") so a future change can't silently strand them.
- [ ] **Not actionable by us:** the four duels stay ACTIVE until their players
      open `/game/history` and claim. Four addresses, testnet dUSDC.

**AC correction.** The original criterion — "the four stranded duels are
COMPLETE and their dUSDC is back with the players" — is **not achievable by
this repo**, because the contract deliberately requires a player signature.
Replaced with: *the reclaim path is proven available and covered by tests.*
Anything else would mean weakening a permission check to hit a checkbox.

**Optional follow-up (not in this plan):** nothing prompts a player that they
have a reclaimable duel — they have to think to visit history. A "you have N
duels to reclaim" nudge would close that, but it's a product change, not
outage preparation.

## Task 5: event-sourced market discovery

`GET /markets` was only ever a replay of `MarketCreated` events — the shape of
`MarketRow` says so in its own docstring. Build the replacement now and prove
it against the Aug 5–17 history, which is still on chain.

- [x] Add a `MarketCreated` tracker to `DuelIndexer` beside the existing
      `drainOrderMinted` / `drainMarketSettled`. New `predict_market` table:
      `expiry_market_id` PK, `propbook_underlying_id`, `expiry`, `tick_size`,
      `admission_tick_size`, `created_at_ms` (the event node timestamp),
      `network`.
- [x] Page correctly — **50 max per query**.
- [x] Re-point `findDeckMarkets` / `findTieredDeckMarkets` / `oracle.ts` at
      that table. Field mapping is 1:1; `checkpoint_timestamp_ms` becomes the
      event timestamp.
- [x] **Verify without live markets:** backfill the Aug 5–17 window and assert
      discovery returns the same markets the old HTTP path would have, with a
      frozen clock. Historical data makes this fully testable today.

## Task 6: detect the revival automatically

Twelve days passed before anyone noticed the outage — and two weeks before
that, nobody noticed there were no players. Detection is the actual gap.

- [x] `/health` gains a `predict` block: newest known market, its age, count
      currently live, and the active `DECK_SOURCE`.
- [x] Add `bun --filter server check:sources` — one command answering "can we
      build a deck right now, and from what?". Fold in `check-6-24-live.ts`
      and `check-market-cadence.ts`, both of which currently fail confusingly
      because they assume the HTTP indexer exists.
- [x] A scheduled probe that watches for the first new `MarketCreated` event
      and **alerts**. This is the single highest-leverage thing in the plan:
      it converts "wait indefinitely" into "get told the day it's back."
- [x] Deck-gen failures must emit a distinct, greppable error — not today's
      generic `market list failed`.
- [x] **Verify:** with Predict dark, `/health` says so plainly and names the
      staleness; the probe fires against a synthetic event.

## Task 7: survive the pin moving again

It has already moved twice (`4-16` → `6-24` → dark), and the official docs
still describe `4-16` — a deployment with **zero events, ever**, behind a dead
host. Assume the revival is a *new* version, not a resurrection of 6-24.

- [x] Write `docs/predict-pin-migration.md`: how to identify the live version,
      which env vars to change, what ABI drift to look for. All ids are
      already env-driven (`network-env.ts`), so make the doc the missing half.
- [x] Make `check:sources` report the *resolved* package ids next to what's
      actually emitting events, so a pin mismatch is visible in one command.
- [x] Record explicitly that the docs are stale and that `predict-server*`
      hosts are gone, so the next person doesn't spend a day on them.
- [x] **Verify:** the doc is good enough that someone could follow it against
      6-24 today and reach the current config.

---

## Sequencing

1. **Tasks 1–3 first.** They unstick real escrowed funds and prove the on-chain
   read path with a known-correct answer. Highest value, zero external
   dependency.
2. **Task 4** immediately after — don't leave the original bug in place.
3. **Task 6** next. Cheap, and it is what ends the waiting.
4. **Tasks 5 and 7** when convenient. They're the durable fixes.

## What this plan deliberately leaves for later

When Predict actually returns, resume at
`2026-08-30-predict-independence.md` Task 2 (a second card source) — but note
that if Tasks 1, 2 and 5 here are done, **the HTTP indexer dependency is
already gone**, and that plan shrinks to almost nothing. Which is the point.

`2026-08-29-dual-network-full.md` stays blocked until there is a working
network to be dual about.

## Definition of done

- The keeper settles a card with **zero HTTP calls to any Mysten host**.
- The four stranded duels are understood (abandoned decks, not a bug), their
  reclaim path is proven available, and all four shapes are covered by tests.
  Completing them requires a player signature the server must not have.
- Market discovery reads from indexed events, verified against Aug 5–17
  history.
- `/health` states plainly whether Predict is alive and how stale the data is.
- **Something tells us the day Predict comes back, without anyone checking.**
- No new oracle, no Move change, no dependency on Mysten doing anything.
