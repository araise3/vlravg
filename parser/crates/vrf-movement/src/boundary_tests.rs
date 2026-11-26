//! Independent boundary reproductions for the updates and movement windows.
use vrf_bitio::BitReader;
use vrf_testkit::{BitWrite, BitWriter};

use crate::decode_movement_rpc;

#[test]
fn missing_array_terminator_is_counted_when_outer_rpc_is_complete() {
    // Given: the array holds only capacity 1; the outer zero handle is present.
    let bytes = [0x08, 0x20, 0x04, 0, 0];
    let mut reader = BitReader::with_bit_len(&bytes, 33).unwrap();

    // When: decoding the exact recorded window.
    let result = decode_movement_rpc(&mut reader, |_| panic!("no update exists")).unwrap();

    // Then: the missing inner terminator is a loss, not an empty clean array.
    assert_eq!(result.update_count, 1);
    assert_eq!(result.error_count, 1);
}

#[test]
fn component_remainder_is_accounted_when_sized_section_is_complete() {
    for extra_bits in [0, 8] {
        // Given: a complete eleven-bit section, optionally followed by 0xff.
        let mut stream = BitWriter::new();
        stream.u16(11).u8(0x52).bits(0, 3).bits(0xff, extra_bits);
        let mut array = BitWriter::new();
        array.int_packed(1).int_packed(1);
        array.int_packed(3).int_packed(32).u32(77);
        array
            .int_packed(4)
            .int_packed(stream.bit_len())
            .extend_bits(&stream);
        array.int_packed(0).int_packed(0);
        let mut rpc = BitWriter::new();
        rpc.bit(false).int_packed(2).int_packed(array.bit_len());
        rpc.extend_bits(&array).int_packed(0);
        let (bytes, bits) = rpc.finish();
        let mut reader = BitReader::with_bit_len(&bytes, u64::from(bits)).unwrap();

        // When: the enclosing component is decoded through the real RPC.
        let result = decode_movement_rpc(&mut reader, |_| panic!("no move exists")).unwrap();

        // Then: every bit beyond the complete section is accounted for.
        assert_eq!(result.error_count, 0);
        let accounted = result.sized_section_tail_bits
            + result.open_section_tail_bits
            + result.envelope_trailer_bits
            + result.sized_section_trailer_bits;
        assert_eq!(accounted, u64::from(extra_bits));
        assert_eq!(result.sized_section_trailer_bits, u64::from(extra_bits));
        assert_eq!(result.sized_section_trailers, u32::from(extra_bits > 0));
        assert_eq!(result.sized_section_tail_bits, 0);
        assert_eq!(result.open_section_tail_bits, 0);
        assert_eq!(result.envelope_trailer_bits, 0);
    }
}

#[test]
fn sparse_array_is_clean_when_capacity_exceeds_changed_elements() {
    for changed in [false, true] {
        // Given: capacity 3, with zero or one changed update at the last index.
        let mut array = BitWriter::new();
        array.int_packed(3);
        if changed {
            array.int_packed(3).int_packed(0);
        }
        array.int_packed(0);
        let mut rpc = BitWriter::new();
        rpc.bit(false).int_packed(2).int_packed(array.bit_len());
        rpc.extend_bits(&array).int_packed(0);
        let (bytes, bits) = rpc.finish();
        let mut reader = BitReader::with_bit_len(&bytes, u64::from(bits)).unwrap();

        // When: decoding a sparse array with its own zero terminator.
        let result = decode_movement_rpc(&mut reader, |_| panic!("no move exists")).unwrap();

        // Then: unused capacity does not become a truncation.
        assert_eq!(result.update_count, 3);
        assert_eq!(result.error_count, 0);
    }
}
