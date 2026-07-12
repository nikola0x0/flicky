# `season` — prize escrow

Standalone Move package for Season prize payouts. Published separately from the
`flicky` duel package (like `swap/`) so a **real-funds** contract has its own
publish/upgrade cadence and admin key, decoupled from game-logic upgrades.

- Module: `season::prize_pool`
- One `PrizePool<T>` shared object per season holds the prize `Balance<T>` (SUI).
- **Admin-operated, not player-facing** — only the team calls `create_pool` /
  `distribute` / `withdraw_remainder`, and the team pays its own gas, so this
  package needs **no** entry in the server's sponsor allowlist.

## Deployed (testnet)

Published from the deploy wallet `0x9c08a74c…` (`SUI_DEPLOYER_PRIVATE_KEY`);
canonical record in `deployed.json`.

| | |
|---|---|
| packageId | `0x11c92f8fec8f75c2b0649cbfe45a844df4a34a51457d42ed1aac46b370a75990` |
| AdminCap | `0x7bcfe7ad000649f4dcc658aa56ec12d1984b294d61886aac75e516d35cdd6f04` (owned by the deployer) |
| UpgradeCap | `0x971d568fe1f0ddbb0133934d2325568bf72acd9f560a28fe10a329ae2781eb68` |
| PrizePool | `0xd3b8c7fb0a129f16e193187cc3ee1067d600bceea5d7f01d6b1ebda61edf4d1a` (shared, `season-0`) |

`SEASON_PACKAGE_ID` + `SEASON_POOL_ID` are set in `apps/server/.env` (and on
Railway), surfaced by `GET /season`. The pool exists but is **empty** — funding
it (the prize SUI) is a deliberate treasury `deposit`, not a dev/CI action.

## Safety model

- `AdminCap` is minted to the publisher in `init`. Every fund-moving entry
  (`create_pool`, `distribute`, `withdraw_remainder`) requires it.
- `deposit` is permissionless (funding is always safe).
- `distribute` is single-shot (`distributed` lock) and asserts matched
  winner/amount lengths and `sum(amounts) <= balance` — it can neither replay
  nor over-spend.
- `withdraw_remainder` is the recovery hatch — funds are never stuck.

## Build & test

```bash
cd apps/contracts/season
sui move build
sui move test        # 4 tests: payout, lock, both guards, recovery
```

## Deploy & operate (season end)

Deployment is a **manual, deliberate step** (it custodies real SUI).

```bash
# 1. Publish. Note the packageId AND the AdminCap object id from the output.
sui client publish --gas-budget 100000000

# 2. Create the pool (admin). ends_at_ms is informational.
sui client call --package <PKG> --module prize_pool --function create_pool \
  --type-args 0x2::sui::SUI \
  --args <ADMIN_CAP> 0x$(printf 'season-0' | xxd -p) 1785283199000 \
  --gas-budget 20000000
# → note the shared PrizePool object id.

# 3. Fund it — send the prize SUI in (anyone can; here the treasury).
sui client call --package <PKG> --module prize_pool --function deposit \
  --type-args 0x2::sui::SUI --args <POOL> <SUI_COIN> --gas-budget 20000000

# 4. At season end: `bun --filter server season:results` prints the eligible
#    winners + amounts. Feed that list to distribute (admin):
sui client call --package <PKG> --module prize_pool --function distribute \
  --type-args 0x2::sui::SUI \
  --args <ADMIN_CAP> <POOL> '[<W1>,<W2>,…]' '[<A1>,<A2>,…]' \
  --gas-budget 30000000

# 5. Recover any leftover (optional / if cancelled):
sui client call --package <PKG> --module prize_pool --function withdraw_remainder \
  --type-args 0x2::sui::SUI --args <ADMIN_CAP> <POOL> --gas-budget 20000000
```

After publishing, run `sui-ts-codegen` (see `apps/contracts/sui-codegen.config.ts`)
if you want typed TS bindings, and wire the packageId where the payout tooling
needs it. Amounts are in the coin's base units (SUI = MIST, 1 SUI = 1e9).
