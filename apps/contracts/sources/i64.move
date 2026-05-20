// Copyright (c) Flicky Labs
// SPDX-License-Identifier: Apache-2.0

/// Signed u64 magnitude with normalized zero. Used by the SVI/Black-Scholes
/// fair-price computation in `flicky::oracle`. Mirrors DeepBook's
/// `deepbook_predict::i64` but lives in our package (separate type identity).
module flicky::i64;

const EOverflow: u64 = 0;
const EZeroDivisor: u64 = 1;
const MAX_U64: u64 = 18_446_744_073_709_551_615;
const FLOAT_SCALING: u64 = 1_000_000_000;

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
    if (magnitude == 0) zero() else I64 { magnitude, is_negative }
}

public fun neg(value: &I64): I64 {
    if (value.magnitude == 0) {
        zero()
    } else {
        I64 { magnitude: value.magnitude, is_negative: !value.is_negative }
    }
}

public fun add(a: &I64, b: &I64): I64 {
    if (a.is_negative == b.is_negative) {
        assert!(a.magnitude <= MAX_U64 - b.magnitude, EOverflow);
        from_parts(a.magnitude + b.magnitude, a.is_negative)
    } else if (a.magnitude >= b.magnitude) {
        from_parts(a.magnitude - b.magnitude, a.is_negative)
    } else {
        from_parts(b.magnitude - a.magnitude, b.is_negative)
    }
}

public fun sub(a: &I64, b: &I64): I64 {
    let neg_b = neg(b);
    add(a, &neg_b)
}

/// `(a * b) / FLOAT_SCALING`, signs XOR.
public fun mul_scaled(a: &I64, b: &I64): I64 {
    let product = ((a.magnitude as u128) * (b.magnitude as u128)) / (FLOAT_SCALING as u128);
    assert!(product <= (MAX_U64 as u128), EOverflow);
    from_parts(product as u64, a.is_negative != b.is_negative)
}

/// `(a * FLOAT_SCALING) / b`, signs XOR.
public fun div_scaled(a: &I64, b: &I64): I64 {
    assert!(b.magnitude > 0, EZeroDivisor);
    let quotient = ((a.magnitude as u128) * (FLOAT_SCALING as u128)) / (b.magnitude as u128);
    assert!(quotient <= (MAX_U64 as u128), EOverflow);
    from_parts(quotient as u64, a.is_negative != b.is_negative)
}

/// Square in fixed point; result is always nonnegative.
public fun square_scaled(value: &I64): u64 {
    mul_scaled(value, value).magnitude
}
