# Design: Migrate Flicky from Predict `6-24` to `8-21`

**Date:** 2026-08-30

**Branch:** `feat/predict-8-21-migration`
**Status:** Approved for implementation; live testnet deployment is intentionally deferred until PR review.

Authoritative upstream sources:

- [8-21 integration guide](https://github.com/MystenLabs/deepbookv3/blob/predict-testnet-8-21/packages/predict/deployment/INTEGRATION.md)
- [8-21 testnet deployment manifest](https://github.com/MystenLabs/deepbookv3/blob/predict-testnet-8-21/packages/predict/deployment/deployment.testnet.json)
- [6-24...8-21 comparison](https://github.com/MystenLabs/deepbookv3/compare/predict-testnet-6-24...predict-testnet-8-21)

## Decision

Move all Flicky testnet integration points to `predict-testnet-8-21`. Keep the
existing raw PTB composition because Flicky must chain the returned Predict
order id into `duel::record_swipe` atomically.

Do not publish contracts or mutate live testnet state in this PR. The branch
prepares the code and a cutover runbook; live smoke testing happens after
review and before merge.

Old AccountWrapper balances are migrated manually: users withdraw dUSDC using
the 6-24 app/config, create their deterministic 8-21 wrapper, and redeposit.
Flicky must not reuse cached 6-24 wrapper ids against the new registry.

## Verified upstream changes

| Area                   | 6-24                                                   | 8-21 impact                                                                                                        |
| ---------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `load_live_pricer`     | separate Block Scholes spot, forward, and SVI objects  | one value store plus one SVI store; remove the forward object                                                      |
| `mint_exact_quantity`  | explicit `leverage` argument                           | leverage removed; Flicky's old value was always 1x                                                                 |
| keeper redemption      | `redeem_settled` with registry/oracle/quantity inputs  | call `redeem_settled_permissionless` with market, registry, wrapper, config, order id, accumulator root, and clock |
| `OrderMinted` event    | `net_premium`                                          | on-chain field is `premium`                                                                                        |
| `MarketSettled` event  | `settled_at_ms`                                        | on-chain field is `onchain_timestamp_ms`                                                                           |
| account surface        | owner auth, create/share/deposit/withdraw/load/balance | call surface used by Flicky remains compatible                                                                     |
| Flicky Move dependency | 6-24 `predict_account::Account` type identity          | update dependency; public `settle_card` signature changes type identity, requiring a fresh Flicky publish          |

## 8-21 testnet deployment

```text
predict package       0x421041754244cf0e985fb9c9f5e1f49428caf3df4cde3a7b266d8e18ea63597b
account package       0xa94ec89b6cbb3e2609c7ca65bd77885b7513f852922ebdf8e766851fb6f85259
propbook package      0xd8b402609b1728f60cf20bfaaec5255701df54350ec13e93aac39463b00bf97b
ProtocolConfig        0x7ef1ac99c2f0a77e7aa2602b5ea7bff68750cff0d80f09bdf827bfb345128f33
PoolVault             0x2a31f592d8fd3d0781e2233770d02d67797890ac82c3d18796d7eb0997896602
predict Registry      0x3d486bd50bb5bb5450ddbcb4f74776b6135f416c09024a6674ac266e77e1870a
AccountRegistry       0x5682c73d657de1546374e632369a25c82744c8a20e9b4f47e6558e3d4bde88d3
OracleRegistry        0x715f5ae4aac0078f4d0c6bf9ea2815614e799e909a90b577aeb8de9ad8bab142
BTC Pyth feed         0xea8fd4624002516b28b495051c838b2c9a34a4f22ae281d328e1bec47f54cd24
BTC BS value store    0x9b64cc860ac09e6dcd675fc579c1048792ddce51cc018f2ca16aeb4a1a5684a3
BTC BS SVI store      0xd5bc586e99c8d595e0ba5e0a2ef2295e652db8934ffbeda630d60e207bedab8f
AccumulatorRoot       0x0000000000000000000000000000000000000000000000000000000000000acc
dUSDC type            0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC
Predict API           https://predict-server-v4.testnet.mystenlabs.com
Propbook API          https://propbook-server-v4.testnet.mystenlabs.com
```

## Implementation boundary

1. Replace testnet defaults and env documentation with the manifest values.
2. Rename the Block Scholes config surface to `bsValueStoreId` and
   `bsSviStoreId`, preventing accidental reconstruction of the removed ABI.
3. Update web, mint-probe, diagnostics, and E2E PTBs for the new pricer and mint
   signatures.
4. Update the keeper to the permissionless redemption entry point and ABI.
5. Accept both old and new event field names while cursors drain the cutover.
6. Move wrapper caches to a new namespace.
7. Point Move stubs at the new published packages and rebuild locks.
8. Keep the currently deployed Flicky package id until a fresh package is
   published during the testnet cutover; never deploy this branch before that
   id is supplied.

## Cutover and rollback

Before deployment, stop new matchmaking and let active 6-24 duels finish or
refund. Users withdraw old wrapper balances while the old configuration is
still available. Publish Flicky as a fresh package, regenerate bindings, set
the new Flicky package id in server/web configuration, then create and fund new
8-21 wrappers.

Run `bun --filter server check:8-21`, then
`bun --filter server test:e2e` against the freshly published Flicky package.
After that, complete the browser gameplay test for one free duel and one
staked duel through create, join, reveal, atomic mint-and-record, settlement,
finalize, and permissionless redemption. Only then merge and deploy.

Rollback means restoring the prior app/server release and 6-24 Flicky package
id. New 8-21 objects and wrappers remain on-chain; they are not deleted.
