//! The scalar readers with more to them than one `BitReader` call; the rest
//! are inline in `dispatch_decode`. `decode_field` checks that the payload was
//! fully consumed, so none of these needs to.

use core::fmt::Write as _;

use vrf_bitio::{BitError, BitReader};

use super::{DecodeError, DecodedValue};

/// A byte enum or `uint8`, as wide as the payload rather than a fixed 8 bits:
/// Unreal writes only the significant bits of byte properties nested in
/// replicated arrays (`CombatReport` `AssistType` is 5 bits; a fixed 8-bit
/// read left all 364 of its rows untyped). Wider than 8 bits is refused, not
/// truncated to a plausible low byte.
pub(super) fn decode_byte(r: &mut BitReader<'_>) -> Result<DecodedValue, DecodeError> {
    let width = r.bits_remaining();
    if width == 0 || width > 8 {
        // Fall back to the nominal width so the error names a concrete read.
        return Ok(DecodedValue::I64(i64::from(r.read_u8()?)));
    }
    Ok(DecodedValue::I64(r.read_bits(width as u32)? as i64))
}

pub(super) fn decode_u64(r: &mut BitReader<'_>) -> Result<DecodedValue, DecodeError> {
    let value = r.read_u64()?;
    if value > i64::MAX as u64 {
        return Err(DecodeError::UnsignedOverflow { value });
    }
    Ok(DecodedValue::I64(value as i64))
}

/// An FName: an `isHardcoded` bit, then either an IntPacked index into the
/// engine's name table, rendered as its decimal (177 of 581 `DamagedBone`
/// payloads on 02d4d478 are this 9-bit form), or an inline FString and an i32
/// instance number (0 is the bare name, `N` is `Name_{N-1}`; docs/DATA.md
/// "FName instance numbers are part of the name"). Generic over the error so
/// the struct blobs keep their variants; `max_bytes` caps the inline string
/// (64 KiB for fields, 1024 in struct blobs).
pub(crate) fn read_fname<E: From<BitError> + From<DecodeError>>(
    r: &mut BitReader<'_>,
    max_bytes: i64,
) -> Result<String, E> {
    if r.read_bit()? {
        return Ok(r.read_int_packed()?.to_string());
    }
    let name = r.read_fstring(max_bytes)?;
    // Negative has no display form; `i32::MIN - 1` must not wrap into a name.
    match r.read_i32()? {
        0 => Ok(name),
        number if number < 0 => Err(DecodeError::InvalidFNameNumber { number }.into()),
        number => Ok(format!("{name}_{}", number - 1)),
    }
}

/// 128-bit GUID: 4 x u32 LE, formatted as a standard 36-byte hex GUID.
pub(super) fn read_guid(r: &mut BitReader<'_>) -> Result<String, BitError> {
    let [a, b, c, d] = [r.read_u32()?, r.read_u32()?, r.read_u32()?, r.read_u32()?];
    let mut s = String::with_capacity(36);
    let _ = write!(
        s,
        "{:08x}-{:04x}-{:04x}-{:04x}-{:012x}",
        a,
        (b >> 16) & 0xFFFF,
        b & 0xFFFF,
        (c >> 16) & 0xFFFF,
        (u64::from(c & 0xFFFF) << 32) | u64::from(d)
    );
    Ok(s)
}

/// A byte enum as wide as its payload (at most 32 bits are read). Zero bits
/// read as `I64(0)`, not a fabricated value: Unreal writes
/// `ceil(log2(variant_count))` bits, so zero bits is the complete encoding of a
/// one-variant enum, and the overlay counts it `decoded_ok`.
pub(super) fn decode_enum_remaining_bits(
    r: &mut BitReader<'_>,
) -> Result<DecodedValue, DecodeError> {
    let width = r.bits_remaining().min(32) as u32;
    Ok(DecodedValue::I64(r.read_bits(width)? as i64))
}

/// Lowercase hex digits, indexed by nibble.
const HEX_DIGITS: [u8; 16] = *b"0123456789abcdef";

/// Length-prefixed byte blob, hex-encoded as it is read (no per-byte
/// `format!`). The table's cap is checked first and keeps its own variant; a
/// count the payload cannot hold is then `InvalidLength` (`Malformed`), not
/// `Eof`, as `read_fstring` refuses a string's: the prefix is at fault.
pub(super) fn read_byte_array_hex(
    r: &mut BitReader<'_>,
    max_bytes: u32,
) -> Result<String, DecodeError> {
    let start = r.position();
    let count = r.read_int_packed()?;
    if count > max_bytes {
        return Err(DecodeError::ByteArrayLengthCapExceeded {
            declared: count,
            max: max_bytes,
        });
    }
    if u64::from(count) * 8 > r.bits_remaining() {
        return Err(BitError::InvalidLength {
            position: start,
            length: i64::from(count),
        }
        .into());
    }
    let mut hex = String::with_capacity(count as usize * 2);
    for _ in 0..count {
        let byte = r.read_u8()?;
        hex.push(HEX_DIGITS[(byte >> 4) as usize] as char);
        hex.push(HEX_DIGITS[(byte & 0x0F) as usize] as char);
    }
    Ok(hex)
}
