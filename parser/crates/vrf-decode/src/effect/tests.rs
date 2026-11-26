//! Pinned wire vectors for the effect decoders: hex blobs from real packets,
//! values checked against an independent parser. `tools/check_effect_decoder.py`
//! re-checks the same blobs on the Python port that produces the valplay
//! bundle.

use super::*;
use crate::test_bits::hex as decode_hex;
use vrf_bitio::BitReader;

/// A reader over the first `bit_count` bits of a hex string.
fn reader_from_hex(hex: &str, bit_count: u64) -> BitReader<'static> {
    let data = decode_hex(hex);
    let leaked: &'static [u8] = Box::leak(data.into_boxed_slice());
    BitReader::with_bit_len(leaked, bit_count).unwrap()
}

/// Packet 4368, a Sheriff shot, as `ReplayPlayContinuousEffectAtLocation`
/// sends it: FloatValues (400 bits), ObjectValues (344) and VectorValues (280).
const FLOATS_4368: &str = "08021020390412400000803f000410200f0412400000a040\
                           000610203d0412400000803f000810203b04124015f9b3ce0000";
const OBJECTS_4368: &str = "08022020370422201d300004202035042220190400\
                            062030ffff062220572a000820206504222075160000";
const VECTORS_4368: &str = "0202182013041a81026b7b179c16f0e8bf11e6b45fc0eee33f\
                            9417c1fc5684b1bf0000";

/// Packet 4368's floats: tags 284 NumProjectiles, 263 AmmoRemaining, 286
/// TracerOption, 285 RandomSeed.
const FLOATS_4368_JSON: &str = "[{\"tag\":284,\"value\":1},\
                                 {\"tag\":263,\"value\":5},\
                                 {\"tag\":286,\"value\":1},\
                                 {\"tag\":285,\"value\":-1509722752}]";

// ---- FloatValues tests ----

/// Packet 17421, Classic shot: five elements, AmmoRemaining (263) 7 and
/// YawSwitch (287) 16 among them.
#[test]
fn decode_float_values_with_yaw_switch() {
    let hex = "0a021020390412400000803f000410200f0412400000e040\
               000610203d0412400000803f000810203b04124032cb82cc\
               000a10203f041240000080410000";
    let mut reader = reader_from_hex(hex, 496);
    let result = decode_effect_floats(&mut reader).unwrap();

    assert_eq!(result.len(), 5);
    assert_eq!(result[4].tag_index, Some(287));
    assert_eq!(result[4].value, Some(16.0));
    assert_eq!(result[1].tag_index, Some(263));
    assert_eq!(result[1].value, Some(7.0));
}

/// Packet 30968, Judge shotgun: NumProjectiles 12, AmmoRemaining 4,
/// RandomSeed 480247136 (no TracerOption for shotguns).
#[test]
fn decode_float_values_shotgun() {
    let hex = "060210203904124000004041000410200f04124000008040\
               000610203b041240ebffe44d0000";
    let mut reader = reader_from_hex(hex, 304);
    let result = decode_effect_floats(&mut reader).unwrap();

    assert_eq!(result.len(), 3);
    assert_eq!(result[0].tag_index, Some(284));
    assert_eq!(result[0].value, Some(12.0));
    assert_eq!(result[1].tag_index, Some(263));
    assert_eq!(result[1].value, Some(4.0));
    assert_eq!(result[2].tag_index, Some(285));
    assert_eq!(result[2].value, Some(480247136.0));
}

// ---- ObjectValues tests ----

/// Packet 4368: tags 283 FiringState, 282 FiringPlayerState, then 65535 and
/// 306 (unnamed).
#[test]
fn decode_object_values_basic() {
    let mut reader = reader_from_hex(OBJECTS_4368, 344);
    let result = decode_effect_objects(&mut reader).unwrap();

    assert_eq!(result.len(), 4);
    assert_eq!(result[0].tag_index, Some(283));
    assert_eq!(result[0].value, Some(3086));
    assert_eq!(result[1].tag_index, Some(282));
    assert_eq!(result[1].value, Some(268));
    assert_eq!(result[2].tag_index, Some(65535));
    assert_eq!(result[2].value, Some(2731));
    assert_eq!(result[3].tag_index, Some(306));
    assert_eq!(result[3].value, Some(1466));
}

// ---- VectorValues tests ----

/// Packet 30968: the Judge shotgun's 12 attack vectors, first and last checked.
#[test]
fn decode_vector_values_shotgun_12_pellets() {
    let hex = "1802182013041a8102dbc17bd5d196e5bfe0a5c85f789ee73f\
               2c6acea060d67cbf0004182023041a8102d928d6ec3252e4bf\
               db684947f09ae83f8ff46bf204feb23f0006182025041a8102\
               cab091674d89e3bfca826e887d57e93f329135a84dc986bf00\
               08182027041a81021feb5fbfc5c9e4bfbe2eacda9150e83fd4\
               e0ab8708b8993f000a182029041a8102eb1e013403a6e5bf70\
               586cb99487e73f211db57f12dda43f000c18202b041a8102cf\
               8ff307062fe5bfbc8f8d8712eae73f9ea909fb1d4fadbf000e\
               18202d041a8102b2d91d6d819be4bf868429ea797ae83f82a1\
               7b5833f487bf001018202f041a81024c18cf0e9622e6bfebed\
               6acd4518e73f1643e10a3d219a3f0012182031041a81021e4a\
               512e352ee5bf896bbcfad9fae73fa65e98e42cf892bf001418\
               2015041a81023f37da4a7fa9e3bff6ce548e533ae93f0ec90b\
               be86529f3f0016182017041a8102246b3d964f35e3bf7de713\
               59cc90e93f0801a7f26937a33f0018182019041a81028e462c\
               93744fe3bf46adf442357ae93f7f3bcd1e38b3a6bf0000";
    let mut reader = reader_from_hex(hex, 3184);
    let result = decode_effect_vectors(&mut reader).unwrap();

    assert_eq!(result.len(), 12);
    let v0 = result[0].value.unwrap();
    assert!((v0.x - (-0.6746606034849337)).abs() < 1e-12);
    assert!((v0.y - 0.7380945082451795).abs() < 1e-12);
    assert!((v0.z - (-0.0070403837716193456)).abs() < 1e-12);

    let v11 = result[11].value.unwrap();
    assert!((v11.x - (-0.6034491419288359)).abs() < 1e-12);
    assert!((v11.y - 0.796167975209223).abs() < 1e-12);
    assert!((v11.z - (-0.04433608413693601)).abs() < 1e-12);
}

/// Empty blob (0 elements): the count, IntPacked 0 = byte 0x00, is all of it.
#[test]
fn decode_empty_arrays() {
    let reader = || BitReader::with_bit_len(&[0u8], 8).unwrap();
    assert!(decode_effect_floats(&mut reader()).unwrap().is_empty());
    assert!(decode_effect_objects(&mut reader()).unwrap().is_empty());
    assert!(decode_effect_vectors(&mut reader()).unwrap().is_empty());
}

// ---- JSON wiring tests ----

#[test]
fn param_names_select_the_element_type() {
    assert_eq!(
        EffectArrayKind::from_param_name("FloatValues"),
        Some(EffectArrayKind::Float)
    );
    assert_eq!(
        EffectArrayKind::from_param_name("ObjectValues"),
        Some(EffectArrayKind::Object)
    );
    assert_eq!(
        EffectArrayKind::from_param_name("VectorValues"),
        Some(EffectArrayKind::Vector)
    );
    // Every other RPC parameter, including ones from the same functions.
    assert_eq!(EffectArrayKind::from_param_name("EffectID"), None);
    assert_eq!(EffectArrayKind::from_param_name("SourceID"), None);
    assert_eq!(EffectArrayKind::from_param_name("Translation"), None);
    assert_eq!(EffectArrayKind::from_param_name("248"), None);
    assert_eq!(EffectArrayKind::from_param_name("floatvalues"), None);
}

/// The whole string is asserted, not a substring: a member carrying no
/// data is exactly where a serialization bug hides.
#[test]
fn float_blob_renders_as_json() {
    let raw = decode_hex(FLOATS_4368);
    let json = decode_effect_blob_json(EffectArrayKind::Float, &raw, 400).unwrap();
    assert_eq!(json, FLOATS_4368_JSON);
}

#[test]
fn object_blob_renders_as_json() {
    let raw = decode_hex(OBJECTS_4368);
    let json = decode_effect_blob_json(EffectArrayKind::Object, &raw, 344).unwrap();
    assert_eq!(
        json,
        "[{\"tag\":283,\"value\":3086},\
          {\"tag\":282,\"value\":268},\
          {\"tag\":65535,\"value\":2731},\
          {\"tag\":306,\"value\":1466}]"
    );
}

#[test]
fn vector_blob_renders_as_json() {
    let raw = decode_hex(VECTORS_4368);
    let json = decode_effect_blob_json(EffectArrayKind::Vector, &raw, 280).unwrap();
    assert_eq!(
        json,
        "[{\"tag\":265,\"value\":{\"x\":-0.7793076561609785,\
          \"y\":0.6228944653768754,\"z\":-0.06842559500463913}}]"
    );
}

#[test]
fn an_empty_blob_renders_as_an_empty_array() {
    let json = decode_effect_blob_json(EffectArrayKind::Float, &[0u8], 8).unwrap();
    assert_eq!(json, "[]");
}

/// A payload that is not this format usually parses into something and
/// leaves a tail, so the tail must be an error (`ResidualBits`).
#[test]
fn a_tail_after_the_terminator_is_an_error() {
    // A well-formed 1-element float array followed by 6 spare bytes.
    let raw = decode_hex("0202102039041240000080 3f0000 00000000000000");
    let bits = (raw.len() as u32) * 8;
    let err = decode_effect_blob_json(EffectArrayKind::Float, &raw, bits).unwrap_err();
    assert!(
        matches!(err, EffectBlobError::ResidualBits { .. }),
        "expected ResidualBits, got {err:?}"
    );
}

/// A bad bit length is a row-level error, not a panic on the export path.
#[test]
fn a_bit_length_past_the_buffer_is_an_error_not_a_panic() {
    let err = decode_effect_blob_json(EffectArrayKind::Float, &[0u8], 4096).unwrap_err();
    assert!(
        matches!(
            err,
            EffectBlobError::BitLengthExceedsBuffer {
                bits: 4096,
                available: 8
            }
        ),
        "expected BitLengthExceedsBuffer, got {err:?}"
    );
}

/// JSON has no literal for NaN or an infinity, and `null` or `0` would
/// fabricate, so the blob is rejected and the caller counts it.
#[test]
fn a_non_finite_float_is_rejected_rather_than_rendered() {
    // Element 0, tag 284, value = f32::NAN (0x7fc00000).
    let raw = decode_hex("020210203904124000 00c07f 0000");
    let err = decode_effect_blob_json(EffectArrayKind::Float, &raw, 112).unwrap_err();
    assert!(
        matches!(err, EffectBlobError::NonFiniteFloat { index: 0 }),
        "expected NonFiniteFloat, got {err:?}"
    );
}

/// The vector arm refuses the same way: packet 4368's vector with x replaced
/// by f64::NAN (0x7ff8000000000000); y and z are the originals.
#[test]
fn a_non_finite_vector_component_is_rejected_rather_than_rendered() {
    let raw =
        decode_hex("0202182013041a8102 000000000000f87f 11e6b45fc0eee33f 9417c1fc5684b1bf 0000");
    let err = decode_effect_blob_json(EffectArrayKind::Vector, &raw, 280).unwrap_err();
    assert!(
        matches!(err, EffectBlobError::NonFiniteFloat { index: 0 }),
        "expected NonFiniteFloat, got {err:?}"
    );
}

// ---- Handle derivation ----

/// The pinned vectors come from `ReplayPlayContinuousEffectAtLocation`, the
/// one function whose handles are both declared and derivable: they must agree.
#[test]
fn scanning_recovers_the_declared_handles() {
    for (blob, bits, handles) in [
        (FLOATS_4368, 400, FLOAT_HANDLES),
        (OBJECTS_4368, 344, OBJECT_HANDLES),
        (VECTORS_4368, 280, VECTOR_HANDLES),
    ] {
        let raw = decode_hex(blob);
        assert_eq!(scan_element_handles(&raw, bits).unwrap(), Some(handles));
    }
}

/// An array that populates no element has no pair to derive.
#[test]
fn an_empty_array_has_no_handles_to_derive() {
    assert_eq!(scan_element_handles(&[0u8], 8).unwrap(), None);
}

/// The same struct under another function arrives at another handle pair,
/// which the fixed constants read as all-null (see `EffectHandles`): the
/// pinned Sheriff FloatValues blob with its handles rewritten from 7/8 to 3/4,
/// where `ClientPlayOneShotEffectAtLocation` puts them.
#[test]
fn a_rebased_blob_decodes_through_derivation_and_not_through_the_constants() {
    // Handle bytes are IntPacked(handle + 1): 0x10 -> 7 and 0x12 -> 8
    // become 0x08 -> 3 and 0x0a -> 4.
    let hex = "0802082039040a400000803f000408200f040a400000a040\
               000608203d040a400000803f000808203b040a4015f9b3ce0000";
    let raw = decode_hex(hex);
    assert_eq!(
        scan_element_handles(&raw, 400).unwrap(),
        Some(EffectHandles::from_base(3))
    );

    // Through the constants: every field is an unknown handle, so the
    // elements come back empty.
    let mut reader = BitReader::with_bit_len(&raw, 400).unwrap();
    let blind = decode_effect_floats(&mut reader).unwrap();
    assert_eq!(blind.len(), 4);
    assert!(
        blind
            .iter()
            .all(|e| e.tag_index.is_none() && e.value.is_none())
    );

    // Through derivation: the same values as the 7/8 original.
    let json = decode_effect_blob_json(EffectArrayKind::Float, &raw, 400).unwrap();
    assert_eq!(json, FLOATS_4368_JSON);
}

/// A float value field must declare 32 bits; otherwise the 32-bit read runs
/// off the end of its own field.
#[test]
fn a_value_field_of_the_wrong_width_is_rejected() {
    // Element 0: tag at handle 3 (16 bits), value at handle 4 declaring
    // 16 bits where a float needs 32.
    let hex = "0202082039040a2000000000";
    let raw = decode_hex(hex);
    let err = decode_effect_blob_json(EffectArrayKind::Float, &raw, 96).unwrap_err();
    assert!(
        matches!(
            err,
            EffectBlobError::UnexpectedPayloadWidth {
                expected: 32,
                found: 16,
                ..
            }
        ),
        "expected UnexpectedPayloadWidth, got {err:?}"
    );
}

/// A sub-byte tail inside the declared window is `ResidualBits` too: the
/// window excludes storage padding, so every bit in it is declared payload.
#[test]
fn a_sub_byte_tail_inside_the_declared_window_is_an_error() {
    // count = 0, array terminator = 0, then four declared bits left over.
    let raw = [0u8, 0u8, 0x0Fu8];
    let err = decode_effect_blob_json(EffectArrayKind::Float, &raw, 20)
        .expect_err("four declared, unconsumed bits must not be accepted");
    assert!(
        matches!(err, EffectBlobError::ResidualBits { remaining: 4 }),
        "expected ResidualBits {{ remaining: 4 }}, got {err:?}"
    );
}

/// An `IntPacked` member that underfills its declared window is rejected,
/// as a mis-sized float is (`settle_field`, `PayloadUnderread`).
#[test]
fn an_int_packed_member_that_underfills_its_window_is_rejected() {
    // The well-formed one-element blob, with the TAG field's declared width
    // widened from 16 to 24 bits and padded. Tag 284 is a two-byte IntPacked,
    // so 8 of the 24 declared bits go uninterpreted.
    let raw = [
        0x02, 0x02, 0x10, 0x30, 0x39, 0x04, 0x00, 0x12, 0x40, 0x00, 0x00, 0x80, 0x3f, 0x00, 0x00,
    ];
    let err = decode_effect_blob_json(EffectArrayKind::Float, &raw, 120)
        .expect_err("an underfilled IntPacked window must not pass");
    assert!(
        matches!(
            err,
            EffectBlobError::PayloadUnderread {
                declared: 24,
                consumed: 16
            }
        ),
        "expected PayloadUnderread, got {err:?}"
    );
}

/// A payload that stops before its terminator is truncated, not sparse
/// (`MissingTerminator`).
#[test]
fn an_array_that_ends_without_its_terminator_is_rejected() {
    // count=2, element 0 complete and closed, then the window simply ends --
    // element 1 and the array terminator never arrive.
    let raw = [
        0x04, 0x02, 0x10, 0x20, 0x39, 0x04, 0x12, 0x40, 0x00, 0x00, 0x80, 0x3f, 0x00,
    ];
    let err = decode_effect_blob_json(EffectArrayKind::Float, &raw, 104)
        .expect_err("a truncated array must not decode as a complete one");
    assert!(
        matches!(err, EffectBlobError::MissingTerminator { .. }),
        "expected MissingTerminator, got {err:?}"
    );
}

/// The byte after the array terminator must be zero
/// (`consume_trailing_terminator`).
#[test]
fn a_non_zero_trailing_terminator_is_rejected() {
    // A well-formed 1-element float array, then one spare non-zero byte that
    // lands exactly in the 8-bit trailing-terminator slot.
    let raw = [
        0x02, 0x02, 0x10, 0x20, 0x39, 0x04, 0x12, 0x40, 0x00, 0x00, 0x80, 0x3f, 0x00, 0x00, 0xAA,
    ];
    let err = decode_effect_blob_json(EffectArrayKind::Float, &raw, 120)
        .expect_err("a non-zero trailing byte is not a terminator");
    assert!(
        matches!(err, EffectBlobError::NonZeroTerminator { .. }),
        "expected NonZeroTerminator, got {err:?}"
    );
}

/// Element indices must ascend: a repeated index would overwrite the earlier
/// element, and a descending one is no order the writer produces.
#[test]
fn an_element_index_that_does_not_ascend_is_rejected() {
    // Count 2, then two float elements (tag 284, values 1.0 and 5.0) at the
    // given wire indices, then the array terminator.
    for (first, second) in [("02", "02"), ("04", "02")] {
        let hex = format!("04 {first}102039041240 0000803f 00 {second}102039041240 0000a040 00 00");
        let err = decode_effect_blob_json(EffectArrayKind::Float, &decode_hex(&hex), 208)
            .expect_err("a non-ascending index must not decode");
        assert!(
            matches!(err, EffectBlobError::NonAscendingIndex { .. }),
            "{first}/{second}: got {err:?}"
        );
    }
}

/// Each shared framing failure keeps its name and fields (cap 256).
#[test]
fn framing_failures_reach_the_caller_as_their_own_variant() {
    use vrf_testkit::{BitWrite, BitWriter};
    for (packed, expected) in [
        (&[257][..], "ArrayCountTooLarge { count: 257, max: 256 }"),
        (&[1, 4], "IndexOutOfBounds { index: 3, count: 1 }"),
        (
            &[1, 1, 41, 32],
            "PayloadTooLarge { bits: 32, remaining: 0 }",
        ),
    ] {
        let mut bits = BitWriter::new();
        for &v in packed {
            bits.int_packed(v);
        }
        let (data, bit_len) = bits.finish();
        let err = decode_effect_blob_json(EffectArrayKind::Float, &data, bit_len).unwrap_err();
        assert_eq!(format!("{err:?}"), expected);
    }
}
