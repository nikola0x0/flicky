# Flicky — Game Spec

> **This doc is the source of truth for Flicky's game design.** When the spec and any other doc disagree, this wins. Changes are tracked in the companion **Flicky — Decisions (ADR Log)**.
> 
> 
> Repo (implementation): [https://github.com/nikola0x0/flicky](https://github.com/nikola0x0/flicky)
> 

---

## One-liner

Swipe YES/NO on a shared deck of binary predictions. Face off against another player. On-chain escrow pays the winner. Real DeepBook Predict markets under a Tinder-style UI.

## Why this exists

Prediction markets are powerful but feel like trading terminals. Swipe-based mobile betting apps (Pulse on Solana, Rush's $500M-in-a-week sub-hour BTC binaries) proved enormous retail demand for "feel-based" prediction UX — but they're shallow and have no real PvP layer. Flicky bridges them: a Tinder-style swipe deck on top of DeepBook Predict's binary-digital primitive, plus a 1v1 escrow layer so two players can put real stakes on "who reads BTC better."

## Player experience in one paragraph

You sign in with Google. You're shown a queue with three stake buttons: Practice ($1), Standard ($5), High Roller ($10). You tap Standard. A few seconds later your opponent appears. Five cards flip up — each one is a BTC binary question ("BTC > $70,000 at 12:00 UTC?"). You have 60 seconds. Swipe right for YES, left for NO. Fast swipes score more. The deck locks; both of you sit and watch the market tick for 10 minutes, sending reaction emojis. The oracle resolves. The winner takes the pot. A share-card pops up. You queue again.

---

## Game design

### Two tiers

| Tier | Money flow | Predict integration | Reward |
| --- | --- | --- | --- |
| **Free** | none | virtual swipes, scored against live DeepBook Predict oracle | win-counter increment |
| **Staked** | dUSDC stake into shared escrow | live swipes recorded against Predict's SVI snapshot, scored against the oracle settlement | winner takes the side-pot |

Both tiers share the **same swipe UX, same card pool, same scoring, same timing**. The only difference is money flow.

### Stake tiers (staked mode)

| Tier | Stake |
| --- | --- |
| Practice | 1 dUSDC |
| Standard | 5 dUSDC |
| High Roller | 10 dUSDC |

Matchmaking is bucketed per tier. MMR within each bucket.

### Match anatomy

```
t = 0s              t = 60s             t = ~10 min         t = ~10 min + 1 block
┌───────────────┐   ┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│  Swipe phase  │ → │ Lockup phase  │ → │  Settlement   │ → │   Payout      │
│  ~60 seconds  │   │  ~10 minutes  │   │  oracle ticks │   │  side-pot to  │
│  5-card deck  │   │  live view +  │   │  binaries     │   │  winner       │
│  commit-reveal│   │  reactions    │   │  resolve 0/1  │   │               │
└───────────────┘   └───────────────┘   └───────────────┘   └───────────────┘
```

1. **Create / Join.** Both players stake dUSDC into the shared `Duel` object. Deck hash is committed on-chain (commit-reveal). Plaintext deck is revealed at swipe-phase start.
2. **Swipe phase (60 s).** Each player swipes YES/NO on each of 5 cards. Direction + the snapshotted `p_swiped` (from Predict's SVI surface) + decide-time are recorded per swipe.
3. **Lockup phase (~10 min).** Swipes are frozen. Shared UI streams live oracle ticks, current mark (vibes only — does not affect scoring), and emoji reactions.
4. **Settlement.** DeepBook Predict's oracle resolves each binary to 0 or 1.
5. **Payout.** Scores are computed; the higher score wins the entire side-pot. Tie → lowest total swipe time wins. Still tied → split.

### Scoring (odds-weighted)

```
card_score   = correct ? (1 / p_swiped) × speed_multiplier : 0
player_score = Σ card_score across the 5 cards
```

Where:

- `p_swiped` = implied probability of the swiped side, snapshotted from Predict's SVI surface at the exact moment of the swipe. NO side's `p = 1 − YES probability`.
- `speed_multiplier`:
    - decided in 0–5 s → **1.5×**
    - decided in 5–20 s → **1.0×**
    - decided in 20–60 s → **0.75×**
    - no swipe before timer → **0** (counts as wrong)

**Why odds-weighted:**

- **Rewards skill, not consensus.** A correct call on a 28% underdog is worth ~3× a correct call on an 88% favorite.
- **Mirrors Predict's economics.** `1/p` is what 1 dUSDC of Predict premium pays out on a correct binary; the in-game score reflects this without exposing premium math.
- **Reduces ties.** Different cards have different point values; two "3/5 correct" players rarely land on the same score.
- **Snapshot-at-swipe defeats oracle gaming** — the price the player saw is the price they're scored against.

The speed multiplier and odds weighting affect duel score only. They never change Predict's pricing or the binary's 0/1 settlement.

### Card types

Decks mix:

- **Directional binaries** — "BTC > strike X at expiry T?"
- **Range cards** — "BTC settles in [low, high] at expiry T?"
- **(Post-MVP) Multi-asset** — BTC + ETH + SUI where oracles permit.

All cards in a duel share **one expiry timestamp** — makes the lockup phase coherent and lets a single keeper call settle the whole match.

### AI Deckmaster

A backend agent generates each duel's deck so the cards feel relevant to right-now markets, not a static catalog.

- **Input:** live SVI surface, spot, last-hour realized vol, time-of-day, duel template chosen by the challenger.
- **Output:** 5-card deck balanced for difficulty — e.g., 2 close-to-money (hard), 2 mid-distance (medium), 1 deep-OTM (gimme or trap).
- **Determinism + fairness:** the generator is seeded with the on-chain duel-creation block hash + `duel_id`. Output is reproducible by anyone for audit. Deck is hashed; the hash is committed to the `Duel` object at creation. Plaintext deck is revealed at swipe-phase start.

**Duel templates** (challenger chooses at queue time):

- **BTC Quickie** — 5 BTC binaries, ~10-min expiry, mixed strikes.
- **Mixed Bag** — BTC + ETH + SUI cards (when oracles support).
- **Range Day** — all range cards on BTC.
- **Wild Pack** — Deckmaster's choice across all card types.

### Speed-pressure & sabotage

| Layer | Status | Mechanic |
| --- | --- | --- |
| **Speed multiplier** | MVP | Faster decisions score more per card. Conviction rewarded, hesitation punished. |
| **Sabotage skills** | Post-MVP | Earnable consumables: "Blur" (opponent's next card blurred 3 s), "Distract" (haptic buzz), "Steal Glance" (peek opponent's current pick). Pure UI; never affects on-chain state. |

### Matchmaking

- **Sync-only for MVP** — both players online and in-app at the same time for the 60-second swipe phase. Shared lockup phase = half the product magic; async kills it.
- **Bot-fill on queue timeout** — if no human opponent in ~30 s, a bot with a fixed skill model fills in. Solves hackathon-scale liquidity.
- **Async mode (post-MVP)** — could be added as "Background Duel" if real-user liquidity later proves insufficient. Async opens cheating vectors (the second player sees more market movement) so it's deferred.

### Free tier specifics

Free tier is the **same product** as staked, minus money flow. Players experience the actual core game before being asked to stake. No solo / daily-pick mode in MVP — free PvP *is* the free product.

- **Matchmaking:** simple FIFO queue; bot-fill on timeout so a player never waits more than ~30 s.
- **Stake:** none.
- **Mint:** none. Positions are virtual; settlement reads from the same Predict oracle that scores staked duels.
- **Reward:** winner's win-counter increments by 1.

### Conversion funnel (free → staked)

A free player who taps "Play staked" (or wins N free duels) is shown the **Deposit screen** — their zkLogin Sui address + QR + copy button + a "send dUSDC here from any wallet" callout. No subsidy, no faucet, no in-app on-ramp in MVP. Practice tier (1 dUSDC) is the lowest-friction first stake.

*Optional first-win bonus on the staked side* (e.g., +0.5 dUSDC, paid from rake) may be added post-MVP to reward conversion without subsidizing acquisition.

### Anti-cheat / fairness

| Vector | Mitigation |
| --- | --- |
| Mark manipulation via whale side-trades | Scoring is on **settlement** (0/1), not mark. A whale's side-trade does not move terminal payoff. |
| Peeking at public Predict surface | Allowed and irrelevant — the surface gives mark, not settled outcome. |
| Front-running deck with parallel positions | **Commit-reveal**: deck hash committed at match creation, revealed only at swipe-phase start. |
| Two-account collusion to farm side-pot | MMR queue + zkLogin OAuth binding raises Sybil cost. Stake-locked entry, light proof-of-attention for ranked queue — post-MVP. |
| Bot-driven swiping | Same 60-s pressure for both players; bot edge is small on freshly-revealed deck. Optional human-only ranked queue with proof-of-attention — post-MVP. |

---

## Identity, wallet, money flow

- **zkLogin** (Google / Apple OAuth → Sui address) is the wallet identity. There is no separate in-app balance — the zkLogin address **is** the wallet.
- **Sponsored gas** covers every on-chain action a player takes. The player's zkLogin wallet only ever needs to hold dUSDC for staking — never SUI for gas.
- **Funding the wallet (staked tier only):** Deposit screen surfaces the zkLogin address + QR + copy. Users top up by sending dUSDC from any wallet (Suiet, Sui Wallet, CEX withdrawal). **No faucet, no in-app on-ramp.**

---

## DeepBook Predict integration

Predict is the centerpiece of the chain story. Touchpoints:

1. **`OracleSVI`** — snapshots `p_swiped` at the moment of each swipe for odds-weighted scoring; provides the binary's 0/1 settlement value.
2. **`predict-server` indexer** — backend uses the event stream to detect settlement and to feed the live oracle-tick view during the lockup phase.
3. **(Trading surface — see ADR-001)** — whether Flicky also calls `predict::mint` and `predict::redeem_permissionless` per duel (taking real Predict positions) or uses Predict as oracle-only is **a live architectural decision tracked in the ADR log**. The user-facing game is identical either way.

### Cross-track absorption

Flicky naturally combines three previously-proposed Predict ideas plus the novel PvP layer:

- **#30 Gamified Predict App** — Flicky (both tiers) is the PvP version of this.
- **#21 Settled-Redeem Keeper Network** — Flicky operates one as system infrastructure.
- **#29 Streaks Leaderboard PWA** — natural v1.1 layer once the streak / ladder retention loop ships.

---

## MVP scope (locked)

- 1v1 only; tournaments / brackets deferred.
- BTC-only card pool; broader oracles deferred.
- Free tier + Staked tier; both on the Predict engine (oracle, SVI, indexer).
- zkLogin + sponsored gas — load-bearing, not optional.
- Deposit screen as the only money-in path (no faucet).
- Settled-redeem keeper.
- AI Deckmaster (open-source generator + on-chain seed + commit-reveal; Nautilus TEE attestation deferred).
- Share-card image for virality (friend lists / chat / spectate deferred).
- Sync-only matchmaking with bot-fill (async deferred).
- Sabotage skills, streaks, ladder cosmetics — all deferred.

## Deferred (post-MVP)

PLP rake loop, graduation to direct Predict trading, streaks/ladder/cosmetics, broader-oracle decks (Pyth wide / sports / weather), Nautilus TEE Deckmaster attestation, spectator markets, duel-share NFTs, async matchmaking, sabotage skills, margin tier, cross-asset cards.

---

## Open questions

- **ADR-001 — Tunnel pattern for the swipe phase.** Per-swipe Predict mints vs. tunnel + Predict-as-oracle-only. See ADR log.
- **Sync vs. async matchmaking** beyond MVP — see Matchmaking section.
- **Server key management** for tunnel mode (if ADR-001 accepted) — per-duel keypair vs. long-lived service keypair vs. rotating-with-TEE-attestation.

## Prior art

- **Pulse** (Solana, Cypherpunk) — Tinder-swipe predictions; YES/NO swipe = binary digital strike. Same UX seed, no PvP.
- **Rush** (Solana, Cypherpunk) — 10-sec BTC mobile bets, $500M volume in 1 week. Proves retail demand at this tenor.
- **Kiwi** (Radar) — TG wallet with prediction features.
- **FEEN** (Cypherpunk) — 30-sec vol races with parlays.