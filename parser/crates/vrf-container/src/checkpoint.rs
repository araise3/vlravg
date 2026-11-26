//! Checkpoint chunk parser.
//!
//! A Checkpoint chunk is a full-state snapshot at one instant: the server's
//! NetGUID cache, its net-field export map, and one DemoFrame that re-opens
//! every live actor with its complete replicated state. It is not redundant
//! with ReplayData: 6-11% of a checkpoint's RepLayout values differ from what
//! ReplayData carried at the same timestamp, and 1.0-2.2% of its keys were
//! never sent there.
//!
//! The same six-field header as an Event chunk, then an Oodle archive framed
//! like a ReplayData chunk's but with no `MemorySizeInBytes`; all 4,024
//! checkpoints of the 215-replay 13.01 corpus fit it exactly. The plaintext is
//! `vrf_schema::checkpoint`'s concern.

use vrf_bitio::BitReader;

use crate::error::ContainerError;
use crate::io::{declared_body, read_fstring, read_i32, read_u32};
use crate::limits::MAX_FSTRING_BYTES;

/// A parsed Checkpoint chunk header plus its still-compressed archive.
#[derive(Debug, Clone)]
pub struct CheckpointChunk<'a> {
    /// Checkpoint id, `checkpoint0`, `checkpoint1`, ... in every corpus file.
    pub id: String,
    /// Chunk group, `checkpoint` in every corpus file.
    pub group: String,
    /// Free-form metadata; a 1-based counter in every corpus file.
    pub metadata: String,
    /// Snapshot time in ms: the enclosed DemoFrame's own time in all 4,024 corpus checkpoints.
    pub time1: u32,
    pub time2: u32,
    /// Declared archive size. Validated non-negative and within the chunk.
    pub size_in_bytes: i32,
    /// The Oodle archive, exactly `size_in_bytes` bytes.
    pub archive: &'a [u8],
    /// Bytes after the archive this layout does not account for; 0 in all
    /// 19,166 checkpoints of 1,014 replays, 11.06-13.06.
    pub trailing_bytes: usize,
}

/// Parse a Checkpoint chunk: the region `data[chunk.data_offset .. + chunk.size_in_bytes]`
/// of a [`RawChunk`](crate::RawChunk) of type
/// [`ChunkType::Checkpoint`](crate::ChunkType::Checkpoint).
///
/// # Errors
///
/// [`ContainerError::FString`] if a string runs past the chunk,
/// [`ContainerError::Truncated`] if another field or the archive does, and
/// [`ContainerError::InvalidCheckpointArchiveSize`] if `SizeInBytes` is negative.
pub fn parse_checkpoint_chunk(payload: &[u8]) -> Result<CheckpointChunk<'_>, ContainerError> {
    let mut reader = BitReader::new(payload);

    let id = read_fstring(&mut reader, "checkpoint id", MAX_FSTRING_BYTES)?;
    let group = read_fstring(&mut reader, "checkpoint group", MAX_FSTRING_BYTES)?;
    let metadata = read_fstring(&mut reader, "checkpoint metadata", MAX_FSTRING_BYTES)?;
    let time1 = read_u32(&mut reader, "checkpoint time1")?;
    let time2 = read_u32(&mut reader, "checkpoint time2")?;
    let size_in_bytes = read_i32(&mut reader, "checkpoint archive size")?;

    let (archive, trailing_bytes) = declared_body(
        payload,
        &reader,
        size_in_bytes,
        |size| ContainerError::InvalidCheckpointArchiveSize { size },
        "checkpoint archive",
    )?;

    Ok(CheckpointChunk {
        id,
        group,
        metadata,
        time1,
        time2,
        size_in_bytes,
        archive,
        trailing_bytes,
    })
}

/// Decompress a checkpoint's Oodle archive ([`CheckpointChunk::archive`]),
/// **dropping** the count [`decompress_checkpoint_with_trailing`] returns. With
/// no `MemorySizeInBytes`, the archive's own `decompressed_size` is range-checked
/// before it sizes the allocation. An uncompressed replay returns the archive.
///
/// # Errors
///
/// [`ContainerError::EncryptedNotSupported`] when `encrypted`, and the same
/// Oodle error variants a ReplayData chunk produces.
pub fn decompress_checkpoint(
    archive: &[u8],
    compressed: bool,
    encrypted: bool,
) -> Result<Vec<u8>, ContainerError> {
    decompress_checkpoint_with_trailing(archive, compressed, encrypted).map(|(plain, _)| plain)
}

/// As [`decompress_checkpoint`], also returning the archive bytes the codec
/// never read (bytes after the archive are [`CheckpointChunk::trailing_bytes`]).
/// 0 in all 19,166 checkpoint archives of 1,014 replays, 11.06-13.06.
pub fn decompress_checkpoint_with_trailing(
    archive: &[u8],
    compressed: bool,
    encrypted: bool,
) -> Result<(Vec<u8>, usize), ContainerError> {
    if encrypted {
        return Err(ContainerError::EncryptedNotSupported);
    }
    if !compressed {
        // Every corpus replay is compressed: no framing guess could be checked.
        return Ok((archive.to_vec(), 0));
    }
    // A >2 GiB slice is rejected, not truncated by `as i32`.
    let declared_size = i32::try_from(archive.len()).map_err(|_| ContainerError::Truncated {
        context: "checkpoint archive length",
        needed: archive.len(),
        available: i32::MAX as usize,
    })?;
    crate::oodle::decompress_oodle_archive(archive, declared_size, None, "checkpoint archive")
}

#[cfg(test)]
mod tests {
    use super::*;
    use vrf_testkit::add_fstring_utf16;

    /// The strings are UTF-16, as every corpus checkpoint string is.
    fn build(archive: &[u8], trailing: usize) -> Vec<u8> {
        let mut out = Vec::new();
        add_fstring_utf16(&mut out, "checkpoint0");
        add_fstring_utf16(&mut out, "checkpoint");
        add_fstring_utf16(&mut out, "1");
        out.extend_from_slice(&47u32.to_le_bytes());
        out.extend_from_slice(&47u32.to_le_bytes());
        out.extend_from_slice(&(archive.len() as i32).to_le_bytes());
        out.extend_from_slice(archive);
        out.extend(core::iter::repeat_n(0u8, trailing));
        out
    }

    #[test]
    fn parses_the_six_header_fields_and_hands_back_the_archive() {
        let chunk = build(&[1, 2, 3, 4, 5], 0);
        let cp = parse_checkpoint_chunk(&chunk).unwrap();
        assert_eq!(cp.id, "checkpoint0");
        assert_eq!(cp.group, "checkpoint");
        assert_eq!(cp.metadata, "1");
        assert_eq!(cp.time1, 47);
        assert_eq!(cp.time2, 47);
        assert_eq!(cp.size_in_bytes, 5);
        assert_eq!(cp.archive, &[1, 2, 3, 4, 5]);
        assert_eq!(cp.trailing_bytes, 0);
    }

    /// Zero across the corpus, so this is the only place the branch runs.
    #[test]
    fn trailing_bytes_are_reported_not_discarded() {
        let chunk = build(&[9; 3], 4);
        let cp = parse_checkpoint_chunk(&chunk).unwrap();
        assert_eq!(cp.archive, &[9, 9, 9]);
        assert_eq!(cp.trailing_bytes, 4);
    }

    #[test]
    fn a_negative_archive_size_is_an_error() {
        let mut chunk = build(&[1, 2], 0);
        let size_at = chunk.len() - 2 - 4;
        chunk[size_at..size_at + 4].copy_from_slice(&(-1i32).to_le_bytes());
        assert!(matches!(
            parse_checkpoint_chunk(&chunk),
            Err(ContainerError::InvalidCheckpointArchiveSize { size: -1 })
        ));
    }

    #[test]
    fn an_archive_running_past_the_chunk_is_truncated_not_panicking() {
        let mut chunk = build(&[1, 2], 0);
        let size_at = chunk.len() - 2 - 4;
        chunk[size_at..size_at + 4].copy_from_slice(&4096i32.to_le_bytes());
        assert!(matches!(
            parse_checkpoint_chunk(&chunk),
            Err(ContainerError::Truncated { .. })
        ));
    }

    /// Nothing outside bounds the archive's own output length, so a corrupt
    /// header must not become a huge allocation.
    #[test]
    fn an_out_of_range_decompressed_size_is_rejected() {
        let mut archive = Vec::new();
        archive.extend_from_slice(&i32::MAX.to_le_bytes());
        archive.extend_from_slice(&0i32.to_le_bytes());
        assert!(matches!(
            decompress_checkpoint(&archive, true, false),
            Err(ContainerError::InvalidMemorySize { size }) if size == i32::MAX
        ));
    }

    #[test]
    fn encryption_is_refused_rather_than_guessed() {
        assert!(matches!(
            decompress_checkpoint(&[0; 8], true, true),
            Err(ContainerError::EncryptedNotSupported)
        ));
    }
}
