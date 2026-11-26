use vrf_bitio::BitError;

/// A movement RPC decode failure. Exhaustive on purpose: adding
/// `#[non_exhaustive]` or removing a variant would break downstream matches.
#[derive(Debug, Clone, thiserror::Error)]
pub enum MovementError {
    #[error("bit read error: {0}")]
    Bit(#[from] BitError),

    #[error("invalid movement magic: 0x{0:02X} (expected 0x52)")]
    InvalidMagic(u8),

    #[error("movement marker mismatch: expected {expected}, got {actual}")]
    MarkerMismatch { expected: u8, actual: u8 },

    #[error("movement error sentinel was set")]
    ErrorSentinel,

    #[error("variant-0 external character reference is not supported")]
    Variant0ExternalCharRef,

    #[error("update count too large: {0}")]
    TooManyUpdates(u32),

    #[error("movement component header needs 16 bits, only {available_bits} remain")]
    TruncatedComponentHeader { available_bits: u64 },

    /// Never emitted: an index past the declared count is counted in
    /// `RpcDecodeResult::error_count` instead. Kept for API compatibility.
    #[error("update index {index} out of range (count={count})")]
    UpdateIndexOutOfRange { index: u32, count: u32 },
}
