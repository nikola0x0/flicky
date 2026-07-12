# Flicky × DeepBook Predict **6-24** — Migration & Update Report

**Date:** 2026-07-11
**Branch:** `feat/predict-6-24-migration`
**Scope:** Migrating Flicky from DeepBook Predict `predict-testnet-4-16` → `predict-testnet-6-24`, plus the gameplay/economics tuning done on top of it.

---

## 0. TL;DR

- DeepBook Predict re-architected from `4-16` → `6-24`: **`PredictManager` → `AccountWrapper`**, **`predict::mint` → `expiry_market::mint_exact_quantity`**, no public on-chain quote, keeper-attested settlement. Flicky's whole swipe/mint/settle path was rewritten to match.
- Each **swipe = a real 6-24 mint** (proven live on testnet). The duel **stake** is the prize pool; the mint is a small position for scoring.
- Gameplay tuning this session: **probability-targeted strikes (`svi_quote`)** so the live PnL visibly drifts, a **mint-admissibility probe** to dodge volatile LP-backing, **per-side win-odds** on the YES/NO buttons, **account-funded stake**, and the **position cost minimized** to `SWIPE_QUANTITY = 2 dUSDC`.
- **How to run:** `docker` Postgres + `bun dev`, with `apps/server/.env.local` holding the keys and `DECK_STRIKE_MODE=svi_quote`. Full steps in §5.

---

## 1. Why the migration was mandatory

The judges / upstream run on `predict-testnet-6-24`. `6-24` is **not a re-point of `4-16`** — it is a different object model, event set, and mint/settlement flow. A rebuild (not a config swap) was required. Design source of truth: `README.md` + `docs/superpowers/specs/2026-07-09-predict-6-24-migration-design.md`.

---

## 2. What changed on-chain: `4-16` → `6-24`

| Concern | 4-16 (old) | 6-24 (new) |
|---|---|---|
| Player account object | `PredictManager` (per player) | **`account::AccountWrapper`** (per player, deterministic address from `(AccountRegistry, owner)`) |
| Market object | single predict pool | **`expiry_market::ExpiryMarket`** — one per (underlying, expiry), each with its own strike/admission grid |
| Take a position | `predict::mint` | **`expiry_market::mint_exact_quantity(...)`** → returns a `u256` order id |
| Price a mint | `predict::get_trade_amounts` (public quote) | **`expiry_market::load_live_pricer(...)`** — no public quote/probability read (`public(package)`) |
| Deposit / withdraw | manager methods | `account::deposit_funds` / `account::withdraw_funds` / `account::withdraw_balance` (mint-internal) |
| Position read | positions on manager | `predict_account::has_position`, cashflow via indexer |
| Redeem settled | generic | **`expiry_market::redeem_settled` (NON-generic)** — passing type args aborts |
| Auth | manager owner | `account::generate_auth` (authorizes `ctx.sender()`) |
| Settlement / entry-probability | readable | **`settlement_price` + `entry_probability` are `public(package)`** → keeper must attest them off-chain |

**Load-bearing invariants (unchanged, from README):**

- **Player-signed atomic swipe PTB.** Each swipe is one PTB: `account::generate_auth` → `expiry_market::load_live_pricer` → `expiry_market::mint_exact_quantity` (returns `order_id`) → `duel::record_swipe(order_id)`. Forced by Predict's `sender == owner` invariant — the mint can't be routed through the keeper.
- **`Duel` shared object does NOT hold Predict positions.** Each player owns their `AccountWrapper`; the `Duel` escrows the dUSDC side-pot (the prize) and records swipes.
- **Sponsored gas end-to-end.** The zkLogin wallet only ever holds dUSDC; every player PTB (create/join/swipe/settle) is sponsored (Enoki, with a self-sponsor fallback).
- **Commit-reveal deck.** Cards are hashed at duel creation, revealed at match start.

---

## 3. New packages & objects (the "updated packages")

### 3.1 On-chain Move packages / shared objects (testnet `6-24`)

> All are **`??` env fallbacks** — override per environment with the env var in the last column. Source: `apps/server/src/env.ts`, `apps/web/src/lib/config.ts`.

| Name | Object / Package ID | Env override |
|---|---|---|
| **Flicky package** (this repo's `duel.move`, published 2026-07-09) | `0x6c6be7201465b165c82e717b75074060208495118dbda5afb19471be89d3cbfb` | `FLICKY_PACKAGE_ID` (server) / `VITE_FLICKY_PACKAGE_ID_TESTNET` (web) |
| DeepBook **Predict package** | `0xdb3ef5a5129920e59c9b2ae25a77eddb48acd0e1c6307b97073f0e076016446e` | `DEEPBOOK_PREDICT_PACKAGE_ID` |
| DeepBook **Account package** | `0xb9389eac8d59170ffd1427c1a66e5c8306263464fcc6615e825c1f5b3e15da3b` | `ACCOUNT_PACKAGE_ID` |
| Predict **ProtocolConfig** | `0x2325224629b4bd96d1f1d7ee937e07f8a06f861018a130bbb26db09cb0394cb6` | `PROTOCOL_CONFIG_ID` |
| Predict **PoolVault** | `0xfde98c636eb8a7aba59c3a238cfee6b576b7118d1e5ffa2952876c4b270a3a2a` | `POOL_VAULT_ID` |
| Predict **Registry** | `0x54afbf245caf42466cedb5756ed7816f34f544afdfa13579a862eccf3afa21ca` | `PREDICT_REGISTRY_ID` |
| **AccountRegistry** | `0x3c54d5b8b6bca376fc289121838ad02f8a5b3843242b9ad7e8f8245720e685a2` | `ACCOUNT_REGISTRY_ID` |
| **OracleRegistry** | `0xf3deaff68cbd081a35ec21653af6f671d2ad5f012f3b4d817d81752843374136` | `ORACLE_REGISTRY_ID` |
| BTC **Pyth feed** | `0xc78d7de16217d46d21b92ae475da799448be30b71a758dc6d7bb3ac2f1c35afb` | `BTC_PYTH_FEED_ID` |
| BTC **BlockScholes Spot feed** | `0xcdc5fa7364e60fd2504aa96f65b707dc0734e507a919b1a7d7d63164fd67b745` | `BTC_BS_SPOT_FEED_ID` |
| BTC **BlockScholes Forward feed** | `0xe72c734ea8d8dcbc9183d9d8f96f51aaa1fb5034d5ed33ac60d67d261e15b48a` | `BTC_BS_FWD_FEED_ID` |
| BTC **BlockScholes SVI feed** | `0xdc2f8270676bd05fb28491e8d4a41a495722fda7a454926dd66dbba256a21c69` | `BTC_BS_SVI_FEED_ID` |
| **AccumulatorRoot** | `0xacc` | `ACCUMULATOR_ROOT_ID` |
| **Clock** | `0x6` | — |
| **dUSDC coin type** | `0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC` | — |

**Indexers (off-chain reads):**

| Purpose | URL | Env override |
|---|---|---|
| Predict markets (`GET /markets?limit=500`, `/markets/{id}/state`, `/positions/.../cashflow`) | `https://predict-server-beta.testnet.mystenlabs.com` | `PREDICT_INDEXER_URL` |
| Propbook / BTC spot (`/oracles/{pythFeedId}/pyth/latest` → `normalized_spot`) | `https://propbook.api.testnet.mystenlabs.com` | `PROPBOOK_INDEXER_URL` |

### 3.2 TypeScript codegen (regenerated bindings)

Regenerated Sui bindings under `apps/web/src/sui/gen/`:

- **New:** `account/account.ts`, `deepbook_predict/predict_account.ts` (6-24 `AccountWrapper` / positions).
- **Rewritten:** `flicky/duel.ts` (new `create_duel(stake, deck_hash, deck_size)`, `record_swipe(order_id)`, `settle_card(...)`, `finalize_*`).
- **Removed (4-16 only):** `deepbook_predict/{predict,predict_manager,oracle,market_key,range_key,i64}.ts`, old `swap` bindings.

### 3.3 npm dependencies (no bump required for 6-24)

The 6-24 work runs on the existing pinned versions — no dependency upgrade was needed:

| Package | Version |
|---|---|
| `@mysten/sui` | `2.20.2` |
| `@mysten/dapp-kit-react` | `2.1.6` |
| `@mysten/enoki` | `1.2.2` |
| Bun (runtime + PM) | `1.3.9` |

Server uses `@mysten/sui/grpc` (`SuiGrpcClient`) + `@mysten/sui/graphql`; web uses `ClientWithCoreApi` (`client.core.*`).

---

## 4. Changes made this session (on top of the migration)

### 4.1 Economics / money flow

- **Stake funded from the account** (`apps/web/src/lib/flicky.ts`): `create_duel` / `join_duel` withdraw the stake from the player's `AccountWrapper` via `account::withdraw_funds` (not from the wallet). Single funding source: the account pays both the stake **and** the mint premiums. Keeps the zkLogin wallet dUSDC-only.
- **`SWIPE_QUANTITY = 2_000_000` (2 dUSDC)** (`apps/web/src/components/onboarding-modal.tsx`): the **practical minimum**. The mint's `net_premium = P × quantity` must clear the protocol `min_net_premium` floor ($1). At 1 dUSDC notional an ATM swipe is ~$0.5 (aborts, code 4); 2 dUSDC gives ~$1.1–1.3 on the favored side. Keeps the **position cheap so the stake pool is the dominant money** (design intent). A 5-card duel draws ~$5–6 of premium total.
- **Deck size kept at 5** (`resolveDeckBounds` default `[3, 5]`).

### 4.2 Strike placement — `svi_quote` (dramatic PnL)

`apps/server/src/deckmaster.ts`, env `DECK_STRIKE_MODE=svi_quote`:

- Places each card's strike at a **target win-probability** per difficulty zone (`ZONE_TARGET_PROB` = close `0.56` / mid `0.61` / edge `0.65`) via an inverse Black-Scholes digital, using the **same vol (`SVI_VOL = 0.6`) as the web's `markCardPnl`** so the placement and the live PnL agree.
- Why: testnet BTC spot is nearly frozen, so a flat ATM deck shows PnL ≈ $0. An offset strike makes the PnL **drift continuously toward ±quantity via time-decay** as the card nears settlement (e.g. $0.7 → $2.9), independent of spot movement.
- The old `price_offset` mode (fixed near-ATM bps) is still available as the env fallback (flat PnL).

### 4.3 Mint-admissibility probe (LP-backing defense)

`apps/server/src/mint-probe.ts` (new), env `DECK_PROBE_MINTABLE=true`:

- 6-24 markets gate each mint on a **volatile per-market LP cash reserve** (`expiry_cash::assert_backing`, `EInsufficientCash`, code 0) that flips within seconds and the indexer exposes no field for.
- `filterMintableMarkets` devInspect-probes an ATM mint on each candidate market (via the sponsor's funded wrapper — no gas) and drops the currently-unbacked ones.
- `buildProbedDeck` probes each card's **favored** direction; if it can't mint it falls the card back to ATM. **Only the favored side is required** — demanding both directions would force short-expiry cards back to ATM (flat PnL), since the unfavored long-shot's premium dips under the floor on short markets.
- Internal **deck-gen retry** (`matchmaking.ts`, 4×2 s) absorbs transient 0-backed windows before surfacing a match-setup failure.

### 4.4 Web UX

- **Per-side win odds** on the YES/NO chips (`active-duel.tsx` + `pnl.ts` `upProbability`): e.g. `YES 64% / NO 36%`, drifting toward 0/100% as the card ages. Shows which side is the favored (placeable) call vs the long-shot.
- **Pre-swipe balance check**: if the account can't cover the next premium (`< 0.7 × SWIPE_QUANTITY`), prompt a top-up **before** the on-chain abort instead of the opaque `account::withdraw_balance` error.
- **Friendly abort messages**: `withdraw_balance`/code 1 → "top up your account"; `assert_mint_admission`/code 4 → "that long-shot side is too unlikely to place — swipe the other way".
- **Dynamic deck size**: removed all hardcoded `5` in the swipe/settle/reveal flow (`active-duel.tsx`, `App.tsx`, `flicky.ts` `buildRevealDeckTx` now accepts `[1, 20]`) — reads `cardCount`/`deckSize` instead.

### 4.5 Sponsored gas resilience

`apps/server/src/sponsor.ts`, `apps/web/src/lib/sponsor.ts`:

- **Self-sponsor fallback** when Enoki fails/unconfigured (circuit breaker, 60 s), preserving the wallet-holds-only-dUSDC invariant. Self-sponsor enforces the same MoveCall allowlist; Sui framework packages (`0x1`/`0x2`/`0x3`) are allowed for coin plumbing.
- Web `executeSponsored` sets `tx.setSender(...)` before the `onlyTransactionKind` build (needed for `coinWithBalance` coin resolution).

### 4.6 Verification status

- Whole monorepo **typechecks** (5/5). **Server tests** 125 pass / 0 fail; **web tests** 35 pass / 0 fail.
- **Real 6-24 mints proven live on testnet** (atomic `mint_exact_quantity` → `record_swipe`, both players, both directions) — see `docs/superpowers/specs/2026-07-10-6-24-e2e-results.md`.

---

## 5. How to run the new version (local, production-like)

### 5.1 Prerequisites

- **Bun ≥ 1.3** (repo pins `1.3.9`). Never `npm`/`pnpm`/`yarn`.
- **Docker** (for local Postgres).
- A funded testnet key (SUI for gas + dUSDC) for the sponsor/keeper.

### 5.2 Boot Postgres

```bash
docker run -d --name flicky-pg \
  -e POSTGRES_USER=flicky -e POSTGRES_PASSWORD=flicky -e POSTGRES_DB=flicky \
  -p 5433:5432 postgres:16
```

### 5.3 Configure `apps/server/.env.local` (gitignored)

```bash
DATABASE_URL=postgres://flicky:flicky@localhost:5433/flicky
ALLOWED_ORIGIN=http://localhost:5173
SUI_NETWORK=testnet

# Sponsored gas (Enoki). Empty => /sponsor 503 => web falls back to wallet-paid gas.
ENOKI_PRIVATE_KEY=enoki_private_...

# Keeper hot key (auto settle/finalize/redeem). Empty => keeper disabled.
KEEPER_SECRET_KEY=suiprivkey1...

# Self-sponsor fallback gas key (needs SUI). Also the mint-probe's funded wrapper owner.
SPONSOR_SECRET_KEY=suiprivkey1...

# Strike placement — "svi_quote" = dramatic drifting PnL; "price_offset" = flat near-ATM.
DECK_STRIKE_MODE=svi_quote
```

The 6-24 object IDs in §3.1 are baked in as defaults; only override them (via the env vars in that table) if the upstream redeploys.

> Web env (`apps/web/.env.local`) is optional — the 6-24 IDs are `VITE_`-overridable fallbacks in `apps/web/src/lib/config.ts`. Set `VITE_SPONSOR_URL` / `VITE_SERVER_WS_URL` only if the server isn't on `localhost:3001`.

### 5.4 Install & run

```bash
bun install
bun dev                       # turbo: web (:5173) + server (:3001) in parallel
# or individually:
bun --filter server dev       # bun --hot
bun --filter web dev          # vite
```

**Important — env vs hot-reload:** `bun --hot` reloads **code** on save but **not env**. After changing any `.env.local` value (e.g. `DECK_STRIKE_MODE`), **restart** `bun --filter server dev`.

### 5.5 Quality gates

```bash
bun typecheck                 # tsc --noEmit per workspace
bun lint                      # eslint per workspace
bun --filter server test      # bun:test
bun --filter web test
```

### 5.6 Playing a duel (2 tabs)

1. Sign in on two browser profiles (zkLogin). Each gets an `AccountWrapper`.
2. **Deposit dUSDC into the account** (the account funds stake + premiums). Budget: `stake + 5 × ~$1.1` — e.g. ~$8–11 for a full 5-card duel; start with a low tier for cheap testing.
3. Queue on the same tier in both tabs → they pair → the server generates + commits the deck → create/join/reveal → swipe.
4. Each swipe mints a real 6-24 position (sponsored). Play **promptly** — short markets expire in ~10–15 min.

### 5.7 Diagnostics

```bash
# 6-24 deploy-gate health (config objects + a live pricer devInspect)
bun --filter server run check:6-24

# account/wrapper balance for an address
curl "http://localhost:3001/manager?owner=0x<addr>"

# live BTC markets (filter propbook_underlying_id==1, expiry>now)
curl "https://predict-server-beta.testnet.mystenlabs.com/markets?limit=500"
```

---

## 6. Known constraints & gotchas (6-24 realities, not bugs)

1. **`min_net_premium` floor ($1/swipe).** Every mint costs ≥ $1, so a 5-card duel costs ≥ $5 in premiums. The position can't be free while minting real 6-24 positions. `SWIPE_QUANTITY = 2` is the practical minimum.
2. **Volatile per-market LP backing** (`EInsufficientCash`). Testnet markets flip backed↔unbacked within seconds and expose no readable backing field. Defended by the mint probe + deck-gen retry, but a match can still say "trouble setting up — retrying" during an extended dip.
3. **Testnet BTC spot is nearly frozen.** Live PnL relies on `svi_quote`'s time-decay drift to move, not on spot ticks.
4. **Long-shot side unplaceable on short markets.** With offset strikes, the unfavored side's premium is below the $1 floor on short-expiry markets → the player is told to swipe the favored side (the higher-% call). Only the favored side is guaranteed mintable.
5. **`redeem_settled` is NON-generic** — passing type arguments aborts.
6. **Stale `FLICKY_PACKAGE_ID` override** in any `apps/server/.env*` (a pre-6-24 "flicky oracle" package) causes `ArityMismatch` on `create_duel`. Leave it unset to fall back to `apps/contracts/deployed.json`.

---

## 7. File map (changed this branch)

- `apps/contracts/sources/duel.move` — 6-24 `Duel`/`Card`/`Swipe`, `record_swipe(order_id)`, `settle_card(...)`, `finalize_*`.
- `apps/server/src/` — `predict.ts` (wrapper/balance), `sponsor.ts` (Enoki + self-sponsor), `keeper.ts` (6-24 settle/redeem), `deckmaster.ts` (discovery + `svi_quote`), **`mint-probe.ts` (new)**, `ws/{matchmaking,practice,handlers}.ts`, `env.ts`.
- `apps/web/src/` — `lib/{flicky,deepbook,config,sponsor,pnl}.ts`, `routes/game/{active-duel,duel-view,play}.tsx`, `components/onboarding-modal.tsx`, `sui/gen/**` (codegen).
- `docs/superpowers/` — the 4 migration plans + specs + `2026-07-10-6-24-e2e-results.md`.

---

## 8. Outstanding issues & backlog (NOT yet resolved)

Honest list of the problems still open, grouped by area. Severity: **P1** = blocks a smooth game, **P2** = degrades UX, **P3** = polish.

### 8.1 Find match / matchmaking

| # | Issue | Root cause | Current mitigation | Proposed fix | Sev |
|---|---|---|---|---|---|
| M1 | **"Trouble setting up the match" loops** during LP-backing dips | The mint probe drops all live markets when every candidate is momentarily unbacked (`EInsufficientCash`); backing flips within seconds and the pool is only 1–2 short markets | Internal deck-gen retry (4×2 s) + 15 s outer requeue | (a) Widen the candidate pool by also pulling **longer-cadence markets** (better-backed) into `findDeckMarkets`; (b) exponential retry with a user-visible "markets thin, still trying" state; (c) cache the last-known-backed market set for a few seconds | **P1** |
| M2 | **WebSocket churn** — console shows `ws:<URL>/ws failed` / "closed before established" and a placeholder `<URL>` | The WS url is unresolved in some render paths (env/config fallback) and the socket reconnect thrashes on transient failures | Auto-reconnect via `onclose` | Fix the `ws:<URL>` placeholder (ensure `VITE_SERVER_WS_URL`/config always resolves), add backoff + a single connection owner, surface a clean "reconnecting" chip | **P2** |
| M3 | **Sync-only PvP needs two humans on the same tier at once** | No bot fallback in the real queue (Practice is separate) | Players wait in queue | Optional: a timed bot fallback, or cross-tier matching within a stake band | **P3** |
| M4 | Match can be announced then fail at deck-gen after the pair is popped | Backing can die between preflight and deck-gen | requeue both + retry | Move the mintable-market probe into the **preflight** so a pair is only formed when a deck is buildable | **P2** |

### 8.2 Swipe errors

| # | Issue | Root cause | Current mitigation | Proposed fix | Sev |
|---|---|---|---|---|---|
| S1 | **Long-shot side unplaceable** on short markets (`assert_mint_admission`, code 4) | With offset strikes, the unfavored side's premium `(1-p)×qty` is below the `$1` floor on short-expiry markets | Only the favored side is guaranteed mintable; friendly message + per-side win-% on the buttons | Proactively **dim/disable** the long-shot button on short cards (client already knows the odds); or raise `SWIPE_QUANTITY` on short-expiry cards so both sides clear the floor | **P2** |
| S2 | **Card's market can expire mid-match** → `pricing::load_live_pricer` abort (code 9) | Short markets (10–15 min) can expire during a slow match / stale duel | 10-min headroom filter | Bias deck to markets whose expiry comfortably exceeds the 10-min swipe window + finalize lag; warn if a card is about to expire | **P2** |
| S3 | **LP backing can flip AFTER the deck-gen probe** | A card that probed OK at match start can be unbacked by swipe time (backing is volatile over the 10-min window) | deck-gen probe reduces but can't eliminate | Catch code 0 at swipe time with a "market backing dropped — retry / skip card" flow; optional client-side re-probe just before minting | **P2** |
| S4 | **Account drains mid-game** → `account::withdraw_balance` abort (code 1) | Account funds stake + every premium (single pool, option B); the `5 dUSDC` gate < a full game's cost | Pre-swipe balance check + friendly top-up prompt | Raise the queue gate to `stake + deckSize × premium` estimate, or an in-match top-up CTA | **P2** |

### 8.3 Premium (card cost) too high

| # | Issue | Root cause | Current mitigation | Proposed fix | Sev |
|---|---|---|---|---|---|
| P1 | **Each swipe costs ≥ $1** (5-card duel ≥ $5 in premiums) | Protocol `min_net_premium = $1` hard floor — the smallest real 6-24 mint costs ~$1 | `SWIPE_QUANTITY` set to the practical minimum (2 dUSDC) | Cannot go lower while minting real positions. **Design fork:** either (A) keep small mints + raise the stake so the pool dominates, or (B) stop minting real positions and keeper-attest `p_swiped` off-chain (positions become free) — a contract/scoring rework. **Chosen: A.** | **P1** |
| P2 | **Favored side is the expensive one, and it gets more expensive near expiry** | Premium `= P × qty`; favored `P` is high and drifts toward 1 via time-decay, so a late favored swipe can cost ~$3 | Per-side win-% shown so the cost is legible before swiping | Show the estimated **premium in dUSDC** on each button (not just %); optionally cap by swiping earlier | **P3** |
| P3 | **Stake pool does not always dominate the position** | At `starter` (stake 1 → pool 2) the ~$5–6 position exceeds the pool, inverting the intended "stake is the game" design | Tiers `standard`(5)/`high_roller`(10) make the pool dominate | Decide the stake-tier policy (raise `starter`, or label it a "position-heavy" low-stakes tier) — **open decision** | **P2** |

### 8.4 Too few markets vs. cards

| # | Issue | Root cause | Current mitigation | Proposed fix | Sev |
|---|---|---|---|---|---|
| K1 | **Deck is 5 cards but often only 1–2 live BTC markets** clear the headroom | Upstream testnet market supply is thin; short-cadence markets dominate and are volatile | Multi-card-per-market: round-robin `deckSize` cards across whatever markets are live, with distinct strikes per market | (a) Pull more markets (raise the indexer `limit`, include longer-cadence tiers); (b) accept fewer distinct markets as by-design | **P2** |
| K2 | **Duplicate / near-identical cards** when many cards land on one market | With 1 market + ATM fallback, several cards can collapse to the same (market, strike) → identical cards, dull deck | Dedup nudges strikes by admission cells; harmless duplicates allowed | Spread strikes across a wider probability ladder on the same market; only fall back to ATM as a last resort | **P3** |
| K3 | **Trade-off: short markets (many, volatile, expire fast) vs long markets (few, well-backed, slow settle)** | 6-24 market cadence is upstream | headroom filter picks nearest-eligible | Tune market selection to prefer the **well-backed middle band** (e.g. 30–120 min) over the flakiest 10–15 min markets, balancing snappiness vs reliability | **P2** |

### 8.5 Suggested priority order

1. **M1 + K1/K3** — market pool: pull longer-cadence/better-backed markets so matches form reliably and decks are less degenerate. (Biggest UX win.)
2. **S3 + S2** — graceful swipe-time handling of backing-drop / near-expiry so a live match doesn't dead-end.
3. **P3 (stake tiers) + S4 (gate)** — settle the stake-vs-position economics + fund-enough gate.
4. **S1 (dim long-shot) + P2 (show $ premium) + M2 (WS)** — polish.
