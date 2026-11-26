//! The primitive decoders' tests, scalar and vector, and the overlay's. The
//! array, struct-blob and effect decoders keep their tests next to their own
//! modules.

#[cfg(feature = "overlay")]
mod blueprint_fields;
#[cfg(feature = "overlay")]
mod overlay;
mod scalar;
mod vector;

fn str_value(s: &str) -> crate::DecodedValue {
    crate::DecodedValue::Str(s.to_owned())
}
