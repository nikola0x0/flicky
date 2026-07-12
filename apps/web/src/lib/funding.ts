/**
 * Duel funding economics — the web's single source of truth, mirrored on the
 * server in `apps/server/src/predict.ts` (`SWIPE_QUANTITY_MIST`,
 * `MAX_DECK_SIZE`, `requiredQueueBalance`). Keep the two in lockstep: the
 * server enforces the queue-join gate against the AccountWrapper balance, so
 * the web must deposit at least what the server requires — otherwise the
 * player funds their manager and then gets bounced at `queue_join`.
 */
import { DEFAULT_DECK_SIZE } from "@/lib/flicky"

/**
 * Per-swipe Predict `mint_exact_quantity` size (notional, dUSDC micro-units).
 *
 * This is the position NOTIONAL, not the premium paid. The mint's
 * `net_premium = entry_probability × quantity / leverage` must clear the
 * protocol's `min_net_premium` floor ($1 = 1_000_000) or the mint aborts
 * with `ENetPremiumBelowMinimum` (`strike_exposure_config::assert_mint_admission`,
 * abort code 4). By design the position is kept as CHEAP as the protocol
 * allows — the duel STAKE (side-pot) is the game's real prize, the mint is
 * just how each swipe takes a genuine Predict position for scoring. So this
 * sits at 3 dUSDC notional: at this quantity BOTH sides of an offset-strike
 * card clear the floor (band widens to p ∈ [0.334, 0.666], covering every
 * `ZONE_TARGET_PROB` zone in deckmaster) — the favored side (win prob ≳ 0.56)
 * yields a premium of ~$1.68–1.89, and the long-shot side ~$1.11–1.32 — while
 * a 5-card duel draws ~$7.5–9 of premium total, so a stake pool of a few
 * dUSDC per side still dominates it. MUST match the server's
 * `SWIPE_QUANTITY_MIST`.
 */
export const SWIPE_QUANTITY = 3_000_000n

/**
 * Absolute floor the AccountWrapper must hold before queueing, mirroring the
 * server's `MIN_BALANCE_FOR_QUEUE`. This is only the floor — the real target
 * is `requiredManagerBalance(stake)`, which is always higher for a real
 * staked tier.
 */
export const MIN_MANAGER_BALANCE = 5_000_000n

/**
 * Worst-case premium budget for one duel: a full deck of `DEFAULT_DECK_SIZE`
 * cards, each swipe minting `SWIPE_QUANTITY` notional. Decks are adaptive
 * (3–5 cards) but never larger than the default, so this is the ceiling.
 * Mirrors the server's `MAX_DECK_SIZE * SWIPE_QUANTITY_MIST`.
 */
export const MAX_PREMIUM_BUDGET = BigInt(DEFAULT_DECK_SIZE) * SWIPE_QUANTITY

/**
 * dUSDC the player's AccountWrapper must hold before queueing at `stake`.
 *
 * In the 6-24 model BOTH the duel stake and every swipe premium are withdrawn
 * from the AccountWrapper (`account::withdraw_funds`, see
 * `buildCreateDuelDusdcTx` in `flicky.ts`) — the wallet only funds the
 * account, it does NOT pay the stake separately. So the account must hold the
 * stake plus the worst-case premium budget. Mirrors the server's
 * `requiredQueueBalance`; floored at `MIN_MANAGER_BALANCE`.
 */
export function requiredManagerBalance(stake: bigint): bigint {
  const required = stake + MAX_PREMIUM_BUDGET
  return required > MIN_MANAGER_BALANCE ? required : MIN_MANAGER_BALANCE
}
