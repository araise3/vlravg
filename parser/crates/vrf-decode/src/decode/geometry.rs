//! Vector, rotator, transform and replicated-movement readers; each value
//! renders into `value_str` through its model type's `Display`.

use vrf_bitio::{BitError, BitReader};

use super::DecodeError;
use crate::types::{
    FQuat, FRepMovement, FRotator, FTransform, FVector, RotatorQuantization, VectorQuantization,
};

pub(super) fn read_vector_net_quantize(
    r: &mut BitReader<'_>,
    scale: u32,
) -> Result<FVector, DecodeError> {
    if scale == 0 {
        return Err(DecodeError::InvalidQuantizationScale { scale });
    }
    read_quantized_vector(r, scale)
}

pub(super) fn read_float_vector(r: &mut BitReader<'_>) -> Result<FVector, BitError> {
    Ok(FVector {
        x: f64::from(r.read_f32()?),
        y: f64::from(r.read_f32()?),
        z: f64::from(r.read_f32()?),
    })
}

pub(super) fn read_double_vector(r: &mut BitReader<'_>) -> Result<FVector, BitError> {
    Ok(FVector {
        x: r.read_f64()?,
        y: r.read_f64()?,
        z: r.read_f64()?,
    })
}

/// [`BitReader::read_quantized_vector`]. Only its raw-float fallback can be
/// NaN or infinite (the packed path is an integer over a non-zero scale); see
/// FRepMovement's Display.
fn read_quantized_vector(r: &mut BitReader<'_>, scale: u32) -> Result<FVector, DecodeError> {
    let [x, y, z] = r.read_quantized_vector(scale)?;
    let v = FVector { x, y, z };
    if v.x.is_finite() && v.y.is_finite() && v.z.is_finite() {
        Ok(v)
    } else {
        Err(DecodeError::NonFiniteComponent {
            context: "quantized vector",
        })
    }
}

/// Fixed-point normal vector: 3 x SerializedInt(65536), bias 32768, scale 32767.
pub(super) fn read_fixed_vector_normal(r: &mut BitReader<'_>) -> Result<FVector, BitError> {
    const BIAS: i32 = 1 << 15;
    let mut axis = || -> Result<f64, BitError> {
        Ok(f64::from(r.read_serialized_int(1 << 16)? as i32 - BIAS) / f64::from(BIAS - 1))
    };
    Ok(FVector {
        x: axis()?,
        y: axis()?,
        z: axis()?,
    })
}

/// [`BitReader::read_compressed_rotator`]: `width` 16 is short, 8 byte.
pub(super) fn read_rotation(r: &mut BitReader<'_>, width: u32) -> Result<FRotator, BitError> {
    let [pitch, yaw, roll] = r.read_compressed_rotator(width)?;
    Ok(FRotator { pitch, yaw, roll })
}

fn read_quaternion(r: &mut BitReader<'_>) -> Result<FQuat, BitError> {
    Ok(FQuat {
        x: r.read_f32()?,
        y: r.read_f32()?,
        z: r.read_f32()?,
        w: r.read_f32()?,
    })
}

pub(super) fn read_transform(r: &mut BitReader<'_>) -> Result<FTransform, BitError> {
    let rotation = read_quaternion(r)?;
    let translation = read_float_vector(r)?;
    let scale = read_float_vector(r)?;
    Ok(FTransform {
        rotation,
        translation,
        scale,
    })
}

pub(super) fn read_rep_movement(
    r: &mut BitReader<'_>,
    rotation_quant: RotatorQuantization,
    location_quant: VectorQuantization,
) -> Result<FRepMovement, DecodeError> {
    let simulated_physics_sleep = r.read_bit()?;
    let rep_physics = r.read_bit()?;
    let rep_server_frame = r.read_bit()?;
    let rep_server_handle = r.read_bit()?;

    // The divisor is the table entry's: the header says only "scaled", classes
    // differ (docs/DATA.md), and a wrong divisor reads the same bits silently.
    let location = read_quantized_vector(r, location_quant.scale())?;
    let rotation = match rotation_quant {
        RotatorQuantization::ByteComponents => read_rotation(r, 8)?,
        RotatorQuantization::ShortComponents => read_rotation(r, 16)?,
    };
    // Whole units, Unreal's default VelocityQuantizationLevel: displacement /
    // dt / reported speed has a median of 0.97-1.06 on all 18 moving classes.
    let linear_velocity = read_quantized_vector(r, 1)?;
    let angular_velocity = rep_physics
        .then(|| read_quantized_vector(r, 1))
        .transpose()?;
    let server_frame = rep_server_frame.then(|| r.read_int_packed()).transpose()?;
    let server_physics_handle = rep_server_handle.then(|| r.read_int_packed()).transpose()?;

    Ok(FRepMovement {
        location,
        rotation,
        linear_velocity,
        angular_velocity,
        simulated_physics_sleep,
        rep_physics,
        server_frame,
        server_physics_handle,
    })
}
