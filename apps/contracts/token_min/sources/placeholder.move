// Vendored minimal stub of the on-chain `token` package
// (testnet `0x36dbef8…`). Empty by design — flicky never calls into
// `token::*`, but the address must be declared as a transitive dep of
// `deepbook_predict` so Sui's publish validator can resolve the linkage
// table.
module token::placeholder;
