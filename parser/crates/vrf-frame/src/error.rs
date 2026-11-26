use thiserror::Error;

/// A chunk malformed at the framing level; content-block errors live in
/// `vrf-net`.
#[derive(Debug, Error)]
pub enum FrameError {
    #[error("bit-IO error during frame parsing: {0}")]
    Bit(String),

    /// A net-field export or export-GUID read failed.
    #[error("schema error during frame parsing: {0}")]
    Schema(String),

    #[error("negative packet size: {size}")]
    NegativePacketSize { size: i32 },

    #[error("packet size {size} exceeds maximum {max}")]
    PacketTooLarge { size: i32, max: i32 },

    #[error("frame time {seconds} s is outside the representable millisecond range")]
    TimeOutOfRange { seconds: f32 },

    #[error("{context}: needed {needed} bytes, only {available} available")]
    Truncated {
        context: &'static str,
        needed: usize,
        available: usize,
    },
}

// `Bit` and `Schema` hold the rendered string, not the source error, so a
// vrf-bitio or vrf-schema error-shape change is not a breaking change here.
impl From<vrf_bitio::BitError> for FrameError {
    fn from(e: vrf_bitio::BitError) -> Self {
        Self::Bit(e.to_string())
    }
}

impl From<vrf_schema::SchemaError> for FrameError {
    fn from(e: vrf_schema::SchemaError) -> Self {
        Self::Schema(e.to_string())
    }
}
