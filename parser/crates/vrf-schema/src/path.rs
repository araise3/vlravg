//! Replay path aliases. One logical path has equivalent spellings: with or
//! without a `Default__` leaf prefix, `/_Core/` under `/Game/Characters/`, and
//! the `_ClassNetCache` suffix. Matching is ordinal and exact.

/// Marks an export group as an RPC (ClassNetCache) group. The Python adapter
/// under `tools/` keeps a copy that `crates/vrfkit/tests/adapter_contract.rs` pins.
pub const CLASS_NET_CACHE_SUFFIX: &str = "_ClassNetCache";
const CORE_SEGMENT: &str = "/_Core/";
const CHARACTERS_ROOT: &str = "/Game/Characters/";
const DEFAULT_OBJECT_PREFIX: &str = "Default__";

/// Visit every lookup key for an export-group path: `path` itself, then its
/// `Default__` and `/_Core/` aliases; the order decides which spelling wins
/// (a visitor: docs/PERFORMANCE_NOTES.md#path-alias-enumeration).
pub fn for_each_replay_path_key(path: &str, mut visit: impl FnMut(&str)) {
    find_replay_path_key::<()>(path, |key| {
        visit(key);
        None
    });
}

/// [`for_each_replay_path_key`] until `probe` accepts a key, returning what it
/// gave back; aliases past the hit are never built.
pub fn find_replay_path_key<T>(path: &str, mut probe: impl FnMut(&str) -> Option<T>) -> Option<T> {
    probe(path)
        .or_else(|| default_object_alias(path).and_then(|alias| probe(&alias)))
        .or_else(|| core_alias(path).and_then(|alias| probe(&alias)))
}

/// Like [`find_replay_path_key`], but each base key is followed by its
/// `_ClassNetCache` toggle (suffix removed if present, appended if absent).
pub fn find_class_net_cache_key<T>(
    path: &str,
    mut probe: impl FnMut(&str) -> Option<T>,
) -> Option<T> {
    let mut toggled = String::new();
    find_replay_path_key(path, |key| {
        if let Some(hit) = probe(key) {
            return Some(hit);
        }
        toggled.clear();
        match key.strip_suffix(CLASS_NET_CACHE_SUFFIX) {
            // A path that is only the suffix strips to "", which is not a key.
            Some("") => return None,
            Some(stripped) => toggled.push_str(stripped),
            None => {
                toggled.push_str(key);
                toggled.push_str(CLASS_NET_CACHE_SUFFIX);
            }
        }
        probe(&toggled)
    })
}

/// Whether a name is a qualified path rather than a bare leaf: one byte pass
/// (`unique_leaf_match` alone makes 174,485 calls on the reference replay), safe
/// because UTF-8 never encodes an ASCII byte inside a multi-byte sequence.
#[inline]
pub fn has_path_separator(name: &str) -> bool {
    name.bytes().any(|b| matches!(b, b'/' | b'.' | b':'))
}

/// Toggle the `Default__` prefix: strip it, or add it to a bare leaf.
fn default_object_alias(path: &str) -> Option<String> {
    if let Some(rest) = path.strip_prefix(DEFAULT_OBJECT_PREFIX) {
        return Some(rest.to_owned());
    }
    if !has_path_separator(path) {
        let mut prefixed = String::with_capacity(DEFAULT_OBJECT_PREFIX.len() + path.len());
        prefixed.push_str(DEFAULT_OBJECT_PREFIX);
        prefixed.push_str(path);
        return Some(prefixed);
    }
    None
}

/// Replace the first `/_Core/` with `/`, or insert `_Core/` after
/// `/Game/Characters/`.
fn core_alias(path: &str) -> Option<String> {
    if let Some(idx) = path.find(CORE_SEGMENT) {
        let mut alias = String::with_capacity(path.len());
        alias.push_str(&path[..idx]);
        alias.push('/');
        alias.push_str(&path[idx + CORE_SEGMENT.len()..]);
        return Some(alias);
    }
    if let Some(rest) = path.strip_prefix(CHARACTERS_ROOT) {
        let mut alias = String::with_capacity(CHARACTERS_ROOT.len() + 6 + rest.len());
        alias.push_str(CHARACTERS_ROOT);
        alias.push_str("_Core/");
        alias.push_str(rest);
        return Some(alias);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What the visitor emits, in order: the order is the contract.
    fn replay_keys(path: &str) -> Vec<String> {
        let mut out = Vec::new();
        for_each_replay_path_key(path, |k| out.push(k.to_owned()));
        out
    }

    /// The same for the ClassNetCache generator, via a probe that never accepts.
    fn cnc_keys(path: &str) -> Vec<String> {
        let mut out = Vec::new();
        let hit: Option<()> = find_class_net_cache_key(path, |k| {
            out.push(k.to_owned());
            None
        });
        assert!(hit.is_none());
        out
    }

    #[test]
    fn the_original_path_is_always_the_first_key() {
        assert_eq!(replay_keys("/Game/Test.Test_C"), ["/Game/Test.Test_C"]);
    }

    #[test]
    fn default_prefix_stripped() {
        assert_eq!(
            replay_keys("Default__Test_C"),
            ["Default__Test_C", "Test_C"]
        );
    }

    #[test]
    fn bare_leaf_gains_default_prefix() {
        assert_eq!(replay_keys("Test_C"), ["Test_C", "Default__Test_C"]);
    }

    #[test]
    fn core_segment_removed() {
        assert_eq!(
            replay_keys("/Game/Characters/_Core/Jett/Jett_C"),
            [
                "/Game/Characters/_Core/Jett/Jett_C",
                "/Game/Characters/Jett/Jett_C"
            ]
        );
    }

    #[test]
    fn characters_root_gains_core() {
        assert_eq!(
            replay_keys("/Game/Characters/Jett/Jett_C"),
            [
                "/Game/Characters/Jett/Jett_C",
                "/Game/Characters/_Core/Jett/Jett_C"
            ]
        );
    }

    #[test]
    fn class_net_cache_suffix_toggled_after_each_base_key() {
        // A bare leaf also has the Default__ alias; each base key precedes its toggle.
        assert_eq!(
            cnc_keys("Test_ClassNetCache"),
            [
                "Test_ClassNetCache",
                "Test",
                "Default__Test_ClassNetCache",
                "Default__Test"
            ]
        );
        assert_eq!(
            cnc_keys("Test"),
            [
                "Test",
                "Test_ClassNetCache",
                "Default__Test",
                "Default__Test_ClassNetCache"
            ]
        );
    }

    /// `_ClassNetCache` alone strips to "", which is not a key; its
    /// `Default__` alias still strips to something real.
    #[test]
    fn a_path_that_is_only_the_suffix_yields_no_stripped_key() {
        assert_eq!(
            cnc_keys("_ClassNetCache"),
            ["_ClassNetCache", "Default___ClassNetCache", "Default__"]
        );
    }

    /// The `/_Core/` alias is a base key too, followed by its own toggle.
    #[test]
    fn class_net_cache_suffix_toggled_after_the_core_alias() {
        assert_eq!(
            cnc_keys("/Game/Characters/_Core/Jett/Jett_C_ClassNetCache"),
            [
                "/Game/Characters/_Core/Jett/Jett_C_ClassNetCache",
                "/Game/Characters/_Core/Jett/Jett_C",
                "/Game/Characters/Jett/Jett_C_ClassNetCache",
                "/Game/Characters/Jett/Jett_C"
            ]
        );
    }

    /// Only a path starting with `Default__` and holding `/_Core/` has both
    /// aliases, so only it shows their order: `Default__` first, then
    /// `/_Core/`, and where both spellings are keys the `Default__` one wins.
    #[test]
    fn the_default_alias_is_tried_before_the_core_alias() {
        let path = "Default__/Game/Characters/_Core/Jett/Jett_C";
        let default_alias = "/Game/Characters/_Core/Jett/Jett_C";
        let core_alias = "Default__/Game/Characters/Jett/Jett_C";
        assert_eq!(replay_keys(path), [path, default_alias, core_alias]);
        let hit = find_replay_path_key(path, |key| {
            [default_alias, core_alias]
                .contains(&key)
                .then(|| key.to_owned())
        });
        assert_eq!(hit.as_deref(), Some(default_alias));
    }

    #[test]
    fn no_alias_for_qualified_path_without_core() {
        assert_eq!(
            replay_keys("/Game/Abilities/Grenade.Grenade_C"),
            ["/Game/Abilities/Grenade.Grenade_C"]
        );
    }

    /// A probe that accepts early stops the walk before any alias is built.
    #[test]
    fn find_short_circuits_on_the_first_acceptance() {
        let mut seen = Vec::new();
        let hit = find_replay_path_key("Test_C", |k| {
            seen.push(k.to_owned());
            Some(k.len())
        });
        assert_eq!(hit, Some("Test_C".len()));
        assert_eq!(seen, ["Test_C"], "the Default__ alias must not be built");
    }
}
