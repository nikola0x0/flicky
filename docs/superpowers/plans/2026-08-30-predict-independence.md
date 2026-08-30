# Predict independence: make Flicky playable when DeepBook Predict is dark

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Get Flicky back to a playable game **today**, and make it structurally impossible for a third-party service outage to take the game down again. Concretely: give the free/social tier a card source and a settlement price that come from **Pyth**, not from DeepBook Predict — and when Predict does come back, read it from **on-chain events** rather than a Mysten-operated HTTP service.

**Status of the game right now: the staked AND free tiers are both unrunnable in production, and have been for ~12 days.** Not because of a bug we introduced — because the upstream protocol went dark.

---

## Evidence (measured 2026-08-30, not recalled)

| Check | Result |
|---|---|
| Last `MarketCreated` event on 6-24 | **2026-08-17T21:03:00Z** |
| Last market expiry across the most recent 50 | **2026-08-17T21:15:00Z** |
| Live (unexpired) markets | **0 of 50** |
| Days since a market was created | **12.3** |
| `predict-server-beta.testnet.mystenlabs.com` | **NXDOMAIN** (also `-server`, `-api`, `propbook.api.…`) |
| Predict package, ProtocolConfig, Registry, AccountRegistry on-chain | **all EXIST** |
| Market creation | **`AdminCap`-gated** — Flicky cannot self-serve |
| Predict mainnet | **does not exist** (Mysten: "later this year") |

**Read that as:** Mysten wound down the 6-24 testnet market-making cron on Aug 17, then tore down the read API. The contracts are still deployed and healthy. Nothing is creating markets, and we have no way to create them ourselves.

So the earlier "Task 0: find the successor hostname" in `2026-08-29-dual-network-full.md` was based on a wrong premise. **There is no successor host to find.** That task is superseded by this plan.

## Why this is fixable without waiting

Three facts, each verified against the source:

1. **The free tier's on-chain path never touches Predict.** `record_swipe_free` and `settle_card_free` (`duel.move:427,521`) take no Predict arguments. `settle_card_free` takes a keeper-supplied `settlement_price`.
2. **Settlement never reads a market object.** `preflight_settle` (`duel.move:542-556`) does exactly one thing with the price: `actual_up = settlement_price > card.strike`.
3. **`Card.expiry_market_id` is an opaque `ID`** (`duel.move:105-111`) used only for settle-time anti-replay and the `CardSettled` event. Nothing dereferences it.

**Therefore a Pyth-sourced deck requires ZERO Move changes.** No republish, no upgrade, no migration. This is a server + web change against the already-deployed contract.

And Pyth is live and independent of Mysten's hosting:

- `pyth_feed::PythFeed` object `0xc78d…35afb` — **exists on-chain**
- `hermes.pyth.network` — **HTTP 200**, operated by Pyth, not Mysten

## Why the old dependency has to go regardless

This is the **third** time the Predict pin has moved under us: `predict-testnet-4-16` → `predict-testnet-6-24` → dark. CLAUDE.md already warns about it. A single Mysten-operated HTTP service is a single point of failure for the entire product, and it has now failed in the most total way possible.

Everything that service provided is available as **on-chain events** — verified by querying testnet GraphQL directly:

| Event | Fields it carries | Replaces |
|---|---|---|
| `config_events::MarketCreated` | `expiry_market_id`, `propbook_underlying_id`, `expiry`, `tick_size`, `admission_tick_size` (+ node `timestamp`) | `GET /markets` — **every field `MarketRow` needs** |
| `config_events::MarketSettled` | `expiry_market_id`, `settlement_price`, `settled_at_ms` | `GET /markets/{id}/state` |
| `order_events::OrderMinted` | `expiry_market_id`, `order_id`, `net_premium` | `GET /markets/{id}/positions/{id}/cashflow` |

The indexer **already drains the last two** (`indexer.ts::drainOrderMinted`, `drainMarketSettled` → `order_premiums`, `market_settlements`). Only discovery was never event-sourced.

---

## Non-goals

- Do **not** change the Move contract. The whole point is that we don't have to.
- Do **not** try to create ExpiryMarkets. Creation is `AdminCap`-gated.
- Do **not** migrate off DeepBook Predict as the staked-tier venue. Predict is still the product thesis; this makes Flicky *survive* its absence, not abandon it.
- Do **not** enable the staked tier without Predict. A staked duel mints a real position; there is nothing to mint against.

---

## Global constraints

- `bun` only. Prettier: no semicolons, double quotes, 2-space, trailing comma `es5`, width 80. TS `strict`.
- Preserve **"two tiers share one engine"** (CLAUDE.md). This adds a *card source*, not a second game. Swipe → lockup → settle → finalize stays one code path; only where cards and prices come from changes.
- Preserve commit-reveal: a Pyth deck is hashed at duel creation and revealed at match start, exactly like a Predict deck.
- **Verification baseline (2026-08-30, `6c8691e`):** `bun typecheck` clean across 5 workspaces. Web 107 pass / 0 fail. Server 162 pass / 84 skip / 0 fail. Web lint 44 problems (40 errors, 4 warnings), all pre-existing — bar is *no new* errors.

---

## Task 1: a card source abstraction

Today the deck is welded to Predict markets. Introduce the seam before adding the second source, so neither implementation special-cases the other.

- [ ] Define a `CardSource` interface in `apps/server/src/deckmaster.ts`: given a tier and a deck-size band, return `{ expiryMarketId: string, strike: bigint, settleAtMs: number }[]`. That triple is everything `new_card` + the keeper need.
- [ ] Wrap the existing Predict path (`findDeckMarkets` / `findTieredDeckMarkets` / `filterMintableMarkets`) as `predictCardSource` with no behavior change.
- [ ] Select via `DECK_SOURCE` env (`predict` | `pyth` | `auto`). `auto` prefers Predict and falls back to Pyth when discovery yields nothing — that is the setting that would have kept the game up through this outage.
- [ ] **Verify:** `DECK_SOURCE=predict` produces byte-identical decks to today (fixture test).

## Task 2: Pyth card source

- [ ] `pythCardSource`: read BTC spot from the on-chain `PythFeed` object (`env.pythFeedId`, confirmed live), and synthesize N cards at staggered settle times — reuse the existing tier shape (2 short + 3 mid) from `env.deckShortCount` / `deckMidCount` so pacing and drama are unchanged.
- [ ] Strike selection: reuse the existing offset logic (`env.deckStrikeMode === "price_offset"`) around spot. The Predict path's probability band (`deckQuoteMinProb`/`MaxProb`) came from market quotes we no longer have — derive an equivalent from the offset alone and document the difference honestly rather than pretending the numbers mean the same thing.
- [ ] `expiryMarketId` for a synthetic card: use the **Pyth feed object id**. It is a real `ID`, it is stable, and it makes `CardSettled` events self-describing about their price source. Do not invent a fake id.
- [ ] Settle time is chosen by us, not by a market's expiry — so drop `deckCardMaxHorizonMs` / TTL-floor filtering for this source and set the times directly.
- [ ] **Verify:** `DECK_SOURCE=pyth` generates a valid deck with **no network calls to any `*.mystenlabs.com` host**. Assert that in the test.

## Task 3: Pyth settlement in the keeper

- [ ] `readMarketSettlement` (`keeper.ts:250`) currently fetches `{predictIndexerUrl}/markets/{id}/state`. Add a Pyth path: at/after `settleAtMs`, read the price from the on-chain feed and treat it as settled.
- [ ] **Keep failing closed.** The existing function's contract — any fetch/parse error reports `settled: false` so a hiccup never becomes a garbage settlement — is correct and must survive. A stale Pyth read must not settle a card.
- [ ] Record the settle price in `market_settlements` keyed by the synthetic id + settle time, so a re-run is idempotent.
- [ ] Free-tier premium is 0 (no mint), so `readOrderPremium` is not on this path — assert that rather than leaving it implicit.
- [ ] **Verify:** end-to-end free duel on testnet: create → join → reveal → 5 swipes → keeper settles every card from Pyth → `finalize` → winner recorded, MMR updated.

## Task 4: event-sourced Predict discovery (kills the HTTP dependency)

For when Predict comes back — and so it can never take us down this way again.

- [ ] Add a `MarketCreated` tracker to `DuelIndexer` alongside the existing `drainOrderMinted` / `drainMarketSettled`. Write to a new `predict_market` table (`expiry_market_id` PK, `propbook_underlying_id`, `expiry`, `tick_size`, `admission_tick_size`, `created_at_ms` from the event node timestamp, `network`).
- [ ] Re-point `findDeckMarkets` / `findTieredDeckMarkets` / `oracle.ts` at that table instead of `GET /markets`. The field mapping is 1:1 — `MarketRow.checkpoint_timestamp_ms` becomes the event's `timestamp`.
- [ ] Prefer the DB in `readMarketSettlement` / `readOrderPremium` (the `market_settlements` / `order_premiums` tables the indexer already fills) and treat the HTTP indexer as an optional accelerator, not a requirement.
- [ ] Delete `PREDICT_INDEXER_URL` / `PROPBOOK_INDEXER_URL` from the *required* path. Keep them as optional overrides only.
- [ ] **Verify:** with both indexer URLs pointed at a black hole, deck generation and settlement still work against historical testnet markets.

## Task 5: make the outage visible instead of silent

Twelve days passed before anyone noticed. That is the real failure.

- [ ] `/health` reports the active `DECK_SOURCE`, the age of the newest known market, and whether any market is currently live.
- [ ] Deck-gen failure emits a distinct, greppable error — not the current generic `market list failed`.
- [ ] Add `bun --filter server check:sources` — one command that answers "can we build a deck right now, and from what?" Fold in what `check-6-24-live.ts` and `check-market-cadence.ts` already do, both of which currently fail confusingly because they assume the HTTP indexer exists.
- [ ] **Verify:** with Predict dark, `/health` says so plainly and the game still serves free duels via Pyth.

## Task 6: web + product honesty

- [ ] When `DECK_SOURCE` resolves to `pyth`, the UI must not claim the card is a DeepBook Predict market. Surface the price source on the card / result screen.
- [ ] Keep the staked tier gated whenever Predict discovery is empty — reuse the existing `<NetworkGate />` shape with source-appropriate copy ("staked duels need DeepBook Predict, which is between deployments").
- [ ] **Verify:** with Predict dark, `/game/practice` and free PvP work end-to-end; staked is clearly gated with an honest reason.

---

## Sequencing

1. **Tasks 1–3 first.** They restore a playable game and are independent of whether Predict ever returns.
2. **Task 5** next — cheap, and it is what turns the next outage into a 5-minute detection instead of 12 days.
3. **Task 4** when convenient; it is the durable fix but nothing is currently blocked on it.
4. **Task 6** alongside 1–3 so we never ship a screen that lies about where a price came from.

Then `2026-08-29-dual-network-full.md` resumes on top — but note it is **blocked on this**, not the other way round. Dual-network is meaningless while zero networks work.

## Definition of done

- With every `*.mystenlabs.com` HTTP indexer unreachable, a player can complete a full free duel: match → reveal → swipe → settle → finalize → MMR.
- `DECK_SOURCE=auto` uses Predict when it has live markets and Pyth when it doesn't, with no code change and no redeploy.
- `/health` states which source is active and how stale the market data is.
- Nothing in the Move package changed.
- The staked tier stays honestly gated until Predict has live markets again.

## Open question for the team

Pyth-sourced cards are a **different product** in one real way: a Predict card's strike carries a market-implied probability (that is where `deckQuoteMinProb`/`deckQuoteMaxProb` came from), and a Pyth card's does not — it is a pure price-offset bet with no market view behind it. That is fine for the free tier and for practice. It is **not** obviously fine as the basis for the ranked ladder and Season prizes.

Decide before Task 3 ships: do Pyth-sourced free duels count toward MMR and Season eligibility, or are they unranked until Predict returns? The plan assumes **they count** (otherwise the ladder is frozen for the duration), but that is a product call, not an engineering one.
