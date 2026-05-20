// Vendored minimal stub of `deepbook_predict::i64`. We re-declare the I64
// type with the same field layout as the on-chain package and expose
// magnitude/is_negative readers so flicky can convert SVI params into its
// own i64 type for SVI binary-digital pricing.
module deepbook_predict::i64;

public struct I64 has copy, drop, store {
    magnitude: u64,
    is_negative: bool,
}

public fun magnitude(value: &I64): u64 { value.magnitude }

public fun is_negative(value: &I64): bool { value.is_negative }

public fun is_zero(value: &I64): bool { value.magnitude == 0 }

public fun zero(): I64 { I64 { magnitude: 0, is_negative: false } }

public fun from_u64(value: u64): I64 { I64 { magnitude: value, is_negative: false } }

public fun from_parts(magnitude: u64, is_negative: bool): I64 {
    I64 { magnitude, is_negative: is_negative && magnitude != 0 }
}
