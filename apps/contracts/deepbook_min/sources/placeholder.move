// Vendored minimal stub of the on-chain `deepbook` package
// (testnet `0xfb28c4c…`). Empty by design — flicky never calls into
// `deepbook::*`, but the address must be declared as a transitive dep of
// `deepbook_predict` so Sui's publish validator can resolve the linkage
// table.
module deepbook::placeholder;
