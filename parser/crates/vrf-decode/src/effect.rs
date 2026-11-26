//! Decoder for the shot-effect RepLayoutDynamicArray blobs: the RPC
//! parameters `FloatValues` (`EffectDataFloat`: ammo, projectile count, random
//! seed, tracer option, burst, yaw switch), `ObjectValues` (`EffectDataObject`:
//! firing player state, firing state, equippable) and `VectorValues`
//! (`EffectDataVector`: one attack direction per projectile).
//!
//! # Where this runs
//!
//! vrfkit calls [`decode_effect_blob_json`] for an RPC parameter with one of
//! those names the overlay left untyped (`sink/rpc.rs`) and for
//! `ServerActiveEffects`' `FloatValues` / `ObjectValues` members
//! (`sink/blobs.rs`), and puts the JSON into `value_str` **in addition to**
//! `raw_bits`. Like the type overlay it is additive: a failure leaves
//! `value_str` null, keeps the bits and counts. `tools/to_valplay_bundle.py`
//! reads its shot inputs from the raw bits, which the JSON leaves untouched.
//!
//! Where that Python port can return partial elements on malformed input, this
//! decoder rejects the whole array (underfilled member windows, missing or
//! nonzero terminators, repeated or descending element indices, residual bits).
//! On real blobs the two agree: 91,827 shot arrays from 13.01-13.05 matched in
//! structure, tag and bit pattern.
//!
//! # Wire layout (corpus-validated)
//!
//! ```text
//! [IntPacked: element_count]
//! repeat {
//!     [IntPacked: encoded_index]       // 0 = terminator, else index = encoded - 1
//!     repeat {                         // per element, until handle 0
//!         [IntPacked: encoded_handle]  // 0 = end, else handle = encoded - 1
//!         [IntPacked: payload_bits]
//!         [bits: payload]
//!     }
//! }
//! ```
//!
//! An element is a gameplay-tag index (IntPacked) and a value: an f32, an
//! IntPacked net GUID or three f64s, under a handle pair that depends on the
//! function ([`EffectHandles`](crate::effect::EffectHandles)). An independent
//! parser agrees on `02d4d478`'s 2,647 shots (floats at f32 precision, GUIDs
//! and f64 vectors exactly). Tag indices are replay-specific
//! (`NetworkGameplayTagNodeIndex`); the wiring layer resolves them to names
//! like `FiringState.AmmoRemaining`.
//!
//! Submodules: `framing` (the blob checks and
//! [`scan_element_handles`](crate::effect::scan_element_handles), which derives
//! the handle pair), `elements` (the element type and its decoders) and `json`
//! (the export's rendering).

mod elements;
mod framing;
mod json;
#[cfg(test)]
mod tests;

pub use elements::{
    EffectData, EffectDataFloat, EffectDataObject, EffectDataVector, decode_effect_floats,
    decode_effect_floats_at, decode_effect_objects, decode_effect_objects_at,
    decode_effect_vectors, decode_effect_vectors_at,
};
pub use framing::scan_element_handles;
pub use json::decode_effect_blob_json;

/// Errors that can occur while decoding an effect array blob.
#[derive(Debug, Clone, thiserror::Error)]
pub enum EffectBlobError {
    #[error("bit read: {0}")]
    BitIo(#[from] vrf_bitio::BitError),
    #[error("array count {count} exceeds maximum {max}")]
    ArrayCountTooLarge { count: u32, max: u32 },
    #[error("element index {index} >= declared count {count}")]
    IndexOutOfBounds { index: u32, count: u32 },
    /// A repeat would overwrite the earlier element; all 61,709 arrays on
    /// `02d4d478` ascend.
    #[error("element index {index} does not follow {previous}")]
    NonAscendingIndex { index: u32, previous: u32 },
    #[error("field payload {bits} bits exceeds remaining {remaining}")]
    PayloadTooLarge { bits: u32, remaining: u64 },
    /// A guard against endless field loops.
    #[error("too many fields in element ({context})")]
    TooManyFields { context: &'static str },
    #[error("declared {bits} bits but buffer holds {available}")]
    BitLengthExceedsBuffer { bits: u32, available: u64 },
    /// A blob in this format consumes its window exactly (all 61,617 on
    /// `02d4d478`); a payload that is not this format usually parses into
    /// something plausible and leaves a tail. A sub-byte tail counts too:
    /// `bit_count` is the declared payload length, padding excluded.
    #[error("{remaining} bits left after terminator")]
    ResidualBits { remaining: u64 },
    /// JSON has no literal for NaN or an infinity, and `null` or `0` would
    /// fabricate, so the blob is rejected.
    #[error("element {index} is a non-finite float")]
    NonFiniteFloat { index: usize },
    /// Checked before the read, which would otherwise run past a short field
    /// into the next.
    #[error("{context}: expected a {expected}-bit payload, found {found}")]
    UnexpectedPayloadWidth {
        context: &'static str,
        expected: u32,
        found: u32,
    },
    /// All 128,000 elements on `02d4d478` carry a tag and a value, and two is
    /// what makes the handle pair derivable.
    #[error("element has {found} field(s), expected 2")]
    ElementFieldCount { found: u32 },
    #[error("field handles {first} and {second} are not adjacent")]
    NonAdjacentHandles { first: u32, second: u32 },
    #[error("handle base {found} contradicts {expected} seen earlier")]
    InconsistentHandleBase { expected: u32, found: u32 },
    #[error("field declared {declared} bits but its type read {consumed}")]
    PayloadOverread { declared: u32, consumed: u64 },
    /// See `settle_field` in `effect/framing.rs`.
    #[error("field declared {declared} bits but its type read only {consumed}")]
    PayloadUnderread { declared: u32, consumed: u64 },
    /// The array is sparse, so without this check a truncated payload would
    /// render its missing elements as absent and pass for a complete one.
    #[error("{context} ended without its terminator")]
    MissingTerminator { context: &'static str },
    /// See `consume_trailing_terminator` in `effect/framing.rs`.
    #[error("trailing terminator byte is {value}, expected 0")]
    NonZeroTerminator { value: u32 },
}

pub type Result<T> = core::result::Result<T, EffectBlobError>;

/// The pair of RepLayout field handles an `FEffectData*` element uses: one for
/// the gameplay tag, one for the value.
///
/// Not a constant: Unreal numbers a dynamic array's element handles from the
/// array's own handle in the parent layout, so the same struct arrives under a
/// different pair in every function (tag bases 3 to 15 across ten functions on
/// `02d4d478`). One fixed pair decodes the others to all-`None`, or worse:
/// `MulticastUpdateContinuousEffect`'s float value sits at handle 7, the shot
/// RPC's tag slot, and read as a tag index. [`scan_element_handles`] derives
/// the pair from the blob instead.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EffectHandles {
    /// Handle of the `FGameplayTag` member. Always the lower of the two.
    pub tag: u32,
    /// Handle of the value member. Always `tag + 1`.
    pub value: u32,
}

impl EffectHandles {
    /// The pair whose tag member is at `base`; saturates rather than leave a
    /// debug-build overflow panic on the export path.
    #[must_use]
    pub const fn from_base(base: u32) -> Self {
        Self {
            tag: base,
            value: base.saturating_add(1),
        }
    }
}

/// The `FEffectData{Float,Object,Vector}` handles in
/// `ReplayPlayContinuousEffectAtLocation`, which the pinned vectors use.
const FLOAT_HANDLES: EffectHandles = EffectHandles::from_base(7);
const OBJECT_HANDLES: EffectHandles = EffectHandles::from_base(15);
const VECTOR_HANDLES: EffectHandles = EffectHandles::from_base(11);

/// Which `FEffectData*` element type a blob carries. The three share one
/// framing and differ only in the value decode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EffectArrayKind {
    /// `TArray<FEffectDataFloat>`, declared as `FloatValues`.
    Float,
    /// `TArray<FEffectDataObject>`, declared as `ObjectValues`.
    Object,
    /// `TArray<FEffectDataVector>`, declared as `VectorValues`.
    Vector,
}

impl EffectArrayKind {
    /// Map an RPC parameter's declared name to its element type, `None` for
    /// any other name. By name, not handle: the handle is the parameter's
    /// index within its function and differs across the ten functions.
    #[must_use]
    pub fn from_param_name(name: &str) -> Option<Self> {
        match name {
            "FloatValues" => Some(Self::Float),
            "ObjectValues" => Some(Self::Object),
            "VectorValues" => Some(Self::Vector),
            _ => None,
        }
    }
}
