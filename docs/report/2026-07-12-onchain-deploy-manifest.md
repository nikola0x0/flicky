# On-Chain Deploy Manifest — 6-24 Migration + Demo Hardening

**Date:** 2026-07-12 · **Network:** Sui **testnet** · **Branch:** `fix/matchmaking-smoothness` (umbrella PR → `main`)

This branch bundles the full `4-16 → 6-24` Predict migration plus the demo-hardening,
watch-chart, and matchmaking work. This manifest lists every package ID and shared
object the app binds to, flags **what changed on-chain**, and points to the
source-of-truth file for each id so the team can verify a deploy in one place.

---

## TL;DR — what changed on-chain vs `main`

- **The whole DeepBook Predict target set moved from 4-16 to 6-24** (new Predict/account
  packages + new shared objects + BlockScholes/Pyth feeds). These are **external**
  Mysten-operated objects we point at; we did not deploy them.
- **We published our own `flicky` Move package, then re-published it once:**
  - `0x6c6be720…d3cbfb` — first 6-24 publish (2026-07-09)
  - **`0x5ceae1ca…78582f` — current, re-published 2026-07-11** to carry the
    `SWIPE_WINDOW_MS 600_000 → 300_000` (10 → 5 min) contract change. Old testnet
    duels on the previous package are orphaned (accepted).
- No other on-chain object was created or mutated by us.

---

## 1. Flicky package (ours) — the only thing we deploy

| Field | Value |
|---|---|
| **packageId (current)** | `0x5ceae1cacbba1862e0f0c4e8861280b8a1e9530ce4049317daf5d3951778582f` |
| **originalPackageId** | `0x5ceae1cacbba1862e0f0c4e8861280b8a1e9530ce4049317daf5d3951778582f` |
| **publishTxDigest** | `6zEwmQyySXF17FUE5hXn9V1tqFEuvF4gr3MbqTyY1EDU` |
| **upgradeCap** | `0xcc760f1181fea3f0cb5dd03bf7af6a1db4def10f806e70218bc65f2e868e6746` |
| **publisherAddress** | `0x9826b0895f3adc08f2f4c8907640adf2f29351ec7829281050ded1020e296d5a` |
| **publishedAt** | 2026-07-11T14:09:34Z |
| **network** | testnet |

**Republish lineage:**

| When | packageId | Reason |
|---|---|---|
| 2026-07-09 | `0x6c6be7201465b165c82e717b75074060208495118dbda5afb19471be89d3cbfb` | First 6-24 publish |
| **2026-07-11 (current)** | `0x5ceae1cacbba1862e0f0c4e8861280b8a1e9530ce4049317daf5d3951778582f` | `SWIPE_WINDOW_MS` 10 → 5 min |

**Source of truth & propagation (all updated to the new id in this branch):**

- `apps/contracts/deployed.json` — canonical (`packageId`, `upgradeCap`, tx digest, publisher). Server reads this via `loadFlickyPackageId()` unless `FLICKY_PACKAGE_ID` env overrides.
- `apps/contracts/Published.toml` — CLI-shaped mirror, synced by `scripts/publish.ts`.
- `apps/web/src/lib/config.ts:22` — committed web default (`packageId`).
- `apps/web/.env.production:16` / `apps/web/.env.example:13` — `VITE_FLICKY_PACKAGE_ID_TESTNET`.
- `apps/web/.env.local` — local runtime `VITE_FLICKY_PACKAGE_ID_TESTNET` (gitignored; written by `publish.ts`).
- ⚠️ No committed file still references the old `0x6c6be720…` except historical docs.

---

## 2. DeepBook Predict 6-24 external dependencies (we point at these; not ours)

Canonical list: `apps/web/src/lib/config.ts`; mirrored server-side in `apps/server/src/env.ts`.

| Object | ID | Env override |
|---|---|---|
| DeepBook **Predict package** | `0xdb3ef5a5129920e59c9b2ae25a77eddb48acd0e1c6307b97073f0e076016446e` | `VITE_DEEPBOOK_PREDICT_PACKAGE_ID` |
| Predict **ProtocolConfig** (shared) | `0x2325224629b4bd96d1f1d7ee937e07f8a06f861018a130bbb26db09cb0394cb6` | `VITE_DEEPBOOK_PROTOCOL_CONFIG_ID` |
| Predict **PoolVault** (shared) | `0xfde98c636eb8a7aba59c3a238cfee6b576b7118d1e5ffa2952876c4b270a3a2a` | `VITE_DEEPBOOK_POOL_VAULT_ID` |
| Predict **Registry** (shared) | `0x54afbf245caf42466cedb5756ed7816f34f544afdfa13579a862eccf3afa21ca` | `VITE_DEEPBOOK_PREDICT_REGISTRY_ID` |
| DeepBook **Account package** | `0xb9389eac8d59170ffd1427c1a66e5c8306263464fcc6615e825c1f5b3e15da3b` | `VITE_DEEPBOOK_ACCOUNT_PACKAGE_ID` |
| Account **Registry** (shared) | `0x3c54d5b8b6bca376fc289121838ad02f8a5b3843242b9ad7e8f8245720e685a2` | `VITE_DEEPBOOK_ACCOUNT_REGISTRY_ID` |
| **Oracle Registry** (shared) | `0xf3deaff68cbd081a35ec21653af6f671d2ad5f012f3b4d817d81752843374136` | `VITE_DEEPBOOK_ORACLE_REGISTRY_ID` |
| **Pyth BTC feed** | `0xc78d7de16217d46d21b92ae475da799448be30b71a758dc6d7bb3ac2f1c35afb` | `VITE_DEEPBOOK_PYTH_FEED_ID` |
| **BlockScholes Spot feed** | `0xcdc5fa7364e60fd2504aa96f65b707dc0734e507a919b1a7d7d63164fd67b745` | `VITE_DEEPBOOK_BS_SPOT_FEED_ID` |
| **BlockScholes Forward feed** | `0xe72c734ea8d8dcbc9183d9d8f96f51aaa1fb5034d5ed33ac60d67d261e15b48a` | `VITE_DEEPBOOK_BS_FORWARD_FEED_ID` |
| **BlockScholes SVI feed** | `0xdc2f8270676bd05fb28491e8d4a41a495722fda7a454926dd66dbba256a21c69` | `VITE_DEEPBOOK_BS_SVI_FEED_ID` |
| **AccumulatorRoot** (system) | `0xacc` (`0x2::accumulator::AccumulatorRoot`) | `VITE_DEEPBOOK_ACCUMULATOR_ROOT_ID` |
| **Sui Clock** (system) | `0x6` | — |

> `0xacc` is a real well-known system object (the accumulator root), not a placeholder —
> required on every mint / redeem / deposit / withdraw. Confirmed live during the
> Plan-4 E2E.

**Off-chain services:**

| Service | URL | Env override |
|---|---|---|
| Predict indexer / Pyth latest | `https://predict-server-beta.testnet.mystenlabs.com` | `VITE_DEEPBOOK_PREDICT_INDEXER_URL` / `propbookIndexerUrl` |

The oracle stream now sources the live BTC spot from `GET /oracles/<pythFeedId>/pyth/latest`
on this indexer (`readBtcSpot`), same source deck-gen uses — see the watch-chart work.

---

## 3. Coin types & stake constants

| Item | Value | Where |
|---|---|---|
| Duel stake coin type | `0x2::sui::SUI` | `config.ts:95` (`stakeType`) |
| dUSDC (per-swipe premium, funding account) | 6-decimal | server/web bigint math |
| Swap pool (dUSDC ↔ SUI, local dev) | `VITE_SWAP_POOL_ID` in `apps/server/.env.local` (gitignored) | local only |

> Note: the README describes a dUSDC side-pot; the current on-chain `Duel` escrow uses
> `stakeType = 0x2::sui::SUI` for the side-pot while swipes mint dUSDC-denominated Predict
> positions. Flagged in PR #22 review as a team-confirm item (`Duel<SUI>` vs `Duel<DUSDC>` —
> the Plan-3 critical fix threads `stakeCoinType` so staked swipes use the duel's coin type).

---

## 4. Verify a deploy (checklist)

1. `apps/contracts/deployed.json` → `packageId == 0x5ceae1ca…78582f`.
2. `apps/web/src/lib/config.ts:22` and `apps/web/.env.production:16` → same id.
3. `grep -rn 0x6c6be720 apps/` → only docs hits (no live env/config still on the old package).
4. `readBtcSpot()` against `predictIndexerUrl` returns a non-zero live BTC price.
5. All 13 DeepBook 6-24 objects above resolve to live objects on testnet (Plan-4 gate confirmed).

---

## Related docs

- `docs/report/2026-07-11-predict-6-24-update.md` — the 6-24 migration state + outstanding-issues backlog.
- `docs/superpowers/specs/2026-07-11-watch-pnl-timeline-design.md` + plan — watch-chart feature.
- `temp/docs/matchmaking-smoothness-report.md` — matchmaking find-match analysis (gitignored scratch).
