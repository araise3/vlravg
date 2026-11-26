//! Recover a build's payload transform from its own replay (vlravg fork).
//!
//! No game code is run or emulated: the only input is a replay's still-encoded
//! RepLayout content blocks (header-plaintext framing gives each block's bit
//! count and actor GUID, hence its seed). The RepLayout grammar is the oracle:
//!
//! ```text
//! checksum: 1 bit
//! loop { handle: IntPacked (0 ends), bits: IntPacked, payload: bits }
//! ```
//!
//! **Stage A, the step list.** The first stage of every block (its first
//! 64-bit word, 32-bit word or byte) is keyed by the seed alone; the PRNG,
//! and with it `SEED_ADDEND` and `INIT_A_OFFSET`, only keys later stages. So
//! the step list can be searched on first stages without them. The search
//! space is the slot template ([`crate::spec`]): eight slots, ten choices
//! each, 10^8 lists. A list is kept when the records it decodes fit their
//! blocks; wrong lists decode noise, which rarely does.
//!
//! **Stage B, the PRNG constants.** With the steps known, a block whose
//! decoded records end exactly 8 bits before its end must finish with the
//! zero terminator, so those 8 bits are known plaintext in a later stage.
//! Only the low 7 bits of `seed ± offset` reach the PRNG (it is multiplied by
//! 2^25 in 32 bits), so offset and sign fold into `c` in 0..128, and
//! `addend x c` is 2^39 candidates, tested against those known bits.
//!
//! Every result is a candidate until the full decode passes: the caller must
//! re-run the whole stream through it (`vrfkit solve` runs `validate`).

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use crate::helpers::{MULTIPLIER, advance_state, initial_prng_b, read_u32, read_u64};
use crate::spec::{MAX_OPS, Op, TransformSpec};

/// One still-encoded RepLayout content block.
#[derive(Debug, Clone)]
pub struct Block {
    pub seed: u32,
    pub bit_count: u32,
    /// The payload bits LSB-first, as `BitReader::copy_bits_to` writes them.
    pub bytes: Vec<u8>,
}

/// Tunables; the defaults are what `vrfkit solve` uses.
#[derive(Debug, Clone)]
pub struct Options {
    pub threads: usize,
    /// Report progress lines through this callback.
    pub log: fn(&str),
}

impl Default for Options {
    fn default() -> Self {
        Self {
            threads: std::thread::available_parallelism().map_or(4, usize::from),
            log: |m| eprintln!("{m}"),
        }
    }
}

/// What a solve found.
#[derive(Debug, Clone)]
pub struct Outcome {
    /// Candidates that passed stage B, best first.
    pub candidates: Vec<Scored>,
    /// Step lists that survived stage A, one per function.
    pub step_lists: Vec<Vec<Op>>,
    pub probes_used: usize,
}

/// A full candidate and the share of sampled blocks it decodes into a walk.
#[derive(Debug, Clone)]
pub struct Scored {
    pub spec: TransformSpec,
    pub walked: u64,
    pub sampled: u64,
}

/// Why a solve stopped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SolveError {
    TooFewBlocks(&'static str, usize),
    NoStepList,
    NoProbes,
}

impl core::fmt::Display for SolveError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::TooFewBlocks(what, n) => write!(f, "too few {what} blocks ({n})"),
            Self::NoStepList => write!(f, "no step list in the slot template fits the blocks"),
            Self::NoProbes => write!(f, "no block gives known plaintext past its first stage"),
        }
    }
}

impl core::error::Error for SolveError {}

// ---------------------------------------------------------------------------
// Bit-level grammar over a known plaintext prefix

/// IntPacked over the plaintext bits `[pos, known)` of `bits` (LSB-first).
/// `None`: the value runs past the known bits. `Some(Err)`: malformed.
#[inline]
fn int_packed(bits: u128, pos: &mut u32, known: u32) -> Option<Result<u32, ()>> {
    let mut value: u64 = 0;
    for group in 0..5 {
        if *pos + 8 > known {
            return None;
        }
        let byte = ((bits >> *pos) & 0xff) as u64;
        *pos += 8;
        value |= (byte >> 1) << (7 * group);
        if byte & 1 == 0 {
            return Some(if value > u64::from(u32::MAX) { Err(()) } else { Ok(value as u32) });
        }
    }
    Some(Err(()))
}

/// Largest handle a record may carry before the walk calls it noise. Real
/// streams stay far below; see `docs/replay-parser.md` for the measurement.
const MAX_HANDLE: u32 = 4096;

/// Walk the records whose headers lie inside the `known` plaintext bits of a
/// `bit_count`-bit block. `Ok(Some(e))`: the walk ended at a record end `e`
/// with the next header out of reach; `Ok(None)`: it reached a terminator or
/// the known bits ran out mid-header. `Err`: the bits cannot be RepLayout.
#[inline]
fn walk_prefix(bits: u128, known: u32, bit_count: u32) -> Result<Option<u32>, ()> {
    let mut pos = 1u32; // checksum bit
    loop {
        let start = pos;
        let handle = match int_packed(bits, &mut pos, known) {
            None => return Ok(Some(start)),
            Some(Err(())) => return Err(()),
            Some(Ok(h)) => h,
        };
        if handle == 0 {
            return if start + 8 <= bit_count { Ok(None) } else { Err(()) };
        }
        if handle > MAX_HANDLE {
            return Err(());
        }
        let len = match int_packed(bits, &mut pos, known) {
            None => return Ok(None),
            Some(Err(())) => return Err(()),
            Some(Ok(l)) => l,
        };
        if u64::from(pos) + u64::from(len) > u64::from(bit_count) {
            return Err(());
        }
        pos += len;
        if pos >= known {
            return Ok(Some(pos));
        }
    }
}

// ---------------------------------------------------------------------------
// Stage A

/// The ten choices of slot `k`; index 0 is an empty slot.
fn slot_choice(k: u8, i: u8) -> Option<Op> {
    match i {
        0 => None,
        1 => Some(Op::Not),
        2 => Some(Op::Rev),
        3 => Some(Op::Swap),
        4 => Some(Op::Sbox),
        5 => Some(Op::Add(k)),
        6 => Some(Op::Sub(k)),
        7 => Some(Op::Xor(k)),
        8 => Some(Op::Rotl(k)),
        _ => Some(Op::Rotr(k)),
    }
}

/// The step list for candidate index `n` in 0..10^8 (slot 8 is the top digit).
fn chain_for(mut n: u32) -> ([Option<Op>; MAX_OPS], usize) {
    let mut digits = [0u8; MAX_OPS];
    for d in digits.iter_mut().rev() {
        *d = (n % 10) as u8;
        n /= 10;
    }
    let mut ops = [None; MAX_OPS];
    let mut len = 0;
    for (slot, d) in digits.iter().enumerate() {
        let k = (MAX_OPS - slot) as u8;
        if let Some(op) = slot_choice(k, *d) {
            ops[len] = Some(op);
            len += 1;
        }
    }
    (ops, len)
}

#[inline]
fn chain64(ops: &[Option<Op>], mut v: u64, s: u32) -> u64 {
    for op in ops.iter().flatten() {
        v = op.word64(v, s);
    }
    v
}

#[inline]
fn chain32(ops: &[Op], mut v: u32, s: u32) -> u32 {
    for op in ops {
        v = op.word32(v, s);
    }
    v
}

#[inline]
fn chain8(ops: &[Op], mut v: u8, s: u32) -> u8 {
    for op in ops {
        v = op.byte(v, s);
    }
    v
}

struct Word64 {
    seed: u32,
    word: u64,
    bit_count: u32,
}

/// Search the template for step lists whose first-word decode fits.
fn stage_a(blocks: &[Block], opts: &Options) -> Result<Vec<Vec<Op>>, SolveError> {
    let mut tests: Vec<Word64> = blocks
        .iter()
        .filter(|b| b.bit_count >= 64)
        .map(|b| Word64 {
            seed: b.seed,
            word: read_u64(&b.bytes, 0),
            bit_count: b.bit_count,
        })
        .collect();
    if tests.len() < 256 {
        return Err(SolveError::TooFewBlocks("64-bit", tests.len()));
    }
    // Short blocks bound the record lengths tightest; spread the rest.
    tests.sort_by_key(|t| (t.bit_count.min(512), t.seed));
    let step = (tests.len() / 4096).max(1);
    let tests: Vec<Word64> = tests.into_iter().step_by(step).take(4096).collect();
    let quick = 64.min(tests.len());

    let survivors = Mutex::new(Vec::new());
    let next = AtomicU64::new(0);
    let total: u64 = 100_000_000;
    let jobs = 1000u64;
    std::thread::scope(|scope| {
        for _ in 0..opts.threads {
            scope.spawn(|| {
                loop {
                    let job = next.fetch_add(1, Ordering::Relaxed);
                    if job >= jobs {
                        return;
                    }
                    let lo = job * (total / jobs);
                    for n in lo..lo + total / jobs {
                        let (ops, len) = chain_for(n as u32);
                        if len == 0 {
                            continue;
                        }
                        let ops = &ops[..len];
                        let mut fails = 0;
                        for t in &tests[..quick] {
                            let w = chain64(ops, t.word, t.seed);
                            if walk_prefix(u128::from(w), 64, t.bit_count).is_err() {
                                fails += 1;
                                if fails > 3 {
                                    break;
                                }
                            }
                        }
                        if fails > 3 {
                            continue;
                        }
                        let passed = tests
                            .iter()
                            .filter(|t| {
                                let w = chain64(ops, t.word, t.seed);
                                walk_prefix(u128::from(w), 64, t.bit_count).is_ok()
                            })
                            .count();
                        if passed * 100 >= tests.len() * 97 {
                            let list: Vec<Op> = ops.iter().flatten().copied().collect();
                            survivors.lock().unwrap().push((list, passed));
                        }
                    }
                }
            });
        }
    });
    let survivors = survivors.into_inner().unwrap();
    (opts.log)(&format!(
        "stage A: {} step lists fit {} first words",
        survivors.len(),
        tests.len()
    ));

    // The narrower stages: a 32-bit first word, and the byte of a block too
    // short to hold a record (so its bits 1..=7 open the zero terminator).
    let words32: Vec<(u32, u32, u32)> = blocks
        .iter()
        .filter(|b| (32..64).contains(&b.bit_count))
        .take(4096)
        .map(|b| (b.seed, read_u32(&b.bytes, 0), b.bit_count))
        .collect();
    let bytes8: Vec<(u32, u8)> = blocks
        .iter()
        .filter(|b| (9..25).contains(&b.bit_count))
        .take(4096)
        .map(|b| (b.seed, b.bytes[0]))
        .collect();
    let mut kept: Vec<(Vec<Op>, usize)> = Vec::new();
    for (list, passed64) in survivors {
        let ok32 = words32
            .iter()
            .filter(|(s, w, n)| walk_prefix(u128::from(chain32(&list, *w, *s)), 32, *n).is_ok())
            .count();
        let ok8 = bytes8
            .iter()
            .filter(|(s, b)| chain8(&list, *b, *s) & 0xfe == 0)
            .count();
        let fits = |ok: usize, n: usize| n == 0 || ok * 100 >= n * 97;
        if fits(ok32, words32.len()) && fits(ok8, bytes8.len()) {
            kept.push((list, passed64 + ok32 + ok8));
        }
    }
    (opts.log)(&format!(
        "stage A: {} after the 32-bit ({}) and byte ({}) checks",
        kept.len(),
        words32.len(),
        bytes8.len()
    ));

    // One list per function: equal on random inputs at all three widths.
    let mut x: u64 = 0x243f_6a88_85a3_08d3;
    let mut rng = move || {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        x
    };
    let probes: Vec<(u64, u32)> = (0..64).map(|_| (rng(), rng() as u32)).collect();
    let mut seen: HashMap<Vec<u64>, usize> = HashMap::new();
    let mut lists: Vec<(Vec<Op>, usize)> = Vec::new();
    kept.sort_by_key(|(l, score)| (usize::MAX - score, l.len()));
    for (list, score) in kept {
        let print: Vec<u64> = probes
            .iter()
            .flat_map(|&(v, s)| {
                let opts: Vec<Option<Op>> = list.iter().copied().map(Some).collect();
                [
                    chain64(&opts, v, s),
                    u64::from(chain32(&list, v as u32, s)),
                    u64::from(chain8(&list, v as u8, s)),
                ]
            })
            .collect();
        if let Some(&i) = seen.get(&print) {
            if list.len() < lists[i].0.len() {
                lists[i].0 = list;
            }
            continue;
        }
        seen.insert(print, lists.len());
        lists.push((list, score));
    }
    if lists.is_empty() {
        return Err(SolveError::NoStepList);
    }
    Ok(lists.into_iter().map(|(l, _)| l).collect())
}

// ---------------------------------------------------------------------------
// Stage B

/// Known plaintext in one later stage of one block.
#[derive(Debug, Clone, Copy)]
struct Probe {
    seed: u32,
    prng_b: u64,
    /// PRNG advances before the stage (1 = the second stage).
    stage: u32,
    kind: ProbeKind,
}

#[derive(Debug, Clone, Copy)]
enum ProbeKind {
    /// The final 1..=7 bits: `(ct ^ stream ^ addend_lo) & mask == 0`.
    Tail { ct: u8, mask: u8 },
    /// A whole byte stage that must decode to zero.
    Byte { ct: u8 },
}

impl Probe {
    fn bits(&self) -> u32 {
        match self.kind {
            ProbeKind::Tail { mask, .. } => mask.count_ones(),
            ProbeKind::Byte { .. } => 8,
        }
    }
}

/// Where each stage of a `bit_count`-bit block starts: (offset bits, width).
fn stages(bit_count: u32) -> Vec<(u32, u32)> {
    let mut out = Vec::new();
    let (mut off, mut left) = (0u32, bit_count);
    for width in [64u32, 32, 8] {
        while left >= width {
            out.push((off, width));
            off += width;
            left -= width;
        }
    }
    if left != 0 {
        out.push((off, left));
    }
    out
}

/// Probes from blocks whose decoded records end 8 bits before the block does.
fn probes_for(list: &[Op], blocks: &[Block]) -> Vec<Probe> {
    let opts: Vec<Option<Op>> = list.iter().copied().map(Some).collect();
    let mut out = Vec::new();
    for b in blocks {
        let n = b.bit_count;
        let st = stages(n);
        if st.len() < 2 {
            continue;
        }
        let (_, w0) = st[0];
        let (plain, known): (u128, u32) = match w0 {
            64 => (u128::from(chain64(&opts, read_u64(&b.bytes, 0), b.seed)), 64),
            32 => (u128::from(chain32(list, read_u32(&b.bytes, 0), b.seed)), 32),
            _ => (u128::from(chain8(list, b.bytes[0], b.seed)), 8),
        };
        // Where the terminator must start.
        let end = if n < 25 {
            // No room for a record: the terminator opens the stream.
            if plain & 0xfe != 0 {
                continue;
            }
            1
        } else {
            match walk_prefix(plain, known, n) {
                Ok(Some(e)) => e,
                _ => continue,
            }
        };
        if n - end != 8 && !(n < 25 && end == 1) {
            continue;
        }
        // Known zeros run over [end, end + 8) and must agree inside the first stage.
        let zero_hi = end + 8;
        if end < known {
            let width = (known - end).min(8);
            if (plain >> end) & ((1u128 << width) - 1) != 0 {
                continue;
            }
        }
        let seed = b.seed;
        let prng_b = initial_prng_b(seed);
        for (i, &(off, width)) in st.iter().enumerate().skip(1) {
            let byte = b.bytes[(off / 8) as usize];
            if width < 8 {
                // The tail: only its bits inside the known zeros count.
                let mut mask = 0u8;
                for bit in 0..width {
                    let at = off + bit;
                    if at >= end && at < zero_hi {
                        mask |= 1 << bit;
                    }
                }
                if mask != 0 {
                    out.push(Probe {
                        seed,
                        prng_b,
                        stage: i as u32,
                        kind: ProbeKind::Tail { ct: byte & mask, mask },
                    });
                }
            } else if width == 8 && off >= end && off + 8 <= zero_hi {
                out.push(Probe {
                    seed,
                    prng_b,
                    stage: i as u32,
                    kind: ProbeKind::Byte { ct: byte },
                });
            }
        }
    }
    out
}

/// `prng_a` for `seed`, `addend` and the folded offset `c`.
#[inline(always)]
fn prng_a(seed: u32, addend: u32, c: u32) -> u64 {
    let seed_plus = seed.wrapping_add(addend);
    let offset_term = seed.wrapping_add(c).wrapping_mul(0x0200_0000);
    let mixed = (((seed_plus >> 15) ^ seed_plus) >> 12) ^ offset_term ^ seed_plus;
    u64::from(mixed).wrapping_mul(MULTIPLIER)
}

#[inline(always)]
fn probe_holds(p: &Probe, list: &[Op], addend: u32, c: u32) -> bool {
    let mut a = prng_a(p.seed, addend, c);
    let mut b = p.prng_b;
    let mut state = p.seed;
    let mut stream = 0u8;
    if p.stage == 1 {
        // The first advance's output is the lane sum's high half alone.
        state = (b.wrapping_add(a) >> 32) as u32;
        stream = state as u8;
    } else {
        for _ in 0..p.stage {
            stream = advance_state(&mut state, &mut a, &mut b);
        }
    }
    match p.kind {
        ProbeKind::Tail { ct, mask } => (ct ^ stream ^ addend as u8) & mask == 0,
        ProbeKind::Byte { ct } => chain8(list, ct, state) == 0,
    }
}

/// A second-stage tail probe, prepared for [`scan_offsets`].
#[derive(Clone, Copy)]
struct FastTail {
    seed: u32,
    prng_b: u64,
    ct: u8,
    mask: u8,
}

impl FastTail {
    fn new(p: &Probe) -> Option<Self> {
        match p.kind {
            ProbeKind::Tail { ct, mask } if p.stage == 1 => Some(Self {
                seed: p.seed,
                prng_b: p.prng_b,
                ct,
                mask,
            }),
            _ => None,
        }
    }
}

/// Every offset `c` for which `addend` passes the probe, in one pass.
///
/// The offset reaches the PRNG only through bits 25..=31 of the mixed seed,
/// `mixed = x ^ (((seed + c) & 127) << 25)`. With `y` those seven bits,
/// `prng_a = (x & 0x1ff_ffff) * M + y * (M << 25)`, so the 128 offsets of one
/// addend are 128 steps of one addition, and `c = ((y ^ x >> 25) - seed) & 127`.
#[inline(always)]
fn scan_offsets(p: &FastTail, addend: u32, hits: &mut Vec<u32>) {
    let seed_plus = p.seed.wrapping_add(addend);
    let x = (((seed_plus >> 15) ^ seed_plus) >> 12) ^ seed_plus;
    let base = p
        .prng_b
        .wrapping_add(u64::from(x & 0x01ff_ffff).wrapping_mul(MULTIPLIER));
    let step = MULTIPLIER.wrapping_shl(25);
    let target = p.ct ^ addend as u8;
    // Four interleaved lanes, additions only, so the loop pipelines (and
    // vectorises where the target allows).
    let mut lanes = [
        base,
        base.wrapping_add(step),
        base.wrapping_add(step.wrapping_mul(2)),
        base.wrapping_add(step.wrapping_mul(3)),
    ];
    let step4 = step.wrapping_mul(4);
    let mut pass = [0u64; 2];
    for word in &mut pass {
        for i in (0..64u32).step_by(4) {
            let mut bits = 0u64;
            for (j, lane) in lanes.iter_mut().enumerate() {
                let state = (*lane >> 32) as u8;
                bits |= u64::from((state ^ target) & p.mask == 0) << j;
                *lane = lane.wrapping_add(step4);
            }
            *word |= bits << i;
        }
    }
    for (half, mut word) in pass.into_iter().enumerate() {
        while word != 0 {
            let y = word.trailing_zeros() + 64 * half as u32;
            word &= word - 1;
            hits.push(((y ^ (x >> 25)).wrapping_sub(p.seed)) & 127);
        }
    }
}

/// The signed offset that `c` folds.
fn offset_for(c: u32) -> i32 {
    if c < 64 { c as i32 } else { -((128 - c) as i32) }
}

fn stage_b(list: &[Op], blocks: &[Block], opts: &Options) -> Result<(Vec<TransformSpec>, usize), SolveError> {
    let mut probes = probes_for(list, blocks);
    if probes.is_empty() {
        return Err(SolveError::NoProbes);
    }
    // Cheap and sharp first: a second-stage tail (the fast scan), then few
    // advances and many bits. Duplicate seeds add nothing.
    probes.sort_by_key(|p| {
        let tail1 = p.stage == 1 && matches!(p.kind, ProbeKind::Tail { .. });
        (!tail1, p.stage, 8 - p.bits())
    });
    let mut seen = HashSet::new();
    probes.retain(|p| seen.insert((p.seed, p.stage)));
    let bits: u32 = probes.iter().map(Probe::bits).sum();
    (opts.log)(&format!(
        "stage B: {} probes, {bits} known bits, steps [{}]",
        probes.len(),
        list.iter().map(|o| format!("{o:?}")).collect::<Vec<_>>().join(", ")
    ));
    let probes = &probes[..probes.len().min(4096)];

    let found = Mutex::new(Vec::new());
    let next = AtomicU64::new(0);
    let stop = AtomicBool::new(false);
    // Jobs: 2^15 slices of 2^17 addends, each with all 128 offsets.
    let jobs: u64 = 1 << 15;
    let fast_first = FastTail::new(&probes[0]);
    let done = AtomicU64::new(0);
    std::thread::scope(|scope| {
        for _ in 0..opts.threads {
            scope.spawn(|| {
                loop {
                    if stop.load(Ordering::Relaxed) {
                        return;
                    }
                    let job = next.fetch_add(1, Ordering::Relaxed);
                    if job >= jobs {
                        return;
                    }
                    let first = &probes[0];
                    let mut hits = Vec::new();
                    // `fast`: every offset of one addend in one pass (see `scan_offsets`).
                    let lo = (job as u32) << 17;
                    for addend in lo..lo + (1 << 17) {
                        if let Some(fast) = fast_first {
                            scan_offsets(&fast, addend, &mut hits);
                        } else {
                            hits.extend((0..128).filter(|&c| probe_holds(first, list, addend, c)));
                        }
                        for c in hits.drain(..) {
                            if probes.iter().all(|p| probe_holds(p, list, addend, c)) {
                                let spec = TransformSpec::new(addend, offset_for(c), list)
                                    .expect("search stays in the template");
                                found.lock().unwrap().push(spec);
                            }
                        }
                    }
                    let finished = done.fetch_add(1, Ordering::Relaxed) + 1;
                    if finished % 4096 == 0 {
                        (opts.log)(&format!("stage B: {finished}/{jobs}"));
                    }
                    if found.lock().unwrap().len() > 64 {
                        stop.store(true, Ordering::Relaxed);
                    }
                }
            });
        }
    });
    Ok((found.into_inner().unwrap(), probes.len()))
}

// ---------------------------------------------------------------------------
// Scoring

/// Whether a decoded block walks as RepLayout to its end.
fn walks(plain: &[u8], bit_count: u32) -> bool {
    let bit = |i: u32| (plain[(i / 8) as usize] >> (i % 8)) & 1;
    let read8 = |pos: u32| -> u32 { (0..8).map(|i| u32::from(bit(pos + i)) << i).sum() };
    let mut pos = 1u32;
    while pos < bit_count {
        let read_ip = |pos: &mut u32| -> Option<u32> {
            let mut value: u64 = 0;
            for group in 0..5 {
                if *pos + 8 > bit_count {
                    return None;
                }
                let byte = u64::from(read8(*pos));
                *pos += 8;
                value |= (byte >> 1) << (7 * group);
                if byte & 1 == 0 {
                    return u32::try_from(value).ok();
                }
            }
            None
        };
        let Some(handle) = read_ip(&mut pos) else { return false };
        if handle == 0 {
            return true;
        }
        let Some(len) = read_ip(&mut pos) else { return false };
        if u64::from(pos) + u64::from(len) > u64::from(bit_count) {
            return false;
        }
        pos += len;
    }
    true
}

/// How many of up to `limit` blocks `spec` decodes into a walk.
#[must_use]
pub fn score(spec: &TransformSpec, blocks: &[Block], limit: usize) -> (u64, u64) {
    let step = (blocks.len() / limit.max(1)).max(1);
    let (mut ok, mut n) = (0u64, 0u64);
    let mut buf = Vec::new();
    for b in blocks.iter().step_by(step).take(limit) {
        buf.clear();
        buf.extend_from_slice(&b.bytes);
        if spec.apply(&mut buf, b.bit_count as usize, b.seed).is_err() {
            continue;
        }
        n += 1;
        ok += u64::from(walks(&buf, b.bit_count));
    }
    (ok, n)
}

/// Recover the transform the blocks were encoded with.
pub fn solve(blocks: &[Block], opts: &Options) -> Result<Outcome, SolveError> {
    let start = std::time::Instant::now();
    let lists = stage_a(blocks, opts)?;
    (opts.log)(&format!("stage A: {:.1}s", start.elapsed().as_secs_f64()));
    let mut candidates = Vec::new();
    let mut probes_used = 0;
    for list in lists.iter().take(8) {
        let started = std::time::Instant::now();
        let result = stage_b(list, blocks, opts);
        (opts.log)(&format!("stage B: {:.1}s", started.elapsed().as_secs_f64()));
        match result {
            Ok((found, used)) => {
                probes_used = probes_used.max(used);
                for spec in found {
                    let (walked, sampled) = score(&spec, blocks, 50_000);
                    candidates.push(Scored { spec, walked, sampled });
                }
            }
            Err(e) => (opts.log)(&format!("stage B: {e}")),
        }
        // Lists come best first; a candidate that walks the sample cleanly
        // ends the search (the caller's full oracle run is the proof).
        if candidates.iter().any(|c| c.walked * 1000 >= c.sampled * 999 && c.sampled > 0) {
            break;
        }
    }
    candidates.sort_by(|a, b| {
        let ra = a.walked as f64 / a.sampled.max(1) as f64;
        let rb = b.walked as f64 / b.sampled.max(1) as f64;
        rb.total_cmp(&ra)
    });
    Ok(Outcome {
        candidates,
        step_lists: lists,
        probes_used,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidate_index_covers_the_registered_shapes() {
        // V13_09: add 8, add 7, sbox, sub 5, swap, sub 3, sbox, rev
        // digits by slot 8..1: add(5) add(5) sbox(4) sub(6) swap(3) sub(6) sbox(4) rev(2)
        let (ops, len) = chain_for(55_463_642);
        let list: Vec<Op> = ops[..len].iter().flatten().copied().collect();
        assert_eq!(
            list,
            [Op::Add(8), Op::Add(7), Op::Sbox, Op::Sub(5), Op::Swap, Op::Sub(3), Op::Sbox, Op::Rev]
        );
    }

    #[test]
    fn folded_offsets_reproduce_the_prng() {
        for spec in [
            TransformSpec::parse("0x7e8c_b50f 0x0f: not").unwrap(),
            TransformSpec::parse("0x3c17_a9fa -0x06: not").unwrap(),
            TransformSpec::parse("0x2c24_9eb3 0x33: not").unwrap(),
        ] {
            let c = (spec.init_a_offset.rem_euclid(128)) as u32;
            assert_eq!(offset_for(c), spec.init_a_offset);
            for seed in [0u32, 1, 77, 0xdead_beef, u32::MAX] {
                assert_eq!(prng_a(seed, spec.seed_addend, c), spec.initial_prng_a(seed));
            }
        }
    }

    #[test]
    fn the_offset_scan_agrees_with_the_direct_check() {
        let list = [Op::Not];
        let mut hits = Vec::new();
        for (seed, ct, mask) in [(9u32, 0u8, 1u8), (0xdead_beef, 0x55, 0x7f), (1234, 0x3, 0x0f)] {
            let probe = Probe {
                seed,
                prng_b: initial_prng_b(seed),
                stage: 1,
                kind: ProbeKind::Tail { ct, mask },
            };
            let fast = FastTail::new(&probe).unwrap();
            for addend in [0u32, 1, 0x7e8c_b50f, 0x2c24_9eb3, u32::MAX] {
                hits.clear();
                scan_offsets(&fast, addend, &mut hits);
                hits.sort_unstable();
                let direct: Vec<u32> =
                    (0..128).filter(|&c| probe_holds(&probe, &list, addend, c)).collect();
                assert_eq!(hits, direct, "seed {seed:#x} addend {addend:#x}");
            }
        }
    }

    #[test]
    fn walk_prefix_reads_records_and_refuses_overruns() {
        // checksum 0, handle 3 (byte 0x06), length 4 (0x08), 4 payload bits, terminator.
        let bits: u128 = (0x06 << 1) | (0x08 << 9) | (0b1010 << 17);
        assert_eq!(walk_prefix(bits, 64, 29), Ok(None));
        assert_eq!(walk_prefix(bits, 64, 20), Err(()));
        assert_eq!(walk_prefix(bits, 21, 64), Ok(Some(21)));
    }
}
