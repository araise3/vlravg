//! Decoders for Valorant struct-array blobs that arrive as opaque raw bits.
//!
//! | Field | Export group | Purpose | Module |
//! |-------|-------------|---------|--------|
//! | `RoundResults` | `BombGameState` | Per-round winning team and outcome | `round_results` |
//! | `TeamEconomy` | `BombGameState` | Team loadout value per round | `team_economy` |
//! | `RoundInfos` | `OwnerExclusivePlayerInfo` | Per-player per-round credit | `round_infos` |
//!
//! All three use the RepLayout dynamic-array framing the effect arrays use
//! (diagrammed in the `effect` module docs); an FName member goes through
//! `FieldType::FName`'s reader with a 1024-byte string cap.
//!
//! # Members are selected by DECLARED NAME, not by handle number
//!
//! Handle numbers are a per-build layout detail: 13.02 moved `RoundResults`'
//! members down by eight, which a handle-keyed decoder reads as nothing. So the
//! decoders take, besides a `reader` over exactly the blob's declared bits,
//! `declared`: the enclosing group's field export names indexed by handle
//! (only the fixed-handle `decode_team_economy` does not). An empty declaration
//! is an error, never a fallback to build-specific numbers.
//!
//! Members and payload types, with each build's handles as a reading aid ONLY:
//!
//! - RoundResults (`BombGameState`; 13.01: 93..=96, 13.02: 81..=84,
//!   13.09: 82..=93):
//!   `WinningTeam` (FName), `WinningTeamRole` and `RoundResult` (enum bytes of
//!   variable width), `EliminatedTeams` (skipped; declared at TWO consecutive
//!   handles in every build, one name arm covering both). 13.09 adds
//!   `WinningTeamMode` (an enum byte with unknown names, kept raw) and the
//!   nested `TeamResults` array (skipped).
//! - RoundInfos (`OwnerExclusivePlayerInfo`; 40..=44 in both builds):
//!   `RoundNumber`, `StartOfRoundMoney`, `StartOfRoundLoadoutValue`,
//!   `EndOfRoundMoney`, `EndOfRoundLoadoutValue` (all Int32).
//! - TeamEconomy (`BombGameState` through 13.01; 53..=55 in the 12.01-12.05
//!   samples, 56..=58 from 12.06): `241`, the ReplicationId declared as a
//!   hardcoded FName index (IntPacked), and `LoadoutValue`,
//!   `AverageLoadoutValue` (Int32). From 13.02 the property lives in
//!   separately replicated BaseTeamState actors. `decode_team_economy` keeps
//!   the fixed 56..=58 layout; `decode_team_economy_declared` follows the
//!   declaration.

mod framing;
mod round_infos;
mod round_results;
mod team_economy;

#[cfg(test)]
mod tests;

pub use round_infos::{PlayerRoundInfo, decode_round_infos};
pub use round_results::{AresRoundOutcome, AresTeamRole, RoundResult, decode_round_results};
pub use team_economy::{TeamEconomyUpdate, decode_team_economy, decode_team_economy_declared};

/// Errors that can occur while decoding a struct-array blob.
#[derive(Debug, Clone, thiserror::Error)]
pub enum StructBlobError {
    #[error("bit read: {0}")]
    BitIo(#[from] vrf_bitio::BitError),
    #[error("field decode: {0}")]
    Decode(#[from] crate::DecodeError),
    #[error("array count {count} exceeds maximum {max}")]
    ArrayCountTooLarge { count: u32, max: u32 },
    #[error("element index {index} >= declared count {count}")]
    IndexOutOfBounds { index: u32, count: u32 },
    #[error("field payload {bits} bits exceeds remaining {remaining}")]
    PayloadTooLarge { bits: u32, remaining: u64 },
    /// `decode_team_economy` only.
    #[error("unsupported field handle {handle} in {context}")]
    UnsupportedHandle { handle: u32, context: &'static str },
    /// Nothing to select a member with.
    #[error("undeclared field handle {handle} in {context}")]
    UndeclaredHandle { handle: u32, context: &'static str },
    /// The shape a member takes when a build renames or adds it.
    #[error("unsupported member {name} (handle {handle}) in {context}")]
    UnsupportedMember {
        name: String,
        handle: u32,
        context: &'static str,
    },
    #[error("too many fields in element ({context})")]
    TooManyFields { context: &'static str },
    /// Reported, because `None` means "not sent".
    #[error("{enum_name} has no variant for value {value} in {context}")]
    UnknownEnumValue {
        enum_name: &'static str,
        value: u8,
        context: &'static str,
    },
    /// No bits, or more than a byte.
    #[error("{name} enum width {bits} is invalid in {context}")]
    InvalidEnumWidth {
        name: String,
        bits: u64,
        context: &'static str,
    },
    #[error("not fully consumed: {remaining} bits left")]
    NotFullyConsumed { remaining: u64 },
    /// The parent is aligned past the window whatever the member read, so
    /// only this check sees it.
    #[error("{name} (handle {handle}) left {remaining} of its {declared} bits unread in {context}")]
    MemberNotFullyConsumed {
        name: String,
        handle: u32,
        declared: u32,
        remaining: u64,
        context: &'static str,
    },
}

pub type Result<T> = core::result::Result<T, StructBlobError>;
