// Vendored minimal stub of `deepbook_predict::i64`. We only need the I64
// type to exist with the same field layout as the on-chain package; flicky
// never calls i64 functions directly.
module deepbook_predict::i64;

public struct I64 has copy, drop, store {
    magnitude: u64,
    is_negative: bool,
}
