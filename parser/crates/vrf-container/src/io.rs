//! Fixed-width reads shared by the chunk parsers. A short read becomes
//! [`ContainerError::Truncated`] naming the field and the bytes left.

use vrf_bitio::BitReader;

use crate::error::ContainerError;

/// Little-endian `u32` at `at`; every caller has already checked the length.
pub(crate) fn le_u32(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

fn truncated(reader: &BitReader<'_>, context: &'static str, needed: usize) -> ContainerError {
    ContainerError::Truncated {
        context,
        needed,
        available: (reader.bits_remaining() / 8) as usize,
    }
}

pub(crate) fn read_u16(
    reader: &mut BitReader<'_>,
    context: &'static str,
) -> Result<u16, ContainerError> {
    reader.read_u16().map_err(|_| truncated(reader, context, 2))
}

pub(crate) fn read_u32(
    reader: &mut BitReader<'_>,
    context: &'static str,
) -> Result<u32, ContainerError> {
    reader.read_u32().map_err(|_| truncated(reader, context, 4))
}

pub(crate) fn read_i32(
    reader: &mut BitReader<'_>,
    context: &'static str,
) -> Result<i32, ContainerError> {
    read_u32(reader, context).map(|v| v as i32)
}

pub(crate) fn read_f32(
    reader: &mut BitReader<'_>,
    context: &'static str,
) -> Result<f32, ContainerError> {
    read_u32(reader, context).map(f32::from_bits)
}

/// Two `u32` halves, so a short read reports 4 bytes like every other `Truncated`.
pub(crate) fn read_i64(
    reader: &mut BitReader<'_>,
    context: &'static str,
) -> Result<i64, ContainerError> {
    let lo = read_u32(reader, context)?;
    let hi = read_u32(reader, context)?;
    Ok(i64::from(lo) | (i64::from(hi) << 32))
}

pub(crate) fn read_guid(reader: &mut BitReader<'_>) -> Result<[u32; 4], ContainerError> {
    Ok([
        read_u32(reader, "guid")?,
        read_u32(reader, "guid")?,
        read_u32(reader, "guid")?,
        read_u32(reader, "guid")?,
    ])
}

/// The `size`-byte body after the header `reader` has read from `payload`,
/// and the count of bytes after it that the layout does not account for. A
/// negative `size` is `negative(size)`.
#[cfg(any(feature = "event", feature = "checkpoint"))]
pub(crate) fn declared_body<'a>(
    payload: &'a [u8],
    reader: &BitReader<'_>,
    size: i32,
    negative: fn(i32) -> ContainerError,
    context: &'static str,
) -> Result<(&'a [u8], usize), ContainerError> {
    let size = usize::try_from(size).map_err(|_| negative(size))?;
    // Whole-byte reads that all succeeded leave a byte boundary inside `payload`.
    let header_end = (reader.position() / 8) as usize;
    let available = payload.len() - header_end;
    if available < size {
        return Err(ContainerError::Truncated {
            context,
            needed: size,
            available,
        });
    }
    Ok((&payload[header_end..header_end + size], available - size))
}

/// `max_bytes`: `MAX_FRIENDLY_NAME_BYTES` for the friendly name, else `MAX_FSTRING_BYTES`.
pub(crate) fn read_fstring(
    reader: &mut BitReader<'_>,
    context: &'static str,
    max_bytes: i64,
) -> Result<String, ContainerError> {
    reader
        .read_fstring(max_bytes)
        .map_err(|source| ContainerError::FString { context, source })
}
