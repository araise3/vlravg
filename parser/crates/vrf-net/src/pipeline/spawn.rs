//! Dynamic-actor spawn data: archetype, level, transform and velocity.
//!
//! The block Unreal writes right after the actor GUID when a channel opens for
//! a *dynamic* (even, non-zero GUID) actor: rare (open counts:
//! docs/PERFORMANCE_NOTES.md#measured-rates-reference-replay-02d4d478), but
//! its bit width decides everything after it in the same bunch.

use vrf_bitio::BitReader;

use crate::error::Result;
use crate::net_guid::{self, GuidPathSink};
use crate::types::{FRotator, FVector};

use super::ActorChannelState;

const ORIGIN: FVector = FVector {
    x: 0.0,
    y: 0.0,
    z: 0.0,
};

const UNIT_SCALE: FVector = FVector {
    x: 1.0,
    y: 1.0,
    z: 1.0,
};

/// Quantization divisor Unreal uses for the spawn transform components.
const SPAWN_SCALE_FACTOR: u32 = 10;

/// Read the spawn block for a dynamic actor into `state`.
pub(super) fn read_dynamic_spawn_data(
    payload: &mut BitReader<'_>,
    state: &mut ActorChannelState,
    sink: &mut dyn GuidPathSink,
) -> Result<()> {
    // Archetype. Its path is what identifies the replay controller later, so
    // this read must happen before the net-player-index check in `channel.rs`.
    state.archetype_net_guid = net_guid::internal_load_object(payload, false, 0, sink)?;
    state.level_guid = net_guid::internal_load_object(payload, false, 0, sink)?;
    state.spawn_location = Some(read_optional_quantized_vector(payload, ORIGIN)?);
    if payload.read_bit()? {
        let [pitch, yaw, roll] = payload.read_compressed_rotator(16)?;
        state.spawn_rotation = Some(FRotator { pitch, yaw, roll });
    }
    state.spawn_scale = Some(read_optional_quantized_vector(payload, UNIT_SCALE)?);
    // Velocity is read unconditionally: gating it loses one bit, silently.
    state.spawn_velocity = Some(read_optional_quantized_vector(payload, ORIGIN)?);
    Ok(())
}

/// A hasValue bit, then an isQuantized bit: a QuantizedVector at
/// [`SPAWN_SCALE_FACTOR`] if set, else 3 x f64. A clear hasValue means "take
/// the default" (origin, or unit scale), not "absent": only a static actor,
/// which has no spawn block, leaves the fields `None`.
fn read_optional_quantized_vector(reader: &mut BitReader<'_>, default: FVector) -> Result<FVector> {
    if !reader.read_bit()? {
        return Ok(default);
    }
    let [x, y, z] = if reader.read_bit()? {
        reader.read_quantized_vector(SPAWN_SCALE_FACTOR)?
    } else {
        [reader.read_f64()?, reader.read_f64()?, reader.read_f64()?]
    };
    Ok(FVector { x, y, z })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_bits::{BitWrite, pack};
    use crate::types::NetworkGuid;

    struct NoPaths;
    impl GuidPathSink for NoPaths {
        fn register_path(&mut self, _: u32, _: &str, _: NetworkGuid) {}
    }

    /// Invalid archetype and level GUIDs, no location, a short rotator with
    /// only pitch set (16384 -> 90 degrees), no scale, no velocity: absent
    /// vectors take their own defaults and every bit is read.
    #[test]
    fn spawn_block_reads_a_short_rotator_and_defaults_absent_vectors() {
        let mut bits: Vec<bool> = Vec::new();
        bits.int_packed(0).int_packed(0).bit(false);
        bits.bit(true).bit(true).u16(16384).bit(false).bit(false);
        bits.bit(false).bit(false);
        let data = pack(&bits);
        let mut reader = BitReader::with_bit_len(&data, bits.len() as u64).unwrap();
        let mut state = ActorChannelState::default();
        read_dynamic_spawn_data(&mut reader, &mut state, &mut NoPaths).unwrap();
        assert!(reader.at_end());
        let (pitch, yaw, roll) = (90.0, 0.0, 0.0);
        assert_eq!(state.spawn_rotation, Some(FRotator { pitch, yaw, roll }));
        assert_eq!(state.spawn_location, Some(ORIGIN));
        assert_eq!(state.spawn_scale, Some(UNIT_SCALE));
        assert_eq!(state.spawn_velocity, Some(ORIGIN));
    }

    /// The quantized path sign-extends each component and divides by the scale
    /// factor only when `extra_info` is set: info 72 is 8-bit components with
    /// extra_info 1 (divided by 10), info 8 the same components in whole units.
    #[test]
    fn quantized_vector_sign_extends_and_scales() {
        for (info, want) in [(72, [-0.1, 0.1, -12.8]), (8, [-1.0, 1.0, -128.0])] {
            // hasValue, isQuantized, then 0xFF (-1), 0x01 and 0x80 (-128).
            let mut bits = vec![true, true];
            bits.serialized_int(info, 128).u8(0xFF).u8(0x01).u8(0x80);
            let data = pack(&bits);
            let mut reader = BitReader::with_bit_len(&data, bits.len() as u64).unwrap();
            let v = read_optional_quantized_vector(&mut reader, ORIGIN).unwrap();
            assert_eq!([v.x, v.y, v.z], want, "info {info}");
        }
    }
}
