# Registry

URL: https://docs.sui.io/onchain-finance/deepbook-predict/contract-information/registry

The `Registry` sharedobject **Object** The basic unit of storage on Sui. tracks the Predictobject ID and the oracle IDs created by each `OracleSVICap` . The registrymodule **Module** A component of a Move package that defines interaction with on-chain objects. also exposes admin entry points for setup, quote asset management, oracle creation, pricing configuration, risk configuration, and the withdrawal limiter.

Most app integrations do not call these functions directly. They are operator and governance surfaces for deploying and maintaining the protocol.

## API

Click to open Read registeredobject IDs Use these functions to read the active Predictobject ID and the oracle IDs associated with an oracle cap.

Loading…

Click to open Create the Predictobject The `create_predict()` function creates the shared `Predict`object once for a quote asset and records its ID in the registry.

Loading…

Click to open Create and register oracle caps Oracle caps authorize oracle operators to update oracles and tighten per-oracle ask bounds.

Loading…

Click to open Create an oracle The `create_oracle()` function creates an `OracleSVI` , associates it with the calling cap, and initializes the Predict vault's strike grid for that oracle.

Loading…

Click to open Manage quote assets Admins can enable or disable quote assets for new supply and mint inflows.

Loading…

Click to open Configure pricing These functions control global spread, minimum spread, utilization multiplier, and global ask price bounds.

Loading…

Click to open Configure oracle ask bounds Oracle ask-bound overrides are authorized by the oracle's cap and can only tighten the global bounds.

Loading…

Click to open Configure trading and risk controls These functions control the trading pause, max total exposure percentage, and LP withdrawal limiter.

Loading…

## Structs and events

Click to open `Registry` and `AdminCap` Loading…

Click to open Registry events Loading…