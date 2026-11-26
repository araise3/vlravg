//! The `FEffectData*` element type and its array decoders. The element loop is
//! written once over [`EffectValue`], so the `settle_field` accounting cannot
//! drift between the three value types.

use vrf_bitio::BitReader;

use super::framing::{MAX_ARRAY_COUNT, consume_trailing_terminator, expect_width, settle_field};
use super::{
    EffectBlobError, EffectHandles, FLOAT_HANDLES, OBJECT_HANDLES, Result, VECTOR_HANDLES,
};
use crate::framing::{
    MAX_FIELDS_PER_ELEMENT, read_array_count, read_element_index, read_field_header,
};
use crate::types::FVector;

/// One `FEffectData*` element: a gameplay-tag index (a name like
/// `FiringState.AmmoRemaining` through the replay's tag table) and a value,
/// each `None` if the wire left it out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EffectData<V> {
    pub tag_index: Option<u32>,
    pub value: Option<V>,
}

/// `FEffectDataFloat`.
pub type EffectDataFloat = EffectData<f32>;
/// `FEffectDataObject`: the value is an object net GUID.
pub type EffectDataObject = EffectData<u32>;
/// `FEffectDataVector`: the value is three f64s on the wire.
pub type EffectDataVector = EffectData<FVector>;

/// A value type the shared element loop can read.
trait EffectValue: Copy {
    /// Names the element type in [`EffectBlobError::TooManyFields`] and
    /// [`EffectBlobError::MissingTerminator`].
    const CONTEXT: &'static str;

    /// Read the value member (handle already checked). Fixed-width types check
    /// `payload_bits` first: a wider read would run into the next field.
    fn read(reader: &mut BitReader<'_>, payload_bits: u32) -> Result<Self>;
}

impl EffectValue for f32 {
    const CONTEXT: &'static str = "EffectDataFloat";

    fn read(reader: &mut BitReader<'_>, payload_bits: u32) -> Result<Self> {
        expect_width("EffectDataFloat value", 32, payload_bits)?;
        Ok(reader.read_f32()?)
    }
}

impl EffectValue for u32 {
    const CONTEXT: &'static str = "EffectDataObject";

    /// IntPacked, like the tag, so width cannot tell them apart; the tag is the
    /// lower handle. Per function on `02d4d478` the lower takes 1 to 5 values
    /// from tag space, the upper 209 to 580 across the net-GUID range.
    fn read(reader: &mut BitReader<'_>, _payload_bits: u32) -> Result<Self> {
        Ok(reader.read_int_packed()?)
    }
}

impl EffectValue for FVector {
    const CONTEXT: &'static str = "EffectDataVector";

    fn read(reader: &mut BitReader<'_>, payload_bits: u32) -> Result<Self> {
        expect_width("EffectDataVector value", 192, payload_bits)?;
        Ok(FVector {
            x: reader.read_f64()?,
            y: reader.read_f64()?,
            z: reader.read_f64()?,
        })
    }
}

/// Decode one `TArray<FEffectData*>` under the handle pair its function uses.
/// The result has the declared length, unpopulated slots staying all-`None`,
/// so an output index is the wire index.
fn decode_elements<V: EffectValue>(
    reader: &mut BitReader<'_>,
    handles: EffectHandles,
) -> Result<Vec<EffectData<V>>> {
    let count = read_array_count(reader, MAX_ARRAY_COUNT)?;
    let absent = EffectData {
        tag_index: None,
        value: None,
    };
    let mut elements = vec![absent; count as usize];
    // Terminators are required, not inferred; see `MissingTerminator`.
    let mut array_terminated = false;
    let mut previous: Option<u32> = None;

    while !reader.at_end() {
        let Some(index) = read_element_index(reader, count)? else {
            consume_trailing_terminator(reader)?;
            array_terminated = true;
            break;
        };
        if let Some(previous) = previous.filter(|&p| index <= p) {
            return Err(EffectBlobError::NonAscendingIndex { index, previous });
        }
        previous = Some(index);

        let elem = &mut elements[index as usize];
        let mut field_count = 0u32;
        let mut element_terminated = false;

        while !reader.at_end() {
            let Some((handle, payload_bits)) = read_field_header(reader)? else {
                element_terminated = true;
                break;
            };
            field_count += 1;
            if field_count > MAX_FIELDS_PER_ELEMENT {
                return Err(EffectBlobError::TooManyFields {
                    context: V::CONTEXT,
                });
            }

            let start_pos = reader.position();
            if handle == handles.tag {
                elem.tag_index = Some(reader.read_int_packed()?);
            } else if handle == handles.value {
                elem.value = Some(V::read(reader, payload_bits)?);
            } else {
                reader.skip_bits(u64::from(payload_bits))?;
            }

            settle_field(reader, start_pos, payload_bits)?;
        }

        if !element_terminated {
            return Err(EffectBlobError::MissingTerminator {
                context: V::CONTEXT,
            });
        }
    }

    // A zero-count array carries no elements and no terminator -- the count
    // byte is the whole blob -- so only a populated array owes one.
    if count > 0 && !array_terminated {
        return Err(EffectBlobError::MissingTerminator {
            context: V::CONTEXT,
        });
    }

    Ok(elements)
}

/// Decode a `TArray<FEffectDataFloat>` (`reader` at the start of the blob)
/// under the handles `ReplayPlayContinuousEffectAtLocation` uses, 7/8; other
/// functions need [`decode_effect_floats_at`]. The framing is in the
/// [`crate::effect`] docs.
pub fn decode_effect_floats(reader: &mut BitReader<'_>) -> Result<Vec<EffectDataFloat>> {
    decode_elements(reader, FLOAT_HANDLES)
}

/// [`decode_effect_floats`] with the element's handle pair supplied (see
/// [`EffectHandles`]).
pub fn decode_effect_floats_at(
    reader: &mut BitReader<'_>,
    handles: EffectHandles,
) -> Result<Vec<EffectDataFloat>> {
    decode_elements(reader, handles)
}

/// Decode a `TArray<FEffectDataObject>` under the handles
/// `ReplayPlayContinuousEffectAtLocation` uses, 15/16; see
/// [`decode_effect_floats`].
pub fn decode_effect_objects(reader: &mut BitReader<'_>) -> Result<Vec<EffectDataObject>> {
    decode_elements(reader, OBJECT_HANDLES)
}

/// [`decode_effect_objects`] with the element's handle pair supplied.
pub fn decode_effect_objects_at(
    reader: &mut BitReader<'_>,
    handles: EffectHandles,
) -> Result<Vec<EffectDataObject>> {
    decode_elements(reader, handles)
}

/// Decode a `TArray<FEffectDataVector>` (values are three f64s, 192 bits)
/// under the handles `ReplayPlayContinuousEffectAtLocation` uses, 11/12; see
/// [`decode_effect_floats`].
pub fn decode_effect_vectors(reader: &mut BitReader<'_>) -> Result<Vec<EffectDataVector>> {
    decode_elements(reader, VECTOR_HANDLES)
}

/// [`decode_effect_vectors`] with the element's handle pair supplied.
pub fn decode_effect_vectors_at(
    reader: &mut BitReader<'_>,
    handles: EffectHandles,
) -> Result<Vec<EffectDataVector>> {
    decode_elements(reader, handles)
}
