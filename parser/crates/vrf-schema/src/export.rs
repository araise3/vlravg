//! Net field export groups: one object path each, with a sparse table of
//! [`NetFieldExport`] descriptors keyed by handle.

/// An `FName`'s instance number is its displayed suffix plus one: 0 renders
/// the bare name, `N` renders `Name_{N-1}`. A negative number has no display
/// form and is appended as is, never wrapped into a plausible suffix
/// (`vrf-decode`'s reader rejects one; the schema must still name the field).
pub(crate) fn render_fname(name: String, number: i32) -> String {
    match number {
        0 => name,
        n if n > 0 => format!("{name}_{}", n - 1),
        n => format!("{name}_{n}"),
    }
}

/// One replicated-field descriptor within a group.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetFieldExport {
    /// The key content blocks name this field by.
    pub handle: u32,
    /// Checksum the engine uses to detect schema drift between client and server.
    pub compatible_checksum: u32,
    /// Human-readable field name (e.g. `"IndicatorLocation"`).
    pub name: String,
}

/// Field exports sharing an object path. The first appearance carries the path
/// and slot count; later frames reuse `path_name_index` to add or overwrite
/// fields, and a re-export can grow the group.
#[derive(Debug, Clone)]
pub struct NetFieldExportGroup {
    /// The group's full object path.
    pub path: String,
    /// The index later frames use instead of the path string.
    pub path_name_index: u32,
    /// Indexed by handle; the length is the declared slot count.
    pub fields: Vec<Option<NetFieldExport>>,
}

impl NetFieldExportGroup {
    /// Create a new group with `capacity` empty field slots.
    pub fn new(path: String, path_name_index: u32, capacity: u32) -> Self {
        Self {
            path,
            path_name_index,
            fields: vec![None; capacity as usize],
        }
    }

    /// Number of declared field slots (including unfilled ones).
    #[must_use]
    pub fn len(&self) -> u32 {
        self.fields.len() as u32
    }

    /// Whether no field slots have been declared.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.fields.is_empty()
    }

    /// The field at `handle`; `None` if out of range or unpopulated.
    #[must_use]
    pub fn get_field(&self, handle: u32) -> Option<&NetFieldExport> {
        self.fields.get(handle as usize)?.as_ref()
    }

    /// Insert or overwrite the field at its handle. An out-of-range handle
    /// returns `false`; the caller counts it.
    pub fn set_field(&mut self, field: NetFieldExport) -> bool {
        let idx = field.handle as usize;
        if idx >= self.fields.len() {
            return false;
        }
        self.fields[idx] = Some(field);
        true
    }

    /// Populated fields, in handle order.
    pub fn populated_fields(&self) -> impl Iterator<Item = &NetFieldExport> {
        self.fields.iter().filter_map(|slot| slot.as_ref())
    }

    /// Merge `other`'s populated fields over this group's, growing it to
    /// `other`'s length if that is larger.
    pub fn merge_from(&mut self, other: &NetFieldExportGroup) {
        if other.fields.len() > self.fields.len() {
            self.fields.resize(other.fields.len(), None);
        }
        for (i, slot) in other.fields.iter().enumerate() {
            if let Some(field) = slot {
                self.fields[i] = Some(field.clone());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::render_fname;

    #[test]
    fn render_fname_positive_and_zero() {
        assert_eq!(render_fname("Foo".into(), 0), "Foo");
        assert_eq!(render_fname("Foo".into(), 1), "Foo_0");
        assert_eq!(render_fname("Foo".into(), 3), "Foo_2");
    }

    /// Rendered as-is, not wrapped: `i32::MIN.wrapping_sub(1)` is `i32::MAX`,
    /// which reads as a normal suffix.
    #[test]
    fn render_fname_negative_is_not_wrapped_into_a_plausible_suffix() {
        assert_eq!(render_fname("Foo".into(), -1), "Foo_-1");
        assert_eq!(render_fname("Foo".into(), i32::MIN), "Foo_-2147483648");
    }
}
