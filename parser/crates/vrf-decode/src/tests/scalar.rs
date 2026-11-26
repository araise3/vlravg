//! Scalar primitive decoders.

use super::str_value;
use crate::FTextTreeError;
use crate::decode::{DecodeError, DecodedValue, FieldType, decode_field};
use vrf_testkit::{BitWrite, BitWriter};

#[test]
fn double_reads_eight_byte_float() {
    let data = 123.5_f64.to_bits().to_le_bytes();
    let result = decode_field(FieldType::Double, &data, 64).unwrap();
    assert_eq!(result, DecodedValue::F64(123.5));
}

#[test]
fn fstring_reads_unreal_string() {
    // Length = 6 (5 chars + null)
    let mut data = 6i32.to_le_bytes().to_vec();
    data.extend_from_slice(b"Spike\0");
    let result = decode_field(FieldType::FString, &data, data.len() as u32 * 8).unwrap();
    assert_eq!(result, str_value("Spike"));
}

#[test]
fn fname_hardcoded_reads_a_packed_index() {
    // A set leading bit makes the name a hardcoded table index, sent as
    // IntPacked and rendered as its decimal (see `read_fname` for the
    // DamagedBone rows). 9 bits: bit0 = 1, then IntPacked 0 = byte 0x00.
    let result = decode_field(FieldType::FName, &[0x01, 0x00], 9).unwrap();
    assert_eq!(result, str_value("0"));
}

/// The inline (`isHardcoded = 0`) FName shape: a leading zero bit, then an
/// FString, then the i32 instance number.
fn inline_fname_bits(name: &str, number: i32) -> (Vec<u8>, u32) {
    BitWriter::new()
        .bit(false)
        .fstring(name)
        .i32(number)
        .finish()
}

#[test]
fn fname_reads_inline_name() {
    // FString "Bomb" (len=5 including null) + i32 suffix = 0
    let (bits, bit_count) = inline_fname_bits("Bomb", 0);
    let result = decode_field(FieldType::FName, &bits, bit_count).unwrap();
    assert_eq!(result, str_value("Bomb"));
}

/// The FName instance number is part of the name: `N != 0` displays as
/// `Name_{N-1}`, so names differing only in it must not decode alike.
#[test]
fn fname_inline_numbers_do_not_collide() {
    for (number, want) in [(1, "Source_0"), (2, "Source_1")] {
        let (bits, bit_count) = inline_fname_bits("Source", number);
        let result = decode_field(FieldType::FName, &bits, bit_count).unwrap();
        assert_eq!(result, str_value(want), "number {number}");
    }
}

#[test]
fn fname_negative_instance_numbers_are_rejected() {
    for number in [-1, i32::MIN] {
        let (bits, bit_count) = inline_fname_bits("Source", number);
        let err = decode_field(FieldType::FName, &bits, bit_count)
            .expect_err("a negative FName number has no valid display spelling");
        assert!(
            matches!(err, DecodeError::InvalidFNameNumber { number: n } if n == number),
            "got {err:?} for {number}"
        );
    }
}

/// A byte takes its width from the payload, not a fixed 8 (see `decode_byte`).
#[test]
fn byte_takes_its_width_from_the_payload() {
    // 5 significant bits holding 9 (0b01001), padded to one byte.
    let data = [0b0000_1001u8];
    for width in [1u32, 3, 5, 8] {
        let v = decode_field(FieldType::EnumByte, &data, width)
            .unwrap_or_else(|e| panic!("width {width} should decode: {e:?}"));
        let mask = ((1u16 << width) - 1) as u8;
        let expected = i64::from(0b0000_1001u8 & mask);
        assert_eq!(v, DecodedValue::I64(expected), "width {width}");
    }
}

#[test]
fn byte_array_reads_packed_count_and_bytes() {
    // IntPacked 3 = byte (3 << 1) = 0x06
    let data = [0x06u8, 0x10, 0x20, 0x30];
    let result = decode_field(FieldType::ByteArray { max_bytes: 8 }, &data, 32).unwrap();
    assert_eq!(result, str_value("102030"));
}

/// A count over the table's `max_bytes` is refused from the count alone, with
/// its own variant (no payload byte has been read).
#[test]
fn byte_array_over_the_length_cap_is_refused_distinctly() {
    // IntPacked 10 = byte (10 << 1) = 0x14. No payload bytes needed: the
    // count alone must be enough to refuse before any are read.
    let err = decode_field(FieldType::ByteArray { max_bytes: 8 }, &[0x14], 8)
        .expect_err("a declared count over max_bytes must be refused");
    assert!(
        matches!(
            err,
            DecodeError::ByteArrayLengthCapExceeded {
                declared: 10,
                max: 8
            }
        ),
        "got {err:?}"
    );
}

#[test]
fn guid_reads_four_le_words() {
    let data: Vec<u8> = [0x00112233u32, 0x44556677, 0x8899AABB, 0xCCDDEEFF]
        .iter()
        .flat_map(|word| word.to_le_bytes())
        .collect();
    let result = decode_field(FieldType::Guid, &data, 128).unwrap();
    assert_eq!(result, str_value("00112233-4455-6677-8899-aabbccddeeff"));
}

#[test]
fn serialized_int_reads_value_using_known_maximum() {
    // max=16 -> value_bits = 4. value 5 = 0b0101 in 4 bits.
    let result = decode_field(FieldType::SerializedInt { max: 16 }, &[0x05], 4).unwrap();
    assert_eq!(result, DecodedValue::I64(5));
}

/// `UInt64` past `i64::MAX` is `UnsignedOverflow`, not a wrap; up to it, exact.
#[test]
fn uint64_above_i64_max_is_rejected_not_wrapped() {
    // High bit set: i64::MAX + 1 = 0x8000_0000_0000_0000.
    let over = i64::MAX as u64 + 1;
    let result = decode_field(FieldType::UInt64, &over.to_le_bytes(), 64);
    assert!(matches!(
        result,
        Err(DecodeError::UnsignedOverflow { value }) if value == over
    ));
    // In range, up to the boundary i64::MAX itself: the positive I64.
    for value in [0x0102030405060708u64, i64::MAX as u64] {
        let result = decode_field(FieldType::UInt64, &value.to_le_bytes(), 64).unwrap();
        assert_eq!(result, DecodedValue::I64(value as i64));
    }
}

/// `Int64` reads `UInt64`'s 64 bits as two's complement: what `UInt64` refuses
/// is a negative number here, and below `i64::MAX` both agree (so retyping the
/// effect IDs changed no exported value). Only exactly 64 bits decode.
#[test]
fn int64_reads_eight_byte_twos_complement() {
    for value in [0x0102030405060708i64, -2, i64::MIN] {
        let result = decode_field(FieldType::Int64, &value.to_le_bytes(), 64).unwrap();
        assert_eq!(result, DecodedValue::I64(value));
    }
    let data = [0u8; 9];
    assert!(decode_field(FieldType::Int64, &data, 72).is_err());
    assert!(decode_field(FieldType::Int64, &data, 32).is_err());
}

/// `EnumRemainingBits` reads the whole payload up to 32 bits; a wider one is
/// an error, not its low 32 bits.
#[test]
fn enum_remaining_bits_reads_the_payload_and_refuses_over_32() {
    // 3 bits = value 3 (low 3 bits of 0b011)
    let result = decode_field(FieldType::EnumRemainingBits, &[0b0000_0011], 3).unwrap();
    assert_eq!(result, DecodedValue::I64(3));
    // The boundary still decodes: 32 bits is representable, 33 is not.
    let result = decode_field(FieldType::EnumRemainingBits, &[0xFF; 4], 32).unwrap();
    assert_eq!(result, DecodedValue::I64(u32::MAX as i64));
    let err = decode_field(FieldType::EnumRemainingBits, &[0xFF; 5], 40).unwrap_err();
    assert!(
        matches!(err, DecodeError::NotFullyConsumed { remaining: 8 }),
        "expected the leftover to be reported, got {err:?}"
    );
}

#[test]
fn gameplay_tag_reads_packed_index() {
    // IntPacked 252: 252 = 0b11111100, split: chunk0=252&0x7F=124, chunk1=252>>7=1
    // byte0 = (124 << 1) | 1 = 249, byte1 = (1 << 1) | 0 = 2
    let result = decode_field(FieldType::GameplayTag, &[249, 2], 16).unwrap();
    assert_eq!(result, DecodedValue::I64(252));
}

#[test]
fn bool_reads_single_bit() {
    for (byte, want) in [(0x01u8, true), (0x00, false)] {
        let result = decode_field(FieldType::Bool, &[byte], 1).unwrap();
        assert_eq!(result, DecodedValue::Bool(want));
    }
}

#[test]
fn int32_reads_signed() {
    let result = decode_field(FieldType::Int32, &(-42i32).to_le_bytes(), 32).unwrap();
    assert_eq!(result, DecodedValue::I64(-42));
}

#[test]
fn float_reads_ieee754_single() {
    let result = decode_field(FieldType::Float, &1.25f32.to_le_bytes(), 32).unwrap();
    assert_eq!(result, DecodedValue::F64(1.25));
}

#[test]
fn object_net_guid_reads_int_packed() {
    // IntPacked value 0x3F: byte = (0x3F << 1) | 0 = 0x7E
    let result = decode_field(FieldType::ObjectNetGuid, &[0x7E], 8).unwrap();
    assert_eq!(result, DecodedValue::I64(0x3F));
}

/// `FText` (`LocalizedStat`) decodes to the statistic's name, the only
/// machine-readable source of `EnemiesBlinded` and the other 28: the sibling
/// `Statistic` enum is a bare integer. 32 flag bits, history byte 11, the
/// inline-FName bit, the table path, the `FName` number, then the key.
#[test]
fn ftext_decodes_a_string_table_entry_to_its_key() {
    let vectors: [(u32, &[u8], &str); 3] = [
        // Kills
        (
            785u32,
            &[
                0x00, 0x00, 0x00, 0x00, 0x0B, 0x96, 0x00, 0x00, 0x00, 0x5E, 0x8E, 0xC2, 0xDA, 0xCA,
                0x5E, 0xAA, 0x92, 0x5E, 0x92, 0xDC, 0x8E, 0xC2, 0xDA, 0xCA, 0x5E, 0x86, 0xDE, 0xDA,
                0xC4, 0xC2, 0xE8, 0xA4, 0xCA, 0xE0, 0xDE, 0xE4, 0xE8, 0x5E, 0x82, 0xC4, 0xD2, 0xD8,
                0xD2, 0xE8, 0xF2, 0x8A, 0xCC, 0xCC, 0xCA, 0xC6, 0xE8, 0xE6, 0xBE, 0xA6, 0xE8, 0xE4,
                0xD2, 0xDC, 0xCE, 0xE6, 0x5C, 0x82, 0xC4, 0xD2, 0xD8, 0xD2, 0xE8, 0xF2, 0x8A, 0xCC,
                0xCC, 0xCA, 0xC6, 0xE8, 0xE6, 0xBE, 0xA6, 0xE8, 0xE4, 0xD2, 0xDC, 0xCE, 0xE6, 0x00,
                0x00, 0x00, 0x00, 0x00, 0x0C, 0x00, 0x00, 0x00, 0x96, 0xD2, 0xD8, 0xD8, 0xE6, 0x00,
                0x00,
            ][..],
            "Kills",
        ),
        // EnemiesBlinded
        (
            969u32,
            &[
                0x00, 0x00, 0x00, 0x00, 0x0B, 0xB2, 0x00, 0x00, 0x00, 0x5E, 0x8E, 0xC2, 0xDA, 0xCA,
                0x5E, 0x86, 0xD0, 0xC2, 0xE4, 0xC2, 0xC6, 0xE8, 0xCA, 0xE4, 0xE6, 0x5E, 0x8E, 0xD8,
                0xDE, 0xC4, 0xC2, 0xD8, 0x5E, 0xA6, 0xE8, 0xE4, 0xD2, 0xDC, 0xCE, 0xA8, 0xC2, 0xC4,
                0xD8, 0xCA, 0xE6, 0x5E, 0x86, 0xD0, 0xC2, 0xE4, 0xC2, 0xC6, 0xE8, 0xCA, 0xE4, 0xE6,
                0xBE, 0x8E, 0xD8, 0xDE, 0xC4, 0xC2, 0xD8, 0xBE, 0xA6, 0xE8, 0xE4, 0xD2, 0xDC, 0xCE,
                0xE6, 0x5C, 0x86, 0xD0, 0xC2, 0xE4, 0xC2, 0xC6, 0xE8, 0xCA, 0xE4, 0xE6, 0xBE, 0x8E,
                0xD8, 0xDE, 0xC4, 0xC2, 0xD8, 0xBE, 0xA6, 0xE8, 0xE4, 0xD2, 0xDC, 0xCE, 0xE6, 0x00,
                0x00, 0x00, 0x00, 0x00, 0x1E, 0x00, 0x00, 0x00, 0x8A, 0xDC, 0xCA, 0xDA, 0xD2, 0xCA,
                0xE6, 0x84, 0xD8, 0xD2, 0xDC, 0xC8, 0xCA, 0xC8, 0x00, 0x00,
            ][..],
            "EnemiesBlinded",
        ),
        // AbilityStat_ShotsFired
        (
            1033u32,
            &[
                0x00, 0x00, 0x00, 0x00, 0x0B, 0xB2, 0x00, 0x00, 0x00, 0x5E, 0x8E, 0xC2, 0xDA, 0xCA,
                0x5E, 0x86, 0xD0, 0xC2, 0xE4, 0xC2, 0xC6, 0xE8, 0xCA, 0xE4, 0xE6, 0x5E, 0x8E, 0xD8,
                0xDE, 0xC4, 0xC2, 0xD8, 0x5E, 0xA6, 0xE8, 0xE4, 0xD2, 0xDC, 0xCE, 0xA8, 0xC2, 0xC4,
                0xD8, 0xCA, 0xE6, 0x5E, 0x86, 0xD0, 0xC2, 0xE4, 0xC2, 0xC6, 0xE8, 0xCA, 0xE4, 0xE6,
                0xBE, 0x8E, 0xD8, 0xDE, 0xC4, 0xC2, 0xD8, 0xBE, 0xA6, 0xE8, 0xE4, 0xD2, 0xDC, 0xCE,
                0xE6, 0x5C, 0x86, 0xD0, 0xC2, 0xE4, 0xC2, 0xC6, 0xE8, 0xCA, 0xE4, 0xE6, 0xBE, 0x8E,
                0xD8, 0xDE, 0xC4, 0xC2, 0xD8, 0xBE, 0xA6, 0xE8, 0xE4, 0xD2, 0xDC, 0xCE, 0xE6, 0x00,
                0x00, 0x00, 0x00, 0x00, 0x2E, 0x00, 0x00, 0x00, 0x82, 0xC4, 0xD2, 0xD8, 0xD2, 0xE8,
                0xF2, 0xA6, 0xE8, 0xC2, 0xE8, 0xBE, 0xA6, 0xD0, 0xDE, 0xE8, 0xE6, 0x8C, 0xD2, 0xE4,
                0xCA, 0xC8, 0x00, 0x00,
            ][..],
            "AbilityStat_ShotsFired",
        ),
    ];
    for (bit_count, raw, expected) in vectors {
        assert_eq!(
            decode_field(FieldType::FText, raw, bit_count).unwrap(),
            str_value(expected),
            "{expected}"
        );
    }
}

/// Only history 11 yields a key: history 10 with the same layout, and a valid
/// tree of another history, are refused rather than read as a plausible string.
#[test]
fn ftext_yields_only_a_string_table_key() {
    // Flags, history, the inline-name bit, empty name, number 0, empty key.
    let text = |history| {
        let mut bits = BitWriter::new();
        bits.bits(0, 32).bits(history, 8).bits(0, 1);
        bits.i32(0).i32(0).i32(0).finish()
    };
    let (raw, bits) = text(11);
    assert_eq!(
        decode_field(FieldType::FText, &raw, bits).unwrap(),
        str_value("")
    );
    let (raw, bits) = text(10);
    let err = decode_field(FieldType::FText, &raw, bits).unwrap_err();
    assert!(
        matches!(
            err,
            DecodeError::FTextTree(FTextTreeError::UnsupportedHistory { discriminator: 10 })
        ),
        "got {err:?}"
    );
    let (raw, bits) = BitWriter::new().bits(0, 32).bits(255, 8).i32(0).finish();
    let err = decode_field(FieldType::FText, &raw, bits).unwrap_err();
    assert!(
        matches!(
            err,
            DecodeError::UnsupportedTextHistory { history_type: 255 }
        ),
        "got {err:?}"
    );
}
