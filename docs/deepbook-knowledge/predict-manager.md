# Predict Manager

URL: https://docs.sui.io/onchain-finance/deepbook-predict/contract-information/predict-manager

The `PredictManager` is a per-user shared accountobject **Object** The basic unit of storage on Sui. . It wraps aDeepBook **DeepBook** A decentralized central limit order book (CLOB) built on Sui.`BalanceManager` , stores quote balances, and tracks Predict positions internally.

Each user should create one manager and reuse it. Binary positions and vertical ranges are not separate onchain objects; they are quantities stored inside the manager.

## API

Click to open Read owner, balances, and position quantities Use these functions to read the manager owner, deposited asset balances, binary position quantities, and range quantities.

Loading…

Click to open Deposit quote assets The manager owner deposits quote assets before minting positions or ranges.

Loading…

Click to open Withdraw quote assets The manager owner can withdraw quote assets from the manager.

Loading…

## Events

Click to open `PredictManagerCreated` Emitted when a new `PredictManager` is created.

Loading…