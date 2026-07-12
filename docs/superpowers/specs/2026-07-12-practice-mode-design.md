# Practice Mode (vs Bot) — Design

Date: 2026-07-12
Status: Approved

## Purpose

A single-player on-ramp that teaches the real Flicky loop — swipe 5 binary
cards, watch the chart, see per-card settlement — without matchmaking, stakes,
or any on-chain transaction. The player faces a bot, the deck is synthetic
(no DeepBook Predict markets), prices are the live Pyth BTC feed, and the
whole match resolves ~45 seconds after the last swipe.

Reached from the MODES modal (`mode-modal.tsx` already links to
`/game/practice`, which currently renders "Coming Soon").

## Decisions made during brainstorming

1. **Outcomes are real-price-driven, not scripted.** Each card settles
   against the live Pyth BTC spot at its (synthetic, short) expiry. Because
   strikes sit near the current price, results are naturally coin-flip-ish —
   satisfying the "random ~45s game" ask while keeping chart and card
   outcomes always consistent. No predetermined winner.
2. **Timeline: unlimited swiping, then a 45s lockup.** The player swipes 5
   cards with no time pressure ("No pressure" per the mode card). The moment
   the 5th card is swiped, a 45-second lockup begins; the 5 cards expire
   staggered at roughly seconds 15 / 22 / 30 / 37 / 45.
3. **Architecture: server generates the deck, client runs the match.**
   Extends the existing `practice_start` → `practice_session` scaffold
   (`apps/server/src/ws/practice.ts`); the client owns swiping, bot replay,
   45s clock, per-card settlement, and the result. No practice rooms, no DB
   writes, no keeper involvement.

## Game flow

```
MODES modal → PRACTICE → /game/practice
  INTRO      "vs Bot" screen + Start button. No balance/onboarding gate.
  SWIPING    5 cards, drag-to-swipe like PvP, untimed. Bot (fixed persona:
             avatar + name) visibly "swipes" 1–3s after the player's swipe.
  LOCKUP 45s Starts when the 5th card is swiped. Full chart view of live
             BTC spot with strike lines for still-pending cards. Cards flip
             (won/lost) as their expiry offsets elapse.
  RESULT     Victory/Defeat identical in feel to PvP + per-card recap +
             "Play again" / "Find real match". No history / leaderboard /
             MMR writes.
```

## Server changes (`apps/server`)

### `ws/practice.ts` — synthetic deck generation

Replace the DeepBook-market path (`findDeckMarkets` + `filterMintableMarkets`
+ `buildProbedDeck` + `commitDeck`) with:

- `spot = readBtcSpot()` — same live Pyth source deck-gen and oracle-stream
  already use (1e9-fixed).
- 5 synthetic cards. Strike for card *i* is placed with the same
  digital-Black-Scholes model deckmaster uses (`ASSUMED_VOL` consistent with
  the web's `pnl.ts`), but with time-to-expiry = the card's short
  `expiryOffsetMs` (15s–45s) and a probability ladder like the real deck's
  zone targets (mix of easy ≈0.65 and hard ≈0.35 cards, order shuffled by
  the session seed). Short T means strikes land close to spot, so the price
  genuinely crosses them during lockup.
- `botSwipes`: unchanged — 5 pre-decided random 50/50 picks.
- No mint probing, no commit-reveal (nothing on-chain to commit to).

### Wire protocol (`ws/protocol.ts`, mirrored in web `lib/protocol.ts`)

- `practice_session` payload becomes:

  ```ts
  {
    type: "practice_session",
    cards: Array<{
      strike: string        // 1e9-fixed, same scale as oracle spot
      expiryOffsetMs: number // relative to lockup start (client anchors it)
      pUp: string            // design probability that UP wins, e.g. "0.62"
    }>,
    botSwipes: boolean[],
  }
  ```

  `pUp` doubles as the scoring `p_swiped`: player/bot swiping UP uses `pUp`,
  DOWN uses `1 - pUp`. (Practice has no Predict SVI to snapshot; the design
  probability is the honest stand-in and keeps the `1/p × speed` lesson.)
- New client messages `spot_subscribe` / `spot_unsubscribe` (no payload
  beyond `type`). Existing `oracle_tick` requires a real `ExpiryMarket` id
  (the stream fetches indexer state per market), so practice gets a
  market-less tick instead.
- New server message `spot_tick { spot: string, timestampMs: number }`.

### `ws/oracle-stream.ts` — spot-only subscribers

- Add a `spotSubscribers: Set<ws>` alongside `marketSubscribers`.
- `tick()` currently early-returns when no markets are subscribed; also run
  when spot subscribers exist, and broadcast `spot_tick` to them each tick.
  Reuses the same interval (`env.oracleTickIntervalMs`, ~2s) and the
  existing `lastBtcSpot` cache (fetch hiccups never regress to "0").
- Clean up on socket close alongside the existing oracle cleanup.

### `ws/handlers.ts` + `ratelimit.ts`

Route the two new messages; rate-limit `spot_subscribe` like
`oracle_subscribe`.

## Client changes (`apps/web`)

### Route

`main.tsx`: `/game/practice` → new `routes/game/practice.tsx` (drop
`GameComingSoon` here). The route lives inside the authenticated `/game`
shell like every other mode; it never asks for deposits and never triggers
the onboarding balance gate.

### `usePracticeSession` hook (new)

Local state machine `INTRO → SWIPING → LOCKUP → RESULT` (+ `ERROR`), driven
by:

- `practice_start` send / `practice_session` receive (via the shared
  `useFlickySocket`).
- `spot_subscribe` on session start, `spot_unsubscribe` on exit/unmount;
  `spot_tick` stream feeds both the chart and settlement.
- **Synthetic `RoomState`**: the hook maintains an object shaped like
  `active-duel.tsx`'s `RoomState` (cards keyed by synthetic market ids
  `practice-0` … `practice-4`, swipes, cardOutcomes, creator = player
  address, challenger = bot sentinel address). This lets `BtcSpotChart`,
  `StreamingPnlChart`, and the card ledger render unmodified — they already
  consume `RoomState`-shaped data plus a `ticks` map.
- Swipe recording: player swipe stores `{isUp, quantity, swipedAtMs}`
  locally, with `quantity` = the same `SWIPE_QUANTITY` constant PvP mints,
  so `pnl.ts` projections and the PnL chart scale identically; the bot's
  pre-decided swipe for the same card index is revealed after a random
  1–3s delay.
- Lockup: anchored at `lockupStartMs = Date.now()` when the 5th swipe lands;
  card *i* settles at `lockupStartMs + expiryOffsetMs[i]` using the latest
  `spot_tick`: `upWon = spot >= strike` (same convention as `pnl.ts`).
- Result: per-card PnL via the existing `pnl.ts` binary projection; match
  winner = higher total PnL (mirrors on-chain `finalize` semantics of
  payout + premium comparison). Score recap also shows the `1/p × speed`
  points per correct card to teach the scoring rule.

### Targeted extraction from `active-duel.tsx`

`active-duel.tsx` is 1,320 lines with the reusable UI trapped in internal
functions. Extract the **presentational** pieces into `components/` so both
PvP and practice share them, changing no PvP behavior:

- Drag-to-swipe card (the visual card + drag mechanics from `PhaseSwiping`)
  → takes `onCommit(isUp: boolean)`; PvP keeps its PTB signing + balance
  preflight in `active-duel.tsx`, practice records locally.
- `ChartModal` / `ChartChip`, `CardLedger`, and the Victory/Defeat visuals
  from `PhaseComplete`.

The signing path, room subscription, and phase machine of PvP stay where
they are.

### What practice must NOT do

- No PTBs of any kind (create/join/swipe/settle), no sponsor calls, no
  Predict manager reads, no balance preflight.
- No DB or leaderboard writes (server already does none for practice).
- No reuse of the unrevealed-deck cache or commit-reveal machinery.

## Edge cases

- **WS drop mid-session**: show an error state with a restart button. The
  session is ephemeral — no resume, unlike PvP. Acceptable for practice.
- **Page refresh mid-session**: session lost, back to INTRO.
- **Spot fetch hiccup during lockup**: server's `lastBtcSpot` cache keeps
  ticks flowing with the last good value; the client settles against the
  latest received tick.
- **Spot exactly at strike at expiry**: `upWon = spot >= strike`.
- **No spot tick received yet at a card's expiry moment**: hold the flip
  until the next tick arrives (settle on first tick at/after expiry).

## Testing

- **Server (`bun test` in `apps/server`)**: unit tests for synthetic deck
  gen (strikes on the correct side/distance for their `pUp`, offsets
  strictly increasing within 15–45s, 5 bot swipes) and `protocol.test.ts`
  updates for the new/changed messages.
- **Client**: `bun typecheck` + `bun lint`; manual end-to-end verification
  in the browser (INTRO → SWIPING → LOCKUP → RESULT) since no web test
  runner is wired up.
