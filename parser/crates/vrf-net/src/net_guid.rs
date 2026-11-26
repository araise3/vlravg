//! Net GUID references (`InternalLoadObject`), read by vrf-schema's
//! [`load_object`](vrf_schema::load_object). The paths go to the caller's
//! [`GuidPathSink`], which owns the NetGuidCache.

use vrf_bitio::BitReader;
use vrf_schema::SchemaError;

use crate::error::{NetError, Result};
use crate::types::NetworkGuid;

/// Callback invoked when a net GUID's path is decoded from the stream.
pub trait GuidPathSink {
    /// A GUID path was read from the wire.
    fn register_path(&mut self, guid: u32, path: &str, outer_guid: NetworkGuid);

    /// The path this GUID is known by in the receiver's NetGuidCache, which
    /// decides the net-player-index byte. Answer from the cache, not from
    /// `register_path` calls: paths reach it by more routes. The default
    /// `None` never consumes that byte.
    fn path_for_guid(&self, _guid: u32) -> Option<&str> {
        None
    }
}

/// Read a net GUID reference, path cap 4096 bytes, and register its paths.
/// `is_exporting` is true inside a package-map export bunch; in content-block
/// headers only the default GUID (1) carries inline path data.
pub fn internal_load_object(
    reader: &mut BitReader<'_>,
    is_exporting: bool,
    depth: u32,
    sink: &mut dyn GuidPathSink,
) -> Result<NetworkGuid> {
    let mut register = |guid, path: String, outer| sink.register_path(guid, &path, outer);
    vrf_schema::load_object(reader, is_exporting, 4096, depth, &mut register).map_err(|e| match e {
        SchemaError::Bitio(e) => NetError::Bit(e),
        SchemaError::RecursionLimitExceeded { limit } => NetError::GuidRecursionLimit {
            depth: limit.max(depth),
        },
        e => unreachable!("load_object fails only on a read or its depth limit, not {e}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_bits::{BitWrite, pack};

    type Paths = Vec<(u32, String, NetworkGuid)>;

    impl GuidPathSink for Paths {
        fn register_path(&mut self, guid: u32, path: &str, outer: NetworkGuid) {
            self.push((guid, path.to_owned(), outer));
        }
    }

    /// Read `bits` from depth 0: the result and every path registered.
    fn load(bits: &[bool], is_exporting: bool) -> (Result<NetworkGuid>, Paths) {
        let mut paths = Paths::new();
        let data = pack(bits);
        let result = internal_load_object(&mut BitReader::new(&data), is_exporting, 0, &mut paths);
        (result, paths)
    }

    /// GUID 0 is no object even in an export, and outside one only the
    /// default GUID (1) carries flags: each payload is its IntPacked byte.
    #[test]
    fn a_guid_without_flags_reads_nothing_more() {
        for (guid, is_exporting) in [(0, true), (42, false)] {
            let mut bits = Vec::new();
            bits.int_packed(guid);
            assert_eq!(load(&bits, is_exporting), (Ok(NetworkGuid(guid)), vec![]));
        }
    }

    /// Any GUID in an export, and the default GUID (1) outside one, reads flags.
    #[test]
    fn an_exporting_or_default_guid_reads_its_path() {
        for (guid, is_exporting) in [(18, true), (1, false)] {
            let mut bits = Vec::new();
            // Flags HasPath, then outer GUID 0 (no object) and the path.
            bits.int_packed(guid)
                .u8(0x01)
                .int_packed(0)
                .fstring("/Game/Test.Test_C");
            let registered = (guid, "/Game/Test.Test_C".to_owned(), NetworkGuid(0));
            let expected = (Ok(NetworkGuid(guid)), vec![registered]);
            assert_eq!(load(&bits, is_exporting), expected, "{guid}");
        }
    }

    /// Sixteen nested HasPath GUIDs reach the limit before a 17th is read.
    #[test]
    fn nesting_to_the_depth_limit_is_an_error() {
        let mut bits = Vec::new();
        for _ in 0..16 {
            bits.int_packed(2).u8(0x01);
        }
        let limit = Err(NetError::GuidRecursionLimit { depth: 16 });
        assert_eq!(load(&bits, true), (limit, vec![]));
    }
}
