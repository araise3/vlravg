//! Vector, rotator and replicated-movement decoders. The helpers below write
//! each wire format with `vrf_testkit`, so a test pins the layout both
//! ways.

use super::str_value;
use crate::decode::{DecodeError, DecodedValue, FieldType, decode_field};
use crate::types::{RotatorQuantization, VectorQuantization};
use vrf_testkit::{BitWrite, BitWriter};

/// A scaled packed vector: a SerializedInt(128) header of `width | 1 << 6`
/// (the "scaled integer" flag), then three `width`-bit signed components.
fn packed_vector(bits: &mut BitWriter, components: [i64; 3], width: u32) {
    bits.serialized_int(width | (1 << 6), 1 << 7);
    for component in components {
        bits.bits(component as u64, width);
    }
}

/// A compressed rotator component: a presence bit, then `width` bits if set.
fn rotator_component(bits: &mut BitWriter, value: u16, width: u32) {
    bits.bits(u64::from(value != 0), 1);
    if value != 0 {
        bits.bits(value.into(), width);
    }
}

fn decode_bits(field_type: FieldType, bits: &BitWriter) -> Result<DecodedValue, DecodeError> {
    let (data, bit_count) = bits.finish();
    decode_field(field_type, &data, bit_count)
}

fn movement(rotation: RotatorQuantization, location: VectorQuantization) -> FieldType {
    FieldType::RepMovement { rotation, location }
}

#[test]
fn vector_float_reads_three_floats() {
    let data: Vec<u8> = [1.25f32, -2.5, 3.75]
        .iter()
        .flat_map(|v| v.to_le_bytes())
        .collect();
    let result = decode_field(FieldType::VectorFloat, &data, 96).unwrap();
    assert_eq!(result, str_value("(1.25,-2.5,3.75)"));
}

#[test]
fn vector_double_reads_three_doubles() {
    let data: Vec<u8> = [1.25f64, -2.5, 3.75]
        .iter()
        .flat_map(|v| v.to_le_bytes())
        .collect();
    let result = decode_field(FieldType::VectorDouble, &data, 192).unwrap();
    assert_eq!(result, str_value("(1.25,-2.5,3.75)"));
}

/// Each `VectorNetQuantize` level divides the packed integers by its scale,
/// and the `VectorQuantization` levels are Unreal's divisors, in order.
#[test]
fn quantized_vector_divides_by_its_scale() {
    for (level, scale, width, packed, want) in [
        (
            VectorQuantization::RoundWholeNumber,
            1,
            6,
            [10, -2, 3],
            "(10,-2,3)",
        ),
        (
            VectorQuantization::RoundOneDecimal,
            10,
            7,
            [12, -34, 56],
            "(1.2,-3.4,5.6)",
        ),
        (
            VectorQuantization::RoundTwoDecimals,
            100,
            11,
            [123, -456, 789],
            "(1.23,-4.56,7.89)",
        ),
    ] {
        assert_eq!(level.scale(), scale, "{level:?}");
        let mut bits = BitWriter::new();
        packed_vector(&mut bits, packed, width);
        let result = decode_bits(FieldType::VectorNetQuantize { scale }, &bits);
        assert_eq!(result.unwrap(), str_value(want), "scale {scale}");
    }
}

#[test]
fn quantized_vector_rejects_a_zero_scale() {
    let mut bits = BitWriter::new();
    packed_vector(&mut bits, [1, -2, 3], 4);
    let err = decode_bits(FieldType::VectorNetQuantize { scale: 0 }, &bits)
        .expect_err("a zero divisor must not decode to infinite components");
    assert!(
        matches!(err, DecodeError::InvalidQuantizationScale { scale: 0 }),
        "got {err:?}"
    );
}

/// A `ReplicatedMovement` payload: the four flags, `location` packed at
/// `location_bits`, three rotator components of `rotation_width` bits, and a
/// linear velocity of (10, -2, 3). The optional members are appended after.
fn rep_movement_bits(
    flags: [bool; 4],
    location: [i64; 3],
    location_bits: u32,
    rotation: [u16; 3],
    rotation_width: u32,
) -> BitWriter {
    let mut bits = flags.to_vec();
    packed_vector(&mut bits, location, location_bits);
    for component in rotation {
        rotator_component(&mut bits, component, rotation_width);
    }
    packed_vector(&mut bits, [10, -2, 3], 6);
    bits
}

/// The whole JSON of a payload with every flag clear. Whole-string asserts, not
/// substrings: the null members are what a substring check misses.
fn flags_clear_json(location: &str, rotation: &str) -> String {
    format!(
        concat!(
            r#"{{"linear_velocity":{{"x":10,"y":-2,"z":3}},"#,
            r#""angular_velocity":null,"location":{},"rotation":{},"#,
            r#""simulated_physics_sleep":false,"rep_physics":false,"#,
            r#""server_frame":null,"server_physics_handle":null}}"#
        ),
        location, rotation
    )
}

/// Every optional member present; `server_physics_handle` had no slot at all
/// in the old compact form, so no test could see it.
#[test]
fn rep_movement_decodes_optional_fields() {
    let mut bits = rep_movement_bits([true; 4], [123, -456, 789], 11, [16384, 32768, 49152], 16);
    packed_vector(&mut bits, [-4, 5, -6], 5);
    bits.int_packed(123).int_packed(456);
    let field_type = movement(
        RotatorQuantization::ShortComponents,
        VectorQuantization::RoundTwoDecimals,
    );
    let want = concat!(
        r#"{"linear_velocity":{"x":10,"y":-2,"z":3},"#,
        r#""angular_velocity":{"x":-4,"y":5,"z":-6},"#,
        r#""location":{"x":1.23,"y":-4.56,"z":7.89},"#,
        r#""rotation":{"pitch":90,"yaw":180,"roll":270},"#,
        r#""simulated_physics_sleep":true,"rep_physics":true,"#,
        r#""server_frame":123,"server_physics_handle":456}"#
    );
    assert_eq!(decode_bits(field_type, &bits).unwrap(), str_value(want));
}

#[test]
fn rep_movement_byte_quantized_rotation() {
    let bits = rep_movement_bits([false; 4], [123, -456, 789], 11, [64, 128, 192], 8);
    let field_type = movement(
        RotatorQuantization::ByteComponents,
        VectorQuantization::RoundTwoDecimals,
    );
    let want = flags_clear_json(
        r#"{"x":1.23,"y":-4.56,"z":7.89}"#,
        r#"{"pitch":90,"yaw":180,"roll":270}"#,
    );
    assert_eq!(decode_bits(field_type, &bits).unwrap(), str_value(&want));
}

/// The location divisor is the entry's quantization level, never a constant:
/// a fixed 100 returned world/100 on every whole-unit class. A fixed divisor
/// passes at most one level, and the velocity stays whole units on all three.
#[test]
fn rep_movement_location_is_divided_by_the_declared_quantization() {
    // Every level is checked before failing, so a regression names them all.
    let mut wrong = Vec::new();
    for (level, packed, width, world) in [
        (
            VectorQuantization::RoundWholeNumber,
            [930, -545, 1175],
            12,
            r#"{"x":930,"y":-545,"z":1175}"#,
        ),
        (
            VectorQuantization::RoundOneDecimal,
            [9302, -5451, 11753],
            15,
            r#"{"x":930.2,"y":-545.1,"z":1175.3}"#,
        ),
        (
            VectorQuantization::RoundTwoDecimals,
            [621_541, -570_761, 50_041],
            21,
            r#"{"x":6215.41,"y":-5707.61,"z":500.41}"#,
        ),
    ] {
        let bits = rep_movement_bits([false; 4], packed, width, [0; 3], 8);
        let decoded = decode_bits(movement(RotatorQuantization::ByteComponents, level), &bits)
            .unwrap_or_else(|e| panic!("{level:?}: {e}"));
        let want = flags_clear_json(world, r#"{"pitch":0,"yaw":0,"roll":0}"#);
        if decoded != str_value(&want) {
            wrong.push(format!("{level:?}: got {decoded:?}, want location {world}"));
        }
    }
    assert!(wrong.is_empty(), "{}", wrong.join("; "));
}

/// The raw-`f32` fallback (`componentBitCount == 0`, `extraInfo == 0`) can
/// carry a NaN, which is not a JSON literal: rejected, not rendered. See
/// docs/OVERLAY_RESOLUTION.md "FRepMovement finiteness is enforced".
#[test]
fn rep_movement_with_a_non_finite_component_is_rejected() {
    let mut bits = vec![false; 4];
    // Location: header 0 selects three raw f32 words; the first is a NaN.
    bits.serialized_int(0, 1 << 7);
    for word in [0x7fc0_0000u32, 1.0f32.to_bits(), 2.0f32.to_bits()] {
        bits.bits(word.into(), 32);
    }
    // Byte rotation: three cleared presence flags. Velocity: 1-bit zeros.
    bits.repeat(false, 3);
    packed_vector(&mut bits, [0; 3], 1);
    let field_type = movement(
        RotatorQuantization::ByteComponents,
        VectorQuantization::RoundTwoDecimals,
    );
    let err = decode_bits(field_type, &bits).expect_err("a NaN component must not decode");
    assert!(
        matches!(err, DecodeError::NonFiniteComponent { .. }),
        "expected NonFiniteComponent, got {err:?}"
    );
}
