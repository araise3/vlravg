//! The sections between ExportData and a DemoFrame's packet loop, which exist
//! only to be skipped: a miscounted one desynchronises the frame instead of
//! failing. Level names are still read and validated, not blind-skipped
//! (docs/PERFORMANCE_NOTES.md#measured-shape-on-real-replays).

use vrf_bitio::BitReader;

use crate::error::FrameError;

/// Cap on a level name's FString.
const MAX_FSTRING_BYTES: i64 = 1024 * 1024;

/// StreamingLevelFixes: level names, compact or verbose.
pub(crate) fn read_streaming_level_fixes(
    reader: &mut BitReader<'_>,
    has_streaming_fixes: bool,
) -> Result<(), FrameError> {
    let num_levels = reader.read_int_packed()?;

    if has_streaming_fixes {
        // Compact form: FString names, then a u64 externalOffset.
        for _ in 0..num_levels {
            let _ = reader.read_fstring(MAX_FSTRING_BYTES)?;
        }
        let _ = reader.read_u64()?;
    } else {
        // Verbose form, which no measured replay takes: packageName,
        // packageNameToLoad and a 40-byte FTransform (10 f32) per entry.
        for _ in 0..num_levels {
            let _ = reader.read_fstring(MAX_FSTRING_BYTES)?;
            let _ = reader.read_fstring(MAX_FSTRING_BYTES)?;
            reader.skip_bits(40 * 8)?;
        }
    }

    Ok(())
}

/// ExternalData: numBits, netGuid and payload until numBits is 0. Returns the
/// `(blobs, bytes)` skipped.
pub(crate) fn read_external_data(reader: &mut BitReader<'_>) -> Result<(u64, u64), FrameError> {
    let mut blobs = 0u64;
    let mut bytes = 0u64;
    loop {
        let num_bits = reader.read_int_packed()?;
        if num_bits == 0 {
            return Ok((blobs, bytes));
        }
        let _net_guid = reader.read_int_packed()?;
        let byte_count = u64::from(num_bits.div_ceil(8));
        reader.skip_bits(byte_count * 8)?;
        blobs += 1;
        bytes += byte_count;
    }
}

/// GameSpecificFrameData: when the flag is set, a u64 byte count and that
/// many bytes. Returns the bytes skipped.
pub(crate) fn read_game_specific_frame_data(
    reader: &mut BitReader<'_>,
    has_game_specific: bool,
) -> Result<u64, FrameError> {
    if !has_game_specific {
        return Ok(0);
    }
    let skip_offset = reader.read_u64()?;
    // A raw wire u64: saturated, an overflow fails as Eof instead of wrapping.
    reader.skip_bits(skip_offset.saturating_mul(8))?;
    Ok(skip_offset)
}

#[cfg(test)]
mod tests {
    use super::read_game_specific_frame_data;
    use vrf_bitio::BitReader;

    #[test]
    fn a_huge_game_specific_skip_offset_errors_instead_of_wrapping() {
        // (1 << 61) + 1 wraps to 8 bits under `* 8`, which the trailing byte
        // would satisfy: a silent Ok.
        let bytes: [u8; 9] = [0x01, 0, 0, 0, 0, 0, 0, 0x20, 0xFF];
        let mut reader = BitReader::new(&bytes);
        let result = read_game_specific_frame_data(&mut reader, true);
        assert!(
            result.is_err(),
            "an overflowing skip offset must error, not wrap to 8 and succeed"
        );
    }
}
