# Predict

URL: https://docs.sui.io/onchain-finance/deepbook-predict/contract-information/predict

The `Predict` sharedobject **Object** The basic unit of storage on Sui. is the main protocol entry point. It coordinates user actions across manager balances, oracle state, pricing config, risk config, and vault accounting.

## API

Following are the public functions that applications use most often.

Click to open Create a `PredictManager` The `create_manager()` function creates a new shared `PredictManager` for the caller and returns itsobject ID.

Loading…

Click to open Preview binary position amounts The `get_trade_amounts()` function returns the mint cost and redeem payout for a binary position at the requested quantity.

Loading…

Click to open Mint a binary position The `mint()` function buys a binary position using an enabled quote asset deposited in the caller's `PredictManager` .

Loading…

Click to open Redeem a binary position The `redeem()` function sells a binary position and deposits the payout back into the owner's `PredictManager` .

Loading…

Click to open Redeem a settled binary position permissionlessly The `redeem_permissionless()` function lets anyone redeem a settled position into the owner's `PredictManager` .

Loading…

Click to open Preview range amounts The `get_range_trade_amounts()` function returns the mint cost and redeem payout for a vertical range at the requested quantity.

Loading…

Click to open Mint a vertical range The `mint_range()` function buys a bounded range position. The range is keyed by oracle ID, expiry, lower strike, and higher strike.

Loading…

Click to open Redeem a vertical range The `redeem_range()` function sells a range position and deposits the payout into the owner's `PredictManager` .

Loading…

Click to open Supply vault liquidity The `supply()` function deposits an accepted quote asset into the vault and returns `PLP` shares.

Loading…

Click to open Withdraw vault liquidity The `withdraw()` function burns `PLP` shares and returns the selected quote asset when the requested amount is available after max payout coverage.

Loading…

Click to open Compact settled oracle exposure The `compact_settled_oracle()` function lets an authorized oracle operator compact settled strike-matrix exposure into constant-size settled state.

Loading…

Click to open Read protocol configuration These read functions expose trading pause state, accepted quote assets, pricing parameters, risk limits, ask bounds, and currently available withdrawal amount.

Loading…

## Events

Click to open Trading events Loading…

Click to open Liquidity events Loading…

Click to open Configuration events Loading…