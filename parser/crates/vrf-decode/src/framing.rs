//! The RepLayout dynamic-array framing the struct blobs and the effect arrays
//! share: an element count, then `index + 1` per element and `handle + 1`,
//! payload bits per field, each list closed by a zero.

use vrf_bitio::{BitError, BitReader};

/// Maximum fields per element; the elements read here carry at most five.
pub(crate) const MAX_FIELDS_PER_ELEMENT: u32 = 8;

/// Maximum bits in one field payload, against runaway on corrupt data.
const MAX_FIELD_PAYLOAD_BITS: u32 = 64 * 1024;

/// A framing failure; each blob error type has a variant of the same name.
pub(crate) enum FramingError {
    BitIo(BitError),
    ArrayCountTooLarge { count: u32, max: u32 },
    IndexOutOfBounds { index: u32, count: u32 },
    PayloadTooLarge { bits: u32, remaining: u64 },
}

impl From<BitError> for FramingError {
    fn from(err: BitError) -> Self {
        Self::BitIo(err)
    }
}

macro_rules! into_blob_error {
    ($($feature:literal => $error:ty),+) => {$(
        #[cfg(feature = $feature)]
        impl From<FramingError> for $error {
            fn from(err: FramingError) -> Self {
                match err {
                    FramingError::BitIo(err) => Self::BitIo(err),
                    FramingError::ArrayCountTooLarge { count, max } => {
                        Self::ArrayCountTooLarge { count, max }
                    }
                    FramingError::IndexOutOfBounds { index, count } => {
                        Self::IndexOutOfBounds { index, count }
                    }
                    FramingError::PayloadTooLarge { bits, remaining } => {
                        Self::PayloadTooLarge { bits, remaining }
                    }
                }
            }
        }
    )+};
}

into_blob_error!(
    "structs" => crate::structs::StructBlobError,
    "effect" => crate::effect::EffectBlobError
);

/// The declared element count, refused past `max`.
pub(crate) fn read_array_count(reader: &mut BitReader<'_>, max: u32) -> Result<u32, FramingError> {
    let count = reader.read_int_packed()?;
    if count > max {
        return Err(FramingError::ArrayCountTooLarge { count, max });
    }
    Ok(count)
}

/// The next element index, or `None` at the terminator.
pub(crate) fn read_element_index(
    reader: &mut BitReader<'_>,
    count: u32,
) -> Result<Option<u32>, FramingError> {
    let Some(index) = reader.read_int_packed()?.checked_sub(1) else {
        return Ok(None);
    };
    if index >= count {
        return Err(FramingError::IndexOutOfBounds { index, count });
    }
    Ok(Some(index))
}

/// The next field's handle and payload bit count, or `None` at the terminator.
pub(crate) fn read_field_header(
    reader: &mut BitReader<'_>,
) -> Result<Option<(u32, u32)>, FramingError> {
    let Some(handle) = reader.read_int_packed()?.checked_sub(1) else {
        return Ok(None);
    };
    let bits = reader.read_int_packed()?;
    let remaining = reader.bits_remaining();
    if bits > MAX_FIELD_PAYLOAD_BITS || u64::from(bits) > remaining {
        return Err(FramingError::PayloadTooLarge { bits, remaining });
    }
    Ok(Some((handle, bits)))
}
