# Vault

URL: https://docs.sui.io/onchain-finance/deepbook-predict/contract-information/vault

The Predict vault holds accepted quote assets and takes the opposite side of every trade. `predict.move` owns pricing and trading orchestration; `vault.move` is the state machine for balances, exposure, mark-to-market liability, max payout, and settled-oracle compaction.

LPs interact with the vault through `predict::supply` and `predict::withdraw` , which mint and burn `PLP` shares. See [Predict](/onchain-finance/deepbook-predict/contract-information/predict) for those public liquidity entry points.

## Read functions

Click to open Vault balances and value Use these functions to read total vault balance, concrete asset balances, total mark-to-market liability, vault value, and total max payout.

Loading…

## Structs

Click to open `Vault` Loading…

Click to open `SettledOracleState` After settlement compaction, the vault stores compact per-oracle remaining quantity and liability.

Loading…

Click to open `PLP` `PLP` is the LP share coin minted when users supply vault liquidity.

Loading…