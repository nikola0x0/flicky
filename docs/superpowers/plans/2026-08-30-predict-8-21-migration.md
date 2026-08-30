# Predict 8-21 Migration Implementation Plan

> **Design:** [2026-08-30-predict-8-21-migration-design.md](../specs/2026-08-30-predict-8-21-migration-design.md)

**Goal:** Prepare Flicky to run against DeepBook Predict `predict-testnet-8-21`
without publishing or changing live testnet state.

## Task 1: Deployment configuration and cache isolation

- [x] Add failing server/web assertions for the 8-21 package, object, feed,
      endpoint, and wrapper-cache namespaces.
- [x] Replace baked testnet defaults and env examples from the upstream
      deployment manifest.
- [x] Rename spot/forward/SVI configuration to value-store/SVI-store.
- [x] Verify focused config and wrapper tests.

## Task 2: Player mint PTBs

- [x] Add a failing transaction-shape test proving `load_live_pricer` receives
      seven explicit objects and `mint_exact_quantity` has no leverage argument.
- [x] Update the web builder, server mint probe, deploy diagnostic, and E2E
      builder to the 8-21 ABI.
- [x] Verify focused web/server tests and typechecking.

## Task 3: Keeper redemption and event compatibility

- [x] Change keeper tests to require `redeem_settled_permissionless` and its
      seven explicit arguments.
- [x] Add event parser tests for `premium` and `onchain_timestamp_ms`, retaining
      compatibility with old cursor data during cutover.
- [x] Implement the keeper and indexer changes.
- [x] Verify focused keeper/indexer tests.

## Task 4: Move dependency and generated-source boundary

- [x] Point minimized account and Predict dependencies at the 8-21 published
      package ids and update source documentation.
- [x] Rebuild Move dependencies and run Move tests.
- [x] Document that Flicky needs a fresh publish because the public dependency
      type identity changed; defer binding regeneration until that package exists.

## Task 5: Operational migration surface

- [x] Update tracked env examples, diagnostic names/output, README/CLAUDE
      deployment references, and the explicit cutover checklist.
- [x] Ensure no production code retains a 6-24 package/object/feed/API default.
- [x] Keep legacy diagnostics clearly marked rather than silently repointing
      unsupported flows.

## Task 6: Verification and draft PR

- [x] Run formatting, typecheck, web tests, server tests, and Move tests.
- [x] Review the diff for secrets, live-state mutations, and stale deployment
      identifiers.
- [ ] Commit, push `feat/predict-8-21-migration`, and open a draft PR noting
  that `check:8-21`, the live transaction E2E suite, and the browser gameplay
  test are required before merge.
