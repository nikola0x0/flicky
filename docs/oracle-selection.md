# Oracle / Market Selection — which `ExpiryMarket`s a duel's cards pin to

This doc explains where a duel's settlement clock comes from, how Flicky
picks markets so duels finish quickly instead of dragging out for hours,
and why — on the current DeepBook Predict `6-24` testnet — that's harder
than it sounds.

If you've ever stared at the lockup screen wondering why one duel settles
in 12 minutes and another in ~3 hours, this is the answer.

> **Reading guide.** The **current model is `6-24` `ExpiryMarket`s**,
> described in the first three sections below. The old
> `OracleSVI` / `findLatestOracleSvi` / `ORACLE_MIN_HEADROOM_MS` write-up —
> a single oracle pinned per duel, 15-min oracle cron, 2h/5h tiers — is the
> **removed `4-16` path**, preserved as an appendix for its DeepBook
> operator-behavior background. Where the two disagree on cadence or object
> model, the `6-24` sections win.

---

## Current model — `6-24` `ExpiryMarket` cadence

In `6-24` there is **no single per-duel oracle**. Each duel deck is N cards
(default `[3, 5]`), and each card pins to a DeepBook Predict
**`ExpiryMarket`** — one shared object per `(underlying, expiry)`. Flicky
discovers live BTC markets from the **predict indexer**
(`GET /markets?limit=500`), not from an on-chain `OracleCreated` event
scan. The old web-side `OracleSVI` picker is gone; selection now lives
server-side in `apps/server/src/deckmaster.ts`.

**Cadence on `6-24` testnet is NOT the old 15-min cron.** The upstream BTC
market maker mints a fresh short-lived market roughly **every ~1 minute**
in the near term, then jumps to **hourly** markets further out. There is
essentially **nothing in the ~15–55 min band**. Live snapshot
(`bun --filter server run check:cadence`, 2026-07-19 11:12 UTC):

```
  ttl(min)  expiry(UTC)  status
       0.1  11:13        live · below 10m headroom
       1.1  11:14        live · below 10m headroom
       2.1  11:15        live · below 10m headroom
       7.1  11:20        live · below 10m headroom
      12.1  11:25        ◆ ELIGIBLE — deck can pick
      47.1  12:00        ◆ ELIGIBLE — deck can pick
     107.1  13:00        ◆ ELIGIBLE — deck can pick
     167.1  14:00        ◆ ELIGIBLE — deck can pick

  live markets (expiry > now):     8
  Flicky-eligible (10m < ttl ≤ 3h): 4   ⚠ fewer than a 5-card deck
```

The consequence that matters: the dense sub-10-min markets are filtered
out by the headroom floor, and what clears it is a **wide, sparse expiry
ladder** (12m, 47m, 107m, 167m). Because a deck grabs the _nearest_
eligible markets across that whole ladder, one deck can hold a card that
settles in 12 minutes and another that settles in ~2h47m.

---

## How Flicky picks markets — `selectMarketRows`

The picker is `selectMarketRows` in `apps/server/src/deckmaster.ts`
(wrapped by `findDeckMarkets`). It is a pure filter/sort/slice:

```text
rows      ← GET {predictIndexerUrl}/markets?limit=500
eligible  ← rows where
              propbook_underlying_id === 1          (BTC)
              AND kind === "market_created"
              AND (expiry − now) >  DECK_CARD_MIN_HEADROOM_MS   (10 min)
              AND (expiry − now) ≤  DECK_CARD_MAX_HORIZON_MS     (3 h)
sorted    ← eligible sorted by expiry ASCENDING     (soonest-settling first)
pick      ← sorted.slice(0, count)                  (nearest `count` markets)
```

So **cards are already sorted by settle time, soonest-first** — that part
is done. `buildDeck` / `buildSviDeck` then round-robins `deckSize` cards
across whatever markets survive (`markets[i % markets.length]`), each with
a distinct strike, so a deck needs only **≥ 1 live market**
(`decideDeckSize` floor). When fewer than `deckSize` markets are eligible
(the common case above), several cards share a market with different
strikes rather than failing the match.

**The finalize gate is the whole story for wall-clock.**
`duel::finalize` verifies **every** card is settled before it pays out
(`apps/contracts/sources/duel.move`, `cards_settled` all-true). A card can
only settle once its `ExpiryMarket` expires _and_ DeepBook writes the
settlement price. So a duel's total time is gated by its
**latest-expiring card**, not its soonest — pick a 167-min card into the
deck and the match stays open ~2h47m even though four other cards settled
long ago.

---

## Tiered selection + per-card deadlines (`DECK_TIER_ENABLED`)

The flat picker above bounds the duel with a single horizon knob, but the
`6-24` cadence has three lifetime **tiers** (created→expiry): **short ~3 min**
(minted every ~1 min), **mid ~15 min** (every ~5 min), **long ~180 min**
(hourly). The tiered path composes a deck **across** tiers so cards settle at
**staggered** times (short cards resolve ~3 min in for early drama, mid cards
~6–15 min) while the whole duel still finishes in **≤ ~15 min**.

**Selection** — `selectTieredMarkets` (`apps/server/src/deckmaster.ts`), used
by `findTieredDeckMarkets` when `env.deckTierEnabled`:

- classify each live BTC market by `lifetime = expiry − checkpoint_timestamp_ms`
  (`classifyTier`: ≤5 min short, ≤60 min mid, else long);
- take `DECK_SHORT_COUNT` (2) **freshest** shorts + `DECK_MID_COUNT` (3)
  **soonest-settling** mids that clear their per-tier TTL floor
  (`DECK_SHORT_TTL_FLOOR_MS` 90 s / `DECK_MID_TTL_FLOOR_MS` 5.5 min);
- return them **sorted by expiry ascending** (short-first). Since swipes are
  in-order on chain, card 0 = the soonest-settling short and each later card
  has a later deadline (monotonic countdowns). `buildDeck` round-robins
  `deckSize` cards across whatever the selector returns; when fewer than 3
  safe mids are live (common — the mid tier's oldest rung is under the floor),
  the deck simply has fewer distinct markets. Empty result → matchmaking
  falls back to the flat `findDeckMarkets`.

**Why the short tier is usable at all** — the on-chain 5-min swipe window
(`duel.move` `SWIPE_WINDOW_MS` / `ESwipeTimeout`) is a **ceiling, not a
floor**. The web enforces a stricter **per-card deadline** = `card.expiry −
CARD_SWIPE_BUFFER_MS` (20 s, covers sign + sponsor + execute), so a 3-min
market is swiped well before it expires — no contract change. See
`apps/web/src/lib/swipe-window.ts::cardSwipeRemainingMs` and the swipe
countdown / auto-swipe in `routes/game/active-duel.tsx`.

**Missing a deadline** — swipes are in-order (`EOutOfTurn`) with no skip, so
a card the player can't reach would forfeit _everything after it_. To avoid
that, when a card's per-card countdown hits 0 (but its market is still live
within the buffer) the client **auto-swipes the favored side** — the
guaranteed-mintable one, within the player's pre-funded budget — so the deck
advances. If even that can't land, the remaining cards forfeit at settlement
(`score_staked_card` returns 0 for an un-swiped card — the contract already
tolerates partial decks). `mint-probe.ts::premiumClearsFloor` projects each
card's premium to `min(now+5min, expiry−buffer)` so short cards aren't
spuriously ATM-forced.

> **Prod note (Railway).** `DECK_TIER_ENABLED` is **opt-in** (default off) —
> set it plus the tier vars on `flicky-server` before merging to `main`
> (which auto-deploys). Prod also runs `DECK_PROBE_MINTABLE=false` (the
> on-chain mint probe is a no-op there; the off-chain `premiumClearsFloor`
> in `buildProbedDeck` still runs) and `DECK_CARD_MIN_HEADROOM_MS=300000`.
> See the `check:cadence` "Tiered preview" block for a live dry-run.

---

## Tuning the settle window — making duels "fun-fast"

Two env levers (`apps/server/src/env.ts`) bound the eligible band:

| Env                         | Default  | Effect                                                                                                                                                        | Trade-off                                                                                                                                               |
| --------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DECK_CARD_MAX_HORIZON_MS`  | `3h`     | Upper expiry bound. **This is why duels can drag to ~3h** — it admits the hourly markets. Lower it (e.g. `20–30 min`) to bound the whole duel to that window. | Supply is thin in the short band — a tight horizon often leaves only 1–2 markets, so all cards round-robin onto them (playable, but less deck variety). |
| `DECK_CARD_MIN_HEADROOM_MS` | `10 min` | Lower expiry bound — the swipe/finalize safety margin. Lowering it (e.g. `5–7 min`) taps the dense ~1-min-cadence markets.                                    | Higher risk of `EOracleNotLive` / market-expires-mid-match (report §8.2 S2) and of the long-shot side dropping under the `$1` premium floor (S1).       |

**Structural reality:** because `6-24` testnet offers no markets in the
~15–55 min band, you cannot get 5 _distinct_ markets that all settle
within ~20 minutes. A snappy duel therefore means **accepting a deck
concentrated on 1–2 near-term markets** (tight horizon + round-robin
strikes), not five independent short oracles. That's a supply constraint
upstream, not a Flicky bug.

**Inspect the live pool any time:**

```bash
bun --filter server run check:cadence
# → src/scripts/check-market-cadence.ts
# prints the live ttl ladder with per-market tier, the flat-picker eligible
# set + its wall-clock floor, AND a "Tiered preview" dry-run of
# selectTieredMarkets (2 short + 3 mid) with each card's settle time and
# per-card swipe deadline.
```

---

# Appendix — Legacy `4-16` `OracleSVI` model (historical)

> **Removed in the `6-24` migration.** The `OracleSVI` shared object, the
> web-side `findLatestOracleSvi` picker, and the `ORACLE_MIN_HEADROOM_MS`
> constant described below **no longer exist** in the codebase (see
> `docs/report/2026-07-11-predict-6-24-update.md`). The sections are kept
> for their DeepBook operator-behavior background (settlement latency,
> `settlement_price` flip) and for historical context on the single-oracle
> picker. Do not treat the `4-16` cadence (15-min cron, 2h/5h tiers) as
> current — see the `6-24` sections above.

---

## TL;DR

Every 15 minutes DeepBook mints a new `OracleSVI` shared object —
cron `:00` → 5-hour lifetime, cron `:15/:30/:45` → 2-hour lifetime.
Each oracle is its own on-chain object with independent `id`,
`expiry`, `prices`, and `settlement_price: Option<u64>` — not a state
mutation of a single feed. The DeepBook operator pushes a fresh price
tick roughly **every 1 second** until ~`expiry − 5 s` (last
`OraclePricesUpdated` event), then publishes `settlement_price` in a
separate tx at ~`expiry + 8 s` (5 of 6 testnet samples landed in
7.4–8.2 s; one outlier took 10 min when the operator hiccupped, and
the keeper recovered automatically).

Flicky's picker (`findLatestOracleSvi`) selects `argmin(expiry)`
among oracles that are `active && !settled && expiry − now ≥ 90 s`.
That filter almost always lands on a short-tier (2-hour) oracle
because every short-tier expiry is closer than every long-tier one.
The remaining TTL ranges from ~1.5 to ~120 minutes depending on
where in the 15-minute cycle the duel is created.

Once the chosen oracle's `settlement_price` becomes `Some`, the
keeper (polling every `KEEPER_POLL_INTERVAL_MS`, default 10 s)
bundles `settle_card × 5` + `predict::redeem_permissionless × N` +
`finalize` into one PTB. End-to-end **settle phase = 10–20 s after
expiry**.

Wall-clock breakdown of a duel:

| Stage                                    | Latency         |
| ---------------------------------------- | --------------- |
| Create + join + reveal + 5 swipes        | ~30–90 s        |
| **Lockup (wait for `now > expiry`)**     | **1.5–120 min** |
| Settle phase (settlement_price + keeper) | ~10–20 s        |

The lockup is the dominant cost, which is exactly what the picker
optimises. Everything below is the long form.

---

## Background — DeepBook's oracle pool, not a clock

The settlement clock visible in Flicky's UI (e.g. "11m24s left" on the
oracle badge) is **not** something Flicky's contract sets. It is read
verbatim from the DeepBook Predict `OracleSVI` object that the duel's
deck was committed against:

```ts
// apps/web/src/App.tsx:589
function expiresIn(o: OracleSviInfo, now: number): string {
  const ms = Number(o.expiry) - now
  if (ms <= 0) return "expired"
  // ...
}
```

That `o.expiry` is a `u64` field DeepBook writes when it creates the
oracle, and Flicky never overrides it.

What's surprising — and the source of the "75 minutes?" confusion —
is that DeepBook does **not** run one oracle at a time. On testnet,
DeepBook publishes a **rolling pool of ~13 BTC `OracleSVI` objects
simultaneously** on a strict quarter-hour cron, organised into two
tiers:

| Cron slot | Tier  | Lifetime | Typical use                  |
| --------- | ----- | -------- | ---------------------------- |
| `HH:00`   | long  | 5 hours  | dated forwards               |
| `HH:15`   | short | 2 hours  | swipe-PvP, scalping binaries |
| `HH:30`   | short | 2 hours  | swipe-PvP, scalping binaries |
| `HH:45`   | short | 2 hours  | swipe-PvP, scalping binaries |

DeepBook never mints a long oracle on `:15/:30/:45` and never mints a
short oracle on `:00`. The schedule is mechanical.

At steady state that pool contains:

- **8 short oracles alive** at any moment (lifetime 120 min ÷ creation
  interval 15 min = 8 rungs).
- **5 long oracles alive** (lifetime 300 min ÷ creation interval
  60 min = 5 rungs).

= ~13 BTC oracles concurrently. Snapshot captured 2026-05-20 18:28 UTC:

```
ttl(min)  active settled  created→expiry  life(min)
     1.9   true    false  16:30→18:30        120     ← shortest viable
    16.9   true    false  16:45→18:45        120
    31.9   true    false  14:00→19:00        300     ← long tier
    46.9   true    false  17:15→19:15        120
    61.9   true    false  17:30→19:30        120
    76.9   true    false  17:45→19:45        120     ← the "75 min" oracle
    91.9   true    false  15:00→20:00        300     ← long tier
   106.9   true    false  18:15→20:15        120
   151.9   true    false  16:00→21:00        300     ← long tier
   211.9   true    false  17:00→22:00        300     ← long tier
   271.9   true    false  18:00→23:00        300     ← long tier
```

11 active in this snapshot (one short had just settled, the next
hourly long hadn't been minted yet).

**Each oracle is an independent on-chain object**, not a state mutation
of one shared `OracleSVI`. Each has its own `id`, `expiry`, `prices`
struct, and `settlement_price: Option<u64>`. Whichever oracle a duel
pins to via `create_duel(..., deck_hash)` is the one whose lifecycle
governs the duel's swipe → lockup → settle clock — and that pin is
permanent for the duel.

The "I remember it was 75 minutes" mental model is partially right:
the `:45` short slot at any given moment has a sibling oracle ~75 min
out from being created (because the short tier reaches forward two
hours), so you'll always see one ~75-min-out oracle in the pool. It
just isn't the only one, and "75 min" is one of eleven choices.

---

## Why the old picker drifted to multi-hour expiries

The original `findLatestOracleSvi` (in `apps/web/src/lib/flicky.ts`)
sorted candidates by `OracleCreated` event timestamp, **newest first**,
and returned the first one that was ACTIVE + priced + not settled.

Two failure paths under the two-tier cron design above:

1. **Long-tier publish window.** On the `:00` cron tick DeepBook mints
   a 5-hour oracle. For roughly 15 minutes after, that long oracle is
   the newest `OracleCreated` event. The old picker happily returned
   it, pinning the duel to a 5-hour clock.

2. **Pre-activation latency on short-tier ticks.** On `:15/:30/:45` a
   2-hour short oracle is minted but DeepBook needs a few seconds to
   activate it + push first prices. During that window the previous
   long oracle is the newest _active_ candidate — same outcome, pinned
   to a multi-hour wait.

Concrete reproduction from testnet (captured 2026-05-20 18:36 UTC):

```
0x21500f4f… active=true  ttlMin=110.5
0x680fa57a… active=true  ttlMin=275.5   ← OLD picker chose this
0xf6353f73… active=true  ttlMin=80.5
0xdbcc9a53… active=true  ttlMin=65.5
0x1a53618d… active=true  ttlMin=58.8
0x1281b1cf… active=true  ttlMin=20.5
0xf4e95acc… active=true  ttlMin=5.5    ← NEW picker chooses this
```

A user creating a duel under the old picker would be locked into a
4-hour-and-35-minute wait before `settle_card` could run. Acceptable
for a forwards-trading product, fatal for a swipe-PvP demo.

---

## Legacy strategy — shortest viable expiry (`4-16`, removed)

The picker is now in `apps/web/src/lib/flicky.ts::findLatestOracleSvi`.
Pseudocode:

```text
candidates ← queryEvents(OracleCreated, BTC, limit=30, newest first)
objs       ← multiGetObjects(candidates[0..10])

eligible  ← objs where
              active === true
              AND spot > 0 AND forward > 0
              AND settlement_price is None
              AND (expiry − now) ≥ ORACLE_MIN_HEADROOM_MS

pick      ← argmin(eligible, by expiry)
fallback  ← CONFIG.fallbackOracleSviId  if no eligible
```

Key constant:

```ts
const ORACLE_MIN_HEADROOM_MS = 90_000n // 90 seconds
```

This is the floor — the picker refuses to pin an oracle whose
remaining lifetime is shorter than the swipe phase (60 s) plus some
margin for join latency, sponsor-server round-trips, and clock drift
across fullnodes. Without it, a player could open a duel against an
oracle that expires before they finish swiping, and every
`record_swipe` call would abort with `EOracleNotLive`.

### Why 90 s

Empirically the swipe phase is 60 s and the longest single round-trip
we've measured in the staked flow is ~12 s (PredictManager balance
read + sponsor build + wallet sign + execute + duel object refetch).
Doubling that for safety lands at ~25 s. We use 90 s to be generous
and to leave room for join → reveal_deck latency before swiping
starts. If you observe steady `EOracleNotLive` aborts on the first
card, raise this constant; if duels keep selecting the second-shortest
tier because the shortest is just over 90 s out, lower it.

### Stability across reads

The picker is called from `Lobby.createDuel` once per duel-creation
flow, so transient "no eligible" results just retry on the next
interaction. The fallback path returns `CONFIG.fallbackOracleSviId`
— a hard-coded id baked into the build — so the UI always renders
something even if RPC is unhappy.

---

## How to test it deliberately

For local testing or demos you usually want the duel to settle ASAP.
Two ways to bias toward the shortest tier:

1. **Default (do nothing).** The picker already chooses the shortest
   viable. If DeepBook's pool currently contains a 5-min oracle and
   it has ≥90 s headroom, that's what you'll get.

2. **Lower the headroom.** Set `ORACLE_MIN_HEADROOM_MS` to `60_000n`
   in `apps/web/src/lib/flicky.ts` to allow the picker to pick
   oracles that are only 60 s away from expiry. You'll get faster
   settlement but a higher risk of `EOracleNotLive` if any one PTB
   takes more than ~ a second longer than expected. Useful for "demo
   me settling in under 90 seconds total" runs; not safe for
   contested matches.

3. **Pin a specific oracle id.** If you have a particular oracle you
   want every duel to use, export it as
   `VITE_DEEPBOOK_BTC_ORACLE_ID=0x…` in `apps/web/.env.local` AND
   short-circuit `findLatestOracleSvi` to return it. We don't ship
   a CLI flag for this; copy-paste edit during the demo.

A quick way to inspect the current DeepBook pool from the repo:

```bash
cd apps/server
bun -e '
import { getSuiClient } from "./src/lib/sui"
const c = getSuiClient()
const PKG = process.env.DEEPBOOK_PREDICT_PACKAGE_ID
const evts = await c.queryEvents({
  query: { MoveEventType: PKG + "::registry::OracleCreated" },
  limit: 10, order: "descending",
})
const now = Date.now()
for (const e of evts.data) {
  const p = e.parsedJson
  const o = await c.getObject({ id: p.oracle_id, options: { showContent: true } })
  const f = o.data.content.fields
  console.log(
    p.oracle_id.slice(0,14),
    "active=" + f.active,
    "ttlMin=" + ((Number(f.expiry) - now) / 60000).toFixed(1),
  )
}
'
```

Output lists every BTC oracle DeepBook currently exposes, sorted
newest-first. The picker walks the top 10 and picks the smallest
`expiry` field among the eligible ones.

---

## When does the oracle actually settle?

`OracleSVI.settlement_price` flips from `None` to `Some(u64)` in a
single DeepBook-operator transaction some time **after** the
`expiry` cron tick. Empirical measurement on testnet (5 normal cases

- 1 outlier captured 2026-05-20):

```
expiry=18:30:00  settleTx=18:30:08.046  Δ=  8.0s
expiry=18:15:00  settleTx=18:15:07.559  Δ=  7.6s
expiry=17:45:00  settleTx=17:55:02.524  Δ=602.5s   ← operator hiccup
expiry=17:30:00  settleTx=17:30:08.166  Δ=  8.2s
expiry=17:15:00  settleTx=17:15:07.386  Δ=  7.4s
expiry=16:45:00  settleTx=16:45:07.935  Δ=  7.9s
```

Normal case: **~7–8 seconds after `expiry`**. DeepBook stops pushing
prices ~5 s before expiry (you can see this in `oracle.timestamp` —
the last `OraclePricesUpdated` lands around expiry−5 s), then writes
`settlement_price` in a separate tx at expiry+~8 s.

The outlier shows the operator isn't strictly bounded — at least one
oracle in the sample took 10 min to settle. The keeper handles this
fine; it just polls `settlement_price` and acts when it appears.

So the **full settle phase** from `now > expiry` to `duel.status =
COMPLETE` is:

| Stage                                            | Latency                                    |
| ------------------------------------------------ | ------------------------------------------ |
| Oracle stops price updates                       | expiry − ~5 s                              |
| DeepBook writes `settlement_price`               | expiry + ~8 s                              |
| Keeper poll sees the new state                   | ≤ `KEEPER_POLL_INTERVAL_MS` (default 10 s) |
| Keeper PTB lands (settle×5 + redeems + finalize) | + 1–3 s                                    |
| **Total settle phase**                           | **~10–20 s after expiry**                  |

The dominant cost in a duel's total wall-clock time is therefore
**lockup latency** — the gap between everyone finishing their swipes
and `now > expiry`. The picker minimises that by selecting the
shortest viable expiry from DeepBook's pool. If you tune
`KEEPER_POLL_INTERVAL_MS` down from 10 000 to 2 000, the settle
phase shortens further (at the cost of ~5× more RPC reads per duel).

## Interaction with the settle / finalize keeper

Once a duel is pinned to an oracle, the rest of the flow is gated by
that oracle's lifecycle:

1. **Swipe phase open.** While `now ≤ oracle.expiry`, players can
   call `record_swipe`. The contract guards this with `EOracleNotLive`
   (`apps/contracts/sources/duel.move:335`).

2. **Lockup phase.** After `oracle.expiry` passes but before DeepBook
   publishes `settlement_price`, players can't swipe and the keeper
   can't settle. The UI shows the lockup view with "the deck settles
   when BTC's oracle resolves".

3. **Settle + finalize.** Once `settlement_price` is `Some(...)`,
   `apps/server/src/scripts/keeper.ts::tryClose` builds one PTB that:
   - calls `predict::redeem_permissionless` per (player, swipe) for
     dUSDC duels (see `apps/server/src/scripts/keeper.ts`'s redeem
     block),
   - calls `duel::settle_card` per unsettled card (looped per
     `cards[i].oracleId` in case the deck spans multiple oracles),
   - calls `duel::finalize`.

So the **picked oracle's expiry** is the single dominant factor in
how long a duel takes to settle. The picker change moves the median
duel-end time on testnet from "hours" to "minutes".

---

## Failure modes & what to watch for

- **No eligible oracle.** Picker returns `CONFIG.fallbackOracleSviId`.
  If that fallback id is also expired/settled (which it will be
  eventually — testnet rotates oracles aggressively), the lobby still
  renders, but `create_duel` will fail with `EOracleNotLive` and the
  user sees the raw error. Fix: refresh the fallback id in
  `apps/web/.env.example` periodically, or implement a deterministic
  registry walk on first 404.

- **Picker chose an oracle that becomes inactive between
  `findLatestOracleSvi` and `create_duel`.** DeepBook can deactivate
  on schedule. The race window is the time between Lobby fetching the
  oracle and the player clicking "create". If this becomes a
  recurring problem, the cheap fix is to re-read the chosen oracle
  inside `buildCreateDuelTx` and bail if it's no longer active.

- **The shortest oracle's expiry just barely clears the 90 s
  headroom.** The picker still allows it. The swipe phase will start
  with maybe 90 s on the clock, so the slowest tier (`SPEED_SLOW`,
  20–60 s decide-time) is unreachable — every swipe will score in the
  fast/normal bucket. That's not a bug, but in match analytics it
  shows up as suspiciously fast play. Bumping `ORACLE_MIN_HEADROOM_MS`
  to e.g. 150 000 ms reserves the full swipe-phase window.

---

## File pointers

- `apps/web/src/lib/flicky.ts::findLatestOracleSvi` — the picker.
- `apps/web/src/lib/flicky.ts::ORACLE_MIN_HEADROOM_MS` — the floor.
- `apps/web/src/lib/flicky.ts::fetchOracleSvi` — single-oracle read,
  used by the SwipingView header and the settle path.
- `apps/web/src/App.tsx::expiresIn` — UI formatter.
- `apps/contracts/sources/duel.move::EOracleNotLive` (abort code 6)
  — the contract guard the picker is designed around.
- `apps/server/src/scripts/keeper.ts::tryClose` — what reads
  `oracle.settlement_price` to decide whether the duel can be
  settled + finalized.
