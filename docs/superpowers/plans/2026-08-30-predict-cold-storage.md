# Cold storage: be ready the day DeepBook Predict comes back

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Do everything that can be done and *verified* while DeepBook Predict is dark, so that the day Mysten revives it the game comes back on its own — no scramble, no code change, ideally no deploy. And along the way, unstick the four duels that are already stuck.

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

- [ ] Rewrite `keeper.ts::readMarketSettlement` (`:250`) to `getObject` the
      `ExpiryMarket` with `include: { json: true }` and read
      `settlement_price` / `settled_liability_materialized`, instead of
      fetching `{predictIndexerUrl}/markets/{id}/state`.
- [ ] **Keep the fail-closed contract.** The current function returns
      `{ settled: false }` on any error so a hiccup never becomes a garbage
      settlement. That property is why nothing was mis-settled during the
      outage — preserve it exactly.
- [ ] Treat "object missing" as unsettled-and-retry, not as settled-with-zero.
- [ ] Keep the HTTP path only as an optional override behind
      `PREDICT_INDEXER_URL`, never as the default.
- [ ] **Verify against real data:** market `0xc4b094e765e36bb8…` must read
      back `64493721012300`, matching what card 0 of duel `0xf950887b…`
      actually settled at. That is a regression test with a known answer.

## Task 2: premium from events, not from HTTP

- [ ] `keeper.ts::readOrderPremium` (`:310`) fetches
      `/positions/{orderId}/cashflow`. The `OrderMinted` event already carries
      `net_premium`, and `DuelIndexer::drainOrderMinted` **already writes it**
      to `order_premiums`. Read that table first.
- [ ] Confirm the four stranded duels' order ids resolve. If they predate the
      indexer's cursor, add a bounded historical backfill — remember the
      **50-event page cap**; a naive `last: 200` silently returns null, which
      is exactly the kind of bug that hides for six weeks.
- [ ] Preserve today's documented fallback (`premium = 0`, `resolved: false`)
      when a premium genuinely cannot be resolved, and make sure that path is
      logged loudly rather than silently.
- [ ] **Verify:** premiums recovered for the 3 unsettled cards of duel
      `0xf950887b…` match the shape of the 2 already settled.

## Task 3: rescue the four stranded duels

The end-to-end proof that Tasks 1–2 work — with real escrowed stake.

- [ ] Add `bun --filter server rescue:duels` — a dry-run-by-default script
      that finds ACTIVE duels whose cards' markets have settled on-chain and
      reports what it *would* settle.
- [ ] Run it against the four: `0xbaf5bdec…` (0/5), `0xf950887b…` (2/5),
      `0x7f8cfc1e…` (0/5), `0x0ebe1183…` (0/5).
- [ ] Then execute for real: `settle_card` × remaining, then `finalize`.
      dUSDC returns to four players who have had it locked since July.
- [ ] **Verify:** all four reach COMPLETE, `DuelFinalized` fires, the
      leaderboard updates, and `/duels/recent?status=ACTIVE` returns empty.

## Task 4: find out why they got stuck

They stalled on 2026-07-18/19, weeks before Predict died. Rescuing them
without understanding that leaves the bug in place for the next duel.

- [ ] Read the keeper logs / reconstruct from `event_cursor` and the duel
      mirror: did `tryClose` throw, latch, or silently skip? One duel got 2/5
      cards settled and then stopped — that partial progress is the clue.
- [ ] Check whether a single unsettleable card blocks the whole duel, since
      `finalize` needs *all* cards settled. If so, that is a design fragility
      worth naming, not just a bug.
- [ ] Add a regression test for whatever it was.
- [ ] **Verify:** the failure mode is reproducible in a test before it's fixed.

## Task 5: event-sourced market discovery

`GET /markets` was only ever a replay of `MarketCreated` events — the shape of
`MarketRow` says so in its own docstring. Build the replacement now and prove
it against the Aug 5–17 history, which is still on chain.

- [ ] Add a `MarketCreated` tracker to `DuelIndexer` beside the existing
      `drainOrderMinted` / `drainMarketSettled`. New `predict_market` table:
      `expiry_market_id` PK, `propbook_underlying_id`, `expiry`, `tick_size`,
      `admission_tick_size`, `created_at_ms` (the event node timestamp),
      `network`.
- [ ] Page correctly — **50 max per query**.
- [ ] Re-point `findDeckMarkets` / `findTieredDeckMarkets` / `oracle.ts` at
      that table. Field mapping is 1:1; `checkpoint_timestamp_ms` becomes the
      event timestamp.
- [ ] **Verify without live markets:** backfill the Aug 5–17 window and assert
      discovery returns the same markets the old HTTP path would have, with a
      frozen clock. Historical data makes this fully testable today.

## Task 6: detect the revival automatically

Twelve days passed before anyone noticed the outage — and two weeks before
that, nobody noticed there were no players. Detection is the actual gap.

- [ ] `/health` gains a `predict` block: newest known market, its age, count
      currently live, and the active `DECK_SOURCE`.
- [ ] Add `bun --filter server check:sources` — one command answering "can we
      build a deck right now, and from what?". Fold in `check-6-24-live.ts`
      and `check-market-cadence.ts`, both of which currently fail confusingly
      because they assume the HTTP indexer exists.
- [ ] A scheduled probe that watches for the first new `MarketCreated` event
      and **alerts**. This is the single highest-leverage thing in the plan:
      it converts "wait indefinitely" into "get told the day it's back."
- [ ] Deck-gen failures must emit a distinct, greppable error — not today's
      generic `market list failed`.
- [ ] **Verify:** with Predict dark, `/health` says so plainly and names the
      staleness; the probe fires against a synthetic event.

## Task 7: survive the pin moving again

It has already moved twice (`4-16` → `6-24` → dark), and the official docs
still describe `4-16` — a deployment with **zero events, ever**, behind a dead
host. Assume the revival is a *new* version, not a resurrection of 6-24.

- [ ] Write `docs/predict-pin-migration.md`: how to identify the live version,
      which env vars to change, what ABI drift to look for. All ids are
      already env-driven (`network-env.ts`), so make the doc the missing half.
- [ ] Make `check:sources` report the *resolved* package ids next to what's
      actually emitting events, so a pin mismatch is visible in one command.
- [ ] Record explicitly that the docs are stale and that `predict-server*`
      hosts are gone, so the next person doesn't spend a day on them.
- [ ] **Verify:** the doc is good enough that someone could follow it against
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
- The four stranded duels are COMPLETE and their dUSDC is back with the
  players.
- The reason they stalled is understood, fixed, and covered by a test.
- Market discovery reads from indexed events, verified against Aug 5–17
  history.
- `/health` states plainly whether Predict is alive and how stale the data is.
- **Something tells us the day Predict comes back, without anyone checking.**
- No new oracle, no Move change, no dependency on Mysten doing anything.
