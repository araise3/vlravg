//! Shared types used across the replication layer.

/// Maximum packet payload in bits: Unreal's `MAX_PACKET_SIZE * 8` (2 KB =
/// 16 384 bits), the `read_serialized_int` bound for a bunch's bit count.
pub const MAX_PACKET_SIZE_BITS: u32 = 2 * 1024 * 8;

/// Maximum number of GUIDs in a single package-map export bunch.
pub const MAX_GUID_COUNT: u32 = 2048;

/// Maximum simultaneously tracked channel indices: bounds adversarial
/// IntPacked indices that would add a table entry per bunch (the reference
/// replay peaks at 232).
pub const MAX_ACTIVE_CHANNELS: usize = 4_096;

/// Reason a channel was closed by the server, read as `SerializedInt(15)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
#[repr(u8)]
pub enum ChannelCloseReason {
    /// Actor was destroyed.
    #[default]
    Destroyed = 0,
    /// Actor entered dormancy: still alive, so not a despawn.
    Dormancy = 1,
}

impl ChannelCloseReason {
    /// The `MAX` passed to `read_serialized_int`.
    pub const MAX: u32 = 15;

    /// Any wire value but 1 (Dormancy) reads as Destroyed.
    #[must_use]
    pub fn from_raw(v: u32) -> Self {
        match v {
            1 => Self::Dormancy,
            _ => Self::Destroyed,
        }
    }
}

pub use vrf_schema::{ExportFlags, NetworkGuid};

/// 3D vector as decoded from the spawn data.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FVector {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

/// Rotation as decoded from compressed short format.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FRotator {
    pub pitch: f32,
    pub yaw: f32,
    pub roll: f32,
}
