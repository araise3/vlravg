//! A build's payload transform as data: the registry line's own grammar,
//! parsed at run time, so a new build needs one text line rather than a code
//! change (vlravg fork; `docs/replay-parser.md`).
//!
//! ```text
//! 0x2c24_9eb3 0x33: sub 8, not, rotl 6, swap, xor 3, not, sub 1
//! ```
//!
//! `SEED_ADDEND`, then the signed `INIT_A_OFFSET` (negative: subtracted), then
//! the step list. Every registered build fits one template: eight slots run
//! from 8 down to 1, and slot `k` holds nothing, `not`, `rev`, `swap`, `sbox`,
//! or one of `add`/`sub`/`xor`/`rotl`/`rotr` keyed by `k`. So keyed steps come
//! in strictly decreasing key order. [`TransformSpec::parse`] enforces that
//! template; the solver (`crate::solve`) searches exactly it.
//!
//! The interpreter here mirrors the `step!` macro in `lib.rs` operation for
//! operation; `tests::interpreter_matches_every_compiled_build` holds them equal.

use crate::helpers::{
    advance_state, initial_prng_a, initial_prng_b, read_u32, read_u64,
    reverse_bits64_without_final_16bit_swap, substitute_bytes_u32, substitute_bytes_u64,
    swap_adjacent_bits_u8, swap_adjacent_bits_u32, swap_adjacent_bits_u64, write_u32, write_u64,
};
use crate::sbox::{SBOX_8, SBOX_32, SBOX_64};
use vrf_bitio::{BitError, Result as BitResult};

/// One step of a transform. Keyed steps carry their key index (1..=8).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Op {
    Add(u8),
    Sub(u8),
    Xor(u8),
    Rotl(u8),
    Rotr(u8),
    Not,
    Rev,
    Swap,
    Sbox,
}

impl Op {
    /// The key index of a keyed step.
    #[must_use]
    pub const fn key(self) -> Option<u8> {
        match self {
            Self::Add(k) | Self::Sub(k) | Self::Xor(k) | Self::Rotl(k) | Self::Rotr(k) => Some(k),
            _ => None,
        }
    }

    #[inline(always)]
    #[must_use]
    pub fn word64(self, v: u64, s: u32) -> u64 {
        match self {
            Self::Add(k) => v.wrapping_add(u64::from(s.rotate_right(u32::from(k)))),
            Self::Sub(k) => v.wrapping_sub(u64::from(s.rotate_right(u32::from(k)))),
            Self::Xor(k) => v ^ !u64::from(s.rotate_right(u32::from(k))),
            Self::Rotl(k) => v.rotate_left(s.rotate_right(u32::from(k)) % 63 + 1),
            Self::Rotr(k) => v.rotate_right(s.rotate_right(u32::from(k)) % 63 + 1),
            Self::Not => !v,
            Self::Rev => reverse_bits64_without_final_16bit_swap(v),
            Self::Swap => swap_adjacent_bits_u64(v),
            Self::Sbox => substitute_bytes_u64(v, &SBOX_64),
        }
    }

    #[inline(always)]
    #[must_use]
    pub fn word32(self, v: u32, s: u32) -> u32 {
        match self {
            Self::Add(k) => v.wrapping_add(s.rotate_left(u32::from(k))),
            Self::Sub(k) => v.wrapping_sub(s.rotate_left(u32::from(k))),
            Self::Xor(k) => v ^ s.rotate_left(u32::from(k)),
            Self::Rotl(k) => v.rotate_left(s.rotate_left(u32::from(k)) % 31 + 1),
            Self::Rotr(k) => v.rotate_right(s.rotate_left(u32::from(k)) % 31 + 1),
            Self::Not => !v,
            Self::Rev => v.reverse_bits(),
            Self::Swap => swap_adjacent_bits_u32(v),
            Self::Sbox => substitute_bytes_u32(v, &SBOX_32),
        }
    }

    #[inline(always)]
    #[must_use]
    pub fn byte(self, v: u8, s: u32) -> u8 {
        let key = |k: u8| s.wrapping_mul(11u32.pow(u32::from(k)));
        match self {
            Self::Add(k) => v.wrapping_add(key(k) as u8),
            Self::Sub(k) => v.wrapping_sub(key(k) as u8),
            Self::Xor(k) => v ^ key(k) as u8,
            Self::Rotl(k) => v.rotate_left(key(k) % 7 + 1),
            Self::Rotr(k) => v.rotate_right(key(k) % 7 + 1),
            Self::Not => !v,
            Self::Rev => v.reverse_bits(),
            Self::Swap => swap_adjacent_bits_u8(v),
            Self::Sbox => SBOX_8[v as usize],
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Add(_) => "add",
            Self::Sub(_) => "sub",
            Self::Xor(_) => "xor",
            Self::Rotl(_) => "rotl",
            Self::Rotr(_) => "rotr",
            Self::Not => "not",
            Self::Rev => "rev",
            Self::Swap => "swap",
            Self::Sbox => "sbox",
        }
    }
}

/// Most steps a template line can hold: one per slot.
pub const MAX_OPS: usize = 8;

/// One build's transform, as data.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TransformSpec {
    pub seed_addend: u32,
    /// Signed `INIT_A_OFFSET`: positive is added, negative subtracted.
    pub init_a_offset: i32,
    ops: [Op; MAX_OPS],
    len: u8,
}

/// Why a registry line did not parse.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpecError(pub String);

impl core::fmt::Display for SpecError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "invalid transform line: {}", self.0)
    }
}

impl core::error::Error for SpecError {}

fn parse_hex(text: &str) -> Option<u64> {
    let digits = text.strip_prefix("0x")?.replace('_', "");
    if digits.is_empty() {
        return None;
    }
    u64::from_str_radix(&digits, 16).ok()
}

impl TransformSpec {
    /// Build a spec, checking the slot template.
    pub fn new(seed_addend: u32, init_a_offset: i32, ops: &[Op]) -> Result<Self, SpecError> {
        if ops.is_empty() || ops.len() > MAX_OPS {
            return Err(SpecError(format!("{} steps (1..=8 allowed)", ops.len())));
        }
        if !(-127..=127).contains(&init_a_offset) {
            return Err(SpecError(format!("offset {init_a_offset} out of range")));
        }
        // Slot template: each step takes the next slot down; a keyed step's
        // slot is its key, so keys strictly decrease and leave room for the
        // steps after them.
        let mut next_slot = MAX_OPS as i32;
        for (i, op) in ops.iter().enumerate() {
            let slot = match op.key() {
                Some(k) if (1..=8).contains(&k) && i32::from(k) <= next_slot => i32::from(k),
                Some(k) => return Err(SpecError(format!("key {k} breaks the slot order"))),
                None => next_slot,
            };
            let after = (ops.len() - i - 1) as i32;
            if slot - 1 < after {
                return Err(SpecError("more steps than slots".into()));
            }
            next_slot = slot - 1;
        }
        let mut stored = [Op::Not; MAX_OPS];
        stored[..ops.len()].copy_from_slice(ops);
        Ok(Self {
            seed_addend,
            init_a_offset,
            ops: stored,
            len: ops.len() as u8,
        })
    }

    /// Parse `0xADDEND [-]0xOFFSET: step, step, ...`.
    pub fn parse(line: &str) -> Result<Self, SpecError> {
        let err = |m: &str| SpecError(format!("{m}: '{line}'"));
        let (head, steps) = line.split_once(':').ok_or_else(|| err("missing ':'"))?;
        let mut head = head.split_whitespace();
        let addend = head
            .next()
            .and_then(parse_hex)
            .filter(|v| *v <= u64::from(u32::MAX))
            .ok_or_else(|| err("bad addend"))? as u32;
        let offset_text = head.next().ok_or_else(|| err("missing offset"))?;
        if head.next().is_some() {
            return Err(err("trailing text before ':'"));
        }
        let (negative, magnitude) = match offset_text.strip_prefix('-') {
            Some(rest) => (true, rest),
            None => (false, offset_text),
        };
        let magnitude = parse_hex(magnitude)
            .filter(|v| *v <= 127)
            .ok_or_else(|| err("bad offset"))? as i32;
        let offset = if negative { -magnitude } else { magnitude };
        let mut ops = Vec::new();
        for step in steps.trim().trim_end_matches(';').split(',') {
            let mut words = step.split_whitespace();
            let name = words.next().ok_or_else(|| err("empty step"))?;
            let key = words.next();
            if words.next().is_some() {
                return Err(err("step has extra words"));
            }
            let keyed = |make: fn(u8) -> Op| -> Result<Op, SpecError> {
                let k = key
                    .and_then(|k| k.parse::<u8>().ok())
                    .ok_or_else(|| err("keyed step needs a key 1..=8"))?;
                Ok(make(k))
            };
            let unkeyed = |op: Op| -> Result<Op, SpecError> {
                if key.is_some() {
                    return Err(err("unkeyed step takes no key"));
                }
                Ok(op)
            };
            ops.push(match name {
                "add" => keyed(Op::Add)?,
                "sub" => keyed(Op::Sub)?,
                "xor" => keyed(Op::Xor)?,
                "rotl" => keyed(Op::Rotl)?,
                "rotr" => keyed(Op::Rotr)?,
                "not" => unkeyed(Op::Not)?,
                "rev" => unkeyed(Op::Rev)?,
                "swap" => unkeyed(Op::Swap)?,
                "sbox" => unkeyed(Op::Sbox)?,
                other => return Err(err(&format!("unknown step '{other}'"))),
            });
        }
        Self::new(addend, offset, &ops).map_err(|e| err(&e.0))
    }

    #[must_use]
    pub fn ops(&self) -> &[Op] {
        &self.ops[..usize::from(self.len)]
    }

    #[inline]
    #[must_use]
    pub fn tail_xor(&self) -> u8 {
        self.seed_addend as u8
    }

    #[inline]
    #[must_use]
    pub fn initial_prng_a(&self, seed: u32) -> u64 {
        initial_prng_a(
            seed,
            self.seed_addend,
            self.init_a_offset.unsigned_abs(),
            self.init_a_offset > 0,
        )
    }

    #[inline]
    #[must_use]
    pub fn word64(&self, mut v: u64, s: u32) -> u64 {
        for op in self.ops() {
            v = op.word64(v, s);
        }
        v
    }

    #[inline]
    #[must_use]
    pub fn word32(&self, mut v: u32, s: u32) -> u32 {
        for op in self.ops() {
            v = op.word32(v, s);
        }
        v
    }

    #[inline]
    #[must_use]
    pub fn byte(&self, mut v: u8, s: u32) -> u8 {
        for op in self.ops() {
            v = op.byte(v, s);
        }
        v
    }

    /// The staging loop of [`crate::transform_in_place`], driven by this spec.
    pub fn apply(&self, buf: &mut [u8], bit_count: usize, seed: u32) -> BitResult<()> {
        if bit_count == 0 {
            return Ok(());
        }
        let available = (buf.len() as u64).saturating_mul(8);
        if bit_count as u64 > available {
            return Err(BitError::InvalidBitLength {
                requested: bit_count as u64,
                available,
            });
        }
        let mut state = seed;
        let mut stream_byte = seed as u8;
        let mut prng_a = self.initial_prng_a(seed);
        let mut prng_b = initial_prng_b(seed);
        let mut offset = 0usize;
        let mut left = bit_count;
        while left > 63 {
            let value = self.word64(read_u64(buf, offset), state);
            write_u64(buf, offset, value);
            stream_byte = advance_state(&mut state, &mut prng_a, &mut prng_b);
            offset += 8;
            left -= 64;
        }
        while left > 31 {
            let value = self.word32(read_u32(buf, offset), state);
            write_u32(buf, offset, value);
            stream_byte = advance_state(&mut state, &mut prng_a, &mut prng_b);
            offset += 4;
            left -= 32;
        }
        while left > 7 {
            buf[offset] = self.byte(buf[offset], state);
            stream_byte = advance_state(&mut state, &mut prng_a, &mut prng_b);
            offset += 1;
            left -= 8;
        }
        if left != 0 {
            let mask = 0xffu8 >> (7 - ((bit_count - 1) & 7));
            buf[offset] ^= mask & (stream_byte ^ self.tail_xor());
        }
        Ok(())
    }
}

impl core::fmt::Display for TransformSpec {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        let addend = self.seed_addend;
        write!(f, "0x{:04x}_{:04x} ", addend >> 16, addend & 0xffff)?;
        let sign = if self.init_a_offset < 0 { "-" } else { "" };
        write!(f, "{sign}0x{:02x}:", self.init_a_offset.unsigned_abs())?;
        for (i, op) in self.ops().iter().enumerate() {
            let sep = if i == 0 { " " } else { ", " };
            match op.key() {
                Some(k) => write!(f, "{sep}{} {k}", op.name())?,
                None => write!(f, "{sep}{}", op.name())?,
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ALL_VERSIONS, TransformVersion};

    /// The compiled registry, as `lib.rs` spells it.
    fn compiled_lines() -> Vec<(TransformVersion, TransformSpec)> {
        let source = include_str!("lib.rs");
        let mut out = Vec::new();
        for line in source.lines() {
            let line = line.trim();
            let Some(rest) = line.strip_prefix('V') else { continue };
            let mut parts = rest.splitn(4, ' ');
            let (Some(_variant), Some(_name), Some(build), Some(spec)) =
                (parts.next(), parts.next(), parts.next(), parts.next())
            else {
                continue;
            };
            if !build.starts_with('"') {
                continue;
            }
            let branch = format!("++Ares-Core+release-{}", build.trim_matches('"'));
            let version = TransformVersion::from_branch(&branch).expect("compiled build");
            out.push((version, TransformSpec::parse(spec).expect(spec)));
        }
        out
    }

    #[test]
    fn compiled_specs_equal_their_source_lines() {
        for (version, spec) in compiled_lines() {
            assert_eq!(version.spec(), spec, "{version:?}");
        }
    }

    #[test]
    fn every_compiled_line_parses_and_round_trips() {
        let lines = compiled_lines();
        assert_eq!(lines.len(), ALL_VERSIONS.len());
        for (_, spec) in &lines {
            assert_eq!(TransformSpec::parse(&spec.to_string()).unwrap(), *spec);
        }
    }

    #[test]
    fn interpreter_matches_every_compiled_build() {
        let mut x: u64 = 0x9e37_79b9_7f4a_7c15;
        let mut next = || {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x
        };
        for (version, spec) in compiled_lines() {
            for bits in [1usize, 7, 8, 9, 15, 31, 32, 33, 63, 64, 65, 100, 127, 128, 300, 777] {
                for _ in 0..20 {
                    let seed = next() as u32;
                    let mut a: Vec<u8> = (0..bits.div_ceil(8)).map(|_| next() as u8).collect();
                    let mut b = a.clone();
                    version.apply(&mut a, bits, seed).unwrap();
                    spec.apply(&mut b, bits, seed).unwrap();
                    assert_eq!(a, b, "{version:?} bits={bits} seed={seed:#x}");
                }
            }
        }
    }

    /// The solved 13.10 line computes the function of upstream's spelling.
    #[test]
    fn solved_1310_equals_upstreams_spelling() {
        let solved = TransformSpec::parse("0x2c24_9eb3 0x33: sub 8, rotl 6, swap, xor 3, sub 1").unwrap();
        let upstream =
            TransformSpec::parse("0x2c24_9eb3 0x33: sub 8, not, rotl 6, swap, xor 3, not, sub 1").unwrap();
        let mut x: u64 = 0x1310;
        let mut next = || {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x
        };
        for bits in [1usize, 7, 8, 9, 15, 31, 32, 33, 63, 64, 65, 72, 127, 128, 999] {
            for _ in 0..200 {
                let seed = next() as u32;
                let mut a: Vec<u8> = (0..bits.div_ceil(8)).map(|_| next() as u8).collect();
                let mut b = a.clone();
                solved.apply(&mut a, bits, seed).unwrap();
                upstream.apply(&mut b, bits, seed).unwrap();
                assert_eq!(a, b, "bits={bits} seed={seed:#x}");
            }
        }
    }

    #[test]
    fn template_violations_are_refused() {
        for bad in [
            "0x1 0x0: add 3, sub 5",
            "0x1 0x0: add 9",
            "0x1 0x0: not, not, not, not, not, not, not, not, not",
            "0x1 0x0: add 1, not",
            "0x1 0x0: frob",
            "0x1 0x80: not",
            "0x1 0x0 x: not",
            "0x1 0x0: not 3",
        ] {
            assert!(TransformSpec::parse(bad).is_err(), "{bad}");
        }
        assert!(TransformSpec::parse("0x2c24_9eb3 0x33: sub 8, not, rotl 6, swap, xor 3, not, sub 1").is_ok());
    }
}
