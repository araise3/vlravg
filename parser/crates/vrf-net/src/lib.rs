//! Unreal Engine replication layer: packets -> bunches -> content blocks -> fields.
//!
//! No field payload is skipped, descriptor or not. Every property and RPC
//! reaches the caller's sink as `(handle, bit_count, raw_bits)`, which works
//! because the field stream is self-describing: each field carries its handle
//! and length.
//!
//! ```text
//! packet  : sentinel-trimmed byte slice -> bit stream
//! bunch   : header + partial reassembly state machine
//! content : framing loop; header + payload per block
//! field   : self-describing handle/size stream
//! ```
//!
//! The caller injects export-group resolution (which names map to which
//! handles), typed field decoding, and NetGuidCache storage (through
//! [`net_guid::GuidPathSink`]).
//!
//! A malformed bunch is discarded and counted; it does not abort the replay.
//! Not every lost bit is tallied: a malformed packet's tail is counted only
//! as a packet, a RepLayout-export bunch only as a bunch, and the payload
//! after a cleanly read package-map export list not at all.

#![forbid(unsafe_code)]

pub mod bunch;
pub mod content;
pub mod error;
pub mod field;
pub mod net_guid;
pub mod packet;
pub mod pipeline;
pub mod stats;
pub mod types;

pub use error::NetError;
pub use pipeline::{PLAYER_CONTROLLER_LEAF, ReplicationReader, ReplicationSink};
pub use stats::NetStats;

/// Bunch builders shared by this crate's unit tests, over `vrf_testkit`'s
/// LSB-first bit writer.
#[cfg(test)]
mod test_bits {
    use crate::types::{ChannelCloseReason, MAX_PACKET_SIZE_BITS};
    pub use vrf_testkit::{BitWrite, BitWriter, pack};

    /// Pack `bits` as one packet: the data, then the sentinel bit.
    pub fn build_packet(bits: &[bool]) -> Vec<u8> {
        let mut with_sentinel = bits.to_vec();
        with_sentinel.push(true);
        pack(&with_sentinel)
    }

    /// The header flags one synthetic bunch varies. The default is a
    /// reliable bunch on channel 0 with every other flag clear.
    #[derive(Default)]
    pub struct BunchSpec {
        pub ch_index: u32,
        pub b_open: bool,
        pub b_close: bool,
        /// Close reason Dormancy rather than Destroyed; used only with `b_close`.
        pub dormant: bool,
        pub unreliable: bool,
        pub b_has_package_map_exports: bool,
        pub b_has_must_be_mapped_guids: bool,
        pub b_partial: bool,
        pub b_partial_initial: bool,
        pub b_partial_final: bool,
    }

    /// Append one bunch header declaring `payload_bit_count` bits, in
    /// `parse_bunch_header` order. The channel FName, hardcoded index 1, is
    /// written when the bunch is reliable or opens its channel.
    pub fn write_bunch_header(bits: &mut BitWriter, spec: &BunchSpec, payload_bit_count: u32) {
        let b_control = spec.b_open || spec.b_close;
        bits.bit(b_control);
        if b_control {
            bits.bit(spec.b_open).bit(spec.b_close);
        }
        if spec.b_close {
            bits.serialized_int(u32::from(spec.dormant), ChannelCloseReason::MAX);
        }
        // bIsReplicationPaused, bReliable, ChIndex, the two GUID-list flags,
        // bPartial, the VALORANT bit.
        bits.bit(false)
            .bit(!spec.unreliable)
            .int_packed(spec.ch_index)
            .bit(spec.b_has_package_map_exports)
            .bit(spec.b_has_must_be_mapped_guids)
            .bit(spec.b_partial)
            .bit(false);
        if spec.b_partial {
            bits.bit(spec.b_partial_initial).bit(spec.b_partial_final);
        }
        if !spec.unreliable || spec.b_open {
            bits.bit(true).int_packed(1);
        }
        bits.serialized_int(payload_bit_count, MAX_PACKET_SIZE_BITS);
    }

    /// Append one bunch: its header, then `payload`.
    pub fn write_bunch(bits: &mut BitWriter, spec: &BunchSpec, payload: &[bool]) {
        write_bunch_header(bits, spec, payload.len() as u32);
        bits.extend_from_slice(payload);
    }

    /// One bunch, one packet.
    pub fn build_bunch_packet(spec: &BunchSpec, payload: &[bool]) -> Vec<u8> {
        let mut bits = BitWriter::new();
        write_bunch(&mut bits, spec, payload);
        build_packet(&bits)
    }
}
