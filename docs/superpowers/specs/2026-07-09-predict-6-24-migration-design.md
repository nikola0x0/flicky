# Design: Migrate flicky's DeepBook Predict integration `4-16` → `6-24`

**Date:** 2026-07-09 · **Branch:** `feat/predict-6-24-migration` · **Demo Day:** 2026-07-18
**Status:** Approved design — ready for implementation plan.

Source of truth for `6-24`: `github.com/MystenLabs/deepbookv3` branch `predict-testnet-6-24`,
fetched locally into `temp/deepbookv3` (ref `FETCH_HEAD` / `origin/predict-testnet-6-24`).
Authoritative IDs: `packages/predict/deployment/deployment.testnet.json`.

---

## 1. Context & decision

- flicky today integrates DeepBook Predict **`predict-testnet-4-16`** (`OracleSVI` model, `predict::mint`).
  Its short-dated BTC oracle supply died ~2026-07-07; only long-dated oracles remain, so decks can't
  fast-settle. See `temp/docs/project_oracle_supply.md`.
- DeepBook migrated to **`predict-testnet-6-24`**, which has abundant short-dated markets (cadences
  1m/5m/1h per `deployment.testnet.json` wiring; verify live at implementation time). This is a
  **re-architecture, not a repoint**.
- **Decision gate resolved:** judges will use `6-24` → migration is mandatory.
- **Directive:** full-feature, production-grade migration (both STAKED + FREE tiers, all edge cases).
  Deploy target = testnet (6-24 is testnet-only; its IDs are provisional and will change at mainnet).

## 2. The `4-16` → `6-24` model diff (verified against source)

| | `4-16` (today) | `6-24` (target) | Source (`packages/…`) |
|---|---|---|---|
| Predict package | `0xf5ea2b37…5138` | `0xdb3ef5a5…446e` | deployment.testnet.json |
| Protocol object | `Predict` `0xc8736204…` | `protocol_config::ProtocolConfig` `0x232522…4cb6` | — |
| Market unit | `OracleSVI` (per expiry) | `expiry_market::ExpiryMarket` (shared, per expiry) | predict/sources/expiry_market.move:54 |
| Manager | `PredictManager` | `account::AccountWrapper` (shared, owner-derived) | account/sources/account.move |
| Mint | `predict::mint(&Predict,&Manager,&OracleSVI,key,qty)` | `expiry_market::mint_exact_quantity(...)` (13 args) | expiry_market.move:242 |
| Position shape | `is_up` + single strike | range `(lower_tick, higher_tick]` | expiry_market.move:236 |
| Price quote | `predict::get_trade_amounts` (public) | `pricing::range_price` (**public(package)** — not callable) | pricing.move:96 |
| Settlement read | `&OracleSVI.settlement_price` (public) | `ExpiryMarket.settlement_price` (**public(package)** — not callable) | expiry_market.move:500 |
| Discovery | `registry::OracleCreated` + predict-server | `config_events::MarketCreated` (on-chain scan) | config_events.move:26 |

### 2.1 Deployment IDs (testnet `6-24`)

```
predict pkg          0xdb3ef5a5129920e59c9b2ae25a77eddb48acd0e1c6307b97073f0e076016446e
ProtocolConfig       0x2325224629b4bd96d1f1d7ee937e07f8a06f861018a130bbb26db09cb0394cb6
plp::PoolVault       0xfde98c636eb8a7aba59c3a238cfee6b576b7118d1e5ffa2952876c4b270a3a2a
predict Registry     0x54afbf245caf42466cedb5756ed7816f34f544afdfa13579a862eccf3afa21ca
propbook pkg         0x8eb2adde1c91f8b7c9ba5e9b0a32bfb804510c342939c5f77458fd8143f9755b
propbook OracleRegistry 0xf3deaff68cbd081a35ec21653af6f671d2ad5f012f3b4d817d81752843374136
account pkg          0xb9389eac8d59170ffd1427c1a66e5c8306263464fcc6615e825c1f5b3e15da3b
account_registry::AccountRegistry 0x3c54d5b8b6bca376fc289121838ad02f8a5b3843242b9ad7e8f8245720e685a2
block_scholes_oracle 0x8192932b70d5946217d0f09aad44f84ad5c27ee4c1ca31b09f46200fbd31d3de
pyth_lazer (dep)     0xf5bd2141967507050a91b58de3d95e77c432cd90d1799ee46effc27430a68c21
wormhole (dep)       0xd5afd4e456e5451f1ca1e7b3d734ce7a0a3b397811a6cb72a4bd1dfc387839f2
token/deep (dep)     0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8
dusdc                0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a

BTC feeds (propbook_underlying_id = 1):
  Pyth               0xc78d7de16217d46d21b92ae475da799448be30b71a758dc6d7bb3ac2f1c35afb
  BlockScholes spot  0xcdc5fa7364e60fd2504aa96f65b707dc0734e507a919b1a7d7d63164fd67b745
  BlockScholes fwd   0xe72c734ea8d8dcbc9183d9d8f96f51aaa1fb5034d5ed33ac60d67d261e15b48a
  BlockScholes SVI   0xdc2f8270676bd05fb28491e8d4a41a495722fda7a454926dd66dbba256a21c69
```
All IDs are testnet-provisional (DeepBook: "will change at Mainnet launch"). Keep everything
env-overridable — always resolve from `deployment.testnet.json` at implementation time.

## 3. Invariants: what survives, what changes

### 3.1 SURVIVES — atomic player-signed swipe PTB ✅
The load-bearing invariant holds. An EOA owner obtains an `Auth` and mints directly:
1. `account::generate_auth(ctx)` → `Auth{ kind:OWNER, owner:ctx.sender() }` (account.move:99)
2. `expiry_market::load_live_pricer(market, config, propbook_registry, pyth, bs_spot, bs_fwd, bs_svi, clock)` → `Pricer` (public, expiry_market.move:167)
3. `expiry_market::mint_exact_quantity(...)` → `order_id: u256` (public fun, composable; owner-checked via `assert_owner`, expiry_market.move:242 / account.move:126,344)
4. `flicky::duel::record_swipe(...)` on the shared `Duel`

No app-witness, no keeper-mediated mint. Effective check `owner == account.owner` == old `sender == manager.owner()`.
Also preserved: sponsored gas end-to-end, `Duel` does not hold positions, commit-reveal deck, two-tiers-one-engine.

### 3.2 CHANGES — settlement read & p_swiped snapshot become keeper-attested
DeepBook demoted the two public reads flicky depended on to `public(package)`:
- **Settlement price:** `ExpiryMarket.settlement_price()` and `ensure_settled()` are `public(package)`; `is_settled` is private. No public getter (expiry_market.move:500,509,669). A third-party Move contract holding `&ExpiryMarket` **cannot** read the settled price or force settlement.
- **p_swiped / entry probability:** no public quote; `entry_probability` is emitted only in `order_events::OrderMinted` (order_events.move:16); `mint_exact_quantity` returns only `order_id` — it does not return probability or premium.

**Consequence:** flicky's scoring/settlement moves from "on-chain-verified, permissionless, manipulation-proof"
to **keeper-attested**: an off-chain keeper reads the public `OrderMinted` / `MarketSettled` events and
feeds the values into the contract as arguments. Scoring math itself stays **on-chain and deterministic**.

### 3.3 Trust model: Hybrid, env-toggleable
- **Default `keeper` mode** (ships now, self-sufficient): `settle_card` accepts keeper-fed `settlement_price`
  and per-player `entry_probability` as arguments.
- **`onchain` mode** (later, if DeepBook exposes public getters): add a compatible upgrade
  `settle_card_onchain` that reads on-chain directly — additive entry function, no struct change, does not
  orphan duels. Off-chain selects via `PREDICT_SETTLEMENT_MODE=keeper|onchain`.
- Parallel action: petition DeepBook to make `settlement_price` + a `range_price`/quote getter `public`
  (one-line visibility change on their side).

**Accepted trade-offs (approved):**
- Two dUSDC pools per player: the Predict `Account` balance (funds premiums/fees) is separate from the
  dUSDC stake escrowed in the `Duel` side-pot.
- `record_swipe` no longer snapshots `p_swiped` at swipe time; it stores the returned `order_id`. The keeper
  backfills `entry_probability` at settle time from the `OrderMinted` event.

## 4. Component design

### 4.1 Contract — `apps/contracts/sources/duel.move` (fresh publish)
- Swap imports: `deepbook_predict::{expiry_market, protocol_config, pricing::Pricer}` + `account::{account, account_registry}` for the old `oracle/predict/predict_manager/market_key`.
- `Card { oracle_id, strike }` → `Card { expiry_market_id: ID, lower_tick: u64, higher_tick: u64, tick_size: u64 }`.
  UP/YES = `(K, +∞]` → `lower_tick = K/tick_size, higher_tick = pos_inf_tick`; DOWN/NO = `(−∞, K]` → `lower_tick = 0, higher_tick = K/tick_size`. (`pos_inf_tick = (1<<30)-1`, constants.move:151.)
- `record_swipe`: drop the on-chain `get_trade_amounts` snapshot; store `order_id: u256` + direction + quantity. `Swipe { is_up, quantity, order_id }` (drop `premium`, `p_swiped`).
- `settle_card`: add args `settlement_price: u64`, `p0_entry_probability: u64`, `p1_entry_probability: u64` (keeper-fed); keep on-chain scoring (`1/p_swiped × speed_multiplier`), accumulation, `CardSettled` event. Reserve name `settle_card_onchain` for the future additive read path.
- Anti-replay: `account::has_position(account, expiry_market_id, order_id)` (predict_account.move:78) replaces `PredictManager.position(key) >= quantity`.
- Keep all lifecycle/edge paths: FREE tier (`*_free`), refund/forfeit/reveal-timeout, `finalize`, deck-size 1–20.
- Fresh publish → new package id → orphans existing `Duel` objects (unavoidable: struct + signature changes).

### 4.2 Stub packages — `apps/contracts/`
Replace `deepbook_predict_min/` with link-only stubs mirroring 6-24 ABIs:
`predict_min` (expiry_market, protocol_config, pricing::Pricer), `propbook_min` (registry/OracleRegistry),
`account_min` (account, account_registry, AccountWrapper, Auth), `block_scholes_oracle_min` (feed types).
Signatures only; bodies tree-shaken; on-chain dispatch hits the real published packages.

### 4.3 Codegen
Regenerate `apps/web/src/sui/gen/deepbook_predict/` from `0xdb3ef5a…`, add `gen/account/` + `gen/propbook/`,
and regenerate `gen/flicky/` from the redeployed flicky package.

### 4.4 Account onboarding (new)
Players need a shared `AccountWrapper` + dUSDC in the Predict account before a STAKED swipe. Lazy setup:
before a player's first staked swipe, if `account_registry::derived_wrapper_exists(registry, owner)` is
false (account_registry.move:73), prepend `account_registry::new` → `account::share` → `account::deposit_funds<DUSDC>`
(sponsored). Deposit ≥ the deck's projected total premium. Lookup is deterministic via
`derived_wrapper_address(registry, owner)` (account_registry.move:63) — no event scan needed.
FREE tier needs no account (no mint).

### 4.5 Server — `apps/server/src`
- `deckmaster.ts`: discovery → scan `config_events::MarketCreated`, filter `propbook_underlying_id == 1`, keep `clock < expiry`, prune via `MarketSettled` / `ExpiryMarketMintPausedUpdated`. `buildStakedSwipeTx` → new PTB (auth → load_live_pricer → mint_exact_quantity → record_swipe). Strike selection maps to tick ranges (amplitude + sign-balance) using `tick_size`/`admission_tick_size` from `MarketCreated`.
- `keeper.ts`: read `OrderMinted` (entry_probability by order_id/owner) + `MarketSettled` (settlement_price); build settle PTB feeding those values; redeem via `expiry_market::redeem_settled` (expiry_market.move:387).
- `oracle.ts` / `indexer.ts` / `ws/oracle-stream.ts` / `ws/protocol.ts`: new event types + feed objects.
- `env.ts`: add all §2.1 IDs + `PREDICT_SETTLEMENT_MODE` (default `keeper`).

### 4.6 Web — `apps/web/src`
- `lib/deepbook.ts`: new mint PTB, tick-range helpers, pricer load, account create/deposit.
- `lib/flicky.ts`: `fetchOracleSvi` → read `ExpiryMarket`; strike↔tick; settle path per mode.
- `lib/config.ts`, `lib/protocol.ts`, `App.tsx`: new IDs + account-onboarding UI.

### 4.7 Config/env
All §2.1 IDs via env (deployment-agnostic pattern preserved): add `PoolVault`, predict `Registry`,
`AccountRegistry`, BTC feed objects, and `PREDICT_SETTLEMENT_MODE` across `apps/server/src/env.ts`,
`apps/web/src/lib/config.ts`, and the `FLICKY_PACKAGE_*` / `VITE_*` vars.

## 5. Sponsored-gas allowlist additions
Player-signed PTBs now call, in addition to `flicky::duel::*`:
`account::account_registry::new`, `account::account::share`, `account::account::deposit_funds`,
`account::account::generate_auth`, `deepbook_predict::expiry_market::load_live_pricer`,
`deepbook_predict::expiry_market::mint_exact_quantity`. Keeper-signed: settle/finalize + `redeem_settled`.

## 6. Sequencing (dependency order)
1. Stub packages (4.2) → 2. `duel.move` rewrite (4.1) + Move tests → 3. publish → 4. codegen (4.3) →
5. env/config (4.7) → 6. server (4.5) → 7. web + onboarding (4.4, 4.6) → 8. discovery validation →
9. E2E on testnet.

## 7. Testing & verification
- Move: port the 30-test suite to the 6-24 model (mock `ExpiryMarket` + account stubs); cover keeper-fed settle, anti-replay via `has_position`, range-tick UP/DOWN scoring, free tier, edge paths.
- Server: unit tests for `MarketCreated` discovery, PTB builders, keeper event→settle mapping.
- `bun typecheck` + `bun --filter server test` green.
- Discovery returns ≥3 live short-dated BTC markets.
- **E2E on testnet**: create → join → reveal → **atomic sponsored swipe mints a real 6-24 position** →
  lockup → settle → payout, all inside a 5-minute demo window.

## 8. Risks & open items
- **6-24 IDs are provisional** — re-verify from `deployment.testnet.json` before each deploy.
- **Live cadence** — deployment wiring shows 1m/5m/1h; task doc observed 3m/15m. Confirm live short markets exist before relying on the 5-min E2E.
- **Premium funding** — projecting deck premium for the onboarding deposit needs a quote; without a public quote getter, estimate off-chain from the SVI feed (over-deposit margin acceptable).
- **DeepBook getter ask** — `onchain` mode is inert until DeepBook exposes public getters; `keeper` mode must be fully sufficient on its own.
- **Fresh publish orphans duels** — communicate; no in-flight duels should straddle the cutover.

## 9. Out of scope
- Mainnet deployment (6-24 is testnet-only).
- Self-hosting oracles (rejected — Predict integration is the product point).
- Multi-asset (BTC is the only underlying on the registry).
