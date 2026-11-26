//! Numeric FastArray custom-delta framing (`ReceiveCustomDeltaProperty` /
//! `NetDeltaSerialize`), without a gameplay item schema. The measured body is
//! a support bit (must be true; false is unvalidated), four little-endian i32
//! header words, deleted IDs, then changed IDs with handle/width field streams
//! ending at encoded handle 0.
//!
//! AbilitiesAndBuffs uses [`crate::fastarray::ChecksumMode::Absent`]. Both
//! modes can consume the same body, so the mode must come from independent
//! evidence, never from whichever fits. Field offsets address the caller's
//! bytes; neither handles nor item IDs carry established game meaning.

use vrf_bitio::BitReader;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
/// Whether each changed item's property stream starts with a checksum flag.
pub enum ChecksumMode {
    /// Measured AbilitiesAndBuffs variant: no per-item flag.
    Absent,
    /// Consume one per-item flag; no checksum-value interpretation is made.
    Present,
}

#[derive(Debug, Clone, PartialEq, Eq)]
/// Signed replication keys and validated nonnegative wire counts.
pub struct Header {
    /// Current FastArray replication key from the signed wire word.
    pub array_replication_key: i32,
    /// Base FastArray replication key from the signed wire word.
    pub base_replication_key: i32,
    /// Number of deleted replication IDs following the header.
    pub num_deletes: u32,
    /// Number of changed item records following the deletions.
    pub num_changed: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
/// One property window, still requiring an independently established schema.
pub struct RawField {
    /// Zero-based handle (`encoded_handle - 1`), matching the Python extractor.
    pub handle: u32,
    /// Payload start relative to the beginning of this inner bit window.
    pub payload_bit_offset: u32,
    /// Exact payload width; no value semantics are assigned.
    pub payload_bit_count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
/// A serialized changed item, not an ability cast or actor lifecycle event.
pub struct ChangedItem {
    /// Signed FastArray replication ID.
    pub replication_id: i32,
    /// Schema-independent raw fields in serialized order.
    pub fields: Vec<RawField>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
/// Fully consumed numeric structure of the supplied inner window.
pub struct FastArrayDelta {
    /// Measured feature bit; false is rejected until observed and modeled.
    pub supports_delta_struct: bool,
    /// Four fixed signed header words and validated nonnegative counts.
    pub header: Header,
    /// Deleted replication IDs in serialized order.
    pub deleted_replication_ids: Vec<i32>,
    /// Changed item IDs and their schema-independent raw property windows.
    pub changed_items: Vec<ChangedItem>,
    /// Exact consumed width, equal to the supplied bit count on success.
    pub consumed_bits: u32,
}

/// Read a complete FastArray body with an explicitly chosen checksum mode.
///
/// Returns `None` for malformed windows, unsupported feature flags, negative
/// or physically impossible counts, truncated fields, and unconsumed suffixes.
/// Successful structural decoding does not authorize property names or values.
#[must_use]
pub fn decode_fast_array_delta(
    payload: &[u8],
    bit_count: u32,
    checksum_mode: ChecksumMode,
) -> Option<FastArrayDelta> {
    if payload.len() != (bit_count as usize).div_ceil(8) {
        return None;
    }
    let mut r = BitReader::with_bit_len(payload, u64::from(bit_count)).ok()?;
    let supports_delta_struct = r.read_bit().ok()?;
    if !supports_delta_struct {
        return None;
    }
    let array_replication_key = r.read_i32().ok()?;
    let base_replication_key = r.read_i32().ok()?;
    let deletes_i32 = r.read_i32().ok()?;
    let changed_i32 = r.read_i32().ok()?;
    let num_deletes = u32::try_from(deletes_i32).ok()?;
    let num_changed = u32::try_from(changed_i32).ok()?;
    let checksum_bits = u64::from(checksum_mode == ChecksumMode::Present);
    let minimum = u64::from(num_deletes) * 32 + u64::from(num_changed) * (40 + checksum_bits);
    if minimum > r.bits_remaining() {
        return None;
    }
    let mut deleted_replication_ids = Vec::new();
    for _ in 0..num_deletes {
        deleted_replication_ids.push(r.read_i32().ok()?);
    }
    let mut changed_items = Vec::new();
    for _ in 0..num_changed {
        let replication_id = r.read_i32().ok()?;
        if checksum_mode == ChecksumMode::Present {
            r.read_bit().ok()?;
        }
        let mut fields = Vec::new();
        loop {
            let encoded_handle = r.read_int_packed().ok()?;
            if encoded_handle == 0 {
                break;
            }
            let handle = encoded_handle - 1;
            let payload_bit_count = r.read_int_packed().ok()?;
            let payload_bit_offset = u32::try_from(r.position()).ok()?;
            r.skip_bits(u64::from(payload_bit_count)).ok()?;
            fields.push(RawField {
                handle,
                payload_bit_offset,
                payload_bit_count,
            });
        }
        changed_items.push(ChangedItem {
            replication_id,
            fields,
        });
    }
    if !r.at_end() {
        return None;
    }
    Some(FastArrayDelta {
        supports_delta_struct,
        header: Header {
            array_replication_key,
            base_replication_key,
            num_deletes,
            num_changed,
        },
        deleted_replication_ids,
        changed_items,
        consumed_bits: u32::try_from(r.position()).ok()?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use vrf_testkit::{BitWrite, BitWriter};

    fn header(deletes: u32, changed: u32) -> BitWriter {
        let mut bits = BitWriter::new();
        bits.bits(1, 1).bits(8, 32).bits(5, 32);
        bits.bits(u64::from(deletes), 32)
            .bits(u64::from(changed), 32);
        bits
    }

    /// Decode the whole of `b` under `mode`.
    fn decode(b: &BitWriter, mode: ChecksumMode) -> Option<FastArrayDelta> {
        let (data, bit_count) = b.finish();
        decode_fast_array_delta(&data, bit_count, mode)
    }

    #[test]
    fn deletion_only_closes_exactly() {
        let mut b = header(2, 0);
        b.bits(17, 32).bits(23, 32);
        let d = decode(&b, ChecksumMode::Absent).unwrap();
        assert_eq!(d.deleted_replication_ids, vec![17, 23]);
        assert_eq!(d.consumed_bits, b.bit_len());
    }
    #[test]
    fn changed_fields_retain_exact_offsets() {
        let mut b = header(0, 1);
        b.bits(7, 32).int_packed(3).int_packed(5);
        let offset = b.bit_len();
        b.bits(0b10101, 5).int_packed(0);
        let d = decode(&b, ChecksumMode::Absent).unwrap();
        assert_eq!(
            d.changed_items[0].fields,
            vec![RawField {
                handle: 2,
                payload_bit_offset: offset,
                payload_bit_count: 5
            }]
        );
    }
    #[test]
    fn rejects_false_support_flag_truncation_and_suffix() {
        let mut b = header(0, 0);
        let (data, bit_count) = b.finish();
        assert!(decode_fast_array_delta(&data, bit_count - 1, ChecksumMode::Absent).is_none());
        b[0] = false;
        assert!(decode(&b, ChecksumMode::Absent).is_none());
        b[0] = true;
        b.push(true);
        assert!(decode(&b, ChecksumMode::Absent).is_none());
    }

    #[test]
    fn rejects_negative_counts_and_count_overrun() {
        assert!(decode(&header(u32::MAX, 0), ChecksumMode::Absent).is_none());
        assert!(decode(&header(1, 0), ChecksumMode::Absent).is_none());
    }

    #[test]
    fn rejects_packed_overflow_and_unterminated_values() {
        for tail in [[1, 1, 1, 1, 32], [1, 1, 1, 1, 1]] {
            let mut b = header(0, 1);
            b.bits(7, 32);
            for byte in tail {
                b.bits(byte, 8);
            }
            assert!(decode(&b, ChecksumMode::Absent).is_none());
        }
    }

    #[test]
    fn explicit_checksum_modes_are_distinct() {
        let mut b = header(0, 1);
        b.bits(7, 32)
            .bits(1, 1)
            .int_packed(1)
            .int_packed(3)
            .bits(5, 3);
        b.int_packed(0);
        assert!(decode(&b, ChecksumMode::Present).is_some());
        assert!(decode(&b, ChecksumMode::Absent).is_none());
    }

    #[test]
    fn every_bit_truncation_of_changed_fixture_is_rejected() {
        let mut b = header(0, 1);
        b.bits(7, 32)
            .int_packed(3)
            .int_packed(5)
            .bits(21, 5)
            .int_packed(0);
        let (data, full) = b.finish();
        for bit_count in 0..full {
            let short = &data[..(bit_count as usize).div_ceil(8)];
            assert!(
                decode_fast_array_delta(short, bit_count, ChecksumMode::Absent).is_none(),
                "accepted truncation at {bit_count}"
            );
        }
        let mut padded = data.clone();
        padded.push(0);
        assert!(decode_fast_array_delta(&padded, full, ChecksumMode::Absent).is_none());
    }
}
