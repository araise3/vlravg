//! The chunk stream after the replay info. A [`RawChunk`] names a byte range in
//! the caller's buffer, so a consumer can skip whole chunk kinds unread.

use crate::error::ContainerError;
use crate::io::le_u32;

/// Chunk discriminant. Header (0) must be the first chunk; values other than
/// 0-3 are kept in `Unknown`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChunkType {
    Header,
    ReplayData,
    Checkpoint,
    Event,
    Unknown(u32),
}

impl ChunkType {
    #[must_use]
    pub const fn from_raw(raw: u32) -> Self {
        match raw {
            0 => Self::Header,
            1 => Self::ReplayData,
            2 => Self::Checkpoint,
            3 => Self::Event,
            other => Self::Unknown(other),
        }
    }

    #[must_use]
    pub const fn to_raw(self) -> u32 {
        match self {
            Self::Header => 0,
            Self::ReplayData => 1,
            Self::Checkpoint => 2,
            Self::Event => 3,
            Self::Unknown(v) => v,
        }
    }
}

/// A single chunk's type and byte range, without owning its payload.
#[derive(Debug, Clone)]
pub struct RawChunk {
    pub chunk_type: ChunkType,
    pub size_in_bytes: i32,
    /// Offset of the payload in the input slice, past the 8-byte chunk header.
    pub data_offset: usize,
}

/// Lazy iterator over the chunk stream; the caller reads each payload through
/// `RawChunk::data_offset` or skips it.
pub struct ChunkIterator<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> ChunkIterator<'a> {
    /// Start at `offset`, the first chunk header after the replay info.
    #[must_use]
    pub const fn new(data: &'a [u8], offset: usize) -> Self {
        Self { data, pos: offset }
    }

    #[must_use]
    pub const fn position(&self) -> usize {
        self.pos
    }

    #[must_use]
    pub const fn at_end(&self) -> bool {
        self.pos >= self.data.len()
    }

    /// The next chunk's metadata, advancing past its payload. `Ok(None)` at the
    /// end of the buffer; an error when too few bytes remain for a chunk header
    /// or the declared size runs past the buffer.
    pub fn next_chunk(&mut self) -> Result<Option<RawChunk>, ContainerError> {
        let available = match self.data.len().checked_sub(self.pos) {
            None | Some(0) => return Ok(None),
            Some(n) => n,
        };
        if available < 8 {
            return Err(ContainerError::Truncated {
                context: "chunk header",
                needed: 8,
                available,
            });
        }

        let raw_type = le_u32(self.data, self.pos);
        let size = le_u32(self.data, self.pos + 4) as i32;

        if size < 0 {
            return Err(ContainerError::InvalidChunkSize { size });
        }
        let size_usize = size as usize;
        let data_offset = self.pos + 8;

        // Against what is left: `data_offset + size_usize` can overflow a 32-bit `usize`.
        if size_usize > self.data.len() - data_offset {
            return Err(ContainerError::Truncated {
                context: "chunk payload",
                needed: size_usize,
                available: self.data.len() - data_offset,
            });
        }

        let chunk = RawChunk {
            chunk_type: ChunkType::from_raw(raw_type),
            size_in_bytes: size,
            data_offset,
        };

        self.pos = data_offset + size_usize;
        Ok(Some(chunk))
    }
}
