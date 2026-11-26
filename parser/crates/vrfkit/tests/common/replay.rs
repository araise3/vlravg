//! The replay pieces vrf-testkit leaves to its callers, shared by the binary
//! tests and, by path, the driver's unit tests.

// Each includer uses a different subset.
#![allow(dead_code)]

use vrf_testkit::*;

/// One DemoFrame under `header_payload`'s flags: no exports or streaming
/// levels, the ExternalData blobs `(numBits, netGuid)` -- each followed by
/// `ceil(numBits / 8)` payload bytes -- a GameSpecificFrameData block of
/// `game_bytes`, then `packets`.
pub fn frame(
    time_seconds: f32,
    external: &[(u32, u32)],
    game_bytes: usize,
    packets: &[&[u8]],
) -> Vec<u8> {
    let mut buf = Vec::new();
    add_i32(&mut buf, 0); // currentLevelIndex
    add_f32(&mut buf, time_seconds);
    add_int_packed(&mut buf, 0); // no layout exports
    add_int_packed(&mut buf, 0); // no export GUIDs
    add_int_packed(&mut buf, 0); // no streaming levels
    add_u64(&mut buf, 0); // externalOffset
    for &(num_bits, net_guid) in external {
        add_int_packed(&mut buf, num_bits);
        add_int_packed(&mut buf, net_guid);
        buf.extend(std::iter::repeat_n(0xA5, num_bits.div_ceil(8) as usize));
    }
    add_int_packed(&mut buf, 0); // ExternalData terminator
    add_u64(&mut buf, game_bytes as u64);
    buf.extend(std::iter::repeat_n(0x5A, game_bytes));
    for packet in packets.iter().copied().chain([&[][..]]) {
        add_int_packed(&mut buf, 0); // seenLevelIndex
        add_i32(&mut buf, packet.len() as i32); // 0 ends the frame
        buf.extend_from_slice(packet);
    }
    buf
}

/// A ReplayData chunk payload: SizeInBytes is `body`'s length (the frames,
/// or their archive in a compressed replay), MemorySizeInBytes `frames_len`.
pub fn replay_data(body: &[u8], frames_len: usize) -> Vec<u8> {
    let mut buf = Vec::new();
    add_u32(&mut buf, 0); // time1
    add_u32(&mut buf, 60_000); // time2
    add_i32(&mut buf, body.len() as i32);
    add_i32(&mut buf, frames_len as i32);
    buf.extend_from_slice(body);
    buf
}

/// A checkpoint archive's plain bytes: no GUIDs and no export groups, then
/// `frames`. The first word is the frame offset minus 8; the tables end at
/// byte 24.
pub fn checkpoint_tables(frames: &[u8]) -> Vec<u8> {
    let mut plain = Vec::new();
    add_u32(&mut plain, 16); // frame offset word: 24 - 8
    for _ in 0..5 {
        add_u32(&mut plain, 0); // three reserved words, GUID entries, export groups
    }
    plain.extend_from_slice(frames);
    plain
}

/// A Checkpoint chunk payload around `archive`, then `trailing` bytes inside
/// the chunk.
pub fn checkpoint(index: u32, archive: &[u8], trailing: usize) -> Vec<u8> {
    let mut buf = Vec::new();
    add_fstring(&mut buf, &format!("checkpoint{index}"));
    add_fstring(&mut buf, "checkpoint");
    add_fstring(&mut buf, &(index + 1).to_string());
    add_u32(&mut buf, 1000 * (index + 1)); // time1
    add_u32(&mut buf, 1000 * (index + 1)); // time2
    add_i32(&mut buf, archive.len() as i32);
    buf.extend_from_slice(archive);
    buf.extend(std::iter::repeat_n(0xCD, trailing));
    buf
}

/// A packet whose one reliable bunch opens a partial reassembly on channel 2
/// and never finishes it: 8 payload bits at end of stream.
pub fn unfinished_partial_packet() -> Vec<u8> {
    let mut payload = BitWriter::new();
    payload.int_packed(3);
    let mut bits = BitWriter::new();
    bits.extend_bits(&[true, true, false, false, true]) // control, open, close, paused, reliable
        .int_packed(2) // channel index
        .extend_bits(&[false, false, true, false]) // exports, must be mapped, partial, Valorant
        .extend_bits(&[true, false]) // partial initial, partial final
        .bit(true) // hardcoded channel name
        .int_packed(1)
        .serialized_int(payload.len() as u32, 2 * 1024 * 8)
        .extend_bits(&payload)
        .bit(true); // end-of-packet marker
    pack(&bits)
}
