//! The element loop the three struct blobs share, over the common framing.

use vrf_bitio::BitReader;

use super::{Result, StructBlobError};
use crate::framing::{
    MAX_FIELDS_PER_ELEMENT, read_array_count, read_element_index, read_field_header,
};

/// Maximum element count of a struct blob.
const MAX_ARRAY_COUNT: u32 = 128;

/// The element loop all three blobs share. Per field, in this order: header,
/// field-count limit, window, `name_for(handle)`, then `member` (reads the
/// window into the row and returns the label a leftover is reported under, or
/// `None` for a name without an arm), then the window-consumed check. The
/// order decides which error a malformed blob reports, so it is written once.
pub(super) fn decode_elements<'d, R>(
    reader: &mut BitReader<'_>,
    context: &'static str,
    mut name_for: impl FnMut(u32) -> Result<&'d str>,
    new_row: impl Fn(u32) -> R,
    mut member: impl FnMut(&mut R, &'d str, &mut BitReader<'_>) -> Result<Option<&'d str>>,
) -> Result<Vec<R>> {
    let count = read_array_count(reader, MAX_ARRAY_COUNT)?;
    let mut rows = Vec::new();
    while let Some(index) = read_element_index(reader, count)? {
        let mut row = new_row(index);
        for field_idx in 0..=MAX_FIELDS_PER_ELEMENT {
            let Some((handle, bit_count)) = read_field_header(reader)? else {
                break;
            };
            if field_idx == MAX_FIELDS_PER_ELEMENT {
                return Err(StructBlobError::TooManyFields { context });
            }
            // Advances the parent past the window, whatever `member` reads.
            let mut sub = reader.sub_reader(u64::from(bit_count))?;
            let name = name_for(handle)?;
            let Some(label) = member(&mut row, name, &mut sub)? else {
                return Err(StructBlobError::UnsupportedMember {
                    name: name.to_owned(),
                    handle,
                    context,
                });
            };
            ensure_member_consumed(&sub, label, handle, bit_count, context)?;
        }
        rows.push(row);
    }
    ensure_consumed(reader)?;
    Ok(rows)
}

/// Read a byte-width enum whose payload carries only its significant bits;
/// a zero-width or over-wide payload is an error.
pub(super) fn read_narrow_byte(
    reader: &mut BitReader<'_>,
    name: &str,
    context: &'static str,
) -> Result<u8> {
    let bits = reader.bits_remaining();
    if bits == 0 || bits > 8 {
        return Err(StructBlobError::InvalidEnumWidth {
            name: name.to_owned(),
            bits,
            context,
        });
    }
    Ok(reader.read_bits(bits as u32)? as u8)
}

/// The name the REPLAY declares for `handle`, which selects a member. Handle
/// -> name, NEVER the reverse: `WinningTeam` is also the match-winner scalar
/// at handle 50.
pub(super) fn member_name<'d>(
    declared: &[Option<&'d str>],
    handle: u32,
    context: &'static str,
) -> Result<&'d str> {
    declared
        .get(handle as usize)
        .copied()
        .flatten()
        .ok_or(StructBlobError::UndeclaredHandle { handle, context })
}

/// Ensure ONE field's sub-reader consumed its whole window, which
/// [`ensure_consumed`] cannot see.
fn ensure_member_consumed(
    sub: &BitReader<'_>,
    name: &str,
    handle: u32,
    declared: u32,
    context: &'static str,
) -> Result<()> {
    let remaining = sub.bits_remaining();
    if remaining > 0 {
        return Err(StructBlobError::MemberNotFullyConsumed {
            name: name.to_owned(),
            handle,
            declared,
            remaining,
            context,
        });
    }
    Ok(())
}

/// Ensure the reader is fully consumed.
fn ensure_consumed(reader: &BitReader<'_>) -> Result<()> {
    if reader.bits_remaining() > 0 {
        return Err(StructBlobError::NotFullyConsumed {
            remaining: reader.bits_remaining(),
        });
    }
    Ok(())
}
