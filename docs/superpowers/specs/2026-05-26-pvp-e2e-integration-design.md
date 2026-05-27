# PvP E2E Integration — Design

## Goal

Wire the end-to-end PvP duel flow (matchmake → create/join → reveal → swipe → settle) into `apps/web` on top of the existing pixel-art UI shell, **without** porting the playground's raw `moveCall`-string PTB builders. The web app already has codegen-based equivalents that are type-safe and architecturally correct; this plan extends those rather than duplicating them.

## Non-Goals

- Range positions, LP, admin Predict calls — playground exposes these, none belong in the game UI.
- Client-driven settlement — keeper handles it; the client is a passive observer.
- **Client-driven deck reveal** — the server (keeper) holds plaintext and calls `reveal_deck`; the client never builds that PTB. See Reveal flow below.
- Full disconnect/forfeit handling (grace timers, abandonment penalties) — deferred; v1 displays peer-left state but doesn't act on it.
- `practice` tier flow — separate spec, shares the swipe engine but skips chain.

## Roles — what's forced, what isn't

The Move contract forces a single bit of asymmetry: one player must sign `create_duel(stake, deck_hash)`, the other must sign `join_duel(duel, stake)`. Each call spends that player's own dUSDC — no one (including the server) can spend a player's coin for them. The server picks who plays which role at matchmaking time.

**Everything else is symmetric.** Both players see the same UI from reveal onwards. The deck plaintext is server-side property; neither client ever holds it before reveal.

## Reveal flow (server-driven, WS-first)

1. At matchmaking, server generates the deck via Deckmaster and caches `{ deckHashHex → cards }`.
2. `match_found` payload carries `deckHash` — handed only to the creator (used to build `create_duel`). The plaintext stays server-side.
3. Creator signs `create_duel(stake, deckHash)`; challenger signs `join_duel(duel, stake)`. Both wallets only ever see the hash, not the cards. **No headstart**: neither player can read card content from their sign-time view.
4. The instant the server detects `join_duel` landed (status → ACTIVE), it does TWO things in parallel:
   - **(fast path)** Broadcasts `deck_revealed { duelId, cards: DeckCard[] }` to both clients via WS. Clients render the swipe deck immediately.
   - **(chain path)** Server's keeper calls `reveal_deck(duel, cards)` on chain. Permissionless — keeper just needs gas.
5. Clients show cards but **swipe buttons stay disabled** until `room_state.cardsRevealed === true` (server flips this after the keeper's tx confirms). Typically ~1–3s. UI displays a brief "preparing chain…" indicator over the first card during this gap.
6. Once chain reveal lands, swipe buttons enable and both clients enter the identical swipe loop.

The two events have distinct consumers and are NOT redundant:
- WS push → delivers cards to the **client UIs** so they can render.
- On-chain `reveal_deck` → delivers cards to the **contract** so `record_swipe` can verify per-card strikes and `settle_card` can compute outcomes.

Skipping the on-chain reveal isn't an option — without `duel.cards[i].strike` on chain, the contract rejects swipes (strike-mismatch) and can't settle. The WS-first ordering just collapses the player-visible "loading cards" gap from "wait for chain" to "wait for chain, but with cards already on screen."

This removes the creator-disconnect failure mode, removes one sponsored sign step from the creator, collapses two client state machines to one, and shows cards to both players at the same instant.

## Architectural baseline (what's already there)

Do not recreate any of this:

| Concern                  | Lives in                                                | Notes                                                                                                                                                    |
| ------------------------ | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Duel PTB builders        | `apps/web/src/lib/flicky.ts`                            | `buildCreateDuelDusdcTx`, `buildJoinDuelDusdcTx`, `buildRevealDeckTx`, `buildSwipeTx`, `buildSettleAndFinalizeTx`. Uses `@/sui/gen/flicky/duel` codegen. |
| Deck commit-reveal       | `apps/web/src/lib/flicky.ts`                            | `computeDeckHash` (BCS + sha2-256), `DeckCard` type.                                                                                                     |
| Duel state read/parse    | `apps/web/src/lib/flicky.ts`                            | `fetchDuel`, `parseDuel`, `DuelState`.                                                                                                                   |
| Oracle discovery         | `apps/web/src/lib/flicky.ts`                            | `findLatestOracleSvi`, `fetchOracleSvi`, `oracleStrikes`.                                                                                                |
| Atomic staked swipe      | `apps/web/src/lib/deepbook.ts`                          | `buildStakedSwipeTx` (mint + record_swipe in one PTB).                                                                                                   |
| PredictManager discovery | `apps/web/src/lib/deepbook.ts`                          | `findPredictManager` with localStorage cache, `invalidateManagerCache`.                                                                                  |
| dUSDC balances           | `apps/web/src/lib/deepbook.ts`                          | `getWalletDusdcBalance`, `getManagerDusdcBalance`.                                                                                                       |
| Manager onboarding PTBs  | `apps/web/src/lib/deepbook.ts`                          | `buildCreateManagerTx`, `buildDepositDusdcTx`, `buildWithdrawDusdcTx`.                                                                                   |
| Sponsored-gas signing    | `apps/web/src/lib/sponsor.ts`, `lib/use-flicky-sign.ts` | All player-signed PTBs go through this.                                                                                                                  |
| Wire protocol            | `apps/web/src/lib/protocol.ts`                          | Full `ClientMsg`/`ServerMsg` discriminated unions, `STAKE_TIERS`.                                                                                        |
| WebSocket hook (basic)   | `apps/web/src/hooks/use-flicky-socket.ts`               | 47 lines; exposes `{ wsOpen, lastMsg, send }`. Will be extended (see below).                                                                             |
| Environment              | `apps/web/src/lib/config.ts`                            | `packageId`, `deepbookPredictPackageId`, `serverHttpUrl`, `serverWsUrl`, `CLOCK_ID`, `stakeType`, etc. Already complete.                                 |

## Naming discipline

Preserve the established conventions. The playground's `tx*` / `read*` prefixes do not get ported.

| Concept                | Web naming                   | Playground naming (do NOT use) |
| ---------------------- | ---------------------------- | ------------------------------ |
| PTB builders           | `build*Tx`                   | `tx*`                          |
| State reads            | `fetch*` / `find*`           | `read*`                        |
| Per-swipe Predict cost | `premium` (matches contract) | —                              |
| Duel entry escrow      | `stake` (matches contract)   | —                              |

**UI copy** labels `premium` as **"swipe cost"** — friendlier for non-trading players. The word "stake" in UI refers only to the duel-entry amount.

## Changes

### 1. `lib/deepbook.ts` — add a UI-only swipe-cost quoter

> **Contract change (2026-05-27):** the new `record_swipe` no longer takes a client-supplied `premium`. The contract snapshots `premium` and `p_swiped` itself by calling `predict::get_trade_amounts` inside the PTB. `buildStakedSwipeTx` in `lib/deepbook.ts` is already updated to the new signature (no `premium` arg; new `predict` shared object arg). README explicitly warns: *"Frontend must NEVER pre-compute `premium` client-side and pass it to the contract."*

So we don't need a premium quoter to satisfy the PTB. We DO still want one for the UI — players should see the swipe cost on the UP/DOWN buttons before they confirm, even though the contract will recompute it.

Add a **display-only** helper:

```ts
export interface SwipeQuote {
  premium: bigint   // dUSDC micro-units — preview only; DO NOT pass to buildStakedSwipeTx
  pUp: bigint       // 1e9 fixed point; for UI implied-probability display
}

export async function quoteSwipePremium(
  client: SuiClient,
  args: {
    oracleSviId: string
    oracleExpiry: bigint
    strike: bigint
    isUp: boolean
    quantity: bigint
  },
): Promise<SwipeQuote>
```

Implementation: devInspect `predict::get_trade_amounts` with a `MarketKey` built from `marketKey.up`/`marketKey.down` codegen. Parse the BCS return.

Caveat in the JSDoc: the contract will re-snapshot at swipe time so the actual on-chain `premium` may differ by a few atoms due to clock/SVI drift between quote and execute. UI displays the quote as an **estimate**, not a commitment. **No new `lib/predict-txb.ts` file.**

### 2. `hooks/use-flicky-socket.ts` — typed subscription pattern

Current API drops messages when two components read the same `lastMsg` state (`pvp.tsx` watches `queue_status`/`match_found`; `active-duel.tsx` watches `duel_assigned`/`room_state`/`oracle_tick`).

Extend to:

```ts
type Unsubscribe = () => void
function useFlickySocket(address?: string): {
  wsOpen: boolean
  send: (msg: ClientMsg) => void
  onMessage: (handler: (msg: ServerMsg) => void) => Unsubscribe
}
```

Internally: a `Set<handler>` invoked on each `ws.onmessage`. Drop the `lastMsg` state. Callers register effect-scoped handlers and filter by `msg.type`.

### 3. `routes/game/pvp.tsx` — onboarding gate

Before `send({ type: "queue_join", tier })`:

1. Call `findPredictManager(client, address)`. If `null`, open onboarding modal.
2. Call `getManagerDusdcBalance(client, managerId)`. If `< MIN_MANAGER_BALANCE` (= `5n * SWIPE_QUANTITY` = 5 dUSDC; covers worst-case 5-card exposure), open onboarding modal at the deposit step.
3. On modal completion, queue.

Onboarding modal — new component `apps/web/src/components/onboarding-modal.tsx`. Two steps, both sponsored:

- **Create Manager** (skip if exists): sign `buildCreateManagerTx`, extract id from objectChanges via `extractManagerIdFromChanges`, `writeManagerCache(address, id)`.
- **Deposit dUSDC**: default = `MIN_MANAGER_BALANCE - currentBalance` so the user ends up at exactly 5 dUSDC; allow override upward. Sign `buildDepositDusdcTx(client, address, managerId, amount)`.

Note: the duel-entry `STAKE_TIERS[tier]` (3/5/10 dUSDC) is escrowed separately from the wallet at `buildCreateDuelDusdcTx` time and does not draw from the PredictManager. The PredictManager balance only funds per-swipe premiums.

Both calls go through `lib/sponsor.ts` per CLAUDE.md constraint.

### 4. `routes/game/active-duel.tsx` — fill in the state machine

Replace the 41-line placeholder. Single state machine for both roles:

```
ENTRY (sign create_duel | sign join_duel) → AWAIT_REVEAL → SWIPING(card i) → AWAIT_SETTLEMENT → COMPLETE
```

The only role-conditional branch is the ENTRY step. From `AWAIT_REVEAL` onwards, creator and challenger render the identical UI.

#### ENTRY (on mount)

- If `role === "creator"`: read `deckHash` from the `match_found` payload (the server pre-generated the deck at matchmaking; plaintext stays server-side). Sign `buildCreateDuelDusdcTx(client, address, deckHash, STAKE_TIERS[tier], DEEPBOOK.dusdcType)` → sponsored → execute. Parse `duelId` from objectChanges. `send({ type: "room_subscribe", duelId })`.
- If `role === "challenger"`: wait for `duel_assigned` from server. Sign `buildJoinDuelDusdcTx(client, address, duelId, STAKE_TIERS[tier], DEEPBOOK.dusdcType)` → sponsored → execute. `send({ type: "room_subscribe", duelId })`.

The web app does NOT build `reveal_deck`. `buildRevealDeckTx` in `lib/flicky.ts` stays put (test fixtures may use it) but no production web code invokes it.

#### AWAIT_REVEAL

Two-substep wait:

1. **Cards rendered (WS-fast):** wait for `deck_revealed { duelId, cards }` from server. Store `cards` in local state, render the swipe deck. Swipe buttons disabled, "preparing chain…" indicator shown on card 0.
2. **Swipes unlocked (chain):** wait for `room_state.cardsRevealed === true`. Enable swipe buttons, hide the indicator, transition to `SWIPING(0)`.

Both substeps fire for both players. The WS push arrives in milliseconds; the chain confirmation in 1–3s. No `/deckmaster/reveal?hash=` REST polling.

#### Swipe loop (both, after deck is locally known)

1. Once: `findLatestOracleSvi(client)` → `oracleSviId`; `fetchOracleSvi(client, oracleSviId)` → `{ expiry, ... }`.
2. `send({ type: "oracle_subscribe", oracleIds: [oracleSviId] })` to stream live ticks.
3. For each card `i` in 0..4:
   - On entering card `i`, pre-fetch both quotes in parallel:
     ```
     [upQ, downQ] = await Promise.all([
       quoteSwipePremium(client, { ..., isUp: true,  quantity: SWIPE_QUANTITY }),
       quoteSwipePremium(client, { ..., isUp: false, quantity: SWIPE_QUANTITY }),
     ])
     ```
   - Render two buttons:
     - `UP` — labeled with `fmtDusdc(upQ.premium)` swipe cost + implied probability `upQ.pUp / 1e9`.
     - `DOWN` — labeled with `fmtDusdc(downQ.premium)` swipe cost + `1 - upQ.pUp`.
   - On click: `buildStakedSwipeTx({ duelId, oracleSviId, managerId, oracleExpiry, strike, isUp, quantity, cardIdx: i })` → sponsored sign → execute. **No `premium` passed** — contract snapshots it. Optimistically advance to card `i+1`.
4. After all 5 swipes locally: transition to `AWAITING_SETTLEMENT`.

Reconciliation: every `room_state` event re-derives the displayed card index from `swipes` (for _this_ address). Survives F5 because the server's `room_state` carries the full swipe log.

Live data: `oracle_tick` updates a `spot` display under the active card. No re-quoting on every tick (would hammer devInspect) — quote freezes when card enters.

`SWIPE_QUANTITY` constant in this file = `1_000_000n` (1 dUSDC). **Rationale, not arbitrary:** the worst-case per-game Predict exposure is `5 × SWIPE_QUANTITY = 5 dUSDC`, which matches the PredictManager balance minimum already gated by `protocol.ts` (`STAKE_TIERS` PRD note: "all gated by PredictManager balance ≥ 5 dUSDC"). Bumping this constant breaks that invariant — if it changes, the onboarding gate's minimum-balance check must move in lockstep. Out-of-scope to make user-configurable in v1; the game emphasizes per-card PnL, not bet-sizing skill.

#### Settlement (passive)

> **Contract change (2026-05-27):** settlement is now a **single** `finalize_multi` call (or `finalize` if all 5 cards share one oracle), not 5× `settle_card` + a separate `finalize`. The new `buildFinalizeTx` helper in `lib/flicky.ts` builds the PTB, but the web app does NOT call it — the keeper does, signed by the server admin key.

- No client-side finalize call. Keeper in `apps/server/src/keeper.ts` waits until both players are 5/5 AND all relevant oracles have `settlement_price.is_some()`, then submits `finalize_multi(duel, p0_mgr, p1_mgr, oracle_0..oracle_4, clock)`.
- UI shows "awaiting settlement" while watching `room_state`. With one-shot finalize, the displayed counter is no longer a 0→5 settled-card progress — it's "waiting for oracles to settle" (5 separate expiries), then a single chain confirmation flips the duel to COMPLETE.
- The `room_state.settledCount` field (per current `protocol.ts`) is interpreted as "oracles with `settlement_price.is_some()`", climbing 0→5. UI displays "X / 5 oracles settled" until the keeper fires `finalize_multi`.
- On `room_state.status === "COMPLETE"`: render winner from `room_state` payout fields. The `DuelFinalized` event also carries `oracle_id` + `settlement_price` as on-chain proof — server can include these in the room_state push for the results screen.
- `finalize_test_one_oracle` (dev-mode finalize using spot price as fallback) is **out of scope** for the production game UI. The keeper picks the right finalize call.

#### Disconnect/forfeit display only

- `peer_left` → grey banner "opponent disconnected — N s grace".
- `peer_forfeit` → declare you the winner-by-default; settlement still runs through the keeper.

#### Contract-enforced timeouts (UI surfaces, doesn't trigger)

The new contract has three timing constants the UI should reflect — but the chain enforces them; the web app only needs to display countdowns and react to the resulting events:

| Constant | Value | UI behavior |
|---|---|---|
| `REVEAL_TIMEOUT_MS` | 5 min after `join_duel` | Server keeper reveals within ~1-3s in practice; this 5-min ceiling exists as a contract-level forfeit window. UI doesn't need a countdown; just handle `peer_forfeit` if the keeper ever fails to reveal. |
| `SWIPE_WINDOW_MS` | 10 min after `join_duel` | Each `record_swipe` aborts with `ESwipeTimeout` after this. UI shows a small "swipe deadline" countdown during the swipe phase. If a player runs out, their remaining cards stay unswiped → keeper still calls `finalize_multi`; the player just forfeits the score on those cards. |
| `REFUND_TIMEOUT_MS` | 1 h ACTIVE | Beyond this, either player can call `refund_duel` to reclaim stake. Not in the v1 UI; deferred. |

### 5. `lib/config.ts` — bump the deployed package id

Following the 2026-05-27 contract redeploy:

- Current: `packageId` defaults to `0x505cdc...` (stale, pre-fix/contract).
- Update to: `0x4ab595f3b0276c50eeff2181905cabc1d94ca3fd6b7aafe1a01d12869f258c44` (current, per `apps/contracts/deployed.json`).
- `VITE_FLICKY_PACKAGE_ID_TESTNET` in `apps/web/.env.local` should already be auto-written by `publish.ts`, but the in-code default needs to match for fresh checkouts.

### 6. Files explicitly NOT created

- ~~`apps/web/src/lib/duel-txb.ts`~~ — duplicates `lib/flicky.ts` with worse type safety.
- ~~`apps/web/src/lib/predict-txb.ts`~~ — duplicates `lib/deepbook.ts`; range/LP/admin functions don't belong in the game UI.
- ~~Any new `config.ts` env vars~~ — already present (only the value updates).
- ~~`finalize_test_one_oracle` UI button~~ — dev-only contract entry; keeper picks the right finalize call.

## Data flow summary

```
pvp.tsx
  │  manager + dUSDC precheck
  │  ↳ onboarding-modal.tsx ─► sponsored ─► buildCreateManagerTx, buildDepositDusdcTx
  ▼
  ws.send queue_join
  ▼  ServerMsg: queue_status, match_found
  ▼
active-duel.tsx
  │  if creator: read deckHash from match_found ─► buildCreateDuelDusdcTx ─► ws.send room_subscribe
  │  if challenger: wait duel_assigned ─► buildJoinDuelDusdcTx ─► ws.send room_subscribe
  ▼  ServerMsg: room_state (status ACTIVE)
  │  server keeper calls reveal_deck (in parallel)
  ▼  ServerMsg: deck_revealed (WS-fast) ─► render cards, swipes disabled
  ▼  ServerMsg: room_state (cardsRevealed: true) ─► swipes enabled
  │  findLatestOracleSvi + fetchOracleSvi
  │  ws.send oracle_subscribe
  ▼  per card i:
  │    quoteSwipePremium × 2 (up/down)
  │    user click ─► buildStakedSwipeTx ─► sponsored ─► execute
  │    ServerMsg: oracle_tick (live), room_state (reconcile)
  ▼  after 5 swipes:
  ▼  ServerMsg: room_state (settledCount climbing, then COMPLETE)
  ▼
results screen ◀── room_state.cardOutcomes
```

## Verification plan

1. `bun --filter server dev` running locally.
2. Open two browser windows with different zkLogin wallets, both signed in.
3. In wallet A: pick stake 3 dUSDC, press queue match. If no PredictManager / insufficient balance, onboarding modal appears — complete it. Queue starts.
4. In wallet B: pick stake 3, queue match. Match-found fires in both.
5. Verify both transition through: waiting → cards rendered (swipes disabled, "preparing chain") → swipes enabled → 5 swipes → awaiting settlement → results.
6. Verify creator's wallet only shows a hash for the `create_duel` confirm dialog (no card content visible at sign time — no headstart).
7. Verify both clients receive `deck_revealed` at effectively the same instant.
8. Verify per-card UP/DOWN buttons show pre-computed swipe cost + implied probability, **and** that the on-chain `premium` in `SwipeRecorded` matches the UI estimate within drift tolerance (a few atoms).
9. Verify swipe PTBs do NOT include a client-supplied `premium` arg (inspect `record_swipe` call args — should be 7 args, not 8).
10. Verify `oracle_tick` updates the live spot under the active card.
11. Verify `room_state` from server matches `fetchDuel` from chain (no protocol drift).
12. Verify settlement is a SINGLE `finalize_multi` tx (one chain confirmation), not 5 settle_card txs.
13. Verify winner displayed matches the `DuelFinalized` event payouts: `payout_to_p0` vs `payout_to_p1`.
14. F5 mid-duel — UI rehydrates from `room_state.swipes`, doesn't double-swipe a card.
15. Verify swipe-deadline countdown is visible during the swipe phase and approaches `joinedAt + 10 min`.

## Out-of-scope (explicit deferrals)

- Client-side settle fallback if keeper lags. Marked passive-only by design.
- Configurable `SWIPE_QUANTITY` per card. Fixed constant for v1.
- Practice/free tier UI flow. Shares the engine but separate spec.
- Full reconnect-with-forfeit-grace logic. Display only.
- Multi-oracle decks (current Deckmaster picks one). Code paths in `buildSettleAndFinalizeTx` already handle it; UI assumes one.
