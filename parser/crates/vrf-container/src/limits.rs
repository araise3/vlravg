//! Magic numbers, version pins and bounds. None may be adjusted to make a file
//! parse: a bound that has to move is a format discovery.

pub(crate) const FILE_MAGIC: u32 = 0x43F4_EFDD;
pub(crate) const NETWORK_MAGIC: u32 = 0x2CF5_A13D;
/// Older legacy file versions have another layout.
pub(crate) const EXPECTED_FILE_VERSION: u32 = 7;
/// Header chunk only: the info section's copy is unrelated (`ReplayInfo::network_version`).
pub(crate) const EXPECTED_NETWORK_VERSION: u32 = 19;
pub(crate) const EXPECTED_ENGINE_NET_PROTO_VERSION: u32 = 32;

pub(crate) const MAX_CUSTOM_VERSION_COUNT: i32 = 1024;
pub(crate) const MAX_FSTRING_BYTES: i64 = 1024 * 1024;
pub(crate) const MAX_ENCRYPTION_KEY_BYTES: i32 = 4096;
/// Tighter than `MAX_FSTRING_BYTES`: the friendly name is user-controlled.
pub(crate) const MAX_FRIENDLY_NAME_BYTES: i64 = 64 * 1024;
pub(crate) const MAX_LEVEL_NAMES_AND_TIMES: i32 = 1024;
pub(crate) const MAX_GAME_SPECIFIC_DATA: i32 = 128;
/// Declared decompressed size: bounds the output allocation against a corrupt field.
pub(crate) const MAX_CHUNK_SIZE: i32 = 256 * 1024 * 1024;

/// A 16-byte GUID plus an `i32` version.
pub(crate) const CUSTOM_VERSION_ENTRY_BYTES: u32 = 20;
/// `LocalFileReplay`, `95A4F03E-7E0B-49E4-BA43-D35694FF87D9`, in serialisation order.
pub(crate) const LOCAL_REPLAY_GUID: [u32; 4] = [0x95A4_F03E, 0x7E0B_49E4, 0xBA43_D356, 0x94FF_87D9];
pub(crate) const LOCAL_REPLAY_VERSION: i32 = 7;
