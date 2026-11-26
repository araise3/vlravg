//! Field stream parsing -- self-describing property and RPC iteration: every
//! field and RPC reaches the [`FieldSink`], none is skipped (see the crate docs).
//!
//! # RepLayout field stream bit layout
//!
//! ```text
//! propertyChecksum: 1 bit (ignored)
//! loop:
//!   encodedHandle: IntPacked
//!   if encodedHandle == 0 -> break
//!   handle = encodedHandle - 1
//!   payloadBitCount: IntPacked
//!   fieldPayload: sub-reader of payloadBitCount
//!   emit (handle, payloadBitCount, fieldPayload)
//! ```
//!
//! # ClassNetCache (RPC) stream bit layout
//!
//! ```text
//! loop:
//!   handle: SerializedInt(max(function_count, 2))
//!   payloadBitCount: IntPacked
//!   rpcPayload: sub-reader of payloadBitCount
//!   emit (handle, payloadBitCount, rpcPayload)
//! ```

use vrf_bitio::BitReader;

use crate::error::{NetError, Result};

/// Sink that receives every field/RPC payload without exception; it decodes
/// what it cares about and may ignore the rest.
pub trait FieldSink {
    /// A RepLayout property field; `reader` holds exactly its `bit_count` bits.
    fn on_field(&mut self, handle: u32, bit_count: u32, reader: BitReader<'_>);

    /// A ClassNetCache RPC; `reader` holds exactly its `bit_count` bits.
    fn on_rpc(&mut self, handle: u32, bit_count: u32, reader: BitReader<'_>);
}

/// The record a walk is inside, so the caller can name the failing record in a
/// `StreamFailure`. Diagnostics only: the pipeline's content-block walks fill
/// one in when the sink's `wants_stream_failure_details` asks;
/// [`parse_rep_layout`] and [`parse_class_net_cache`] never do.
#[derive(Debug, Clone, Copy, Default)]
pub struct WalkContext {
    /// Bit offset inside the block where the current record begins, set
    /// before any of its reads: exact even when the handle read fails.
    pub record_offset: u64,
    /// Handle of the current non-terminator record once its handle read
    /// succeeds. Cleared at every record boundary, so a failed handle read or
    /// an early zero terminator never inherits the previous successful field.
    pub last_handle: Option<u32>,
}

/// What remains after a RepLayout walk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RepLayoutRemainder {
    /// The stream ended exactly at its zero terminator.
    None,
    /// A valid zero terminator was followed by the ClassNetCache portion of
    /// the same `FObjectReplicator::ReceivedBunch` payload.
    ClassNetCache(u64),
    /// A field header or declared payload overran the block.
    Malformed(u64),
}

impl RepLayoutRemainder {
    pub(crate) fn bit_count(self) -> u64 {
        match self {
            Self::None => 0,
            Self::ClassNetCache(bits) | Self::Malformed(bits) => bits,
        }
    }
}

/// A walk's outcome and the count of records it emitted, before any error.
pub(crate) type Walk<R> = (u32, Result<R>);

/// Run a record walk written with `?`, keeping the count of records it
/// emitted before any error.
fn walk<R>(body: impl FnOnce(&mut u32) -> Result<R>) -> Walk<R> {
    let mut count = 0;
    let outcome = body(&mut count);
    (count, outcome)
}

/// Parse a RepLayout property stream, emitting every field to the sink.
///
/// Returns the fields emitted and the bits abandoned mid-block (a declared
/// payload that overran the rest), which the caller adds to `skipped_bits`.
pub fn parse_rep_layout(
    reader: &mut BitReader<'_>,
    sink: &mut dyn FieldSink,
) -> Result<(u32, u64)> {
    let (count, outcome) = parse_rep_layout_impl(reader, sink, None, false);
    Ok((count, outcome?.bit_count()))
}

/// Parse the RepLayout prefix of a content block without consuming a valid
/// post-terminator ClassNetCache tail.
pub(crate) fn parse_rep_layout_content_block(
    reader: &mut BitReader<'_>,
    sink: &mut dyn FieldSink,
    ctx: Option<&mut WalkContext>,
) -> Walk<RepLayoutRemainder> {
    parse_rep_layout_impl(reader, sink, ctx, true)
}

fn parse_rep_layout_impl(
    reader: &mut BitReader<'_>,
    sink: &mut dyn FieldSink,
    mut ctx: Option<&mut WalkContext>,
    retain_class_net_cache_tail: bool,
) -> Walk<RepLayoutRemainder> {
    walk(|field_count| {
        // Property checksum bit -- always present, always ignored.
        reader.read_bit()?;

        let mut remainder = RepLayoutRemainder::None;
        // Only a consumed zero handle terminates the stream; EOF at a record
        // boundary must fail the next handle read, retaining emitted fields.
        loop {
            // The handle and length bits die with an overrunning record, so an
            // abandon is charged from here, not from `bits_remaining`.
            let record_start = reader.position();
            if let Some(ctx) = ctx.as_deref_mut() {
                ctx.record_offset = record_start;
                ctx.last_handle = None;
            }
            let encoded_handle = reader.read_int_packed()?;
            if encoded_handle == 0 {
                // `FObjectReplicator::ReceivedBunch` may place a ClassNetCache
                // stream after the RepLayout terminator in this same window.
                let leftover = reader.bits_remaining();
                if leftover != 0 {
                    remainder = RepLayoutRemainder::ClassNetCache(leftover);
                    if !retain_class_net_cache_tail {
                        reader.skip_remaining();
                    }
                }
                break;
            }

            let handle = encoded_handle - 1;
            if let Some(ctx) = ctx.as_deref_mut() {
                ctx.last_handle = Some(handle);
            }
            // A zero-bit payload is a valid empty field and needs no special
            // case: `sub_reader(0)` is an empty window that cannot overrun.
            let payload_bits = reader.read_int_packed()?;

            if payload_bits as u64 > reader.bits_remaining() {
                remainder = RepLayoutRemainder::Malformed(abandon(reader, record_start));
                break;
            }

            let sub = reader.sub_reader(payload_bits as u64)?;
            sink.on_field(handle, payload_bits, sub);
            *field_count += 1;
        }
        Ok(remainder)
    })
}

/// Parse a ClassNetCache RPC stream, emitting every invocation to the sink.
///
/// `function_count` (the caller's to know: this layer has no descriptors)
/// bounds the handle read. Returns the RPCs emitted and the bits abandoned
/// mid-block, as [`parse_rep_layout`] does.
///
/// The handle is read as `UActorChannel::ReadFieldHeaderAndPayload` reads it,
/// `ReadInt(Max(NetFieldExports.Num(), 2))`: without the minimum of two a
/// capacity-1 group reads a 0-bit handle where the server wrote one bit, and
/// the stream desyncs. A count of 0 is an unresolved group: it fails, unclamped.
pub fn parse_class_net_cache(
    reader: &mut BitReader<'_>,
    function_count: u32,
    sink: &mut dyn FieldSink,
) -> Result<(u32, u64)> {
    let (count, outcome) = parse_class_net_cache_content_block(reader, function_count, sink, None);
    Ok((count, outcome?))
}

pub(crate) fn parse_class_net_cache_content_block(
    reader: &mut BitReader<'_>,
    function_count: u32,
    sink: &mut dyn FieldSink,
    mut ctx: Option<&mut WalkContext>,
) -> Walk<u64> {
    walk(|rpc_count| {
        if function_count == 0 {
            // An unresolved group, not a class with no functions: the handle
            // width is unknown. `Ok` would drop the payload from every counter;
            // failing lets the caller count the bits and name the group.
            return Err(NetError::UnresolvedFunctionCount);
        }

        // The minimum-of-two clamp; see `parse_class_net_cache`.
        let handle_max = function_count.max(2);

        let mut abandoned_bits = 0u64;
        while !reader.at_end() {
            // The abandon paths charge from here, the consumed handle included,
            // so a one-bit block (just a handle) never reads as a clean empty one.
            let record_start = reader.position();
            if let Some(ctx) = ctx.as_deref_mut() {
                ctx.record_offset = record_start;
                ctx.last_handle = None;
            }
            let handle = reader.read_serialized_int(handle_max)?;
            if let Some(ctx) = ctx.as_deref_mut() {
                ctx.last_handle = Some(handle);
            }

            // Too few bits for a payload length is a malformed tail, charged
            // together with its handle, as is a payload that overruns.
            if reader.bits_remaining() < 8 {
                abandoned_bits = abandon(reader, record_start);
                break;
            }
            let payload_bits = reader.read_int_packed()?;
            if payload_bits as u64 > reader.bits_remaining() {
                abandoned_bits = abandon(reader, record_start);
                break;
            }

            let sub = reader.sub_reader(payload_bits as u64)?;
            sink.on_rpc(handle, payload_bits, sub);
            *rpc_count += 1;
        }
        Ok(abandoned_bits)
    })
}

/// Skip the rest of the block and return the bits abandoned from the start
/// of the failing record: its handle and length bits die with it.
fn abandon(reader: &mut BitReader<'_>, record_start: u64) -> u64 {
    reader.skip_remaining();
    reader.len_bits() - record_start
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_bits::{BitWrite, pack};

    /// A sink that records all fields/RPCs.
    #[derive(Default)]
    struct RecordingSink {
        fields: Vec<(u32, u32)>,
        rpcs: Vec<(u32, u32)>,
    }

    impl FieldSink for RecordingSink {
        fn on_field(&mut self, handle: u32, bit_count: u32, _reader: BitReader<'_>) {
            self.fields.push((handle, bit_count));
        }
        fn on_rpc(&mut self, handle: u32, bit_count: u32, _reader: BitReader<'_>) {
            self.rpcs.push((handle, bit_count));
        }
    }

    /// Walk `bits`, bound exactly as framing binds a block: RepLayout for
    /// `None`, ClassNetCache with that function count otherwise.
    fn walk_bits(
        bits: &[bool],
        function_count: Option<u32>,
    ) -> (Result<(u32, u64)>, RecordingSink) {
        let data = pack(bits);
        let mut reader = BitReader::with_bit_len(&data, bits.len() as u64).unwrap();
        let mut sink = RecordingSink::default();
        let result = match function_count {
            None => parse_rep_layout(&mut reader, &mut sink),
            Some(count) => parse_class_net_cache(&mut reader, count, &mut sink),
        };
        (result, sink)
    }

    #[test]
    fn rep_layout_multiple_fields() {
        let mut bits = vec![true]; // checksum bit
        bits.int_packed(1).int_packed(8).repeat(false, 8); // handle 0, 8 bits
        bits.int_packed(5).int_packed(16).repeat(true, 16); // handle 4, 16 bits
        bits.int_packed(0); // terminator

        let (result, sink) = walk_bits(&bits, None);
        assert_eq!(result.unwrap(), (2, 0));
        assert_eq!(sink.fields, vec![(0, 8), (4, 16)]);
    }

    #[test]
    fn rep_layout_empty_stream() {
        let mut bits = vec![false]; // checksum
        bits.int_packed(0); // immediate terminator
        assert_eq!(walk_bits(&bits, None).0.unwrap(), (0, 0));
    }

    #[test]
    fn rep_layout_checksum_only_requires_a_terminator() {
        // Given: only the property checksum, with no encoded handle.
        let bits = [false];

        // When: walking the exact one-bit window.
        let (result, sink) = walk_bits(&bits, None);

        // Then: EOF is not a valid empty stream.
        assert!(matches!(result, Err(NetError::Bit(_))));
        assert!(sink.fields.is_empty());
    }

    #[test]
    fn class_net_cache_single_rpc() {
        let mut bits = Vec::new();
        bits.serialized_int(2, 10).int_packed(16).repeat(false, 16);

        let (result, sink) = walk_bits(&bits, Some(10));
        assert_eq!(result.unwrap(), (1, 0));
        assert_eq!(sink.rpcs, vec![(2, 16)]);
    }

    /// A capacity-1 group reads a one-bit handle (the minimum-of-two clamp):
    /// 1 handle bit + 8 length bits end exactly at the block end.
    #[test]
    fn class_net_cache_capacity_one_consumes_one_bit() {
        let mut bits = Vec::new();
        bits.serialized_int(0, 2).int_packed(0); // written with max 2: one bit

        let (result, sink) = walk_bits(&bits, Some(1));
        assert_eq!(result.unwrap(), (1, 0), "one RPC, nothing abandoned");
        assert_eq!(sink.rpcs, vec![(0, 0)]);
    }

    /// The clamp leaves larger capacities alone: max(3, 2) == 3.
    #[test]
    fn class_net_cache_capacity_three_unchanged() {
        let mut bits = Vec::new();
        bits.serialized_int(1, 3).int_packed(8).repeat(true, 8);

        let (result, sink) = walk_bits(&bits, Some(3));
        assert_eq!(result.unwrap(), (1, 0));
        assert_eq!(sink.rpcs, vec![(1, 8)]);
    }

    /// An unresolved group (function count 0) fails instead of being clamped
    /// to a one-bit handle and emitting plausible garbage.
    #[test]
    fn class_net_cache_unresolved_group_still_fails() {
        let mut bits = Vec::new();
        bits.int_packed(8).repeat(true, 8);

        let (result, sink) = walk_bits(&bits, Some(0));
        assert!(result.is_err());
        assert!(sink.rpcs.is_empty());
    }

    /// An overrunning RepLayout record abandons its handle and length bits as
    /// well as the bits left over.
    #[test]
    fn rep_layout_overrun_returns_abandoned_bits() {
        let mut bits = vec![false]; // checksum
        bits.int_packed(1).int_packed(32).repeat(false, 8); // 32 declared, 8 left

        let (result, sink) = walk_bits(&bits, None);
        assert_eq!(result.unwrap(), (0, 8 + 8 + 8));
        assert!(sink.fields.is_empty());
    }

    /// A field before an early terminator must not be named as the failed
    /// record (the CachedAttributeSet shape), and the tail after the
    /// terminator stays in the reader for the chained ClassNetCache walk.
    #[test]
    fn content_block_walk_leaves_the_tail_after_the_terminator() {
        let mut bits = vec![false]; // checksum
        bits.int_packed(62).int_packed(16).repeat(false, 16); // handle 61
        let terminator_offset = bits.len() as u64;
        bits.int_packed(0);
        let tail_offset = bits.len() as u64;
        bits.repeat(true, 13);

        let data = pack(&bits);
        let mut reader = BitReader::with_bit_len(&data, bits.len() as u64).unwrap();
        let mut sink = RecordingSink::default();
        let mut context = WalkContext::default();
        let (count, Ok(remainder)) =
            parse_rep_layout_content_block(&mut reader, &mut sink, Some(&mut context))
        else {
            panic!("valid prefix and tail must complete")
        };

        assert_eq!(count, 1);
        assert_eq!(sink.fields, vec![(61, 16)]);
        assert_eq!(remainder, RepLayoutRemainder::ClassNetCache(13));
        assert_eq!(context.record_offset, terminator_offset);
        assert_eq!(context.last_handle, None);
        assert_eq!(reader.position(), tail_offset);
        assert_eq!(reader.bits_remaining(), 13);
    }

    /// A terminator before the window ends reports the leftover as abandoned:
    /// the grammar-drift shape, where a build moves it earlier.
    #[test]
    fn rep_layout_terminator_before_window_end_returns_abandoned_bits() {
        let mut bits = vec![false]; // checksum
        bits.int_packed(0).repeat(false, 600);
        assert_eq!(walk_bits(&bits, None).0.unwrap(), (0, 600));
    }

    /// Too few bits for a payload length abandons the tail with the handle
    /// already read from that record: 1 + 3 bits.
    #[test]
    fn class_net_cache_short_tail_returns_abandoned_bits() {
        let mut bits = Vec::new();
        bits.serialized_int(0, 2).repeat(false, 3);
        assert_eq!(walk_bits(&bits, Some(2)).0.unwrap(), (0, 4));
    }

    /// A one-bit block (only a handle) is not a clean `Ok((0, 0))`.
    #[test]
    fn class_net_cache_handle_only_block_is_not_a_clean_success() {
        let mut bits = Vec::new();
        bits.serialized_int(0, 2);
        assert_eq!(bits.len(), 1);
        assert_eq!(walk_bits(&bits, Some(2)).0.unwrap(), (0, 1));
    }
}
