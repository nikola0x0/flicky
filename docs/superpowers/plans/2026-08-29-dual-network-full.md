# Dual-network: make testnet AND mainnet fully playable

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take Flicky from "testnet works, mainnet is a gated preview" (shipped in #56/#57) to **both networks fully playable in one deploy** — a player picks a network in settings and gets the complete loop there: matchmaking, deck reveal, staked swipes, keeper settlement, MMR, leaderboard, and season prizes, all scoped to that chain, with no cross-chain bleed in either direction.

**Current state (as of `89f5e86`):** the *read* plane is already dual-network. `networkEnv(net)` resolves chain config, `getSuiClient(net)` / `getGraphQLClient(net)` are per-network maps, `POST /sponsor` resolves its key + MoveCall allowlist per network, the read endpoints take `?network=`, and `duel` / `player_rating` carry a `network` column with reads scoped by it. The web pins one network per page load (`lib/network.ts`) and gates the duel routes on `DUELS_ENABLED`.

What is NOT dual-network yet is the **write and realtime plane**: one keeper, one indexer, one set of matchmaking queues, one oracle stream, one sponsor-balance monitor — all bound to `env.network`. That is what this plan finishes.

**Architecture:** Stay single-process and single-database. There is no second Railway service and no second environment; `SUI_NETWORKS` is the switch. Every currently-global singleton becomes a per-network instance keyed off `env.enabledNetworks`, and every chain-scoped table row carries the network that produced it. The WS wire gains a `network` field at subscribe time so a socket can only ever join queues and rooms on the chain it declared.

**Tech Stack:** Bun runtime (`Bun.serve`), `@mysten/sui` 2.20.3 (`SuiGrpcClient` reads/exec, `SuiGraphQLClient` events), Postgres via `Bun.sql`, Vite + React 19 web. No new infra.

---

## Hard blockers (outside this repo)

These gate the *mainnet half* of the goal. Everything else in this plan can land and be verified on testnet first.

1. **DeepBook Predict has no mainnet deployment.** `predict-testnet-6-24` is testnet-only; Mysten has mainnet slated for later in 2026 and warns the contracts may still change. Until it ships there is no mainnet `ExpiryMarket` to mint against, so the staked tier cannot run on mainnet at all.
2. **The 6-24 testnet deployment is dark, not just its indexer.** Last `MarketCreated` 2026-08-17T21:03Z; 0 live markets as of 2026-08-30; the read API hosts are NXDOMAIN. This is NOT fixable with a Railway variable — see `2026-08-30-predict-independence.md`, which **blocks this plan**.
3. **Real money on mainnet.** The sponsor and keeper address balances must be funded with real SUI, and Enoki zkLogin is paid on mainnet at scale.

Do not treat 1 as "not started" — treat it as **the flip is config-only on the web, and this plan's Tasks 1–9 on the server.**

---

## Global constraints

- `bun` only. Server is ESM, runs `bun --hot src/index.ts`. Prefer `Bun.*` APIs.
- Prettier: no semicolons, double quotes, 2-space, trailing comma `es5`, width 80. TS `strict`.
- **Mainnet never falls back to a testnet value.** `pick()` in `apps/server/src/network-env.ts` enforces this; every sponsor resolver throws rather than substituting a default. That is load-bearing — it is the only thing between the public `POST /sponsor` route and an attacker draining the sponsor through unrelated MoveCalls. Do not add a fallback.
- **Empty string counts as unset.** A `.env` placeholder (`FOO_MAINNET=`) inlines as `""`, and `"" ?? fallback` is `""` — this already caused a bug where `predictAvailable` computed `true` on mainnet and the gate never engaged. `envOr()` (web) and the truthy checks in `pick()` (server) handle it; keep any new resolver consistent.
- Preserve the README invariants: player-signed swipe PTBs stay atomic, `Duel` never holds Predict positions, the two tiers share one engine, sponsored gas end-to-end, commit-reveal deck, keeper-fed settlement.
- **Verification baseline (measured 2026-08-29 on `89f5e86`):** `bun typecheck` is clean across all 5 workspaces. `bun --filter web test` = 107 pass / 0 fail. `bun --filter server test` = 162 pass / 84 skip / 0 fail (the 84 skip are DB-backed, need `TEST_DATABASE_URL`). `bun --filter web lint` = 44 problems (40 errors, 4 warnings), **all pre-existing** in `App.tsx`, `sui/gen/*`, and a handful of components — do not rabbit-hole fixing them; the bar is *no new* errors.
- Run the DB-backed suites for anything touching `db.ts`:
  ```
  docker run -d --name flicky-test-pg -e POSTGRES_PASSWORD=test \
    -e POSTGRES_DB=flicky_test -p 55432:5432 postgres:16-alpine
  TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/flicky_test bun test
  ```

---

## What is already correct (do not redo)

Verified while writing this plan — these need no work:

- **Indexer event cursors are already collision-free.** `DuelIndexer` builds tracker ids as `${packageId}::duel::EventName` (`indexer.ts:465-477`), and the flicky package id differs per network, so two indexers cannot fight over one `event_cursor` row.
- **`order_premiums` (PK `expiry_market_id, order_id`) and `market_settlements` (PK `expiry_market_id`)** key on chain-unique Sui object ids, so cross-network collision is not possible. Adding `network` there is optional hygiene, not correctness.
- **`player_profile` (avatars) should stay global.** An avatar is identity, not chain state — the same player should look the same on both networks. Do not add `network` to it.
- Per-network Sui/GraphQL clients, sponsor instances, `?network=` on reads, and the web's per-page-load network pin all landed in #56.

---

## File structure

- `apps/server/src/network-env.ts` — already the resolver; extend only if new chain-scoped keys appear.
- `apps/server/src/index.ts` — boot a keeper + indexer **per enabled network** instead of one on `env.network`.
- `apps/server/src/keeper.ts` — accept a `NetworkEnv` instead of reading module-level `env`.
- `apps/server/src/deckmaster.ts`, `oracle.ts`, `predict.ts`, `mint-probe.ts` — take `network` (or a `NetworkEnv`) as a parameter; stop reading the default network's `env.*`.
- `apps/server/src/ws/protocol.ts` — add `network` to the client hello / subscribe messages.
- `apps/server/src/ws/matchmaking.ts` — partition `queues`, `roomSubscribers`, `pendingPairs`, `pendingPairTimers`, `forfeitTimers` by network.
- `apps/server/src/ws/oracle-stream.ts` — one tick loop per network.
- `apps/server/src/sponsor-balance.ts` — monitor every enabled network's sponsor address.
- `apps/server/src/season.ts` — per-network season config + escrow.
- `apps/server/src/db.ts` — `network` on `deck` and `predict_manager`; widen `player_rating` PK.
- `apps/web/src/hooks/use-flicky-socket.ts`, `lib/protocol.ts` — send `network` on connect.
- `apps/contracts/scripts/publish.ts`, `deployed.json` — per-network deploy records.

---

## Task 0: ~~unblock the Predict indexer~~ — SUPERSEDED, and the premise was wrong

> **Superseded 2026-08-30 by `2026-08-30-predict-independence.md`.**
>
> This task assumed a successor hostname existed to point at. It does not.
> Measuring on 2026-08-30: the last `MarketCreated` event on 6-24 was
> **2026-08-17T21:03Z**, the last market expiry **21:15Z**, and **0 of the most
> recent 50 markets are still live** — 12.3 days of silence. Mysten wound down
> the testnet market-making cron, *then* tore down the read API. The contracts
> are still deployed and healthy, but market creation is `AdminCap`-gated so we
> cannot create our own.
>
> There is no hostname to find. **This whole plan is blocked** until Flicky can
> build a deck without Predict — see the superseding plan. Dual-network is
> meaningless while zero networks work.

- [ ] ~~Find the current DeepBook Predict indexer + propbook oracle hostnames.~~ **No successor exists — do not spend time on this.**
- [ ] Confirm the response shapes still match what `deckmaster.ts::MarketRow` and `oracle.ts` parse — CLAUDE.md warns this pin has moved before (`4-16` → `6-24`) and changed what it exposes.
- [ ] Set `PREDICT_INDEXER_URL` and `PROPBOOK_INDEXER_URL` on the `flicky-server` Railway service (no code change needed — both are already env overrides).
- [ ] Update the baked defaults in `network-env.ts::TESTNET_DEFAULTS` to match, so fresh checkouts work.
- [ ] **Verify:** `curl '<server>/oracle/list?asset=BTC'` returns a non-empty `markets` array; a practice duel generates a deck.

---

## Task 1: WS wire carries a network

The socket is the one remaining place a client can act on a chain it didn't declare. Everything in Tasks 2–3 depends on this.

- [ ] Add `network` to the client→server hello/register message in `apps/server/src/ws/protocol.ts`. Validate it against `env.enabledNetworks`; reject with a typed error otherwise. **Default to `env.network` when absent** so an old client keeps working through the rollout.
- [ ] Store the resolved network on `SocketState` (`matchmaking.ts::newSocketState`), set once at register time and immutable for the socket's life — a socket must not be able to change chains mid-session.
- [ ] Web: send `CONFIG.network` on connect in `apps/web/src/hooks/use-flicky-socket.ts`.
- [ ] **Verify:** a socket that declares `mainnet` on a deploy with `SUI_NETWORKS=testnet` is rejected with a clear error, not silently served testnet.

## Task 2: partition matchmaking by network

**This is the correctness bug that makes "both networks live" unsafe today.** `queues` is `Map<Tier, AnyWs[]>` (`matchmaking.ts:179`), so with two live networks a testnet player can be paired with a mainnet one, and the resulting duel is unplayable for both.

- [ ] Re-key `queues` to `Map<\`${Network}:${Tier}\`, AnyWs[]>` (or a nested map) and take the network from `SocketState`.
- [ ] Do the same for `pendingPairs` and `pendingPairTimers` (`:190-192`) — a pending pair is a network-scoped agreement.
- [ ] `roomSubscribers` (`:181`) and `forfeitTimers` (`:183`) key on duel id, which is a chain-unique object id, so collision is impossible — but `subscribeRoom` must still **verify the duel's network matches the socket's** before subscribing, or a mainnet client could watch a testnet room.
- [ ] `socketsByAddress` (`:177`) stays global — one player, one identity, possibly two sockets. Anything that broadcasts to an address must filter by the target network.
- [ ] `queueStats()` (consumed by `/health`) reports per-network counts.
- [ ] **Verify:** extend `matchmaking.test.ts` — two sockets on different networks in the same tier must NOT match; two on the same network must.

## Task 3: per-network keeper, indexer, and oracle stream

- [ ] `index.ts`: loop `env.enabledNetworks` and boot one `DuelIndexer` and one `Keeper` per network that has a `flickyPackageId` **and** `predictAvailable`. Both constructors already take `(client, packageId)` (`keeper.ts:398`, `indexer.ts:465`), so this is mostly wiring — pass `getSuiClient(net)`.
- [ ] `Keeper` currently reads module-level `env.*` for Predict ids and the indexer URL (`keeper.ts:255,316,616-626`). Thread a `NetworkEnv` through the constructor and use it instead.
- [ ] Same for `deckmaster.ts`, `oracle.ts`, `predict.ts` (`:153-208`), and `mint-probe.ts` (`:166-208`) — each reads the default network's `env.*` today. Give them an explicit `network` (or `NetworkEnv`) parameter; keep `env.network` as the default argument so existing call sites and tests don't churn.
- [ ] `ws/oracle-stream.ts`: one tick loop per network. `marketSubscribers` (`:29`) keys on chain-unique market ids so it can stay flat, but each tick must read that market's own network's indexer.
- [ ] Each keeper needs its own funded signer: `KEEPER_SECRET_KEY_MAINNET` (may be the same key, but the **address balance must be funded separately on mainnet with real SUI**).
- [ ] **Verify:** `/health` shows `services: "active"` for every enabled network; boot with `SUI_NETWORKS=testnet,mainnet` and confirm two indexers log independent cursors.

## Task 4: finish the database

- [ ] **Widen `player_rating`'s PRIMARY KEY** from `address` to `(address, network)`. This is the one live-data migration: drop the constraint, add the composite, and update `upsertPlayerRating`'s `ON CONFLICT (address)` target (`db.ts:747`) to `ON CONFLICT (address, network)`. Existing rows already default to `'testnet'`, so no backfill.
- [ ] `upsertPlayerRating`'s INSERT does **not** list `network` today — it relies on the column default. That is correct while only testnet writes, but becomes silently wrong the moment a second keeper runs. Stamp it explicitly, the way `upsertDuel` already does.
- [ ] Add `network` to `deck` (`db.ts:165`) and scope `getDeck` / `upsertDeck` / `deleteDeck` by it, so a testnet deck commitment can never be revealed against a mainnet duel.
- [ ] Add `network` to `predict_manager` (PK `owner`, `db.ts:182`) and widen to `(owner, network)` — an AccountWrapper is per-chain, so one owner has a different wrapper on each.
- [ ] Leave `order_premiums`, `market_settlements` (chain-unique keys) and `player_profile` (identity) alone — see "already correct" above.
- [ ] **Verify:** DB suites green with `TEST_DATABASE_URL`; a rating written on one network doesn't move the other network's leaderboard.

## Task 5: per-network season + prizes

Season prizes are real value; a testnet season and a mainnet season are different promotions with different pools.

- [ ] `season.ts` reads `env.season*` (default network) today. Make `GET /season` take `?network=` and resolve `seasonPackageId` / `seasonPoolId` / `seasonAdminCapId` from `networkEnv(net)` (they already live there).
- [ ] Decide whether `seasonId` / `seasonName` / `seasonEndsAt` / `seasonPrizeSplit` are per-network too. **Recommendation: yes** — a mainnet season should be able to run a different pool and end date. Add `SEASON_*_MAINNET` and move them into `NetworkEnv`.
- [ ] `scripts/season-deposit.ts` / `season-distribute.ts` / `season-results.ts` take a `--network` flag and refuse to run against a network whose `seasonPoolId` is unset.
- [ ] Web `lib/season.ts` already calls through `apiUrl()`, so it picks this up for free once the server is scoped.
- [ ] **Verify:** `GET /season?network=mainnet` returns the mainnet pool (or a clean "no season" shape), never testnet's.

## Task 6: publish the contracts to mainnet

- [ ] Make `deployed.json` per-network — `deployed.testnet.json` / `deployed.mainnet.json`, or a `{ [network]: record }` shape. `network-env.ts::loadFlickyPackageId` already refuses to use a record whose `network` field doesn't match, so it's safe today, but it can only ever find testnet.
- [ ] `SUI_NETWORK=mainnet bun --filter @flicky/contracts publish` for `flicky`, then `swap` and `season`. `publish.ts` already writes a `[published.mainnet]` block in `Move.toml` and a `VITE_FLICKY_PACKAGE_ID_MAINNET` env key (`publish.ts:240`), so those parts are done.
- [ ] Needs a mainnet-funded deployer wallet (`SUI_DEPLOYER_PRIVATE_KEY`). The resulting `UpgradeCap` is real value — record where it lives.
- [ ] Seed the mainnet AMM pool for `/game/shop`, or leave `SWAP_PACKAGE_MAINNET` unset (the shop stays gated, and `resolveSwapPackage` returns null so the sponsor simply doesn't allowlist swap).
- [ ] **Verify:** `/health` shows a non-null `flickyPackageId` for mainnet.

## Task 7: mainnet stake coin

- [ ] Set `DUSDC_COIN_TYPE_MAINNET` / `VITE_DUSDC_COIN_TYPE_MAINNET` to **Circle's native USDC**, not dUSDC (a testnet faucet token that does not exist on mainnet):
  `0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC`
- [ ] **Do not use bridged wUSDC** (`0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN`). It is Wormhole-bridged, not Circle-issued, and not redeemable through Circle Mint.
- [ ] **Confirm decimals on-chain before trusting the scale** — query `CoinMetadata` for the type rather than assuming. USDC is 6dp everywhere Circle issues it, which would make `DUSDC_DECIMALS`/`DUSDC_SCALE` in `apps/web/src/lib/swap.ts` correct unchanged, but a wrong scale here misprices every stake by 1000x. Verify, don't assume.
- [ ] Once verified, the `DUSDC_*` *names* lie on mainnet. Rename to `STAKE_*` / `QUOTE_*`, or leave a comment — do not leave a reader guessing whether the scale is wrong.
- [ ] Audit every user-facing "dUSDC" string for a network-appropriate label.
- [ ] **Verify:** the header balance chip reads a real mainnet USDC balance.

## Task 8: fund and monitor per network

- [ ] `sponsor-balance.ts` monitors one address (`:50-51,98`). Monitor **every enabled network's** sponsor address, with per-network warn floors — mainnet SUI is real money and deserves a higher floor than testnet.
- [ ] `scripts/fund-sponsor.ts` takes `--network`.
- [ ] Fund the mainnet sponsor **and** keeper address balances. An empty address balance surfaces as an opaque `Invalid withdraw reservation` on every `POST /sponsor` — a silent outage.
- [ ] `/health`'s `sponsorBalance` becomes per-network.
- [ ] **Verify:** `/health` shows a balance for each enabled network; drain a testnet sponsor below the floor and confirm the WARN fires.

## Task 9: web — finish the client half

- [ ] Remove the `<NetworkGate />` gating once `DUELS_ENABLED` goes true on mainnet — it is already derived from resolved ids (`config.ts`), so this should be **zero code change**. Confirm that empirically rather than assuming.
- [ ] **Add an always-visible network indicator.** The picker moved into settings (#57), so nothing in the UI says which chain you're on. That was fine while mainnet couldn't spend anything; once real funds are live, a player must not be able to swipe real USDC believing they're on testnet. A small amber marker on the header balance chips when `IS_MAINNET` is enough.
- [ ] The picker is only reachable while signed in (`<MenuButton>` renders only with an account). Today the `<NetworkGate />` "switch to testnet" button is the escape hatch; once the gate is gone that hatch disappears. Give signed-out users a way to switch.
- [ ] Add a confirmation when switching networks with a duel in flight (`/game/play/*`) — a live stake should not vanish to a misclick.
- [ ] **Verify:** full duel loop on each network; switching mid-session lands on the right chain with the right balances.

## Task 10: cross-network safety net

The failure this whole plan exists to prevent is a transaction built for one chain being executed against another. Make it structurally impossible, not merely unlikely.

- [ ] Assert in `POST /sponsor` that every MoveCall's package belongs to the **requested network's** resolved id set. `buildAllowedTargets(network)` already does this — add an explicit test that a testnet-built PTB submitted with `network: "mainnet"` is rejected.
- [ ] Add a server-side check that a duel id referenced by any write path exists on the socket's network before acting on it.
- [ ] **Verify:** a test that takes a real testnet PTB, submits it as `network: "mainnet"`, and asserts a 403/503 — never a signature.

---

## Rollout

1. Land Tasks 1–5 and 8–10 **with `SUI_NETWORKS` still unset** (testnet-only). Everything is exercised on testnet; the second network is inert. This is the safest possible way to land a partitioning refactor.
2. Task 6/7 (mainnet publish + coin) once Predict mainnet exists.
3. Flip `SUI_NETWORKS=testnet,mainnet` on Railway. **This is the only switch** — and `railway variables set ... --skip-deploys` stages it without restarting production mid-duel.
4. Kill switch: remove `mainnet` from `SUI_NETWORKS`. The web gate re-engages on its own because `predictAvailable` is derived, not flagged.

## Testing on mainnet costs real money

Plan for it rather than discovering it:

- Run the first mainnet duels at `minStakeMist` with a team-controlled pair of accounts.
- The keeper pays real gas per `settle_card` × deck size, plus `finalize`. Budget it before enabling.
- Do not point the existing e2e suites at mainnet. They create and abandon duels freely.

## Definition of done

- A player can pick either network in settings and play a complete staked duel there.
- `/health` shows `services: "active"` for both networks with independent cursors.
- Two players on different networks are never matched.
- A leaderboard, MMR rating, season pool, and duel history on one network are unaffected by the other.
- `POST /sponsor` cannot be made to co-sign a PTB for a network other than the one it was built for.
- Removing `mainnet` from `SUI_NETWORKS` cleanly returns the app to today's behavior.
