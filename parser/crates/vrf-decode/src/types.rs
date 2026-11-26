//! Model types for Unreal replay values, as plain data; their `Display` impls
//! produce the string written to `value_str`.

use core::fmt;

/// How [`FRepMovement`] serializes its rotation, per axis:
/// - `ByteComponents`: 1 flag bit + 8 data bits (+/-1.4deg precision)
/// - `ShortComponents`: 1 flag bit + 16 data bits (+/-0.005deg)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RotatorQuantization {
    ByteComponents,
    ShortComponents,
}

/// Location quantization for [`FRepMovement`] (Unreal's `EVectorQuantization`):
/// the decimals the sending class rounds to before packing. Not on the wire --
/// the packed header says only "scaled" -- so every `RepMovement` entry states it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum VectorQuantization {
    /// Whole units: the packed integer is the coordinate.
    RoundWholeNumber,
    /// One decimal: the packed integer is ten times the coordinate.
    RoundOneDecimal,
    /// Two decimals: the packed integer is a hundred times the coordinate.
    RoundTwoDecimals,
}

impl VectorQuantization {
    /// The divisor that turns a scaled packed integer back into world units.
    pub const fn scale(self) -> u32 {
        match self {
            Self::RoundWholeNumber => 1,
            Self::RoundOneDecimal => 10,
            Self::RoundTwoDecimals => 100,
        }
    }
}

/// A 3D vector; components are `f64` whatever the wire width (f32 is widened).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FVector {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

impl fmt::Display for FVector {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "({},{},{})", self.x, self.y, self.z)
    }
}

/// Euler rotation (degrees).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FRotator {
    pub pitch: f32,
    pub yaw: f32,
    pub roll: f32,
}

impl fmt::Display for FRotator {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "rot({},{},{})", self.pitch, self.yaw, self.roll)
    }
}

/// Quaternion rotation (4 x f32).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FQuat {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub w: f32,
}

impl fmt::Display for FQuat {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "quat({},{},{},{})", self.x, self.y, self.z, self.w)
    }
}

/// Transform = rotation (quat) + translation (vec3) + scale (vec3).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FTransform {
    pub rotation: FQuat,
    pub translation: FVector,
    pub scale: FVector,
}

impl fmt::Display for FTransform {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "xform({};{};{})",
            self.rotation, self.translation, self.scale
        )
    }
}

/// Replicated movement state, in wire order:
///
/// ```text
/// 4 bits: bSimulatedPhysicsSleep, bRepPhysics, bRepServerFrame, bRepServerHandle
/// location: packed quantized vector / VectorQuantization::scale()
/// rotation: RotationShort or RotationByte; linear velocity: whole units
/// if bRepPhysics: angular velocity (whole units)
/// if bRepServerFrame / bRepServerHandle: IntPacked server frame / physics handle
/// ```
///
/// The location divisor and rotator width are per-class choices the wire does
/// not carry; `FieldType::RepMovement` supplies both.
#[derive(Debug, Clone, PartialEq)]
pub struct FRepMovement {
    pub location: FVector,
    pub rotation: FRotator,
    pub linear_velocity: FVector,
    pub angular_velocity: Option<FVector>,
    pub simulated_physics_sleep: bool,
    pub rep_physics: bool,
    /// `None` when `bRepServerFrame` is clear: not sent, not frame 0.
    pub server_frame: Option<u32>,
    /// `None` when `bRepServerHandle` is clear.
    pub server_physics_handle: Option<u32>,
}

/// An [`FVector`] as the JSON object `{"x":..,"y":..,"z":..}`, not its compact
/// `Display`; the effect JSON writes vectors the same way.
pub(crate) struct VectorJson<'a>(pub(crate) &'a FVector);

impl fmt::Display for VectorJson<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let FVector { x, y, z } = self.0;
        write!(f, "{{\"x\":{x},\"y\":{y},\"z\":{z}}}")
    }
}

/// `Some(v)` as `v`, `None` as JSON `null`.
struct OrNull<T>(Option<T>);

impl<T: fmt::Display> fmt::Display for OrNull<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.0 {
            Some(v) => v.fmt(f),
            None => f.write_str("null"),
        }
    }
}

/// A JSON object whose member names and order match the reference bundle byte
/// for byte. Finiteness is `DecodeError::NonFiniteComponent`'s job, not the
/// type's: the raw-float fallback can carry NaN, so any other constructor owes
/// that check (docs/OVERLAY_RESOLUTION.md "FRepMovement finiteness is enforced").
impl fmt::Display for FRepMovement {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let FRotator { pitch, yaw, roll } = self.rotation;
        write!(
            f,
            "{{\"linear_velocity\":{},\"angular_velocity\":{},\"location\":{},\
             \"rotation\":{{\"pitch\":{pitch},\"yaw\":{yaw},\"roll\":{roll}}},\
             \"simulated_physics_sleep\":{},\"rep_physics\":{},\
             \"server_frame\":{},\"server_physics_handle\":{}}}",
            VectorJson(&self.linear_velocity),
            OrNull(self.angular_velocity.as_ref().map(VectorJson)),
            VectorJson(&self.location),
            self.simulated_physics_sleep,
            self.rep_physics,
            OrNull(self.server_frame),
            OrNull(self.server_physics_handle),
        )
    }
}
