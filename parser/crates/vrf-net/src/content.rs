//! Content block header parsing.
//!
//! A bunch's payload is a sequence of content blocks, each a header saying
//! what it describes (the actor, a subobject, or a deletion) and a payload.
//!
//! ```text
//! +------------------------------------------------------------------+
//! | hasRepLayout        : 1 bit                                      |
//! | isActor             : 1 bit                                      |
//! | [if isActor -> return immediately, actor uses channel state]     |
//! | objectNetGuid       : InternalLoadObject(...)                    |
//! | isStablyNamed       : 1 bit                                      |
//! | [if isStablyNamed -> return: stably-named subobject]             |
//! | isDeleted           : 1 bit                                      |
//! | [if isDeleted]                                                   |
//! |   deleteFlags       : 1 byte (8 bits)                            |
//! |   -> return as deleted                                           |
//! | classNetGuid        : InternalLoadObject(...)                    |
//! | [if classNetGuid invalid -> return as deleted (flags=0)]         |
//! | bUseActorOuter      : 1 bit                                      |
//! | [if !bUseActorOuter]                                             |
//! |   outerNetGuid      : InternalLoadObject(...)                    |
//! | -> return as subobject                                           |
//! +------------------------------------------------------------------+
//! ```

use vrf_bitio::BitReader;

use crate::error::Result;
use crate::net_guid::{self, GuidPathSink};
use crate::types::NetworkGuid;

/// Parsed content block header.
#[derive(Debug, Clone, Default)]
pub struct ContentBlockHeader {
    /// Whether the payload uses RepLayout (properties) vs ClassNetCache (RPCs).
    pub has_rep_layout: bool,
    /// This block describes the actor itself (not a subobject).
    pub is_actor: bool,
    /// This block is a deletion notification.
    pub is_deleted: bool,
    /// Net GUID of the object (subobject case).
    pub object_net_guid: NetworkGuid,
    /// Net GUID of the class (subobject case, when present).
    pub class_net_guid: NetworkGuid,
    /// The class GUID field was read, even as an invalid zero: this separates
    /// a read-invalid class (deleted, flags 0) from an explicit delete.
    pub has_class_net_guid: bool,
    /// Net GUID of the outer object.
    pub outer_net_guid: NetworkGuid,
    /// Whether the subobject is stably named.
    pub is_stably_named: bool,
    /// Deletion flags (only valid when is_deleted).
    pub delete_flags: u8,
}

/// Read a content block header from the stream. `actor_net_guid` is the
/// channel's actor GUID, the default outer.
pub fn read_content_block_header(
    reader: &mut BitReader<'_>,
    actor_net_guid: NetworkGuid,
    sink: &mut dyn GuidPathSink,
) -> Result<ContentBlockHeader> {
    // Every shape below starts from this.
    let base = ContentBlockHeader {
        has_rep_layout: reader.read_bit()?,
        outer_net_guid: actor_net_guid,
        ..Default::default()
    };

    if reader.read_bit()? {
        return Ok(ContentBlockHeader {
            is_actor: true,
            ..base
        });
    }

    let base = ContentBlockHeader {
        object_net_guid: net_guid::internal_load_object(reader, false, 0, sink)?,
        ..base
    };

    if reader.read_bit()? {
        return Ok(ContentBlockHeader {
            is_stably_named: true,
            ..base
        });
    }

    if reader.read_bit()? {
        return Ok(ContentBlockHeader {
            is_deleted: true,
            delete_flags: reader.read_u8()?,
            ..base
        });
    }

    let class_net_guid = net_guid::internal_load_object(reader, false, 0, sink)?;
    if !class_net_guid.is_valid() {
        return Ok(ContentBlockHeader {
            is_deleted: true,
            has_class_net_guid: true,
            ..base
        });
    }

    // bUseActorOuter
    let outer_net_guid = if reader.read_bit()? {
        actor_net_guid
    } else {
        net_guid::internal_load_object(reader, false, 0, sink)?
    };

    Ok(ContentBlockHeader {
        class_net_guid,
        has_class_net_guid: true,
        outer_net_guid,
        ..base
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_bits::{BitWrite, pack};

    #[derive(Default)]
    struct NullSink;
    impl GuidPathSink for NullSink {
        fn register_path(&mut self, _: u32, _: &str, _: NetworkGuid) {}
    }

    #[test]
    fn actor_block_returns_immediately() {
        let bits = vec![true, true]; // hasRepLayout=true, isActor=true
        let data = pack(&bits);
        let mut reader = BitReader::new(&data);
        let mut sink = NullSink;
        let hdr = read_content_block_header(&mut reader, NetworkGuid(18), &mut sink).unwrap();
        assert!(hdr.is_actor);
        assert!(hdr.has_rep_layout);
        assert_eq!(hdr.outer_net_guid, NetworkGuid(18));
    }

    #[test]
    fn subobject_stably_named() {
        let mut bits = Vec::new();
        bits.push(false); // hasRepLayout
        bits.push(false); // isActor = false
        bits.int_packed(50); // objectNetGuid
        bits.push(true); // isStablyNamed
        let data = pack(&bits);
        let mut reader = BitReader::new(&data);
        let mut sink = NullSink;
        let hdr = read_content_block_header(&mut reader, NetworkGuid(18), &mut sink).unwrap();
        assert!(!hdr.is_actor);
        assert!(hdr.is_stably_named);
        assert_eq!(hdr.object_net_guid, NetworkGuid(50));
    }

    #[test]
    fn deleted_block_reads_flags() {
        let mut bits = Vec::new();
        bits.push(false); // hasRepLayout
        bits.push(false); // isActor
        bits.int_packed(60); // objectNetGuid
        bits.push(false); // isStablyNamed
        bits.push(true); // isDeleted
        bits.u8(0x03); // deleteFlags
        let data = pack(&bits);
        let mut reader = BitReader::new(&data);
        let mut sink = NullSink;
        let hdr = read_content_block_header(&mut reader, NetworkGuid(18), &mut sink).unwrap();
        assert!(hdr.is_deleted);
        assert_eq!(hdr.delete_flags, 0x03);
        assert_eq!(hdr.object_net_guid, NetworkGuid(60));
    }

    #[test]
    fn explicit_delete_zero_and_read_invalid_class_zero_stay_distinct() {
        let parse = |invalid_class: bool| {
            let mut bits = vec![false, false];
            bits.int_packed(60);
            bits.push(false);
            bits.push(!invalid_class);
            if invalid_class {
                bits.int_packed(0);
            } else {
                bits.extend([false; 8]);
            }
            let data = pack(&bits);
            read_content_block_header(&mut BitReader::new(&data), NetworkGuid(18), &mut NullSink)
                .unwrap()
        };
        let explicit = parse(false);
        let invalid = parse(true);
        assert!(explicit.is_deleted && invalid.is_deleted);
        assert_eq!(explicit.delete_flags, 0);
        assert_eq!(invalid.class_net_guid, NetworkGuid(0));
        assert!(!explicit.has_class_net_guid);
        assert!(invalid.has_class_net_guid);
    }
}
