# One-Sided Swipe Cards: Long-Shot Mint Aborts — Root Cause & Solution Options

- **Date:** 2026-07-18
- **Status:** Investigation complete — awaiting team decision on fix direction
- **Severity:** High — blocks gameplay mid-match
- **Components:** `apps/server/src/deckmaster.ts`, `apps/server/src/mint-probe.ts`, `apps/web/src/routes/game/active-duel.tsx`
- **Environment:** Predict testnet pin `predict-testnet-6-24`

## TL;DR

This is **not a random failure but a deterministic consequence of the current
strike-placement design**. The protocol's $1 `min_net_premium` floor only
admits a mint when that side's probability exceeds ⅓ (at the current
3 dUSDC swipe quantity). The deck places strikes so the long-shot side sits at
p = 0.37–0.44 — leaving only **$0.11–$0.32 of margin** above the floor. That
margin is eroded by **time decay** (probabilities sharpen as 1/√T on
short-expiry markets) and **spot drift** between deck build and the player's
actual swipe. An "edge" zone card can lose one side **from time passing alone,
with no price movement**. This report proposes four fix directions with
pros/cons, plus two quick wins worth doing regardless of the chosen direction.

## 1. Symptom

Mid-match, a card sometimes only allows swiping one direction. When the player
swipes the other (long-shot) side, the transaction aborts on-chain and the UI
shows:

> "That long-shot side is too unlikely to place on this market — swipe the
> other way (the favored call)."

The player is forced onto the same direction as their opponent — the card
becomes a near-wash and loses its competitive meaning.

The actual on-chain failure is DeepBook Predict's
`strike_exposure_config::assert_mint_admission`, abort code 4
(`ENetPremiumBelowMinimum`): that side's
`net_premium = probability × quantity` fell below the `min_net_premium`
floor of $1.

## 2. Root-Cause Chain

1. **The safety margin is thin from the moment the deck is built.**
   Deckmaster places strikes at a target win-probability for the favored side:
   close 0.56, mid 0.61, edge 0.63 (`ZONE_TARGET_PROB` in `deckmaster.ts`).
   The long-shot side therefore sits at p = 0.44 / 0.39 / 0.37, i.e. premiums
   of $1.32 / $1.17 / $1.11 — only 11–32 cents above the $1 floor.

2. **The mint probe runs exactly once, at deck-build time.**
   `buildProbedDeck` (`mint-probe.ts`) devInspects both directions and falls
   back to an ATM strike if either fails — but only at build time. The deck is
   commit-revealed (hashed at creation, revealed at match start), so
   **strikes cannot change afterwards**. More than 10 minutes can elapse
   between the probe and the last card's swipe (matchmaking + reveal + the
   10-minute swipe window).

3. **Time decay breaks the mint condition by itself — no price move needed.**
   Market expiries are very short (the minimum headroom default is only
   10 minutes — `DECK_CARD_MIN_HEADROOM_MS` in `env.ts`). For a fixed strike,
   the normalized distance d scales as 1/√T: an edge card placed at
   p = 0.63 with 20 minutes to expiry reaches p ≈ 0.68 with 10 minutes
   left → long-shot 0.32 < 0.334 → **abort with spot unchanged**.

4. **Spot drift and vol mismatch compound it.**
   BTC only needs to drift a few bps toward the favored side for the
   long-shot's p to fall further. Strikes are placed using a fixed model vol
   of 0.6 (`SVI_VOL`), while the on-chain pricer uses live SVI vol feeds — if
   realized vol is lower than 0.6, actual probabilities are sharper than the
   placement model assumes, and the margin is thinner than designed.

## 3. Quantifying the Margin

At quantity 3 dUSDC, the mint threshold is p > 0.334. The table shows each
zone's distance to the threshold at deck build — and how much it sharpens
after just half the time to expiry elapses (spot unchanged):

| Zone  | p favored (at placement) | p long-shot | Long-shot premium | Margin over $1 floor | p long-shot at ½ T remaining |
| ----- | -----------------------: | ----------: | ----------------: | -------------------: | ---------------------------: |
| close |                     0.56 |        0.44 |             $1.32 |               +$0.32 |             0.415 — survives |
| mid   |                     0.61 |        0.39 |             $1.17 |               +$0.17 |             0.346 — marginal |
| edge  |                     0.63 |        0.37 |             $1.11 |               +$0.11 |             0.319 — **dead** |

In other words: an edge card on a short-headroom market is **guaranteed** to
lose one side before the end of the swipe window; a mid card dies with any
additional drift; a close card usually survives. This matches the "sometimes"
frequency players report.

## 4. Secondary Finding: Errors Misclassified to the Player

The error-classification regex in `active-duel.tsx:420–425` maps
`abort code: 1` to the "out of dUSDC — top up" message. But Predict has a
second admission gate, `assert_mint_probability_and_leverage_policy`, which
also aborts with **code 1** when the probability falls outside the
`[min_entry, max_entry]` band — fundamentally the same "one side is not
mintable" failure, yet the player is told to deposit more funds. If anyone has
reported "out of funds despite sufficient balance", this is why. Worth fixing
regardless of which direction below is chosen.

## 5. Solution Options

### A — Raise the per-swipe quantity: 3 → 6 dUSDC (effort: small)

The mint threshold is p > 1/quantity: raising to 6 dUSDC lowers the threshold
from 0.334 to 0.167. The decay + drift margin becomes ~5× wider — the
long-shot at 0.37 would have to fall below 0.167 to die, which practically
never happens within 10 minutes. Only two constants change (`SWIPE_QUANTITY`
on web + `SWIPE_QUANTITY_MIST` on server) plus the funding math.

**Pros**

- Near-total fix, tiny diff, no contract changes
- Cards keep their current strike offsets — no flattening
- Larger premiums → larger PnL swings → more dramatic PnL chart

**Cons**

- Players must fund their account with more: premium budget 15 → 30 dUSDC
  (added to the stake at queue time)
- Premium swing grows relative to the stake pool — the stake's share as the
  "real prize" shrinks
- Need to re-probe the `[min_entry, max_entry]` band and LP backing at the new
  quantity (bigger mints can hit backing limits on thin markets)

### B — Decay-aware strike placement + raise headroom to 30 minutes (effort: medium)

Keep quantity 3. When placing strikes, budget for probability sharpening
up front: choose the target p so that at the **end** of the swipe window (not
at build time) the long-shot side still clears 0.334 plus a drift margin.
Also raise `DECK_CARD_MIN_HEADROOM_MS` from 10 to 30 minutes so 1/√T
stretches more slowly (the `env.ts` comment already describes 30 minutes, but
the default is 10).

**Pros**

- No change to game economics — required balance, stake, and premiums stay
  the same
- Fixes the layer that actually causes the bug (placement), not the symptom
- Raising headroom also reduces the risk of LP backing flipping mid-match

**Cons**

- Flatter leans → less dramatic cards, smaller PnL drift (edge zone on short
  markets may have to collapse toward ATM)
- Later settlement → players wait longer for results
- Small residual risk remains under strong price moves — narrowed, not
  eliminated

### C — Combined: quantity 3 → 4 + decay-aware placement + 30-minute headroom (recommended, effort: medium)

Raise quantity moderately (threshold p > 0.25) for a hard margin, while also
placing strikes with decay compensation. Two independent layers of defense:
placement never creates near-threshold cards, and even if the model is wrong
(vol mismatch, price runs) the 0.25 threshold remains far below the long-shot
range of 0.37–0.44.

**Pros**

- Best balance: wide margin with the budget rising only 15 → 20 dUSDC
- Keeps the drama of the lean (no need to collapse strikes toward ATM as much
  as pure B)
- Defense-in-depth: if one layer fails, the other still holds

**Cons**

- More changes than A or B alone (though each change is small)
- Still raises the account funding requirement (less than A)
- Target p must be re-tuned for the new headroom and validated on testnet

### D — UI-only smoothing: pre-disable the unmintable side (effort: small–medium)

No economics change. The client computes p itself (with the same digital-BS
model already in `pnl.ts`) or devInspects when the card appears, and
**locks the unplaceable side up front** with an explanation — instead of
letting the player swipe into an error.

**Pros**

- Touches neither economics nor server deck-gen
- Completely removes the "swipe then get an error" experience
- Good polish worth shipping alongside any other option

**Cons**

- **Does not meet the goal**: one-sided cards still exist; both players are
  forced onto the same direction → the card becomes a wash, losing its
  competitive meaning
- If the client model is used to predict admission, it can diverge from the
  on-chain pricer (false positives/negatives)
- Per-card devInspect is heavy for the client or requires a new endpoint

### Quick wins worth doing regardless of the chosen direction

- **Fix error classification** in `active-duel.tsx`: match aborts by
  (module, code) instead of bare `abort code: N` — Predict's code 1 currently
  renders as "out of dUSDC" (see section 4).
- **Add metrics/logging**: count swipe aborts by abort code + card zone to
  measure the real frequency and verify the chosen fix drives it to zero.

## 6. Comparison Matrix

| Criterion              | A · Qty 6                             | B · Decay-aware               | C · Combined            | D · UI only                   |
| ---------------------- | ------------------------------------- | ----------------------------- | ----------------------- | ----------------------------- |
| Eliminates one-siding  | ~Total                                | Mostly                        | ~Total                  | No (only smoother)            |
| Changes game economics | Budget ×2 (15→30)                     | No                            | Budget +33% (15→20)     | No                            |
| Card drama             | Kept / increased                      | Reduced                       | Nearly kept             | One-sided card = wash         |
| Change size            | Very small                            | Medium                        | Medium                  | Small–medium                  |
| Residual risk          | Band/backing at new qty — needs probe | Vol mismatch, big price moves | Lowest (two layers)     | Client model diverges from pricer |

## 7. Recommendation & Questions for the Team

**Recommendation:** pick **C** if a slightly higher account funding
requirement is acceptable (20 dUSDC premium budget + stake); pick **B** if
the current economics are untouchable. In all cases ship the two quick wins,
and consider D as final polish.

**For the team to decide:**

1. What is the acceptable ceiling for the dUSDC a player must deposit before
   queueing? (decides A vs B vs C)
2. Does later settlement (30-minute headroom) conflict with pacing/retention?
3. Do we accept one-sided cards as a valid game state (direction D), or treat
   them as a bug to eliminate?

## 8. Appendix: Code References & Verification

- Error message + classification regex:
  `apps/web/src/routes/game/active-duel.tsx:418–433`
- Quantity economics & the $1 floor: `apps/web/src/lib/funding.ts`
  (`SWIPE_QUANTITY = 3_000_000n`), server mirror:
  `apps/server/src/predict.ts:73`
- Per-zone probability targets: `apps/server/src/deckmaster.ts`
  (`ZONE_TARGET_PROB`, `SVI_VOL = 0.6`, `sviRawStrike`)
- Both-direction probe at deck build: `apps/server/src/mint-probe.ts`
  (`buildProbedDeck`)
- Default 10-minute headroom: `apps/server/src/env.ts:153–154`
  (`DECK_CARD_MIN_HEADROOM_MS`)

**Suggested verification:** (1) grep server logs for `ATM fallback` /
`mint probe: kept X/Y` lines and correlate with failing matches; (2)
devInspect the exact failing card in both directions to confirm whether the
abort is code 4 (premium floor) or code 1 (probability band); (3) after
applying the chosen fix, re-run the abort-by-zone stats to confirm they drop
to zero.

---

_Probability figures computed with the digital Black-Scholes model at vol 0.6,
matching the current code._
