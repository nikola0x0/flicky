# Oracle

URL: https://docs.sui.io/onchain-finance/deepbook-predict/contract-information/oracle

`OracleSVI` is the market state for one underlying asset and one expiry. It stores spot and forward prices, SVI volatility surface parameters, activation state, the last update timestamp, and the settlement price after expiry.

## Lifecycle

An oracle starts inactive, becomes active after `activate()` , accepts live price and SVI updates before expiry, enters pending settlement at expiry, and becomes settled when the first post-expiry price update freezes the settlement price.

Mints require a live oracle. Redeems can use quoteable live or settled oracle state. After settlement, price and SVI updates are rejected.

## API

Click to open Activate an oracle The `activate()` function moves an oracle into the active state before expiry.

Loading…

Click to open Update prices The `update_prices()` function pushes high-frequency spot and forward prices. If the oracle is past expiry and not yet settled, this call freezes the settlement price instead of recording another live update.

Loading…

Click to open Update SVI parameters The `update_svi()` function pushes lower-frequency SVI volatility surface parameters before expiry.

Loading…

Click to open Read oracle state Use these functions to read oracle identifiers, underlying asset, prices, SVI parameters, expiry, timestamp, settlement, and lifecycle status.

Loading…

Click to open Create price and SVI data These helper constructors build `PriceData` and `SVIParams` values for oracle updates.

Loading…

Click to open Read status constants These functions return the numeric status values used by `status()` .

Loading…

## Structs

Click to open `OracleSVI` Loading…

Click to open `PriceData` and `SVIParams` Loading…

## Events

Click to open Oracle events Loading…