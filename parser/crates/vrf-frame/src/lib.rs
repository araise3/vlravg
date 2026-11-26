//! DemoFrame iteration: decompressed replay-data chunk -> `(time_ms, packet)` sequence.
//!
//! A stage between the container (decompressed chunks) and the replication
//! reader (packets): a valid container can hold an invalid frame stream.
//!
//! # DemoFrame wire layout
//!
//! A ReplayData chunk is a sequence of DemoFrames, read byte-aligned
//! (`FBinaryArchive`: `IntPacked` is still 7 bits per byte, `FString` an i32
//! length, the bytes and a null):
//!
//! ```text
//! currentLevelIndex   : i32 (ignored)
//! timeSeconds         : f32 (the frame time)
//! ExportData          : numLayoutCmdExports : IntPacked -> ReadNetFieldExports
//!                       numExportGuids      : IntPacked -> ReadExportGuids
//! StreamingLevelFixes : numLevels : IntPacked, then per level
//!                       HasStreamingFixes: FString; then externalOffset : u64
//!                       otherwise: FString, FString, FTransform (40 bytes)
//! ExternalData        : until numBits is 0: numBits : IntPacked,
//!                       netGuid : IntPacked, ceil(numBits / 8) bytes
//! GameSpecificFrameData (flag set): skipExternalOffset : u64, that many bytes
//! packets             : until packetSize is 0:
//!                       seenLevelIndex : IntPacked (HasStreamingFixes; ignored)
//!                       packetSize : i32 (negative -> error), packetSize bytes
//! ```
//!
//! # Flag semantics
//!
//! | Bit | Name | Effect |
//! |-----|------|--------|
//! | 1 (0x02) | `HasStreamingFixes` | Enables the streaming-level-fixes path and per-packet `seenLevelIndex` |
//! | 3 (0x08) | `GameSpecificFrameData` | Enables the game-specific skip section |
//!
//! Every measured replay sets only `HasStreamingFixes` and sends no ExternalData
//! (docs/PERFORMANCE_NOTES.md#measured-shape-on-real-replays); [`FrameSkips`]
//! moves if that changes.
//!
//! No Cargo features: every section must be consumed, in order, to keep the
//! frame cursor aligned.

#![forbid(unsafe_code)]

mod error;
mod sections;

pub use error::FrameError;

use vrf_bitio::BitReader;
use vrf_schema::NetGuidCache;

use sections::{read_external_data, read_game_specific_frame_data, read_streaming_level_fixes};

/// Replay header flags that control DemoFrame parsing.
pub const FLAG_HAS_STREAMING_FIXES: u32 = 1 << 1;
pub const FLAG_GAME_SPECIFIC_FRAME_DATA: u32 = 1 << 3;

/// Unreal's `MaxPacketSizeInBits`, in bytes.
const MAX_PACKET_SIZE_BYTES: i32 = 16384 / 8;

/// A packet from the DemoFrame stream.
#[derive(Debug, Clone)]
pub struct DemoPacket<'a> {
    /// The enclosing DemoFrame's `timeSeconds` in ms; see [`walk_demo_frames`].
    pub time_ms: u32,
    /// Sequential packet index (0-based across the entire chunk).
    pub packet_index: u32,
    /// Raw packet bytes (pass to `ReplicationReader::process_packet`).
    pub data: &'a [u8],
}

/// Section bytes a DemoFrame walk stepped over undecoded, by their declared
/// lengths, so nothing else moves when a build starts sending them: zero is a
/// measurement, not a default. `#[non_exhaustive]` so a further tally is not
/// a breaking change.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct FrameSkips {
    /// ExternalData blobs stepped over: one per non-zero `numBits`.
    pub external_data_blobs: u64,
    /// Their bytes, `ceil(numBits / 8)` each; the net GUIDs read between them
    /// are not counted.
    pub external_data_bytes: u64,
    /// Bytes skipped by GameSpecificFrameData's `skipExternalOffset`, counted
    /// only in frames whose header flag enables the section.
    pub game_specific_bytes: u64,
}

impl FrameSkips {
    /// Add another walk's tallies to these.
    pub fn absorb(&mut self, other: FrameSkips) {
        self.external_data_blobs += other.external_data_blobs;
        self.external_data_bytes += other.external_data_bytes;
        self.game_specific_bytes += other.game_specific_bytes;
    }
}

/// What one [`walk_demo_frames`] call walked; `#[non_exhaustive]` like
/// [`FrameSkips`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct FrameWalk {
    /// Packets yielded to the callback.
    pub packets: u32,
    /// DemoFrames walked; not derivable from `packets`, since a frame carries
    /// any number of packets.
    pub frames: u32,
    /// Section bytes stepped over without being decoded.
    pub skipped: FrameSkips,
    /// Frames whose `timeSeconds` was NaN or infinite. Their packets carry
    /// 0 ms: a plausible wrong time, so it is counted.
    pub non_finite_times: u32,
}

/// [`walk_demo_frames`] returning only `(packets, frames)`, for callers of the
/// published function.
pub fn iter_demo_frames(
    data: &[u8],
    flags: u32,
    cache: &mut NetGuidCache,
    on_packet: impl FnMut(DemoPacket<'_>, &mut NetGuidCache),
) -> Result<(u32, u32), FrameError> {
    let walk = walk_demo_frames(data, flags, cache, on_packet)?;
    Ok((walk.packets, walk.frames))
}

/// Walk every DemoFrame in a decompressed ReplayData chunk (`data`), calling
/// `on_packet` for each packet. `flags` is `ReplayHeader.flags`.
///
/// Each frame's ExportData is applied to `cache` before its packets.
/// `on_packet` gets the frame's time, the packet's bytes (a slice of `data`)
/// and the cache as of that packet's wire position; a mutation it makes is
/// visible to the next packet before a later frame's ExportData.
pub fn walk_demo_frames(
    data: &[u8],
    flags: u32,
    cache: &mut NetGuidCache,
    mut on_packet: impl FnMut(DemoPacket<'_>, &mut NetGuidCache),
) -> Result<FrameWalk, FrameError> {
    let has_streaming_fixes = (flags & FLAG_HAS_STREAMING_FIXES) != 0;
    let has_game_specific = (flags & FLAG_GAME_SPECIFIC_FRAME_DATA) != 0;

    let mut reader = BitReader::new(data);
    let mut packet_index: u32 = 0;
    let mut frame_count: u32 = 0;
    let mut skipped = FrameSkips::default();
    let mut non_finite_times: u32 = 0;

    while !reader.at_end() {
        frame_count += 1;
        let _current_level_index = reader.read_i32()?;
        let time_seconds = reader.read_f32()?;
        // The consumer bundle's rule: `seconds * 1000` in f64, rounded half away
        // from zero. Outside u32 ms after rounding is refused, not saturated
        // (-1.0 s would read as the first frame); non-finite is 0 ms, counted.
        let time_ms = if time_seconds.is_finite() {
            let ms = (f64::from(time_seconds) * 1000.0).round();
            if ms < 0.0 || ms > f64::from(u32::MAX) {
                return Err(FrameError::TimeOutOfRange {
                    seconds: time_seconds,
                });
            }
            ms as u32
        } else {
            non_finite_times += 1;
            0
        };

        // ExportData into `cache`; its per-frame counts reach no counter.
        let _ = vrf_schema::read_net_field_exports(&mut reader, cache)?;
        let _ = vrf_schema::read_export_guids(&mut reader, cache)?;
        read_streaming_level_fixes(&mut reader, has_streaming_fixes)?;

        let (blobs, bytes) = read_external_data(&mut reader)?;
        skipped.external_data_blobs += blobs;
        skipped.external_data_bytes += bytes;

        skipped.game_specific_bytes +=
            read_game_specific_frame_data(&mut reader, has_game_specific)?;

        loop {
            if has_streaming_fixes {
                let _seen_level_index = reader.read_int_packed()?;
            }

            let packet_size = reader.read_i32()?;
            if packet_size == 0 {
                break;
            }
            if packet_size < 0 {
                return Err(FrameError::NegativePacketSize { size: packet_size });
            }
            if packet_size > MAX_PACKET_SIZE_BYTES {
                return Err(FrameError::PacketTooLarge {
                    size: packet_size,
                    max: MAX_PACKET_SIZE_BYTES,
                });
            }

            let packet_size_usize = packet_size as usize;
            let bit_count = (packet_size_usize as u64) * 8;
            if reader.bits_remaining() < bit_count {
                return Err(FrameError::Truncated {
                    context: "packet data",
                    needed: packet_size_usize,
                    available: (reader.bits_remaining() / 8) as usize,
                });
            }

            // Every frame read, ExportData included, is whole bytes.
            debug_assert_eq!(reader.position() % 8, 0);
            let byte_offset = (reader.position() / 8) as usize;
            let packet_data = &data[byte_offset..byte_offset + packet_size_usize];
            reader.skip_bits(bit_count)?;

            on_packet(
                DemoPacket {
                    time_ms,
                    packet_index,
                    data: packet_data,
                },
                cache,
            );
            packet_index += 1;
        }
    }

    Ok(FrameWalk {
        packets: packet_index,
        frames: frame_count,
        skipped,
        non_finite_times,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use vrf_testkit::add_int_packed;

    /// One DemoFrame: `exports` is the whole ExportData section, then no
    /// streaming levels, the ExternalData blobs `(numBits, netGuid, payload)`,
    /// `game_specific` when `flags` enables that section, and `packets`.
    fn build_frame(
        flags: u32,
        time_secs: f32,
        exports: &[u8],
        external: &[(u32, u32, &[u8])],
        game_specific: &[u8],
        packets: &[&[u8]],
    ) -> Vec<u8> {
        let streaming = flags & FLAG_HAS_STREAMING_FIXES != 0;
        let mut data = Vec::new();
        data.extend_from_slice(&0i32.to_le_bytes()); // currentLevelIndex
        data.extend_from_slice(&time_secs.to_le_bytes());
        data.extend_from_slice(exports);
        data.push(0); // numLevels
        if streaming {
            data.extend_from_slice(&0u64.to_le_bytes()); // externalOffset
        }
        for &(num_bits, net_guid, payload) in external {
            add_int_packed(&mut data, num_bits);
            add_int_packed(&mut data, net_guid);
            data.extend_from_slice(payload);
        }
        data.push(0); // ExternalData terminator
        if flags & FLAG_GAME_SPECIFIC_FRAME_DATA != 0 {
            data.extend_from_slice(&(game_specific.len() as u64).to_le_bytes());
            data.extend_from_slice(game_specific);
        }
        // The empty packet is the frame terminator: packetSize 0.
        for packet in packets.iter().chain([&[][..]].iter()) {
            if streaming {
                data.push(0); // seenLevelIndex
            }
            data.extend_from_slice(&(packet.len() as i32).to_le_bytes());
            data.extend_from_slice(packet);
        }
        data
    }

    /// An ExportData section declaring `/Script/G.Thing` at index 7 with
    /// `field_count` slots, no field and no export GUIDs.
    fn group_export(field_count: u32) -> Vec<u8> {
        let mut data = Vec::new();
        add_int_packed(&mut data, 1); // one layout export
        add_int_packed(&mut data, 7); // path-name index
        add_int_packed(&mut data, 1); // path is exported
        let path = b"/Script/G.Thing";
        data.extend_from_slice(&((path.len() + 1) as i32).to_le_bytes());
        data.extend_from_slice(path);
        data.push(0);
        add_int_packed(&mut data, field_count);
        data.push(0); // no field exported
        add_int_packed(&mut data, 0); // no export GUIDs
        data
    }

    /// Two frames, so the tally must add across frames, not keep the last.
    #[test]
    fn external_data_blobs_are_counted_and_the_packets_still_arrive() {
        // 12 bits -> 2 bytes, 17 bits -> 3 bytes; then 1 bit -> 1 byte.
        let flags = FLAG_HAS_STREAMING_FIXES;
        let external: &[(u32, u32, &[u8])] = &[(12, 6, &[0xAA, 0xBB]), (17, 9, &[1, 2, 3])];
        let mut data = build_frame(flags, 1.0, &[0, 0], external, &[], &[&[0xDE, 0xAD]]);
        data.extend(build_frame(
            flags,
            1.0,
            &[0, 0],
            &[(1, 4, &[0x01])],
            &[],
            &[&[0xBE]],
        ));
        let mut cache = NetGuidCache::new();
        let mut received = Vec::new();

        let walk = walk_demo_frames(&data, flags, &mut cache, |pkt, _| {
            received.push(pkt.data.to_vec());
        })
        .unwrap();

        assert_eq!((walk.packets, walk.frames), (2, 2));
        assert_eq!(
            walk.skipped,
            FrameSkips {
                external_data_blobs: 3,
                external_data_bytes: 6,
                game_specific_bytes: 0,
            }
        );
        assert_eq!(received, [vec![0xDE, 0xAD], vec![0xBE]]);
    }

    /// Counted in bytes, and only when the header flag enables the section.
    #[test]
    fn game_specific_bytes_are_counted_and_the_packet_still_arrives() {
        let flags = FLAG_HAS_STREAMING_FIXES | FLAG_GAME_SPECIFIC_FRAME_DATA;
        let data = build_frame(flags, 1.0, &[0, 0], &[], &[1, 2, 3, 4, 5], &[&[0x7F]]);
        let mut cache = NetGuidCache::new();
        let mut received = Vec::new();

        let walk = walk_demo_frames(&data, flags, &mut cache, |pkt, _| {
            received.push(pkt.data.to_vec());
        })
        .unwrap();

        assert_eq!(
            walk.skipped,
            FrameSkips {
                external_data_blobs: 0,
                external_data_bytes: 0,
                game_specific_bytes: 5,
            }
        );
        assert_eq!(received, [vec![0x7F]]);
    }

    /// Empty sections read as zero, the packet keeps its bytes and frame time,
    /// and `iter_demo_frames` reports the walk's packets and frames.
    #[test]
    fn a_frame_with_empty_sections_skips_nothing() {
        let flags = FLAG_HAS_STREAMING_FIXES | FLAG_GAME_SPECIFIC_FRAME_DATA;
        let payload = [0xDE, 0xAD, 0xBE, 0xEF];
        let data = build_frame(flags, 12.5, &[0, 0], &[], &[], &[&payload]);
        let mut received = Vec::new();

        let walk = walk_demo_frames(&data, flags, &mut NetGuidCache::new(), |pkt, _| {
            received.push((pkt.time_ms, pkt.data.to_vec()));
        })
        .unwrap();
        assert_eq!(walk.skipped, FrameSkips::default());
        assert_eq!((walk.packets, walk.frames), (1, 1));
        assert_eq!(received, [(12500, payload.to_vec())]);
        assert_eq!(
            iter_demo_frames(&data, flags, &mut NetGuidCache::new(), |_, _| {}).unwrap(),
            (walk.packets, walk.frames)
        );
    }

    #[test]
    fn each_packet_observes_only_schema_exports_that_precede_it() {
        let flags = FLAG_HAS_STREAMING_FIXES;
        let mut data = build_frame(flags, 1.0, &group_export(1), &[], &[], &[&[1]]);
        data.extend(build_frame(flags, 2.0, &group_export(2), &[], &[], &[&[2]]));
        let mut cache = NetGuidCache::new();
        let mut seen = Vec::new();

        iter_demo_frames(&data, flags, &mut cache, |packet, packet_cache| {
            seen.push((
                packet.data[0],
                packet_cache.get_group_by_index(7).unwrap().len(),
            ));
        })
        .unwrap();

        assert_eq!(seen, [(1, 1), (2, 2)]);
    }

    /// One frame at `time_secs`: its packet's `time_ms`, or the walk's error.
    fn frame_time(time_secs: f32) -> Result<u32, FrameError> {
        let flags = FLAG_HAS_STREAMING_FIXES | FLAG_GAME_SPECIFIC_FRAME_DATA;
        let data = build_frame(flags, time_secs, &[0, 0], &[], &[], &[&[0x00]]);
        let mut time_ms = None;
        walk_demo_frames(&data, flags, &mut NetGuidCache::new(), |pkt, _| {
            time_ms = Some(pkt.time_ms);
        })?;
        Ok(time_ms.expect("the frame carries one packet"))
    }

    /// Non-finite times are read as 0 ms and counted per frame; 1.5 s and
    /// -0.0 s between them are not.
    #[test]
    fn non_finite_frame_times_are_counted_not_refused() {
        let flags = FLAG_HAS_STREAMING_FIXES | FLAG_GAME_SPECIFIC_FRAME_DATA;
        let mut data = Vec::new();
        for secs in [f32::NAN, 1.5, f32::INFINITY, -0.0, f32::NEG_INFINITY] {
            data.extend(build_frame(flags, secs, &[0, 0], &[], &[], &[&[0x00]]));
        }
        let mut times = Vec::new();
        let walk = walk_demo_frames(&data, flags, &mut NetGuidCache::new(), |pkt, _| {
            times.push(pkt.time_ms);
        })
        .unwrap();
        assert_eq!(walk.non_finite_times, 3);
        assert_eq!((walk.frames, walk.packets), (5, 5));
        assert_eq!(times, [0, 1_500, 0, 0, 0]);
    }

    /// The named cases of the conversion in [`walk_demo_frames`].
    #[test]
    fn time_ms_rounds_like_the_reference() {
        for (secs, ms) in [
            (12.5, 12_500),
            (0.0004, 0),
            (0.0005, 1), // exactly half rounds away from zero
            (0.0006, 1),
            (1.9999, 2_000), // carries into the next second
            // `as u32` alone would give +inf u32::MAX.
            (f32::NAN, 0),
            (f32::NEG_INFINITY, 0),
            (f32::INFINITY, 0),
            // -0.0004 s rounds to -0.0, which the range check accepts.
            (-0.0004, 0),
            (-0.0, 0),
            (0.0, 0),
            // Exact in f32 and just under u32::MAX ms: no off-by-one rejection.
            (4_294_967.0, 4_294_967_000),
        ] {
            assert_eq!(frame_time(secs).unwrap(), ms, "{secs} s");
        }
    }

    #[test]
    fn time_ms_matches_the_reference_formula_across_a_match() {
        // A match's span of uneven timestamps against the rule's expression
        // in f64: catches the rounding rule and f32-vs-f64 drift in the
        // multiply, which named cases would not.
        for step in 0..2000 {
            let secs = (step as f32) * 1.1597; // ~0 to ~2319 s, uneven fractions
            let expected = (f64::from(secs) * 1000.0).round() as u32;
            assert_eq!(frame_time(secs).unwrap(), expected, "at {secs} s");
        }
    }

    /// Refused, not saturated: -1.0 s to 0 ms, 5e6 s to u32::MAX ms (49.7 days).
    #[test]
    fn a_frame_time_outside_the_u32_millisecond_range_is_rejected() {
        for secs in [-1.0, 5.0e6] {
            let err = frame_time(secs).unwrap_err();
            assert!(
                matches!(err, FrameError::TimeOutOfRange { .. }),
                "{secs} s: {err:?}"
            );
        }
    }

    #[test]
    fn empty_data_yields_zero_packets() {
        let mut cache = NetGuidCache::new();
        let (count, frame_count) = iter_demo_frames(
            &[],
            FLAG_HAS_STREAMING_FIXES | FLAG_GAME_SPECIFIC_FRAME_DATA,
            &mut cache,
            |_, _| {},
        )
        .unwrap();
        assert_eq!(count, 0);
        assert_eq!(frame_count, 0);
    }

    #[test]
    fn negative_packet_size_is_error() {
        let flags = FLAG_HAS_STREAMING_FIXES | FLAG_GAME_SPECIFIC_FRAME_DATA;
        let mut data = build_frame(flags, 1.0, &[0, 0], &[], &[], &[]);
        // The frame ends in the terminator's packetSize; make it negative.
        data.truncate(data.len() - 4);
        data.extend_from_slice(&(-1i32).to_le_bytes());

        let mut cache = NetGuidCache::new();
        let err = iter_demo_frames(&data, flags, &mut cache, |_, _| {}).unwrap_err();
        assert!(matches!(err, FrameError::NegativePacketSize { size: -1 }));
    }
}
