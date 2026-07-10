# Predict 6-24 Migration — Plan 2: Server

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate `apps/server` from DeepBook Predict 4-16 (`OracleSVI`/`PredictManager`/`predict::mint`) to 6-24 (`ExpiryMarket`/`account::AccountWrapper`/keeper-fed settle), matching the already-published 6-24 flicky contract (Plan 1), so discovery, the keeper (settle/finalize/redeem), sponsored gas, the indexer, and the WS wire all work against the new model.

**Architecture:** The server builds every PTB with raw `tx.moveCall({ target: "pkg::module::fn" })` (no codegen), so this is a hand rewrite of argument lists + discovery source + field parsing. The server never mints (that's the player-signed web PTB, Plan 3). Its Predict touchpoints are: **discovery** (find live BTC `ExpiryMarket`s + pick strikes), the **keeper** (feed `settlement_price` + per-player `net_premium` into `settle_card`, then `redeem_settled`), the **sponsor allowlist**, and **read/index** paths (indexer, oracle route, oracle-stream, ws wire). Settlement price + premium come from the 6-24 **predict indexer** and on-chain events — the contract exposes no public reads (Plan 1's keeper-attested model).

**Tech Stack:** Bun runtime (`Bun.serve`), `@mysten/sui` 2.20.2 (`Transaction`, `bcs`, `SuiGrpcClient` for reads/exec, `SuiGraphQLClient` for events), Postgres (`Bun.sql`), Enoki sponsored gas. gRPC for object/balance/simulate/execute; GraphQL for event queries.

## Global Constraints

- Use `bun` only. Server is ESM, runs `bun --hot src/index.ts`. Prefer `Bun.*` APIs.
- Prettier: no semicolons, double quotes, 2-space, trailing comma `es5`, width 80. TS `strict`.
- **All 6-24 IDs, PTB recipes, indexer endpoints, tick/leverage units, and abort gotchas are in `docs/superpowers/specs/2026-07-09-predict-6-24-offchain-reference.md` — READ IT FIRST; it is the single source for IDs and arg orders. Do not hardcode IDs in code — add env vars (env-override-first, hard-fail on missing mainnet, mirroring `sponsor.ts`'s `resolveDeepbookPackage` idiom).**
- The 6-24 flicky contract is already published: package `0x6c6be7201465b165c82e717b75074060208495118dbda5afb19471be89d3cbfb` (server reads it from `apps/contracts/deployed.json` via `loadFlickyPackageId()`). Its ABI: `record_swipe(duel, card_idx, is_up, quantity, order_id: u256, clock, ctx)`, `settle_card(duel, p0_wrapper, p1_wrapper, card_idx, settlement_price, p0_premium, p1_premium)`, `settle_card_free(duel, card_idx, settlement_price, p0_premium, p1_premium)`, `finalize(duel, clock, ctx)`, `finalize_test_one_price(duel, price, clock, ctx)`, `new_card(expiry_market_id: ID, strike: u64)`. `Card {expiry_market_id: ID, strike: u64}`, `Swipe {is_up, quantity, order_id: u256}`. Events: `SwipeRecorded {duel_id, player, card_idx, is_up, quantity, order_id}`, `CardSettled {duel_id, card_idx, expiry_market_id, settlement_price, actual_up, p0_payout, p0_premium, p1_payout, p1_premium}`, `DuelFinalized {…, primary_expiry_market_id, primary_settlement_price}`.
- Predict indexer (verified live): `https://predict-server-beta.testnet.mystenlabs.com`. `GET /markets` → array of rows `{expiry_market_id, propbook_underlying_id, expiry (ms), tick_size (string, live="10000000"), admission_tick_size (string, live="1000000000"), max_admission_leverage, min_entry_probability, max_entry_probability, kind:"market_created", …}` — returns ALL created markets, so filter `propbook_underlying_id === 1 && expiry > now`. `GET /markets/{id}/state` → settlement info.
- Propbook oracle indexer: `https://propbook.api.testnet.mystenlabs.com`. `GET /oracles/{pyth_feed_id}/pyth/latest` → current BTC spot.
- Constants: `AccumulatorRoot = 0xacc`, `Clock = 0x6`, dUSDC 6dp. Leverage `1e9`=1x. `max_cost`/`max_probability` uncapped = `u64` max.
- Preserve README invariants: sponsored gas end-to-end, server NEVER mints on the player's behalf, `Duel` doesn't hold positions, `p_swiped` no longer snapshotted on-chain (keeper-attested premium at settle).
- Branch `feat/predict-6-24-migration` (continues from Plan 1, HEAD `98c5a5a`). `apps/web` stays intentionally RED until Plan 3 — server verification is scoped to `apps/server` (`bun --filter server test` + `bun --filter server typecheck`).

**Scope note:** deliver the SERVER. Web (Plan 3) and E2E (Plan 4) follow. Some tasks probe the live indexer as their first step — that is a real step, not a placeholder, because the exact JSON of `/markets/{id}/state` and `/oracles/.../pyth/latest` must be confirmed against the running service before parsing it.

---

## File structure
- `apps/server/src/env.ts` — add all 6-24 shared-object ids + predict/propbook indexer URLs + `PREDICT_SETTLEMENT_MODE`; swap the 4-16 `deepbookPredictPackageId`/`deepbookPredictObjectId` defaults.
- `apps/server/src/predict.ts` → account model: `deriveWrapperFor(owner)` + `readAccountBalance`; keep the strict return contract. (Rename file to `account.ts`? No — keep `predict.ts` to minimize churn; rename the exports.)
- `apps/server/src/deckmaster.ts` — discovery via predict indexer `/markets`; strike selection in price space from spot; tick mapping. Keep `ProbeFn`/pure-logic exports stable for tests where possible.
- `apps/server/src/keeper.ts` — feed-settle (`settlement_price` + per-player `net_premium`), `redeem_settled`, reveal `new_card` ID fix, `parseDuelFromObject` field updates.
- `apps/server/src/sponsor.ts` — replace the Predict allowlist half with 6-24 targets; fix stale `finalize_test_one_oracle`.
- `apps/server/src/indexer.ts`, `ws/protocol.ts`, `ws/oracle-stream.ts`, `oracle.ts`, `manager-api.ts` — field renames (`oracle_id`→`expiry_market_id`, drop `premium`/`p_swiped`, add `order_id`), market-state reads, `OrderMinted`/`MarketSettled` indexing for the keeper.
- Tests: `keeper.test.ts`, `sponsor.test.ts`, `predict.test.ts`, `indexer.test.ts`, `deckmaster.test.ts`.

---

## Task 1: env.ts — 6-24 shared-object ids + indexer URLs + settlement mode

**Files:** Modify `apps/server/src/env.ts`

**Interfaces:**
- Produces on the `env` object (consumed by every later task): `deepbookPredictPackageId` (default → 6-24 `0xdb3ef5a5…`), `protocolConfigId`, `poolVaultId`, `predictRegistryId`, `accountPackageId`, `accountRegistryId`, `propbookPackageId`, `oracleRegistryId`, `pythFeedId`, `bsSpotFeedId`, `bsForwardFeedId`, `bsSviFeedId`, `accumulatorRootId` (default `0xacc`), `predictIndexerUrl`, `propbookIndexerUrl`, `predictSettlementMode` (`"keeper"|"onchain"`, default `"keeper"`). Keep `dusdcCoinType` unchanged.

- [ ] **Step 1: Read the reference + current env.ts**
Read `docs/superpowers/specs/2026-07-09-predict-6-24-offchain-reference.md` (IDs) and `apps/server/src/env.ts:19-136`. Note the existing `envStr(name, fallback)` helper pattern and the `resolveDeepbookPackage`-style mainnet-hard-fail idiom in `sponsor.ts:94-124`.

- [ ] **Step 2: Swap the DeepBook Predict defaults + add the new ids**
Change `DEEPBOOK_PREDICT_PACKAGE_ID` default (env.ts:41-43) from `0xf5ea2b37…5138` to `0xdb3ef5a5129920e59c9b2ae25a77eddb48acd0e1c6307b97073f0e076016446e`. Replace the 4-16 `DEEPBOOK_PREDICT_OBJECT_ID` (`Predict` singleton, gone in 6-24) with the new shared-object ids. Add, using the same `envStr(...)` default pattern (verbatim values from the reference doc):
```ts
protocolConfigId:   envStr("PROTOCOL_CONFIG_ID",   "0x2325224629b4bd96d1f1d7ee937e07f8a06f861018a130bbb26db09cb0394cb6"),
poolVaultId:        envStr("POOL_VAULT_ID",        "0xfde98c636eb8a7aba59c3a238cfee6b576b7118d1e5ffa2952876c4b270a3a2a"),
predictRegistryId:  envStr("PREDICT_REGISTRY_ID",  "0x54afbf245caf42466cedb5756ed7816f34f544afdfa13579a862eccf3afa21ca"),
accountPackageId:   envStr("ACCOUNT_PACKAGE_ID",   "0xb9389eac8d59170ffd1427c1a66e5c8306263464fcc6615e825c1f5b3e15da3b"),
accountRegistryId:  envStr("ACCOUNT_REGISTRY_ID",  "0x3c54d5b8b6bca376fc289121838ad02f8a5b3843242b9ad7e8f8245720e685a2"),
propbookPackageId:  envStr("PROPBOOK_PACKAGE_ID",  "0x8eb2adde1c91f8b7c9ba5e9b0a32bfb804510c342939c5f77458fd8143f9755b"),
oracleRegistryId:   envStr("ORACLE_REGISTRY_ID",   "0xf3deaff68cbd081a35ec21653af6f671d2ad5f012f3b4d817d81752843374136"),
pythFeedId:         envStr("BTC_PYTH_FEED_ID",     "0xc78d7de16217d46d21b92ae475da799448be30b71a758dc6d7bb3ac2f1c35afb"),
bsSpotFeedId:       envStr("BTC_BS_SPOT_FEED_ID",  "0xcdc5fa7364e60fd2504aa96f65b707dc0734e507a919b1a7d7d63164fd67b745"),
bsForwardFeedId:    envStr("BTC_BS_FWD_FEED_ID",   "0xe72c734ea8d8dcbc9183d9d8f96f51aaa1fb5034d5ed33ac60d67d261e15b48a"),
bsSviFeedId:        envStr("BTC_BS_SVI_FEED_ID",   "0xdc2f8270676bd05fb28491e8d4a41a495722fda7a454926dd66dbba256a21c69"),
accumulatorRootId:  envStr("ACCUMULATOR_ROOT_ID",  "0xacc"),
predictIndexerUrl:  envStr("PREDICT_INDEXER_URL",  "https://predict-server-beta.testnet.mystenlabs.com"),
propbookIndexerUrl: envStr("PROPBOOK_INDEXER_URL", "https://propbook.api.testnet.mystenlabs.com"),
predictSettlementMode: (Bun.env.PREDICT_SETTLEMENT_MODE === "onchain" ? "onchain" : "keeper") as "keeper" | "onchain",
```
Keep `dusdcCoinType` and `deepbookPredictObjectId` — but repurpose `deepbookPredictObjectId` only if still referenced; otherwise remove it and fix references in later tasks. (Grep `deepbookPredictObjectId` usages; the keeper/redeem path replaces them.)

- [ ] **Step 3: typecheck**
Run `cd apps/server && bun run typecheck`. Expected: clean (env.ts has no consumers of the new fields yet). If `deepbookPredictObjectId` removal breaks a reference, leave the field in place for now (later tasks remove its uses) — do not delete it in this task.

- [ ] **Step 4: Commit**
```bash
git add apps/server/src/env.ts
git commit -m "feat(server): add 6-24 shared-object ids + indexer urls + settlement mode to env"
```

---

## Task 2: Sponsor allowlist → 6-24 targets

**Files:** Modify `apps/server/src/sponsor.ts`, `apps/server/src/sponsor.test.ts`

**Interfaces:**
- Consumes: `env` (Task 1) — `accountPackageId`, `deepbookPredictPackageId`.
- Produces: `buildAllowedTargets(network)` returning the 6-24 target set.

- [ ] **Step 1: Write the failing test**
In `sponsor.test.ts`, update the `buildAllowedTargets` assertion to expect the 6-24 targets and NOT the old ones. Add:
```ts
test("allowlist covers 6-24 account + expiry_market targets, not 4-16 predict", () => {
  const targets = buildAllowedTargets("testnet")
  expect(targets).toContain(`${env.accountPackageId}::account_registry::new`)
  expect(targets).toContain(`${env.accountPackageId}::account::deposit_funds`)
  expect(targets).toContain(`${env.deepbookPredictPackageId}::expiry_market::mint_exact_quantity`)
  expect(targets).toContain(`${env.flickyPackageId}::duel::finalize_test_one_price`)
  expect(targets.some((t) => t.includes("::predict::mint"))).toBe(false)
  expect(targets.some((t) => t.includes("finalize_test_one_oracle"))).toBe(false)
})
```

- [ ] **Step 2: Run it, verify it fails**
`cd apps/server && bun test sponsor.test.ts` → FAIL (old allowlist).

- [ ] **Step 3: Update the allowlist (`sponsor.ts:38-83`)**
Replace `DEEPBOOK_PREDICT_FNS` with the 6-24 player-signed set and fix the stale flicky fn:
```ts
const FLICKY_FNS = [
  "duel::new_card", "duel::create_duel", "duel::create_duel_free",
  "duel::join_duel", "duel::join_duel_free", "duel::reveal_deck",
  "duel::record_swipe", "duel::record_swipe_free",
  "duel::claim_reveal_timeout", "duel::refund_duel",
  "duel::settle_card", "duel::settle_card_free",
  "duel::finalize", "duel::finalize_free", "duel::finalize_test_one_price",
]
const ACCOUNT_FNS = [
  "account_registry::new", "account::share", "account::generate_auth",
  "account::deposit_funds", "account::withdraw_funds",
]
const DEEPBOOK_PREDICT_FNS = [
  "expiry_market::load_live_pricer", "expiry_market::mint_exact_quantity",
  "expiry_market::mint_exact_amount", "expiry_market::redeem_live",
]
```
Add an `account` package resolver mirroring `resolveDeepbookPackage` (env-first, mainnet hard-fail) and include `${accountPkg}::${fn}` for `ACCOUNT_FNS` in `buildAllowedTargets` (sponsor.ts:126-136). Keep `SWAP_FNS` as-is.

- [ ] **Step 4: Run tests green**
`cd apps/server && bun test sponsor.test.ts` → PASS.

- [ ] **Step 5: Commit**
```bash
git add apps/server/src/sponsor.ts apps/server/src/sponsor.test.ts
git commit -m "feat(server): sponsor allowlist for 6-24 account + expiry_market targets"
```

---

## Task 3: Discovery — predict indexer `/markets` + price-space strike selection

**Files:** Modify `apps/server/src/deckmaster.ts`, `apps/server/src/deckmaster.test.ts`

The 4-16 discovery scanned `oracle::OraclePricesUpdated` and probed the on-chain quote slope (`predict::get_trade_amounts`) to place strikes in probability space. 6-24 exposes **no public quote**, so: discover live `ExpiryMarket`s from the predict indexer, read current BTC spot from the propbook indexer, and place strikes as **price offsets around spot** snapped to `admission_tick_size`, sign-balanced. This drops the on-chain amplitude probe.

**Interfaces:**
- Produces: `findDeckMarkets(count, maxHorizonMs): Promise<MarketSnapshot[]>` where `MarketSnapshot = { expiryMarketId: string, expiry: number, tickSize: bigint, admissionTickSize: bigint }`; `buildDeck(markets, spot): { expiryMarketId, strike, lowerTick, higherTick, isUpFavored }[]`; a stable `snapToAdmissionTick(rawStrike, tickSize, admissionTickSize): bigint`.
- Consumes: `env.predictIndexerUrl`, `env.propbookIndexerUrl`, `env.pythFeedId`.

- [ ] **Step 1: Probe the live indexer shapes (real step)**
Run and record the exact JSON so parsing is concrete:
```bash
curl -s "https://predict-server-beta.testnet.mystenlabs.com/markets" | head -c 2000
curl -s "https://predict-server-beta.testnet.mystenlabs.com/markets/<pick-one-expiry_market_id>/state" | head -c 1500
curl -s "https://propbook.api.testnet.mystenlabs.com/oracles/0xc78d7de16217d46d21b92ae475da799448be30b71a758dc6d7bb3ac2f1c35afb/pyth/latest" | head -c 1000
```
Confirmed fields on `/markets` rows: `expiry_market_id`, `propbook_underlying_id`, `expiry` (ms number), `tick_size` (string), `admission_tick_size` (string), `kind:"market_created"`. Record the `/state` settlement field path and the `/pyth/latest` spot field path for Steps 3–4.

- [ ] **Step 2: Write failing tests for the pure helpers**
In `deckmaster.test.ts`, add tests for `snapToAdmissionTick` (rounds a raw strike to the nearest `admission_tick_size` multiple, returned as a tick index) and `buildDeck` (given N markets + a spot, returns N cards with alternating-signed strike offsets, each `expiryMarketId` distinct, `lowerTick/higherTick` set per direction: UP = `[strikeTick, pos_inf]`, DOWN = `[0, strikeTick]`). Keep `allocateSignBalance` reused. Run → FAIL.

- [ ] **Step 3: Implement `findDeckMarkets`**
Replace `findDeckOracles` (deckmaster.ts:246-317) with an indexer fetch:
```ts
export async function findDeckMarkets(
  count = 5,
  maxHorizonMs = env.deckCardMaxHorizonMs,
  minHeadroomMs = env.deckCardMinHeadroomMs,
): Promise<MarketSnapshot[]> {
  const res = await fetch(`${env.predictIndexerUrl}/markets`)
  if (!res.ok) throw new Error(`predict indexer /markets ${res.status}`)
  const rows = (await res.json()) as MarketRow[]
  const now = Date.now()
  return rows
    .filter((r) => r.propbook_underlying_id === 1 && r.kind === "market_created")
    .map((r) => ({
      expiryMarketId: r.expiry_market_id,
      expiry: Number(r.expiry),
      tickSize: BigInt(r.tick_size),
      admissionTickSize: BigInt(r.admission_tick_size),
    }))
    .filter((m) => m.expiry > now + minHeadroomMs && m.expiry <= now + maxHorizonMs)
    .sort((a, b) => a.expiry - b.expiry)
    .slice(0, count)
}
```
De-dupe by `expiryMarketId` (indexer may return multiple MarketCreated rows per market on re-emit — keep the first). Define `MarketRow`/`MarketSnapshot` types from the confirmed shape.

- [ ] **Step 4: Implement spot read + `buildDeck` (price-space strikes)**
```ts
export async function readBtcSpot(): Promise<bigint> {
  const res = await fetch(`${env.propbookIndexerUrl}/oracles/${env.pythFeedId}/pyth/latest`)
  if (!res.ok) throw new Error(`propbook /pyth/latest ${res.status}`)
  const j = await res.json()
  return BigInt(/* the spot price field confirmed in Step 1, in tick_size units */)
}
```
`buildDeck(markets, spot)`: for each market, take a sign from `allocateSignBalance(markets.length)`; pick a strike offset from `STRIKE_OFFSETS_BPS` (define a small ladder, e.g. `[+50, -50, +150, -150, 0]` bps of spot mapped to zones close/mid/edge, reusing `allocateZones`); `rawStrike = spot ± offset`; `strikeTick = snapToAdmissionTick(rawStrike, tickSize, admissionTickSize)`; UP-favored → `lowerTick = strikeTick, higherTick = POS_INF_TICK`, DOWN → `lowerTick = 0, higherTick = strikeTick`. Return cards `{ expiryMarketId, strike: strikeTick * tickSize, lowerTick, higherTick, isUpFavored }`. `POS_INF_TICK = (1n << 30n) - 1n`.

- [ ] **Step 5: Wire the deck HTTP route + delete dead 4-16 probe code**
Point the deck-generation route (the live `buildAndProbeDeck` path) at `findDeckMarkets` + `readBtcSpot` + `buildDeck`. Remove `probeCard`, `pickStrikeAdaptive`, `resolveGrids`, the `OraclePricesUpdated`/`OracleCreated` GraphQL scans, and the `OracleSnapshot` type — they depend on the removed on-chain quote. Keep `hashToHex`/deck-hash storage, `allocateSignBalance`, `allocateZones`, `decideDeckSize`, `snapToTick` (rename/retarget to `snapToAdmissionTick`). Update `deckmaster.test.ts` removing probe-based tests; keep pure-logic tests.

- [ ] **Step 6: Run tests + typecheck**
`cd apps/server && bun test deckmaster.test.ts && bun run typecheck` → PASS/clean.

- [ ] **Step 7: Commit**
```bash
git add apps/server/src/deckmaster.ts apps/server/src/deckmaster.test.ts
git commit -m "feat(server): discover 6-24 ExpiryMarkets via predict indexer + price-space strikes"
```

---

## Task 4: Account model — `predict.ts` + `manager-api.ts`

**Files:** Modify `apps/server/src/predict.ts`, `apps/server/src/manager-api.ts`, `apps/server/src/predict.test.ts`, `apps/server/src/db.ts` (manager cache reuse)

4-16 resolved a `PredictManager` by scanning `PredictManagerCreated` events by owner. 6-24 accounts are **deterministic**: the wrapper address is derivable from `(AccountRegistry, owner)`. Replace the scan with a devInspect of `account_registry::derived_wrapper_address` (+ `derived_wrapper_exists`), cache the result.

**Interfaces:**
- Produces: `deriveWrapperFor(owner: string): Promise<string | null>` (null = no wrapper yet, authoritative), `readAccountBalance(wrapper: string): Promise<bigint>`. Keep the strict string/null/throw contract documented at predict.ts:62-72.

- [ ] **Step 1: Write failing test**
In `predict.test.ts`, replace `findManagerFor` tests with `deriveWrapperFor`: given a known owner with a wrapper, returns the derived address; given `derived_wrapper_exists === false`, returns null. (Postgres-gated like the existing suite; mock the devInspect where the suite already mocks the client.) Run → FAIL.

- [ ] **Step 2: Implement `deriveWrapperFor`**
Replace `findManagerFor` (predict.ts:73-108). devInspect `account_registry::derived_wrapper_exists(registry, owner)`; if false return null; else devInspect `derived_wrapper_address(registry, owner)` and decode the returned `address`. Cache via the existing `getCachedManager`/`cacheManager` (db.ts) keyed by owner. Args: `tx.object(env.accountRegistryId)`, `tx.pure.address(owner)`; target `${env.accountPackageId}::account_registry::derived_wrapper_address`.

- [ ] **Step 3: Implement `readAccountBalance`**
Replace `readManagerBalance` (predict.ts:118-142): devInspect `account::balance<DUSDC>(account, root, clock)` — but `balance` takes `&Account` (from `load_account(wrapper)`), `&AccumulatorRoot`, `&Clock`. Chain `account::load_account(wrapper)` → `account::balance<T>(<that>, accumulatorRoot, clock)` in one devInspect tx. typeArguments `[env.dusdcCoinType]`.

- [ ] **Step 4: Update `manager-api.ts`**
`GET /manager?owner=` → call `deriveWrapperFor`; return `{ wrapper, balance }` (rename response field from `manager` to `wrapper`, or keep `manager` key for FE compat — pick `wrapper` and note it; Plan 3 aligns the FE). Update `checkQueueBalanceGate` (predict.ts) to use `readAccountBalance`.

- [ ] **Step 5: Tests + typecheck green**
`cd apps/server && bun test predict.test.ts && bun run typecheck`.

- [ ] **Step 6: Commit**
```bash
git add apps/server/src/predict.ts apps/server/src/manager-api.ts apps/server/src/predict.test.ts
git commit -m "feat(server): resolve 6-24 AccountWrapper (derived) + account balance reads"
```

---

## Task 5: Keeper — feed-settle, redeem_settled, reveal + parse fixes

**Files:** Modify `apps/server/src/keeper.ts`, `apps/server/src/keeper.test.ts`

**Interfaces:**
- Consumes: `env` (Task 1), `deriveWrapperFor` (Task 4), the indexer's `OrderMinted`/`MarketSettled` reads (Task 6 provides `readMarketSettlement(expiryMarketId)` + `readOrderPremium(orderId)`; if Task 6 lands after, add thin local readers here and Task 6 dedups).
- Produces: a keeper that settles + finalizes + redeems on the 6-24 model.

- [ ] **Step 1: Fix `parseDuelFromObject` field parsing (keeper.ts:126-170)**
`Card` field `oracle_id` → `expiry_market_id`; `Swipe` drop `premium`/`p_swiped`, add `order_id` (a `u256` — parse as string/bigint). Update `parseSwipe` (keeper.test.ts covers it). Update the `Swipe`/`Card` TS types used across keeper.

- [ ] **Step 2: Rewrite `tryReveal` new_card arg (keeper.ts:262-263)**
`tx.object(c.oracle_id)` → `tx.pure.id(c.expiryMarketId)` (6-24 `new_card(expiry_market_id: ID, strike)` takes a plain ID). `strike` arg unchanged.

- [ ] **Step 3: Rewrite settlement detection**
The keeper gated on `readOracleSettled` polling `settlement_price` on each card's oracle. Replace with `readMarketSettlement(expiryMarketId)` → `{ settled: boolean, settlementPrice: bigint | null }` via `GET /markets/{id}/state` (confirmed shape in Task 3 Step 1) or the on-chain `MarketSettled` event. Gate `tryClose` on both players fully swiped AND every distinct card market settled.

- [ ] **Step 4: Rewrite the settle+finalize+redeem PTB (keeper.ts:350-449)**
For each card `i`, resolve `settlementPrice` (Step 3) and each player's `net_premium` for that card's swipe via `readOrderPremium(swipe.order_id)` (from `OrderMinted`). Build:
```ts
duelDetails.cards.forEach((card, i) => {
  tx.moveCall({
    target: `${env.flickyPackageId}::duel::settle_card`,
    typeArguments: [env.dusdcCoinType],
    arguments: [
      tx.object(duelId),
      tx.object(p0Wrapper), tx.object(p1Wrapper),
      tx.pure.u64(BigInt(i)),
      tx.pure.u64(settlementPrice[i]),
      tx.pure.u64(p0Premium[i]),
      tx.pure.u64(p1Premium[i]),
    ],
  })
})
tx.moveCall({ target: `${env.flickyPackageId}::duel::finalize`,
  typeArguments: [env.dusdcCoinType], arguments: [tx.object(duelId), tx.object("0x6")] })
```
Then, for each player's swiped card position, `redeem_settled` (per the reference doc §3.3):
```ts
tx.moveCall({
  target: `${env.deepbookPredictPackageId}::expiry_market::redeem_settled`,
  typeArguments: [env.dusdcCoinType],
  arguments: [
    tx.object(card.expiryMarketId), tx.object(env.accountRegistryId), tx.object(wrapper),
    tx.object(env.protocolConfigId), tx.object(env.oracleRegistryId), tx.object(env.pythFeedId),
    tx.pure.u256(swipe.order_id), tx.pure.u64(swipe.quantity),
    tx.object(env.accumulatorRootId), tx.object("0x6"),
  ],
})
```
Resolve `p0Wrapper`/`p1Wrapper` via `deriveWrapperFor(creator)` / `deriveWrapperFor(challenger)`. Keep in-memory idempotency sets + `isTerminalSettleError` (extend abort-code classification for the new `EZeroSettlement`).

- [ ] **Step 5: Guard `predictSettlementMode`**
At keeper start, if `env.predictSettlementMode !== "keeper"`, log a clear "onchain settlement mode not implemented (needs contract settle_card_onchain)" and fall back to keeper mode. (Honors the design's env-toggle without dead branches.)

- [ ] **Step 6: Update keeper tests**
`keeper.test.ts`: fix `parseDuelFromObject`/`parseSwipe` fixtures to the new fields; add a settle-PTB shape test asserting `settle_card` is built with 7 args incl. `settlement_price`+premiums, and `redeem_settled` with the 10-arg 6-24 object graph. Run → PASS.

- [ ] **Step 7: typecheck + commit**
```bash
cd apps/server && bun test keeper.test.ts && bun run typecheck
git add apps/server/src/keeper.ts apps/server/src/keeper.test.ts
git commit -m "feat(server): keeper feed-settle + redeem_settled on 6-24 model"
```

---

## Task 6: Indexer, WS wire, oracle route — field renames + OrderMinted/MarketSettled

**Files:** Modify `apps/server/src/indexer.ts`, `apps/server/src/ws/protocol.ts`, `apps/server/src/ws/oracle-stream.ts`, `apps/server/src/oracle.ts`, `apps/server/src/indexer.test.ts`, `apps/server/src/db.ts` (mirror columns)

**Interfaces:**
- Produces: `readMarketSettlement(expiryMarketId)` + `readOrderPremium(orderId)` (used by Task 5); updated wire types.

- [ ] **Step 1: Indexer event set + field parsing (`indexer.ts`)**
`SwipeRecorded` now carries `order_id` (drop `premium`/`p_swiped`); `CardSettled` uses `expiry_market_id` + carries `p0_premium`/`p1_premium`; `DuelFinalized` uses `primary_expiry_market_id`. Add `deepbook_predict::order_events::OrderMinted` + `config_events::MarketSettled` to a lightweight index (keyed tables: `order_premiums(order_id, net_premium)`, `market_settlements(expiry_market_id, settlement_price, settled_at_ms)`) so the keeper can read premium + settlement without re-deriving. Update `computeCardOutcomes` field keys (`oracle_id`→`expiry_market_id`).

- [ ] **Step 2: DB mirror columns (`db.ts`)**
Rename mirror columns `oracle_id`→`expiry_market_id`, drop `premium`/`p_swiped`, add `order_id` on the swipe mirror; add the two small lookup tables from Step 1. Provide `saveOrderPremium`/`getOrderPremium`, `saveMarketSettlement`/`getMarketSettlement`.

- [ ] **Step 3: WS wire (`ws/protocol.ts`)**
`cards: {oracle_id, strike}` → `{expiry_market_id, strike}`; swipe wire `{isUp, quantity, premium}` → `{isUp, quantity, orderId}`. Update `ServerMsg`/`room_state` shapes. (Plan 3's web consumes these — keep names camelCase per existing convention.)

- [ ] **Step 4: Oracle route + stream (`oracle.ts`, `ws/oracle-stream.ts`)**
`GET /oracle/*` read `OracleSVI` → read `ExpiryMarket` (via `/markets` + `/markets/{id}/state`, or devInspect getters `expiry`/`reference_tick`/settlement). `oracle-stream.ts` `tick()` → poll subscribed `expiry_market_id`s' market state (spot from propbook `/pyth/latest`), broadcast `oracle_tick` with `{expiryMarketId, spot, expiry, settlementPrice}`. Rename `oracle_subscribe {oracleIds}` payload to `{marketIds}` (note for Plan 3).

- [ ] **Step 5: Tests green**
`cd apps/server && bun test indexer.test.ts` → PASS (fix `computeCardOutcomes` fixtures).

- [ ] **Step 6: Commit**
```bash
git add apps/server/src/indexer.ts apps/server/src/ws apps/server/src/oracle.ts apps/server/src/db.ts apps/server/src/indexer.test.ts
git commit -m "feat(server): index OrderMinted/MarketSettled + rename duel wire fields for 6-24"
```

---

## Task 7: Whole-server verification + dead-code sweep

**Files:** `apps/server/**`

- [ ] **Step 1: Grep for stragglers**
```bash
grep -rn "OracleSVI\|PredictManager\|predict_manager\|market_key\|get_trade_amounts\|::predict::mint\|::predict::redeem\|oracle_id\|p_swiped\|finalize_test_one_oracle" apps/server/src --include=*.ts | grep -v ".test.ts"
```
Each hit is a missed rename — fix it. Scripts under `src/scripts/` that hardcode 4-16 ids (`deepbook-discover.ts`, `demo-duel.ts`, `probe-oracles.ts`) may be updated or deleted; if left, add a one-line "4-16 legacy, not migrated" comment so they don't read as current.

- [ ] **Step 2: Full server suite + typecheck**
```bash
cd apps/server && bun test && bun run typecheck
```
Expected: all non-e2e tests PASS, `tsc` clean. (Do NOT run `bun test:e2e` here — it needs live testnet + a seeded account; Plan 4 owns the real E2E.)

- [ ] **Step 3: Boot smoke test**
```bash
cd apps/server && timeout 8 bun --hot src/index.ts 2>&1 | head -30 || true
```
Expected: server boots, indexer + keeper start (or log a clean "disabled" if keys unset), no import/throw on startup.

- [ ] **Step 4: Commit any sweep fixes**
```bash
git add apps/server
git commit -m "chore(server): 6-24 straggler sweep + verification"
```

---

## Verification (whole plan)
- `bun --filter server test` green; `bun --filter server typecheck` clean.
- No 4-16 symbols remain in `apps/server/src` (Task 7 grep empty).
- Discovery returns ≥3 live short-dated BTC `ExpiryMarket`s from the predict indexer.
- Keeper builds a valid `settle_card × N` + `finalize` + `redeem_settled` PTB against the new package (dry-run shape verified in keeper.test.ts).
- Sponsor allowlist covers the 6-24 player-signed targets.

**Known-red (expected):** `apps/web` still red (Plan 3). Root `bun typecheck` will fail on web — scope to `apps/server`.

## Downstream (not in this plan)
- **Plan 3 — Web:** full 6-24 codegen for the web, `lib/deepbook.ts` mint PTB (account onboarding + `mint_exact_quantity` + chained `record_swipe`), `lib/flicky.ts` reads, wire-field alignment with Task 6's renames.
- **Plan 4 — E2E + onboarding:** testnet create→join→reveal→atomic sponsored swipe (real 6-24 mint)→settle→payout in a 5-min window.
