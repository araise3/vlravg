//! Bare-name resolution. The wire names an actor or subobject by bare instance
//! name (`AresWorldSettings`, `BombDestination_A`), while its export group is
//! declared under a qualified path (`/Script/ShooterGame.AresWorldSettings`),
//! and nothing on the wire links the two. These resolvers use only the
//! replay's own schema, never a hardcoded table of actor or map names.
//!
//! # The ambiguity rule
//!
//! A name binds only when exactly one group claims it; a leaf two groups claim
//! is recorded as `AMBIGUOUS_LEAF` and binds nothing. Guessing would hand
//! `BitReader::read_serialized_int` the wrong field capacity, which consumes
//! the wrong bits and yields plausible garbage. Each resolver tries candidate
//! leaves in priority order and the first claimed at all decides: an ambiguous
//! one ends the search, since the next candidate would name another class.

use crate::cache::NetGuidCache;
use crate::export::NetFieldExportGroup;
use crate::hash::FxHashMap;
use crate::path::has_path_separator;

/// Longest `stem + suffix` built on the stack; the reference replay's longest
/// leaf is 61 bytes and the longest suffix 23.
const JOIN_STACK_CAP: usize = 128;

/// Call `f` with `a` and `b` concatenated, without allocating when the result
/// fits in [`JOIN_STACK_CAP`] bytes: a `String` per probe is 166,353 mallocs on
/// the reference replay.
#[inline]
fn with_joined<R>(a: &str, b: &str, f: impl FnOnce(&str) -> R) -> R {
    let total = a.len() + b.len();
    if total <= JOIN_STACK_CAP {
        let mut buf = [0u8; JOIN_STACK_CAP];
        buf[..a.len()].copy_from_slice(a.as_bytes());
        buf[a.len()..total].copy_from_slice(b.as_bytes());
        // Always valid UTF-8; falling through on `Err` keeps this panic-free.
        if let Ok(joined) = core::str::from_utf8(&buf[..total]) {
            return f(joined);
        }
    }
    let mut owned = String::with_capacity(total);
    owned.push_str(a);
    owned.push_str(b);
    f(&owned)
}

/// File a group path under its leaf (the text after its last `.`) in
/// `by_leaf`, turning the leaf ambiguous if another group already claims it.
pub(crate) fn register_leaf(by_leaf: &mut FxHashMap<String, usize>, path: &str, idx: usize) {
    let leaf = match path.rfind('.') {
        Some(dot_pos) => &path[dot_pos + 1..],
        None => return, // not a qualified path
    };
    if leaf.is_empty() {
        return;
    }
    by_leaf
        .entry(leaf.to_owned())
        .and_modify(|existing| {
            if *existing != idx {
                *existing = NetGuidCache::AMBIGUOUS_LEAF;
            }
        })
        .or_insert(idx);
}

impl NetGuidCache {
    /// Resolve a bare class name to the one group whose path ends in `.{name}`,
    /// then by two fallbacks: `name + "Component"` (subobject GUIDs such as
    /// `EquippableStateMachine` omit it) and `name + "_C"` (Blueprint classes
    /// such as `Comp_*`).
    #[must_use]
    pub fn unique_leaf_match(&self, bare_name: &str) -> Option<&NetFieldExportGroup> {
        if has_path_separator(bare_name) {
            return None;
        }
        self.leaf_claim(bare_name)
            .or_else(|| with_joined(bare_name, "Component", |k| self.leaf_claim(k)))
            .or_else(|| with_joined(bare_name, "_C", |k| self.leaf_claim(k)))
            .flatten()
    }

    /// Resolve a bare instance name to its `_ClassNetCache` group.
    ///
    /// The full name and then each shorter stem, instance suffixes (`_A`, `_2`,
    /// `_Ascent_*`) stripped one `_` segment at a time, are tried as
    /// `stem_ClassNetCache`, `stemComponent_ClassNetCache` and
    /// `stem_C_ClassNetCache`. Last come trailing digits trimmed
    /// (`WindowShieldA1` -> `WindowShieldA`), then one trailing uppercase
    /// letter (-> `WindowShield`), so the longer stem goes first. The capacity
    /// is the matched group's [`NetFieldExportGroup::len`], never guessed.
    #[must_use]
    pub fn resolve_cnc_for_instance_name(&self, bare_name: &str) -> Option<&NetFieldExportGroup> {
        if has_path_separator(bare_name) {
            return None;
        }

        let mut stem = bare_name;
        loop {
            if let Some(claim) = self.try_cnc_leaf_candidates(stem) {
                return claim;
            }

            match stem.rfind('_') {
                Some(pos) if pos > 0 => {
                    stem = &bare_name[..pos];
                }
                _ => break,
            }
        }

        // Final fallback, for any name with trailing digits, including one the
        // loop already cut at `_`: `Foo_003` also probes the stem `Foo_`.
        let trimmed = bare_name.trim_end_matches(|c: char| c.is_ascii_digit());
        if trimmed.len() < bare_name.len() && !trimmed.is_empty() {
            if let Some(claim) = self.try_cnc_leaf_candidates(trimmed) {
                return claim;
            }
            // One trailing uppercase letter, a site/variant marker; one, not
            // the whole run.
            if trimmed
                .chars()
                .next_back()
                .is_some_and(|c| c.is_ascii_uppercase())
            {
                let trimmed2 = &trimmed[..trimmed.len() - 1];
                if !trimmed2.is_empty() {
                    if let Some(claim) = self.try_cnc_leaf_candidates(trimmed2) {
                        return claim;
                    }
                }
            }
        }

        None
    }

    /// Look up one `by_leaf` key: `None` when no group claims the leaf,
    /// `Some(None)` when two or more do, `Some(Some(group))` for exactly one.
    /// Keeping ambiguous apart from absent is what lets the resolvers stop.
    #[inline]
    fn leaf_claim(&self, leaf: &str) -> Option<Option<&NetFieldExportGroup>> {
        match *self.leaf_index().get(leaf)? {
            Self::AMBIGUOUS_LEAF => Some(None),
            idx => self.groups().get(idx).map(Some),
        }
    }

    /// The first claim among a stem's three `_ClassNetCache` candidates, in this
    /// order, which decides a stem declared under more than one convention.
    fn try_cnc_leaf_candidates(&self, stem: &str) -> Option<Option<&NetFieldExportGroup>> {
        [
            "_ClassNetCache",
            "Component_ClassNetCache",
            "_C_ClassNetCache",
        ]
        .into_iter()
        .find_map(|suffix| with_joined(stem, suffix, |k| self.leaf_claim(k)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::export::NetFieldExportGroup;

    /// `(registered paths, bare name, the path it must resolve to)`.
    type Row<'a> = (&'a [&'a str], &'a str, Option<&'a str>);

    /// One group per path, at indices 0, 1, 2, ...; a failed registration
    /// fails the test rather than a row resolving to nothing for that reason.
    fn cache_of(paths: &[&str]) -> NetGuidCache {
        let mut cache = NetGuidCache::new();
        for (index, path) in paths.iter().enumerate() {
            cache
                .add_export_group(NetFieldExportGroup::new((*path).into(), index as u32, 1))
                .unwrap();
        }
        cache
    }

    #[test]
    fn unique_leaf_match_resolves_each_row() {
        const FLOAT_CURVE: &str = "/Game/Characters/Components/Comp_Projectile_FloatCurveMovement.Comp_Projectile_FloatCurveMovement_C";
        let ambiguous_then_component = ["/Script/A.Foo", "/Script/B.Foo", "/Script/C.FooComponent"];
        let ambiguous_then_c = [
            "/Script/A.FooComponent",
            "/Script/B.FooComponent",
            "/Game/C.Foo_C",
        ];
        let separators = ["/Script/X.Game:Test", "/Script/X.Game/Test"];
        let rows: &[Row<'_>] = &[
            (
                &["/Script/ShooterGame.AresAttributeSet"],
                "AresAttributeSet",
                Some("/Script/ShooterGame.AresAttributeSet"),
            ),
            // Subobject GUIDs often omit the `Component` their group has.
            (
                &["/Script/ShooterGame.EquippableStateMachineComponent"],
                "EquippableStateMachine",
                Some("/Script/ShooterGame.EquippableStateMachineComponent"),
            ),
            // Blueprint-class GUIDs map to a leaf with a `_C` suffix.
            (
                &[FLOAT_CURVE],
                "Comp_Projectile_FloatCurveMovement",
                Some(FLOAT_CURVE),
            ),
            (
                &["/Script/ShooterGame.SomethingElse"],
                "NonexistentThing",
                None,
            ),
            // Two groups share the leaf, so neither name binds, the second
            // through `+Component` reaching the same ambiguous leaf.
            (
                &["/Script/A.TestComponent", "/Script/B.TestComponent"],
                "TestComponent",
                None,
            ),
            (
                &["/Script/A.TestComponent", "/Script/B.TestComponent"],
                "Test",
                None,
            ),
            // The first candidate claimed at all decides: an ambiguous exact
            // leaf does not fall through to `+Component`, nor an ambiguous
            // `+Component` to `+_C`. The later group of another class is
            // reachable by its own leaf.
            (&ambiguous_then_component, "Foo", None),
            (
                &ambiguous_then_component,
                "FooComponent",
                Some("/Script/C.FooComponent"),
            ),
            (&ambiguous_then_c, "Foo", None),
            (&ambiguous_then_c, "Foo_C", Some("/Game/C.Foo_C")),
            // A qualified name is never leaf-matched, even when a leaf is
            // spelled exactly like it.
            (&separators, "Game:Test", None),
            (&separators, "Game/Test", None),
        ];
        for &(paths, name, expected) in rows {
            assert_eq!(
                cache_of(paths)
                    .unique_leaf_match(name)
                    .map(|g| g.path.as_str()),
                expected,
                "{name} over {paths:?}"
            );
        }
    }

    #[test]
    fn resolve_cnc_for_instance_name_resolves_each_row() {
        const DEADEYE_VO_C: &str =
            "/Game/Audio/VOComponent/AudDeadeyeVoComponent.AudDeadeyeVOComponent_C_ClassNetCache";
        const DEADEYE: &str = "/Game/Audio/VOComponent/AudDeadeye.AudDeadeye_ClassNetCache";
        const DEADEYE_VO: &str =
            "/Game/Audio/VOComponent/AudDeadeyeVoComponent.AudDeadeyeVOComponent_ClassNetCache";
        const BOMB: &str = "/Game/GameModes/Bomb/BombDestination.BombDestination_C_ClassNetCache";
        const GRENADE: &str =
            "/Game/Abilities/GrenadeExplodeIndicator.GrenadeExplodeIndicator_C_ClassNetCache";
        const SWITCH: &str = "/Game/Maps/Switch_BlackMarket_2.Switch_BlackMarket_2_C_ClassNetCache";
        const X_C: &str = "/Game/X/X.X_C_ClassNetCache";
        const X_COMPONENT: &str = "/Script/ShooterGame.XComponent_ClassNetCache";
        const X_PLAIN: &str = "/Script/ShooterGame.X_ClassNetCache";
        let next_suffix = [
            "/Script/A.Foo_ClassNetCache",
            "/Script/B.Foo_ClassNetCache",
            "/Script/C.FooComponent_ClassNetCache",
        ];
        let shorter_stem = [
            "/Game/P1/Foo_Bar.Foo_Bar_C_ClassNetCache",
            "/Game/P2/Foo_Bar.Foo_Bar_C_ClassNetCache",
            "/Game/P3/Foo.Foo_C_ClassNetCache",
        ];
        let uppercase_trim = [
            "/Game/A/FooA.FooA_C_ClassNetCache",
            "/Game/B/FooA.FooA_C_ClassNetCache",
            "/Game/C/Foo.Foo_C_ClassNetCache",
        ];
        let separators = [
            "/Script/X.Foo_ClassNetCache",
            "/Script/X.Game:Foo_ClassNetCache",
        ];
        let rows: &[Row<'_>] = &[
            // The three suffixes: `_ClassNetCache`, `Component_ClassNetCache`,
            // `_C_ClassNetCache`.
            (
                &["/Script/ShooterGame.AresWorldSettings_ClassNetCache"],
                "AresWorldSettings",
                Some("/Script/ShooterGame.AresWorldSettings_ClassNetCache"),
            ),
            (
                &["/Script/ShooterGame.ForceModuleManagerComponent_ClassNetCache"],
                "ForceModuleManager",
                Some("/Script/ShooterGame.ForceModuleManagerComponent_ClassNetCache"),
            ),
            (&[DEADEYE_VO_C], "AudDeadeyeVOComponent", Some(DEADEYE_VO_C)),
            // A stem declared under more than one convention resolves by that
            // suffix order. The groups are registered in the reverse order, so
            // registration order cannot produce the same answers.
            (&[X_C, X_COMPONENT, X_PLAIN], "X", Some(X_PLAIN)),
            (&[X_C, X_COMPONENT], "X", Some(X_COMPONENT)),
            // Instance suffixes are stripped one `_` segment at a time.
            (&[BOMB], "BombDestination_A", Some(BOMB)),
            (&[BOMB], "BombDestination_B", Some(BOMB)),
            (
                &["/Game/Audio/Core/AmbientAudio.AmbientAudio_C_ClassNetCache"],
                "AmbientAudio_Ascent_Defender_SoundA_003",
                Some("/Game/Audio/Core/AmbientAudio.AmbientAudio_C_ClassNetCache"),
            ),
            (
                &["/Script/ShooterGame.MeleeAttackStateComponent_ClassNetCache"],
                "MeleeAttackState_Alt",
                Some("/Script/ShooterGame.MeleeAttackStateComponent_ClassNetCache"),
            ),
            (&[GRENADE], "GrenadeExplodeIndicator_Bounce", Some(GRENADE)),
            // The full name is tried first and matches without stripping.
            (&[SWITCH], "Switch_BlackMarket_2", Some(SWITCH)),
            // Trailing digits, then one trailing uppercase letter.
            (
                &["/Game/Interactable/WindowShield.WindowShield_C_ClassNetCache"],
                "WindowShieldA1",
                Some("/Game/Interactable/WindowShield.WindowShield_C_ClassNetCache"),
            ),
            // Both are real archive names. The digit-only trim is tried before
            // the uppercase trim (shorter-first matched the unrelated
            // `AudDeadeye` group), and the uppercase trim removes one letter:
            // `AudDeadeyeVOB` loses the `B`, not the whole `VOB` run.
            (&[DEADEYE, DEADEYE_VO], "AudDeadeyeVO2", Some(DEADEYE_VO)),
            (&[DEADEYE, DEADEYE_VO], "AudDeadeyeVOB1", Some(DEADEYE_VO)),
            (
                &["/Script/ShooterGame.SomethingUnrelated_ClassNetCache"],
                "AbilitiesAndBuffsComponent",
                None,
            ),
            (
                &[
                    "/Script/A.SharedName_ClassNetCache",
                    "/Script/B.SharedName_ClassNetCache",
                ],
                "SharedName",
                None,
            ),
            // An ambiguous candidate ends the search wherever the resolver
            // would move on: at the next suffix, the next shorter stem, and the
            // uppercase trim after the digit trim. Each later group is
            // reachable when nothing ambiguous comes first.
            (&next_suffix, "Foo", None),
            (&next_suffix, "FooComponent", Some(next_suffix[2])),
            (&shorter_stem, "Foo_Bar", None),
            (&shorter_stem, "Foo_Baz", Some(shorter_stem[2])),
            (&uppercase_trim, "FooA1", None),
            (&uppercase_trim, "Foo1", Some(uppercase_trim[2])),
            // A qualified name is never resolved, even where stripping a `_`
            // segment or matching a leaf spelled like it would succeed.
            (&separators, "Foo_Bar.Baz", None),
            (&separators, "Foo_Bar/Baz", None),
            (&separators, "Game:Foo", None),
        ];
        for &(paths, name, expected) in rows {
            assert_eq!(
                cache_of(paths)
                    .resolve_cnc_for_instance_name(name)
                    .map(|g| g.path.as_str()),
                expected,
                "{name} over {paths:?}"
            );
        }
    }
}
