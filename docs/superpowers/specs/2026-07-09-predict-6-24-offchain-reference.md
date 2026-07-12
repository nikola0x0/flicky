# Predict 6-24 — Off-chain integration reference (for Plans 2 & 3)

Distilled from the authoritative source: `github.com/MystenLabs/deepbookv3` branch
`predict-testnet-6-24`, `packages/predict/deployment/README.md` + `deployment.testnet.json`
+ `scripts/transactions/predictWire.ts`. All IDs are testnet-provisional. Keep everything
env-overridable. Verify against `deployment.testnet.json` before shipping.

## System constants
- Clock: `0x6`
- **AccumulatorRoot: `0xacc`** (full: `0x0000…0acc`) — required `root` arg on mint/redeem/deposit/withdraw
- dUSDC decimals: 6 (`1_000_000` base units = 1 dUSDC)
- Tick grid: `TICK_SIZE = 1_000_000_000` (1e9); `ADMISSION_TICK_SIZE = 10 × TICK_SIZE` (1e10). Raw strike = `tick × tick_size`. Open upper bound = positive-infinity sentinel tick (`pos_inf_tick = (1<<30)-1`).
- Leverage: `1e9`-scaled; `1e9` == 1x (no floor). flicky binary bets use 1x.
- `max_cost` / `max_probability`: pass `u64::max` (`std::u64::max_value!()`) for uncapped.

## Shared object IDs (testnet 6-24)
```
predict pkg          0xdb3ef5a5129920e59c9b2ae25a77eddb48acd0e1c6307b97073f0e076016446e
ProtocolConfig       0x2325224629b4bd96d1f1d7ee937e07f8a06f861018a130bbb26db09cb0394cb6
PoolVault            0xfde98c636eb8a7aba59c3a238cfee6b576b7118d1e5ffa2952876c4b270a3a2a
predict Registry     0x54afbf245caf42466cedb5756ed7816f34f544afdfa13579a862eccf3afa21ca
propbook pkg         0x8eb2adde1c91f8b7c9ba5e9b0a32bfb804510c342939c5f77458fd8143f9755b
OracleRegistry       0xf3deaff68cbd081a35ec21653af6f671d2ad5f012f3b4d817d81752843374136
account pkg          0xb9389eac8d59170ffd1427c1a66e5c8306263464fcc6615e825c1f5b3e15da3b
AccountRegistry      0x3c54d5b8b6bca376fc289121838ad02f8a5b3843242b9ad7e8f8245720e685a2
block_scholes_oracle 0x8192932b70d5946217d0f09aad44f84ad5c27ee4c1ca31b09f46200fbd31d3de
dusdc                0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a  (type ::dusdc::DUSDC)

BTC feeds (propbook_underlying_id = 1):
  PythFeed               0xc78d7de16217d46d21b92ae475da799448be30b71a758dc6d7bb3ac2f1c35afb
  BlockScholesSpotFeed   0xcdc5fa7364e60fd2504aa96f65b707dc0734e507a919b1a7d7d63164fd67b745
  BlockScholesForwardFeed 0xe72c734ea8d8dcbc9183d9d8f96f51aaa1fb5034d5ed33ac60d67d261e15b48a
  BlockScholesSVIFeed    0xdc2f8270676bd05fb28491e8d4a41a495722fda7a454926dd66dbba256a21c69
```
Cadences live: `1m` / `5m` / `1h` per deployment wiring (predictWire.ts creates 5m + 1h). Verify live cadence at build time.

## Discovery — the 6-24 predict indexer (preferred over on-chain scan)
- Predict indexer base: `https://predict-server-beta.testnet.mystenlabs.com` (override via `deployment.testnet.json.servers.predict` if present).
  - `GET /markets` → rows with `expiry_market_id`, `expiry`, `tick_size`, `max_admission_leverage`, … Filter by `expiry` for cadence slots + liveness (`expiry > now`).
  - `GET /markets/{expiry_market_id}/state` → `settlement.settlement_price` once settled.
  - Orders/LP: `/managers`, `/manager-orders`, `/market-orders`, `/status` (health).
- Propbook indexer (optional): `https://propbook.api.testnet.mystenlabs.com`
  - `GET /underlyings/1/binding` → canonical BTC feed object ids (confirm §feeds).
  - `GET /oracles/{propbook_oracle_id}/pyth/latest` → current off-chain spot (strike selection).
- On-chain events (for keeper indexing, past-tense, emitted by owning module): `OrderMinted`, `SettledOrderRedeemed`, `LiveOrderRedeemed`, `LiquidatedOrderRedeemed`, `MarketCreated`, `MarketSettled`, `ExpiryMarketMintPausedUpdated`, `TradingPausedUpdated`, …
- On-chain live state (cash, payout liability, reference tick, settlement) read via `devInspect` getters on `ExpiryMarket` when needed.

## PTB recipes (composable `public fun`s — build as PTBs; arg order exact)

### Account setup (one-time per player; wrapper is deterministic + shared)
```
wrapper = account::account_registry::new(<AccountRegistry>, ctx)   // returns AccountWrapper
account::account::share(wrapper)
auth = account::account::generate_auth(ctx)                        // owner = tx sender
account::account::deposit_funds<DUSDC>(wrapper, auth, dusdc_coin, 0xacc, 0x6)
```
Lookup without creating: `account_registry::derived_wrapper_address(registry, owner)` / `derived_wrapper_exists(registry, owner)`. Withdraw: `withdraw_funds<T>(wrapper, auth, amount, 0xacc, 0x6, ctx)`.

### Pricer (once per tx, before any live mint/redeem)
```
pricer = predict::expiry_market::load_live_pricer(
  market, <ProtocolConfig>, <OracleRegistry>,
  <PythFeed>, <BlockScholesSpotFeed>, <BlockScholesForwardFeed>, <BlockScholesSVIFeed>,
  0x6,
)   // aborts if feeds stale or market past expiry
```

### Mint (the flicky staked-swipe atomic PTB, player-signed)
```
auth   = account::account::generate_auth(ctx)
pricer = predict::expiry_market::load_live_pricer(...)          // as above
order  = predict::expiry_market::mint_exact_quantity(
  market, wrapper, auth, <ProtocolConfig>, pricer,
  lower_tick, higher_tick,   // UP/YES = (K, +inf]: lower=K/tick_size, higher=pos_inf_tick
                             // DOWN/NO = (-inf, K]: lower=0, higher=K/tick_size
  quantity,                  // u64 contracts
  leverage,                  // 1e9 == 1x
  max_cost,                  // u64::max = uncapped all-in withdrawal
  max_probability,           // u64::max = uncapped
  0xacc, 0x6, ctx,
)   // returns u256 order_id — chain into flicky::duel::record_swipe(..., order_id, ...)
// then, same PTB:
flicky::duel::record_swipe<T>(duel, card_idx, is_up, quantity, order /*u256*/, 0x6, ctx)
```
`OrderMinted` event carries `entry_probability` (1e9) + `net_premium` (the keeper reads these by `order_id`/`owner` for the settle-time premium feed). Mint returns ONLY the order id.

### Settled redeem (keeper, permissionless — no auth/pricer)
```
predict::expiry_market::redeem_settled(
  market, <AccountRegistry>, wrapper, <ProtocolConfig>,
  <OracleRegistry>, <PythFeed>,
  order_id, close_quantity, 0xacc, 0x6, ctx,
)
```
Requires the market actually settled (`ensure_settled` against propbook Pyth at the exact expiry ms). Expired-but-unsettled = `awaiting_settle` (can't redeem yet).

### flicky settle (keeper, this repo's contract — keeper-fed values)
```
flicky::duel::settle_card<T>(duel, p0_wrapper, p1_wrapper, card_idx,
  settlement_price /*from MarketSettled or /markets/{id}/state*/,
  p0_premium, p1_premium /*net_premium from each player's OrderMinted*/)
flicky::duel::finalize<T>(duel, 0x6, ctx)
```

## Gotchas (handle these aborts)
- **Oracle freshness:** `load_live_pricer` aborts if any feed is stale or market past expiry (`EBlockScholesPriceStale`, `EPythSpotInvalid`, `ELivePricingExpired`, `EWrongPythFeed`). Always pass the CURRENT registry-bound feed ids.
- **Gates:** `ProtocolConfig.trading_paused` (blocks new risk), `valuation_in_progress` (blocks redeem_settled during flush), per-market `mint_paused`. Every flow calls `config.assert_version()` — rebuild against current ids after any upgrade.
- **Rounding favors protocol** — don't assert bit-exact payouts.
- **Two dUSDC pools per player:** account balance (funds premium/fees) is separate from the dUSDC stake escrowed in the `Duel`.
