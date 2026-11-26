//! Crate-wide error type.

use thiserror::Error;

/// Errors that can occur while writing export files. `#[non_exhaustive]`: the
/// `Parquet` variant exists only with the `parquet` feature.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum ExportError {
    #[cfg(feature = "parquet")]
    #[error("parquet write failed: {0}")]
    Parquet(#[from] parquet::errors::ParquetError),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    /// Caller misuse, such as a row-group size of zero.
    #[error("{0}")]
    Usage(String),
}
