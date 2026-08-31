# DeepBook Predict 8-21 Migration Handoff

Last updated: 2026-08-31 (Asia/Ho_Chi_Minh)

## Objective and current status

Migrate Flicky from the deprecated DeepBook Predict testnet deployment to
MystenLabs `deepbookv3` branch `predict-testnet-8-21`, publish the compatible
Flicky package, and verify the live transaction flow before merge.

The implementation and automated live fast-path verification are complete on
the migration branch. The remaining pre-merge gate is a manual browser game
that is allowed to reach real market expiry, followed by keeper-driven
`settle_card -> finalize -> redeem_settled` verification.

## Git and PR

- Repository: `nikola0x0/flicky`
- Branch: `feat/predict-8-21-migration`
- Worktree used during migration: `/private/tmp/flicky-predict-8-21`
- Draft PR: <https://github.com/nikola0x0/flicky/pull/63>
- Latest implementation commit before this handoff document: `0ee5564`

Migration commits, oldest first:

1. `7b4d01e` — migrate DeepBook Predict to testnet 8-21
2. `cd8ec2f` — fix gRPC response parsing in the publish script
3. `fb50539` — make the live E2E tolerate current market supply
4. `6108aa0` — guard the live E2E funding budget and reuse a deterministic challenger
5. `c0c6599` — add live swipe-cost headroom to the E2E wrapper reserve
6. `0ee5564` — point frontend gameplay at the newly published Flicky package

## Published testnet deployment

- Flicky package:
  `0x23650c9d799238da660c602a6fe02074f864ce3ff2cc90f569a8eaa754b0418b`
- UpgradeCap:
  `0x707afbe1dc1ecdf2d9ebf3a6fd72c9909303f75e60ece90c26faa6e9676c6ba4`
- Publish transaction:
  `HCMjwKNuCVEXiZiq2hjaaL6Kit45BXhUAJk8pkQhJGeF`
- Testnet chain identifier: `4c78adac`

The package and UpgradeCap are recorded in:

- `apps/contracts/deployed.json`
- `apps/contracts/Published.toml`

The publish transaction succeeded on-chain before the original script aborted.
Do not publish another package to repair that historical error. The artifacts
were recovered from the successful transaction, and `publish.ts` was fixed.

## DeepBook Predict 8-21 configuration

Important testnet targets are already mirrored into server/web configuration:

- Predict package:
  `0x421041754244cf0e985fb9c9f5e1f49428caf3df4cde3a7b266d8e18ea63597b`
- Account package:
  `0xa94ec89b6cbb3e2609c7ca65bd77885b7513f852922ebdf8e766851fb6f85259`
- Account registry:
  `0x5682c73d657de1546374e632369a25c82744c8a20e9b4f47e6558e3d4bde88d3`
- Predict registry:
  `0x3d486bd50bb5bb5450ddbcb4f74776b6135f416c09024a6674ac266e77e1870a`
- Predict indexer:
  `https://predict-server-v4.testnet.mystenlabs.com`
- dUSDC type:
  `0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC`

See `apps/server/.env.example`, `apps/web/.env.example`, and
`apps/web/src/lib/config.ts` for the full shared-object set.

## Key migration changes

- The frontend and E2E swipe PTB now use the 8-21 flow:
  `generate_auth -> load_live_pricer -> mint_exact_quantity -> record_swipe`.
- `load_live_pricer` uses the new value/SVI store inputs.
- The removed leverage argument is no longer passed to `mint_exact_quantity`.
- The returned DeepBook `order_id` is chained into Flicky's `record_swipe` in
  the same atomic PTB.
- Wrapper caches use the new `flicky.wrapper.v3` namespace so old deployment
  wrappers cannot leak into 8-21 gameplay.
- Keeper/indexer parsing and settlement builders were migrated to the 8-21
  event and object shapes.
- The E2E challenger is deterministic and reusable instead of generating and
  losing a funded private key on every run.
- The E2E deck is fixed at three cards for bounded spend and an odd result.
- The E2E uses 3 dUSDC notional per swipe; production gameplay remains at 6.
- The E2E reserves 3 dUSDC of wrapper float per card. Unused float remains in
  the deterministic wrappers for later runs.

## Verification already completed

### Live deploy gate

`bun run check:8-21` passed the hard testnet gates, including shared-object
resolution, live market discovery, and `load_live_pricer` simulation.

### Live three-card E2E

The successful run covered:

1. Discovery of three live BTC expiry markets
2. Deterministic challenger funding
3. AccountWrapper creation/top-up for both players
4. Duel create, join, and deck reveal
5. Six atomic `mint_exact_quantity -> record_swipe` transactions
6. `finalize_test_one_price` and typed `DuelFinalized` event extraction

Result: 6 passed, 1 intentionally skipped, 0 failed.

- Successful duel:
  `0x3e613650534278ed78e7ddc0cdbf64ffd04469d57a35a638801b0e5d724b9feb`
- Winner: p1
- Payout: 2 dUSDC

The skipped test is explicitly the real-expiry slow path:
`settle_card x deckSize -> finalize -> redeem_settled`.

### Unpaid verification

- Server typecheck: passed
- Server suite: 204 passed, 84 skipped, 0 failed
- Web typecheck: passed
- Web suite: 116 passed, 0 failed
- Web production build: passed

The web build emits only the existing large-chunk warning.

## Live-test accounts and remaining funds

Never commit or print private keys. The ignored
`apps/server/.env.local` in the migration worktree contains the signer wiring
used for the live test.

- Creator/p0:
  `0x9c08a74cca711f45a176765e9db499f01def450fa90320a4c23934b2082aa882`
- Deterministic challenger/p1:
  `0xb62a2678ac1bb4f7b7c73d7e3c918c66dd525f740b0e6b81b28c13523d4b8f53`
- p0 wrapper:
  `0x6464553faa6c56e27c0cafb144ab6b08e892d1527c606c729e8a4ef2313d38a4`
- p1 wrapper:
  `0x01de02e894bb1fcd75ef16923f1cd130bc2ea452610d7f613bc0ca4f4efe5e3f`

Balances immediately after the successful run:

- p0 wallet: 28.535546 dUSDC
- p0 wrapper: 4.273350 dUSDC
- p1 wrapper: 3.801497 dUSDC
- p1 wallet: 0 dUSDC and 0 SUI (cleanup returned wallet funds to p0)

Wrapper funds are reusable. Do not mistake a lower wallet balance for all funds
having been spent.

## Why the first funded attempt stopped

The initial corrected-quantity attempt reserved 2 dUSDC per card. Two p1 DOWN
swipes left 1.846273 dUSDC in its wrapper; a read-only quote for the third swipe
was 1.844092 shortly afterward. Normal live price/fee drift crossed that nearly
zero margin and caused `account::withdraw_balance` abort code 1.

Commit `c0c6599` raises the reusable reserve to 3 dUSDC per card. The next
single attempt passed. Do not reduce this reserve based only on ATM premium;
8-21 charges an all-in cost that also includes trading fees, builder fees,
EWMA penalties, and inventory impact.

## Frontend readiness and deployment warning

The frontend 8-21 transaction builder was already migrated, but the freshly
published Flicky package ID was initially missing from tracked web defaults.
Commit `0ee5564` synchronizes:

- `apps/web/.env.production`
- `apps/web/.env.example`
- `apps/web/src/lib/config.ts`
- the root `README.md`

A browser game must run from this branch or from a deployment rebuilt from this
branch. An older production deployment still targets the old package.

Also inspect host-level build variables before deploying. If Railway or another
host defines `VITE_FLICKY_PACKAGE_ID_TESTNET`, it overrides the repository file
and must be set to:

`0x23650c9d799238da660c602a6fe02074f864ce3ff2cc90f569a8eaa754b0418b`

The server deployment must likewise use the new Flicky package and the 8-21
DeepBook object IDs from `apps/server/.env.example`.

## Remaining manual browser/keeper gate

Before merging PR #63:

1. Build/deploy both web and server from `feat/predict-8-21-migration`, or run
   them locally from `/private/tmp/flicky-predict-8-21`.
2. Confirm the wallet is on Sui testnet.
3. Confirm the browser account has SUI for gas and enough dUSDC/wrapper balance
   for the chosen staked tier.
4. Start or match a real staked duel.
5. Verify account onboarding/deposit if the wallet has no 8-21 wrapper.
6. Complete every swipe and confirm the wallet signs the atomic 8-21 PTBs.
7. Let the expiry markets settle; do not use `finalize_test_one_price`.
8. Confirm the keeper submits each `settle_card`, then `finalize`, then
   permissionless `redeem_settled` for the recorded orders.
9. Confirm the result screen, payouts, balances, and indexer-backed duel state
   update after transaction finality.
10. Record transaction digests and any console/server errors on PR #63.

If a transaction fails, stop before retrying repeatedly: live E2E/gameplay
spends testnet dUSDC. Capture the failed transaction, exact card/player stage,
wallet balance, and wrapper balance first.

## Useful commands

From the migration worktree:

```bash
cd /private/tmp/flicky-predict-8-21

# Hard deploy gate (reads apps/server/.env.local when run from the server app)
cd apps/server
bun run check:8-21

# Return to repository root for unpaid verification
cd ../..
bun --filter server typecheck
bun --filter server test
bun --filter web typecheck
bun --filter web test
bun --filter web build
```

The funded live E2E command is intentionally not presented as a routine check.
If another paid run is explicitly authorized, load the ignored server env and
run exactly one attempt:

```bash
cd /private/tmp/flicky-predict-8-21
set -a
source ./apps/server/.env.local
set +a
cd apps/server
bun test src/scripts/e2e.test.ts --timeout 900000
```

## Known unrelated issue

`bun --filter server lint` has a pre-existing error in
`apps/server/src/deckmaster.ts` for the unused `_ttl` destructuring binding.
The same line exists on `origin/main`; it was not introduced by this migration.
Do not attribute it to the 8-21 changes without checking the base branch.
