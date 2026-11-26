//! Hash index over the overlay entry slices; why a hash index (not binary
//! search), how it stays correct, and the b-prefix table are in
//! docs/OVERLAY_RESOLUTION.md "Why a hash index (and not binary search)".

use super::{OverlayEntry, OverlayHandleEntry};

/// One open-addressing slot. `entry` is the entry index plus one, so an
/// all-zero slot is empty; `tag`, the key hash's high half, rejects a wrong
/// slot before any string is read.
#[derive(Debug, Clone, Copy, Default)]
struct Slot {
    tag: u32,
    entry: u32,
}

/// A power-of-two open-addressing table with linear probing, sized at >= 2x
/// the entry count so a probe chain always ends on an empty slot (contents are
/// fixed at build time).
#[derive(Debug, Clone)]
pub(super) struct SlotTable {
    slots: Box<[Slot]>,
    mask: usize,
}

impl SlotTable {
    fn new(entry_count: usize) -> Self {
        let capacity = entry_count.saturating_mul(2).max(8).next_power_of_two();
        Self {
            slots: vec![Slot::default(); capacity].into_boxed_slice(),
            mask: capacity - 1,
        }
    }

    fn insert(&mut self, hash: u64, entry_index: usize) {
        let mut position = (hash as usize) & self.mask;
        while self.slots[position].entry != 0 {
            position = (position + 1) & self.mask;
        }
        self.slots[position] = Slot {
            tag: (hash >> 32) as u32,
            // Entry counts are bounded by the static tables: no wrap.
            entry: (entry_index as u32) + 1,
        };
    }

    /// The first entry index whose slot tag matches and which `matches` (the
    /// authoritative comparison; the tag only filters) confirms.
    #[inline]
    pub(super) fn find(&self, hash: u64, mut matches: impl FnMut(usize) -> bool) -> Option<usize> {
        let tag = (hash >> 32) as u32;
        let mut position = (hash as usize) & self.mask;
        loop {
            let slot = self.slots[position];
            if slot.entry == 0 {
                return None;
            }
            if slot.tag == tag {
                let entry_index = (slot.entry - 1) as usize;
                if matches(entry_index) {
                    return Some(entry_index);
                }
            }
            position = (position + 1) & self.mask;
        }
    }
}

/// Golden-ratio seed and a 64-bit odd multiplier: a speed-first mixer, not a
/// keyed hash, because a collision costs one extra string comparison, never a
/// wrong answer.
const HASH_SEED: u64 = 0x9E37_79B9_7F4A_7C15;
const HASH_MULT: u64 = 0x517C_C1B7_2722_0A95;

/// Fold a byte string into the running state, eight bytes per multiply; the
/// tail is zero-padded (the length folding in [`name_hash`] keeps that safe).
fn mix_bytes(mut state: u64, bytes: &[u8]) -> u64 {
    let mut chunks = bytes.chunks_exact(8);
    for chunk in &mut chunks {
        let mut word = [0u8; 8];
        word.copy_from_slice(chunk);
        state = (state ^ u64::from_le_bytes(word))
            .rotate_left(23)
            .wrapping_mul(HASH_MULT);
    }
    let tail = chunks.remainder();
    if !tail.is_empty() {
        let mut word = [0u8; 8];
        word[..tail.len()].copy_from_slice(tail);
        state = (state ^ u64::from_le_bytes(word))
            .rotate_left(23)
            .wrapping_mul(HASH_MULT);
    }
    state
}

/// Final avalanche, so the high half used as the slot tag depends on every
/// input byte rather than only on the last word mixed.
fn finish(mut state: u64) -> u64 {
    state ^= state >> 33;
    state = state.wrapping_mul(0xFF51_AFD7_ED55_8CCD);
    state ^= state >> 33;
    state = state.wrapping_mul(0xC4CE_B9FE_1A85_EC53);
    state ^ (state >> 33)
}

/// Hash a `(group_path, field_name)` key. Both lengths are folded in last,
/// separating `("ab", "c")` from `("a", "bc")` and keeping the zero-padded tail
/// in [`mix_bytes`] from equating keys of different length.
#[inline]
pub(super) fn name_hash(group_path: &str, field_name: &str) -> u64 {
    name_hash_from_group(group_hash_state(group_path), field_name)
}

/// Hash a `(group_path, handle)` key. Lives in its own table, so it only has to
/// separate handles from each other within a group.
#[inline]
pub(super) fn handle_hash(group_path: &str, handle: u32) -> u64 {
    handle_hash_from_group(group_hash_state(group_path), handle)
}

/// The fold state after mixing only the group path, plus its length: what the
/// export sink caches per content block (~2M probes a replay; 80% of blocks hit
/// the group-path memo), so a per-field probe pays only for the field name and
/// the final avalanche. Opaque. A stale state only turns hits into misses (raw
/// bits), never a wrong value: the full string comparison still guards every
/// hit.
#[derive(Debug, Clone, Copy)]
pub struct GroupHashState {
    /// State after [`mix_bytes`] on the group path, seeded with [`HASH_SEED`].
    state: u64,
    /// The group path's byte length, folded in at the finish step.
    group_len: u64,
}

/// Compute the cacheable half of a `(group_path, ...)` key hash, once per
/// content block; the overlay finishes it per probe.
#[inline]
#[must_use]
pub fn group_hash_state(group_path: &str) -> GroupHashState {
    GroupHashState {
        state: mix_bytes(HASH_SEED, group_path.as_bytes()),
        group_len: group_path.len() as u64,
    }
}

/// Finish a `(group_path, field_name)` key hash from a cached group state;
/// equals [`name_hash`] for the same `group_path`.
#[inline]
pub(super) fn name_hash_from_group(group: GroupHashState, field_name: &str) -> u64 {
    let state = mix_bytes(group.state, field_name.as_bytes());
    finish(state ^ (group.group_len << 32) ^ (field_name.len() as u64))
}

/// Finish a `(group_path, handle)` key hash from a cached group state.
#[inline]
pub(super) fn handle_hash_from_group(group: GroupHashState, handle: u32) -> u64 {
    finish(group.state ^ (group.group_len << 32) ^ u64::from(handle))
}

/// The three probe tables an [`OverlayTable`](super::OverlayTable) needs --
/// direct names, `b`-stripped names and handles -- built once on first lookup.
#[derive(Debug, Clone)]
pub(super) struct OverlayIndex {
    pub(super) by_name: SlotTable,
    pub(super) by_stripped_name: SlotTable,
    pub(super) by_handle: SlotTable,
}

impl OverlayIndex {
    pub(super) fn build(entries: &[OverlayEntry], handle_entries: &[OverlayHandleEntry]) -> Self {
        let stripped_count = entries
            .iter()
            .filter(|entry| entry.field_name.starts_with('b'))
            .count();

        let mut by_name = SlotTable::new(entries.len());
        let mut by_stripped_name = SlotTable::new(stripped_count);
        for (position, entry) in entries.iter().enumerate() {
            by_name.insert(name_hash(entry.group_path, entry.field_name), position);
            if let Some(stripped) = entry.field_name.strip_prefix('b') {
                // Also under the stripped name, so the `b`-prefix probe reuses
                // the direct probe's hash and never builds a key.
                by_stripped_name.insert(name_hash(entry.group_path, stripped), position);
            }
        }

        let mut by_handle = SlotTable::new(handle_entries.len());
        for (position, entry) in handle_entries.iter().enumerate() {
            by_handle.insert(handle_hash(entry.group_path, entry.handle), position);
        }

        Self {
            by_name,
            by_stripped_name,
            by_handle,
        }
    }
}
