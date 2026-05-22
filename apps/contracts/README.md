# @flicky/contracts

Move 2024 package for Flicky (Tinder-style PvP prediction-duel on top of
DeepBook Predict) + TypeScript tooling for publish / upgrade / codegen
against **Sui testnet**.

## Quick reference

```bash
# Compile + run Move unit tests
bun run test               # sui move test --gas-limit 100000000000

# Compile only
bun run build              # sui move build

# First deploy to testnet (requires SUI_DEPLOYER_PRIVATE_KEY in .env.local)
bun run publish

# Upgrade after any Move change
bun run upgrade

# Regenerate TS bindings from the current Move package
bun run codegen
```

## Env setup

Copy `.env.example` to `.env.local`:

```bash
cp .env.example .env.local
```

Fill `SUI_DEPLOYER_PRIVATE_KEY`. To export your active Sui CLI keypair:

```bash
sui keytool export --key-identity $(sui client active-address)
```

Paste the resulting `suiprivkey1q...` string as the value.

## What the scripts write

`scripts/publish.ts` writes `deployed.json` with:

- `packageId` — the deployed package (changes on every upgrade).
- `originalPackageId` — first-publish package id; preserved across upgrades.
- `upgradeCap` — the cap that authorizes future upgrades.

`scripts/upgrade.ts` updates `packageId` + `previousPackageId` and mirrors
the new `packageId` into `apps/web/.env.local`. `originalPackageId` is
preserved.

## Modules

See `sources/`:

| Module | Purpose |
| --- | --- |
| `duel` | `Duel<T>` shared object: escrow + 5-card swipe state + per-card scoring + finalize. |
| `pricing` | SVI binary-digital fair pricing — reads `OracleSVI.svi()` + `forward_price()` and computes `N(d2)` (mirrors DeepBook's package-private `compute_nd2`). |
| `math` / `i64` | Fixed-point helpers (ln, sqrt, exp, normal CDF) — direct port of `deepbook_predict::math`/`i64`. |

## Local stub packages

Three "empty" Move packages exist alongside `sources/` purely to declare the
on-chain addresses of DeepBook + transitive deps for the compiler. Flicky
never inlines any of these — at runtime, calls resolve to the actual
published packages.

| Stub | Address bound | Purpose |
| --- | --- | --- |
| `deepbook_predict_min/` | `0xf5ea2b3749…` | Layout-equivalent struct re-declarations + public read API of `OracleSVI`, plus thin signatures for `predict::*`, `predict_manager::*`, `market_key::*`, `range_key::*` so codegen can emit typed builders. |
| `deepbook_min/` | `0x74cd5657…` (latest deepbook v19) | Empty placeholder. Required because deployed `deepbook_predict` references `deepbook::math` types in its linkage table — Sui's publish validator demands the full transitive closure. |
| `token_min/` | `0x36dbef86…` | Empty placeholder. `deepbook` depends on it transitively. |

The compiler tree-shakes `deepbook_min` out of the publish dep list because
nothing in our local source actually `use deepbook::*`. `scripts/publish.ts`
manually re-injects the latest deepbook address per network — see the
`FORCE_INJECT_DEPS` block. Update when DeepBook upgrades again.

> For a longer explanation of why these are separate packages (named-address
> binding + one-package-per-address constraint) see the project root chat
> log around "tại sao phải có deepbook_predict_min".

## Why codegen + how to run it

`@mysten/codegen` reads the Move package summaries and emits typed `moveCall`
builders into `apps/web/src/sui/gen/`. The web app and server can then call:

```ts
import { duel } from "@/sui/gen/flicky"
import { predict } from "@/sui/gen/deepbook_predict"

tx.add(duel.recordSwipe({
  package: CONFIG.packageId,
  arguments: [duelId, oracleId, cardIdx, isUp],
  typeArguments: [stakeCoinType],
}))
```

— no hand-rolled `${packageId}::module::function` strings, no manual BCS
arg encoding. **The output directory is gitignored**; every developer runs
`bun run codegen` after `bun install` to populate it locally. Re-run after
any Move signature change.

If codegen reports `Cannot find module '@mysten/codegen'`, run `bun install`
from the repo root.

## See also

- [`../../docs/prd.md`](../../docs/prd.md) — game design
- [`../../docs/deepbook-oracle-architecture.md`](../../docs/deepbook-oracle-architecture.md) — oracle integration model
