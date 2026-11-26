//! The replay info and the first (Header) chunk: a caller needs both before one
//! packet, for the compression flag, the build and the DemoFrame sections.

use crate::chunk::{ChunkIterator, ChunkType};
use crate::error::ContainerError;
use crate::header::{self, ReplayHeader};
use crate::info::{self, ReplayInfo};

/// The parsed info and header, and where the chunk stream resumes.
#[derive(Debug)]
pub struct Preamble {
    pub info: ReplayInfo,
    pub header: ReplayHeader,
    /// Byte offset of the first chunk after the Header chunk.
    pub remaining_offset: usize,
}

/// The entry point for reading a `.vrf` file.
pub fn parse_preamble(data: &[u8]) -> Result<Preamble, ContainerError> {
    let (replay_info, info_end) = info::parse_replay_info(data)?;

    // Header must be first; see `ContainerError::ChunkBeforeHeader`.
    let mut iter = ChunkIterator::new(data, info_end);
    let chunk = iter
        .next_chunk()?
        .ok_or(ContainerError::MissingHeaderChunk)?;

    match chunk.chunk_type {
        ChunkType::Header => {
            let payload =
                &data[chunk.data_offset..chunk.data_offset + chunk.size_in_bytes as usize];
            let replay_header = header::parse_replay_header(payload)?;
            Ok(Preamble {
                info: replay_info,
                header: replay_header,
                remaining_offset: iter.position(),
            })
        }
        ChunkType::ReplayData => Err(ContainerError::DataBeforeHeader),
        ChunkType::Checkpoint | ChunkType::Event | ChunkType::Unknown(_) => {
            Err(ContainerError::ChunkBeforeHeader {
                chunk_type: chunk.chunk_type,
            })
        }
    }
}
