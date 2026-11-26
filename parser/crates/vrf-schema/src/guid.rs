//! NetGUID value types: the identifier itself, its export flags, and the
//! per-GUID record the cache hands back.

/// A network GUID as transmitted on the wire: `0` is no object, `1` the
/// default object (its export flags are always read), odd values static
/// (level-placed) actors and even non-zero values dynamic (spawned) ones.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct NetworkGuid(pub u32);

impl NetworkGuid {
    #[must_use]
    pub const fn is_valid(self) -> bool {
        self.0 != 0
    }

    #[must_use]
    pub const fn is_default(self) -> bool {
        self.0 == 1
    }

    #[must_use]
    pub const fn is_dynamic(self) -> bool {
        self.is_valid() && (self.0 & 1) == 0
    }
}

/// Flags on an exported NetGUID payload: which optional fields follow the GUID.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExportFlags(pub u8);

impl ExportFlags {
    pub const NONE: Self = Self(0);
    pub const HAS_PATH: Self = Self(1 << 0);
    pub const NO_LOAD: Self = Self(1 << 1);
    pub const HAS_NETWORK_CHECKSUM: Self = Self(1 << 2);

    #[must_use]
    pub const fn contains(self, flag: Self) -> bool {
        (self.0 & flag.0) == flag.0
    }
}

/// One registered NetGUID, from
/// [`NetGuidCache::net_guid_entries`](crate::NetGuidCache::net_guid_entries).
/// Exporters persist the outer chain: it is the only route from a subobject
/// (a weapon's `FiringState`), and so from a shot event, to the owning actor
/// and equippable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NetGuidEntry<'a> {
    pub net_guid: u32,
    /// Object path as the replay declared it.
    pub path: &'a str,
    /// Containing object's GUID, when the replay declared one.
    pub outer_net_guid: Option<u32>,
}
