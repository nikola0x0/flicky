# Market Keys

URL: https://docs.sui.io/onchain-finance/deepbook-predict/contract-information/market-keys

`MarketKey` and `RangeKey` identify the internal position quantities stored in a `PredictManager` .

Use `MarketKey` for binary positions keyed by oracle ID, expiry, strike, and direction. Use `RangeKey` for vertical ranges keyed by oracle ID, expiry, lower strike, and higher strike.

## Binary position keys

Click to open Create `MarketKey` values Use `up()` , `down()` , or `new()` to create keys for binary positions.

Loading…

Click to open Read `MarketKey` fields Loading…

## Range keys

Click to open Create `RangeKey` values Use `new()` to create a vertical range key. It aborts if `lower_strike` is not less than `higher_strike` .

Loading…

Click to open Read `RangeKey` fields Loading…

## Structs

Click to open `MarketKey` Loading…

Click to open `RangeKey` Loading…