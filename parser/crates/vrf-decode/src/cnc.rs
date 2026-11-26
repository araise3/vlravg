//! ClassNetCache payload brute-forcer for groups the replay never declares.
//!
//! Without the group, `function_count` -- the RPC stream's handle width -- is
//! unknown, and `vrf_net` keeps the payload as one
//! `__vrfkit_unresolved_class_net_cache_payload__` raw row. For a known bare
//! instance name (e.g. `AbilitiesAndBuffsComponent`) this tries 2..=256 and
//! keeps the walks that consume the buffer exactly.
//!
//! ```text
//! loop, to the end of the stream (no checksum bit, no handle-0 terminator):
//!   handle       = SerializedInt(max(function_count, 2))
//!   payload_bits = IntPacked
//!   payload      = payload_bits bits
//! ```
//!
//! `SerializedInt(max)` spends `floor(log2(max))` bits plus one conditional
//! bit, so adjacent counts walk identically (34..=65 all read handle 1 in 6
//! bits; vrfkit's `ABILITIES_AND_BUFFS_FC` is that band's minimum): the search
//! returns the minimum clean count. The framing also carries custom-delta
//! properties, so a `CncRpc` does not prove a function call.

use vrf_bitio::BitReader;

/// Maximum `function_count` to try; real groups declare at most a few dozen.
const MAX_FC: u32 = 256;

/// One decoded RPC from a brute-forced ClassNetCache stream.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CncRpc {
    /// The function handle (0-indexed).
    pub handle: u32,
    /// Payload bit count.
    pub payload_bits: u32,
    /// Bit offset of the payload within the original buffer.
    pub payload_offset: u64,
}

/// The result of brute-forcing a ClassNetCache payload.
#[derive(Debug, Clone)]
pub struct BruteForceResult {
    /// The minimum `function_count` that produces a clean walk.
    pub function_count: u32,
    /// The RPCs decoded with that function_count.
    pub rpcs: Vec<CncRpc>,
    /// A count in another handle-width band that walks the SAME bits cleanly
    /// into DIFFERENT RPCs. `None`: every candidate was checked and none
    /// competes.
    pub ambiguous_with: Option<u32>,
}

/// The minimum `function_count` in 2..=256 whose walk consumes the whole
/// buffer (the preservation row's bytes and bit length) with at least one
/// RPC, or `None`. Gate it on a known group path.
#[must_use]
pub fn brute_force_function_count(payload: &[u8], bit_count: u32) -> Option<BruteForceResult> {
    // The whole range, for `ambiguous_with`.
    let mut chosen: Option<BruteForceResult> = None;
    for fc in 2..=MAX_FC {
        let Some(rpcs) = decode_cnc_payload(payload, bit_count, fc) else {
            continue;
        };
        match &mut chosen {
            None => {
                chosen = Some(BruteForceResult {
                    function_count: fc,
                    rpcs,
                    ambiguous_with: None,
                })
            }
            // Any RPC with another handle, size or position is another reading.
            Some(first) if first.ambiguous_with.is_none() && first.rpcs != rpcs => {
                first.ambiguous_with = Some(fc)
            }
            Some(_) => {}
        }
    }
    chosen
}

/// Walk a ClassNetCache stream with a known `function_count` (from
/// [`brute_force_function_count`] on a sample, or a constant for a known group)
/// and return its RPCs, as `parse_class_net_cache` in `vrf-net` walks it. `None`
/// when the walk is not clean -- a malformed read or no RPC -- never partial
/// results; the caller keeps the preservation row.
#[must_use]
pub fn decode_cnc_payload(
    payload: &[u8],
    bit_count: u32,
    function_count: u32,
) -> Option<Vec<CncRpc>> {
    let mut reader = BitReader::with_bit_len(payload, u64::from(bit_count)).ok()?;
    let handle_max = function_count.max(2);
    let mut rpcs = Vec::new();
    // Every read fails rather than run past the window, so the loop leaves
    // only with the window consumed exactly (a sub-byte tail fails the next
    // read): what separates a decode from another format that merely parses.
    while !reader.at_end() {
        let handle = reader.read_serialized_int(handle_max).ok()?;
        let payload_bits = reader.read_int_packed().ok()?;
        let payload_offset = reader.position();
        reader.skip_bits(u64::from(payload_bits)).ok()?;
        rpcs.push(CncRpc {
            handle,
            payload_bits,
            payload_offset,
        });
    }
    (!rpcs.is_empty()).then_some(rpcs)
}

/// The inner structure of an `AbilitiesAndBuffsComponent` ClassNetCache RPC
/// payload (the framing is [`decode_cnc_payload`]'s): a flag bit (always 1),
/// little-endian `u32` words and a sub-32-bit trailing residual. Bit slicing,
/// not a semantic decoder: no word position has an established meaning
/// (`docs/GAS_AND_PATCHVOLUME_INVESTIGATION.md`), and
/// `tools/extract_fastarray_observations.py` reads the same payload as
/// custom-delta FastArray framing.
#[derive(Debug, Clone)]
pub struct AbilitiesActivation {
    /// The leading flag bit, `1` on every observed payload.
    pub flag: bool,
    /// The little-endian `u32` words immediately after the flag bit.
    pub words: Vec<u32>,
    /// Trailing bits that did not form a full word, packed LSB-first.
    pub trailing: u32,
    /// Number of valid bits in `trailing` (always `0..32`).
    pub trailing_bit_count: u32,
}

impl AbilitiesActivation {
    /// The first two raw words, when present; not a known key or identity.
    #[must_use]
    pub fn key_pair(&self) -> Option<(u32, u32)> {
        Some((*self.words.first()?, *self.words.get(1)?))
    }
}

/// Decompose an `AbilitiesAndBuffsComponent` ClassNetCache RPC payload into
/// [`AbilitiesActivation`]. `None` for an empty payload or a `bit_count`
/// longer than the buffer.
#[must_use]
pub fn decode_abilities_and_buffs_inner(
    payload: &[u8],
    bit_count: u32,
) -> Option<AbilitiesActivation> {
    let mut reader = BitReader::with_bit_len(payload, u64::from(bit_count)).ok()?;
    let flag = reader.read_bit().ok()?;
    let mut words = Vec::new();
    while reader.bits_remaining() >= 32 {
        words.push(reader.read_u32().ok()?);
    }
    let trailing_bit_count = reader.bits_remaining() as u32;
    let trailing = reader.read_bits(trailing_bit_count).ok()? as u32;
    Some(AbilitiesActivation {
        flag,
        words,
        trailing,
        trailing_bit_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use vrf_testkit::{BitWrite, BitWriter};

    /// A ClassNetCache stream with one RPC at handle 1, written with
    /// `function_count`'s handle width. The payload is 1-filled on purpose: in
    /// a zero-filled one every misaligned IntPacked reads 0, so wrong counts
    /// walk cleanly as many tiny RPCs; ones make them overrun instead.
    fn build_one_rpc_stream(function_count: u32, payload_bits: u32) -> (Vec<u8>, u32) {
        BitWriter::new()
            .serialized_int(1, function_count.max(2))
            .int_packed(payload_bits)
            .repeat(true, payload_bits as usize)
            .finish()
    }

    /// A single RPC at handle 1 resolves to the minimum count of the handle
    /// width it was written with, and the unambiguous one-filled fixtures keep
    /// `ambiguous_with` clear.
    #[test]
    fn single_rpc_finds_minimum_fc() {
        // fc=34: ilog2 is 5 bits, and 1+32=33 < 34 forces the extra bit, so
        // 6 bits (fc=33 gives 5). fc=50 is in the same band.
        for (written_with, payload_bits) in [(34, 100), (50, 64)] {
            let (data, bit_count) = build_one_rpc_stream(written_with, payload_bits);
            let result = brute_force_function_count(&data, bit_count).expect("a valid fc");
            assert_eq!(result.function_count, 34, "written with {written_with}");
            assert_eq!(result.rpcs.len(), 1);
            assert_eq!(result.rpcs[0].handle, 1);
            assert_eq!(result.rpcs[0].payload_bits, payload_bits);
            assert_eq!(result.ambiguous_with, None, "{result:?}");
        }
    }

    /// A stream written with a larger fc, in a wider handle band, resolves to
    /// that band's minimum.
    #[test]
    fn single_rpc_with_larger_fc() {
        // fc=128 reads handle 1 in 7 bits. The 7-bit band starts at 66: ilog2
        // is 6, and 1+64=65 < 66 forces the extra bit (fc=65 stops at 6 bits).
        let (data, bit_count) = build_one_rpc_stream(128, 50);
        let result = brute_force_function_count(&data, bit_count);
        assert!(result.is_some());
        let result = result.unwrap();
        assert_eq!(result.function_count, 66);
        assert_eq!(result.rpcs[0].handle, 1);
    }

    /// Multiple RPCs in one stream should all be recovered.
    #[test]
    fn multiple_rpcs() {
        let (data, bit_count) = BitWriter::new()
            // RPC 1: handle=3, payload=16 bits of 1s
            .serialized_int(3, 10)
            .int_packed(16)
            .repeat(true, 16)
            // RPC 2: handle=7, payload=8 bits of 1s
            .serialized_int(7, 10)
            .int_packed(8)
            .repeat(true, 8)
            .finish();
        let result = brute_force_function_count(&data, bit_count);
        assert!(result.is_some());
        let result = result.unwrap();
        assert_eq!(result.rpcs.len(), 2);
        assert_eq!(result.rpcs[0].handle, 3);
        assert_eq!(result.rpcs[0].payload_bits, 16);
        assert_eq!(result.rpcs[1].handle, 7);
        assert_eq!(result.rpcs[1].payload_bits, 8);
    }

    /// A zero-bit payload returns None (no RPCs).
    #[test]
    fn empty_payload_returns_none() {
        let data = vec![];
        let result = brute_force_function_count(&data, 0);
        assert!(result.is_none());
    }

    /// An `AbilitiesAndBuffsComponent` RPC payload: flag, LE u32 words, then a
    /// trailing residual.
    fn build_activation_stream(
        flag: bool,
        words: &[u32],
        trailing_bits: u32,
        trailing: u32,
    ) -> (Vec<u8>, u32) {
        let mut bits = BitWriter::new();
        bits.bits(u64::from(flag), 1);
        for &w in words {
            bits.bits(u64::from(w), 32);
        }
        bits.bits(u64::from(trailing), trailing_bits).finish()
    }

    /// The 161-bit shape (flag + 5 words, no trailing), the simplest and most
    /// common `AbilitiesAndBuffsComponent` RPC across thousands of payloads.
    #[test]
    fn abilities_inner_flag_then_u32_stream() {
        let words = [5u32, 3, 1, 0, 2];
        let (data, bit_count) = build_activation_stream(true, &words, 0, 0);
        let decoded = decode_abilities_and_buffs_inner(&data, bit_count).unwrap();
        assert!(decoded.flag);
        assert_eq!(decoded.words, words);
        assert_eq!(decoded.trailing_bit_count, 0);
        assert_eq!(decoded.key_pair(), Some((5, 3)));
    }

    /// A sub-32-bit trailing residual after the last whole word is captured.
    #[test]
    fn abilities_inner_captures_trailing_residual() {
        // flag(1) + 1 word + 16 trailing bits = 49 bits.
        let (data, bit_count) = build_activation_stream(true, &[7], 16, 0xABCD);
        let decoded = decode_abilities_and_buffs_inner(&data, bit_count).unwrap();
        assert!(decoded.flag);
        assert_eq!(decoded.words, vec![7]);
        assert_eq!(decoded.trailing_bit_count, 16);
        assert_eq!(decoded.trailing & 0xFFFF, 0xABCD);
    }

    /// An empty payload has no flag bit and yields `None`.
    #[test]
    fn abilities_inner_empty_is_none() {
        assert!(decode_abilities_and_buffs_inner(&[], 0).is_none());
    }

    /// A flag bit alone (no words, no trailing) decodes cleanly.
    #[test]
    fn abilities_inner_flag_only() {
        let (data, bit_count) = build_activation_stream(true, &[], 0, 0);
        let decoded = decode_abilities_and_buffs_inner(&data, bit_count).unwrap();
        assert!(decoded.flag);
        assert!(decoded.words.is_empty());
        assert_eq!(decoded.trailing_bit_count, 0);
        assert_eq!(decoded.key_pair(), None);
    }

    /// A single-word payload has a flag but no key pair.
    #[test]
    fn abilities_inner_single_word_has_no_key_pair() {
        let (data, bit_count) = build_activation_stream(true, &[42], 0, 0);
        let decoded = decode_abilities_and_buffs_inner(&data, bit_count).unwrap();
        assert_eq!(decoded.words, vec![42]);
        assert_eq!(decoded.key_pair(), None);
    }

    /// A payload that walks cleanly under counts in different bands must be
    /// reported as ambiguous: 90 zero bits are 10 RPCs of 9 bits under fc=2
    /// (1-bit handle, zero payload) and 9 RPCs of 10 bits under fc=3.
    #[test]
    fn an_ambiguous_payload_reports_the_competing_function_count() {
        let data = vec![0u8; 12]; // 96 bits of storage, 90 declared
        let result = brute_force_function_count(&data, 90).expect("fc=2 walks cleanly");

        assert_eq!(result.function_count, 2);
        assert_eq!(result.rpcs.len(), 10, "fc=2 reads ten 9-bit RPCs");
        assert_eq!(
            result.ambiguous_with,
            Some(3),
            "fc=3 parses the same bits into nine RPCs and must be reported",
        );
    }
}
