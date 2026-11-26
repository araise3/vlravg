//! [`FieldType`] and raw bits in, [`DecodedValue`] or [`DecodeError`] out. The
//! readers live in [`scalar`] (primitives) and [`geometry`] (vectors, rotators,
//! transforms). `table.rs` names `crate::decode::FieldType` by path, so this
//! module keeps its path.

mod geometry;
pub(crate) mod scalar;

use vrf_bitio::BitReader;

use crate::ftext::{FTextTree, decode_ftext_tree_from};

/// Every primitive type the overlay can decode. Parametric variants carry
/// their configuration inline, so the overlay table needs no side data.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FieldType {
    Bool,
    Byte,
    EnumByte,
    Int32,
    UInt32,
    /// `FEffectID::EffectID` is one: its checksum reproduces only as `int64`,
    /// so `tools/apply_type_corrections.py` retypes the descriptors' `UInt64`.
    Int64,
    UInt64,
    Float,
    Double,
    FString,
    /// The key of a string-table `FText` (history 11); any other history is
    /// refused.
    FText,
    /// A whole `FText` history tree ([`crate::decode_ftext_tree`]) as JSON, for
    /// properties that send histories other than 11 (the empty 255 most often).
    FTextTree,
    FName,
    ObjectNetGuid,
    Guid,
    SerializedInt {
        max: u32,
    },
    EnumRemainingBits,
    GameplayTag,
    ByteArray {
        max_bytes: u32,
    },
    VectorFloat,
    VectorDouble,
    VectorNetQuantize {
        scale: u32,
    },
    VectorNetQuantizeNormal,
    RotationShort,
    RotationByte,
    Transform,
    /// `FRepMovement`. Both parameters are per-class choices the wire does not
    /// carry: [`crate::types::RotatorQuantization`] and
    /// [`crate::types::VectorQuantization`].
    RepMovement {
        rotation: crate::types::RotatorQuantization,
        location: crate::types::VectorQuantization,
    },
    /// Dynamic arrays and custom decoders -- not decoded, raw_bits suffices.
    Raw,
    /// Explicitly skipped fields (`.Ignore()` in descriptors).
    Skip,
}

/// The result of a successful decode: one of the four `value_*` columns.
#[derive(Debug, Clone, PartialEq)]
pub enum DecodedValue {
    I64(i64),
    F64(f64),
    Bool(bool),
    Str(String),
}

impl DecodedValue {
    /// The `(value_i64, value_f64, value_bool, value_str)` columns, exactly one
    /// of them `Some`.
    #[must_use]
    pub fn into_columns(self) -> (Option<i64>, Option<f64>, Option<bool>, Option<String>) {
        match self {
            Self::I64(v) => (Some(v), None, None, None),
            Self::F64(v) => (None, Some(v), None, None),
            Self::Bool(v) => (None, None, Some(v), None),
            Self::Str(v) => (None, None, None, Some(v)),
        }
    }
}

/// Decode failure. Non-fatal: the field stays as raw_bits only.
#[derive(Debug, Clone, thiserror::Error)]
pub enum DecodeError {
    #[error("bit read error: {0}")]
    BitIo(#[from] vrf_bitio::BitError),
    #[error("not fully consumed: {remaining} bits left after decode")]
    NotFullyConsumed { remaining: u64 },
    #[error("field type is Raw/Skip -- no decode attempted")]
    RawOrSkip,
    /// Refused rather than sign-flipped into a plausible negative `i64`.
    #[error("unsigned value {value} (0x{value:016X}) exceeds i64::MAX")]
    UnsignedOverflow { value: u64 },
    /// A geometry component decoded to `NaN` or an infinity; see
    /// [`crate::types::FRepMovement`]'s `Display` for why it is not coerced.
    #[error("{context} component is not finite")]
    NonFiniteComponent { context: &'static str },
    #[error("quantized vector scale must be non-zero, got {scale}")]
    InvalidQuantizationScale { scale: u32 },
    /// Unreal defines no display spelling for a negative instance number.
    #[error("FName instance number must be non-negative, got {number}")]
    InvalidFNameNumber { number: i32 },
    /// A valid `FText` tree of a history `FieldType::FText` has no key for.
    #[error("FText history {history_type} carries no string-table key")]
    UnsupportedTextHistory { history_type: u8 },
    /// Fires before any payload byte is read, so it is not a layout mismatch:
    /// the fix is raising the table's `max_bytes`.
    #[error("byte array declared {declared} bytes, exceeding the {max} configured for this field")]
    ByteArrayLengthCapExceeded { declared: u32, max: u32 },
    #[error("FText tree: {0}")]
    FTextTree(crate::FTextTreeError),
}

/// Decode raw bits according to the given [`FieldType`]. `Raw` and `Skip` are
/// [`DecodeError::RawOrSkip`]; bits left over are
/// [`DecodeError::NotFullyConsumed`], a layout mismatch such as version drift.
pub fn decode_field(
    field_type: FieldType,
    data: &[u8],
    bit_count: u32,
) -> Result<DecodedValue, DecodeError> {
    let mut reader = BitReader::with_bit_len(data, u64::from(bit_count))?;
    let value = dispatch_decode(field_type, &mut reader)?;
    // No exemption, not even for `EnumRemainingBits`: leftover bits are an error.
    match reader.bits_remaining() {
        0 => Ok(value),
        remaining => Err(DecodeError::NotFullyConsumed { remaining }),
    }
}

fn dispatch_decode(ft: FieldType, r: &mut BitReader<'_>) -> Result<DecodedValue, DecodeError> {
    use DecodedValue::{Bool, F64, I64, Str};
    Ok(match ft {
        FieldType::Bool => Bool(r.read_bit()?),
        FieldType::Byte | FieldType::EnumByte => scalar::decode_byte(r)?,
        FieldType::Int32 => I64(i64::from(r.read_i32()?)),
        FieldType::UInt32 => I64(i64::from(r.read_u32()?)),
        // Two's complement: every bit pattern is a value.
        FieldType::Int64 => I64(r.read_u64()? as i64),
        FieldType::UInt64 => scalar::decode_u64(r)?,
        FieldType::Float => F64(f64::from(r.read_f32()?)),
        FieldType::Double => F64(r.read_f64()?),
        FieldType::FString => Str(r.read_fstring(64 * 1024)?),
        FieldType::FText => match decode_ftext_tree_from(r).map_err(DecodeError::FTextTree)? {
            FTextTree::StringTable { key, .. } => Str(key),
            tree => {
                return Err(DecodeError::UnsupportedTextHistory {
                    history_type: tree.history(),
                });
            }
        },
        FieldType::FTextTree => Str(decode_ftext_tree_from(r)
            .map_err(DecodeError::FTextTree)?
            .to_json()),
        FieldType::FName => Str(scalar::read_fname::<DecodeError>(r, 64 * 1024)?),
        // Both are wire IntPacked values; only the declared type tells them apart.
        FieldType::ObjectNetGuid | FieldType::GameplayTag => I64(i64::from(r.read_int_packed()?)),
        FieldType::Guid => Str(scalar::read_guid(r)?),
        FieldType::SerializedInt { max } => I64(i64::from(r.read_serialized_int(max)?)),
        FieldType::EnumRemainingBits => scalar::decode_enum_remaining_bits(r)?,
        FieldType::ByteArray { max_bytes } => Str(scalar::read_byte_array_hex(r, max_bytes)?),
        FieldType::VectorFloat => render(geometry::read_float_vector(r)?),
        FieldType::VectorDouble => render(geometry::read_double_vector(r)?),
        FieldType::VectorNetQuantize { scale } => {
            render(geometry::read_vector_net_quantize(r, scale)?)
        }
        FieldType::VectorNetQuantizeNormal => render(geometry::read_fixed_vector_normal(r)?),
        FieldType::RotationShort => render(geometry::read_rotation(r, 16)?),
        FieldType::RotationByte => render(geometry::read_rotation(r, 8)?),
        FieldType::Transform => render(geometry::read_transform(r)?),
        FieldType::RepMovement { rotation, location } => {
            render(geometry::read_rep_movement(r, rotation, location)?)
        }
        FieldType::Raw | FieldType::Skip => return Err(DecodeError::RawOrSkip),
    })
}

/// Plain `to_string()` on purpose: pre-reserving 32 or 256 bytes measured no
/// faster end to end and raised peak RSS by ~3 MB of dead row-buffer space.
fn render(value: impl core::fmt::Display) -> DecodedValue {
    DecodedValue::Str(value.to_string())
}
