# When the DeepBook Predict pin moves

Flicky is pinned to a specific DeepBook Predict deployment. **That pin has
already moved twice** — `predict-testnet-4-16` → `predict-testnet-6-24` → the
6-24 testnet going dark on 2026-08-17. Assume it will move again, and that the
next revival is a *new* version rather than 6-24 coming back.

This is the checklist for that day. Everything is env-driven
(`apps/server/src/network-env.ts`), so a pin move should be configuration plus
an ABI check — never a rewrite.

## First: do not trust the docs

As of 2026-08-30 the official pages
(`docs.sui.io/onchain-finance/deepbook/deepbook-predict/*`) still document
**4-16**, and:

- 4-16 has **zero events, ever** on testnet — `PositionMinted`,
  `OracleSettled`, `OracleSVIUpdated` all empty. It was never really used.
- Every HTTP endpoint they list is gone: `predict-server.testnet.mystenlabs.com`
  and `predict-server-beta.testnet.mystenlabs.com` are both NXDOMAIN, as is
  `propbook.api.testnet.mystenlabs.com`.
- They confirm there is **no mainnet deployment**.

So the docs describe a deployment that was never live, reachable through a host
that no longer exists. Verify against the chain, not the docs.

## Step 1 — find out what is actually live

```bash
bun --filter server check:sources
```

It prints the resolved package ids next to what is actually emitting events,
and exits non-zero when no deck can be built. Three shapes to read:

| Output | Meaning |
|---|---|
| `MarketCreated … (2m ago)` + `still live: N>0` | Healthy. Nothing to do. |
| `MarketCreated … (12d ago)` + `still live: 0` | Right pin, upstream is dark. Wait. |
| `MarketCreated  NO EVENTS EVER` | **Wrong pin.** Continue below. |

`NO EVENTS EVER` against a package that exists on chain is the signature of a
moved pin — it's exactly what 4-16 reports today.

## Step 2 — find the new deployment

The package id is not discoverable from our side. Sources, in order of
reliability:

1. The DeepBookV3 repo's branch list (`predict-testnet-*`) and its
   `packages/predict` published-at addresses.
2. Any `Published.toml` / release notes on the new branch.
3. Ask in Sui developer channels. The pin has moved without announcement
   before.

Confirm a candidate before adopting it:

```bash
# Does it emit MarketCreated, and recently?
#   type = <NEW_PKG>::config_events::MarketCreated
# Sui GraphQL caps page size at 50 — a larger `last:` returns null, NOT an
# error, which reads as "no events". Never page above 50.
```

## Step 3 — set the env

Only these change. All are read through `pick()` in `network-env.ts`, which
accepts the bare name (testnet) or a `_MAINNET` suffix, and **never** falls a
mainnet key back to a testnet value.

| Var | What it is |
|---|---|
| `DEEPBOOK_PREDICT_PACKAGE_ID` | the new Predict package |
| `DEEPBOOK_PREDICT_OBJECT_ID` | its shared Predict object, if the new version still has one |
| `PROTOCOL_CONFIG_ID`, `POOL_VAULT_ID`, `PREDICT_REGISTRY_ID` | shared objects |
| `ACCOUNT_PACKAGE_ID`, `ACCOUNT_REGISTRY_ID` | account/wrapper model |
| `ORACLE_REGISTRY_ID`, `BTC_PYTH_FEED_ID`, `BTC_BS_*_FEED_ID` | oracle wiring |
| `ACCUMULATOR_ROOT_ID` | usually `0xacc` |
| `DUSDC_COIN_TYPE` | quote asset — check it didn't change |

Set them on the `flicky-server` Railway service. Use `--skip-deploys` to stage
without restarting production mid-duel:

```bash
railway variables set DEEPBOOK_PREDICT_PACKAGE_ID=0x… \
  --service flicky-server --skip-deploys
```

Web equivalents (`VITE_DEEPBOOK_*`) live in `apps/web/.env.production`.

## Step 4 — check for ABI drift

Config alone is enough only if the ABI is unchanged. The 4-16 → 6-24 move was
**not** config-only: it replaced `OracleSVI` with `ExpiryMarket`, `predict::mint`
with `expiry_market::mint_exact_quantity`, and dropped
`predict::get_trade_amounts` entirely.

Check each of these against the new package:

- **Event types** (`indexer.ts`) — `config_events::MarketCreated`,
  `config_events::MarketSettled`, `order_events::OrderMinted`, and the field
  names read from each. `drainMarketCreated` needs `expiry_market_id`,
  `expiry`, `tick_size`, `admission_tick_size`.
- **`ExpiryMarket` fields** (`keeper.ts::readMarketSettlement`) — we read
  `settlement_price` off the object, and rely on it being **null** (not 0)
  before settlement. Re-verify that on a live and a settled market.
- **Sponsor allowlist** (`sponsor.ts::DEEPBOOK_PREDICT_FNS`) —
  `expiry_market::{load_live_pricer, mint_exact_quantity, mint_exact_amount,
  redeem_live}` and `ACCOUNT_FNS`. A renamed function silently un-sponsors
  that call.
- **Mint PTB shape** (`apps/web/src/lib/deepbook.ts`, `mint-probe.ts`) —
  argument order and types.
- **Keeper redeem** (`keeper.ts`) — `expiry_market::redeem_settled` args.

## Step 5 — verify before trusting

```bash
bun --filter server check:sources   # must exit 0
bun typecheck && bun --filter server test
```

Then a real free-tier duel end to end before re-enabling staked.

## What does NOT need to change

Deliberately, because these no longer depend on Predict's off-chain services:

- **Settlement price** — read off the `ExpiryMarket` object
  (`keeper.ts::readMarketSettlement`). No indexer.
- **Premium** — from `OrderMinted` events via the `order_premiums` mirror
  (`keeper.ts::readOrderPremium`). No indexer.
- **Market discovery** — from `MarketCreated` events via the `predict_market`
  mirror (`deckmaster.ts::indexedMarketRows`). No indexer.

`PREDICT_INDEXER_URL` and `PROPBOOK_INDEXER_URL` remain as optional overrides
only. If a new HTTP indexer appears, it is a convenience, not a dependency —
keep it that way. That is the whole lesson of the 2026-08 outage.

## Gotchas paid for once already

- **Sui GraphQL caps `events` page size at 50.** A larger `last:` returns
  `null` rather than an error, which reads as "no events at all".
- **Existence is not freshness.** An object can resolve fine and be weeks
  stale. Check timestamps, never just `getObject` succeeding — this is how the
  DeepBook `propbook::pyth_feed` mirror was mistaken for a live price source
  when it had been frozen since 2026-08-05.
- **`propbook::pyth_feed` is Mysten's mirror of Pyth, not Pyth.** It dies when
  Mysten's infrastructure does. Real Pyth on Sui is a pull oracle and needs a
  Hermes update pushed on-chain first.
