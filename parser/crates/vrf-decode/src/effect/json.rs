//! Export wiring: one effect blob in, one JSON array out.

use core::fmt::Write as _;

use super::elements::{
    EffectData, decode_effect_floats_at, decode_effect_objects_at, decode_effect_vectors_at,
};
use super::framing::{new_blob_reader, scan_element_handles};
use super::{EffectArrayKind, EffectBlobError, EffectHandles, Result};
use crate::types::VectorJson;

/// Decode one effect-array blob and render it as a JSON array.
///
/// Each element becomes `{"tag":<u32|null>,"value":<value|null>}`, the value a
/// number for [`EffectArrayKind::Float`] and [`EffectArrayKind::Object`] and
/// `{"x":..,"y":..,"z":..}` for [`EffectArrayKind::Vector`]. Unpopulated slots
/// keep their position, so the JSON index is the wire index. `raw` is the
/// parameter payload as `fields.parquet` stores it; `bit_count` is its declared
/// `payload_bits`, **not** `raw.len() * 8`: the padding is not data.
///
/// # Errors
/// [`EffectBlobError`] if the payload is not a well-formed array of this kind,
/// does not consume its window, or holds a float JSON cannot represent. The
/// caller keeps the raw bits and counts the failure.
pub fn decode_effect_blob_json(
    kind: EffectArrayKind,
    raw: &[u8],
    bit_count: u32,
) -> Result<String> {
    // `None` means no element carries a field, so any pair decodes the blob
    // identically.
    let handles = scan_element_handles(raw, bit_count)?.unwrap_or(EffectHandles::from_base(0));
    let mut reader = new_blob_reader(raw, bit_count)?;

    // Not pre-reserved: sizing from the element count measured no faster end
    // to end and cost resident memory in the export's row buffer.
    let mut out = String::new();
    match kind {
        EffectArrayKind::Float => {
            let elements = decode_effect_floats_at(&mut reader, handles)?;
            push_elements(&mut out, &elements, |out, index, v| {
                if !v.is_finite() {
                    return Err(EffectBlobError::NonFiniteFloat { index });
                }
                // Widened first: the f64 text is what the export pins.
                let _ = write!(out, "{}", f64::from(v));
                Ok(())
            })?;
        }
        EffectArrayKind::Object => {
            let elements = decode_effect_objects_at(&mut reader, handles)?;
            push_elements(&mut out, &elements, |out, _, v| {
                let _ = write!(out, "{v}");
                Ok(())
            })?;
        }
        EffectArrayKind::Vector => {
            let elements = decode_effect_vectors_at(&mut reader, handles)?;
            push_elements(&mut out, &elements, |out, index, v| {
                if !(v.x.is_finite() && v.y.is_finite() && v.z.is_finite()) {
                    return Err(EffectBlobError::NonFiniteFloat { index });
                }
                let _ = write!(out, "{}", VectorJson(&v));
                Ok(())
            })?;
        }
    }

    // Checked after the decode, which stops at the terminator by design.
    // Every remaining bit counts, a sub-byte tail included: `bit_count` is the
    // declared payload, so four unread bits are as wrong as forty.
    let remaining = reader.bits_remaining();
    if remaining > 0 {
        return Err(EffectBlobError::ResidualBits { remaining });
    }

    Ok(out)
}

/// Write `elements` as comma-separated `{"tag":..,"value":..}` objects in a
/// JSON array; `push_value` renders a present value, an absent one is `null`.
/// Floats go through `Display`, the shortest round-trip form: faster printers
/// write `1E20` where Rust writes `100000000000000000000`, and the export
/// oracle pins these bytes. A hand-written `u32` writer for the ~128,000 tags
/// a replay measured neutral.
fn push_elements<V: Copy>(
    out: &mut String,
    elements: &[EffectData<V>],
    mut push_value: impl FnMut(&mut String, usize, V) -> Result<()>,
) -> Result<()> {
    out.push('[');
    for (index, element) in elements.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        match element.tag_index {
            Some(t) => {
                let _ = write!(out, "{{\"tag\":{t},\"value\":");
            }
            None => out.push_str("{\"tag\":null,\"value\":"),
        }
        match element.value {
            Some(v) => push_value(out, index, v)?,
            None => out.push_str("null"),
        }
        out.push('}');
    }
    out.push(']');
    Ok(())
}
