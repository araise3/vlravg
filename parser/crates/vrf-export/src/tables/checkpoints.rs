//! The seven checkpoint-scoped tables: fields, actors, NetGUIDs and blocks as
//! decoded from each checkpoint, plus its GUID entries and export declarations.
//! The three declaration tables' numeric dictionary choices were measured
//! while every 8,192-row batch closed its own row group (ten for the reference
//! replay's GUID entries), not the one written now: re-measure before relying
//! on them.

use std::sync::Arc;

use arrow_array::{ArrayRef, RecordBatch};
use arrow_schema::Schema;

use super::batch;
use crate::ExportError;
use crate::record::{
    ActorRecord, CheckpointActorRecord, CheckpointBlockRecord, CheckpointExportFieldRecord,
    CheckpointExportGroupRecord, CheckpointFieldRecord, CheckpointGuidEntryRecord,
    CheckpointIdentity, CheckpointNetGuidRecord, FieldRecord, NetGuidRecord,
};
use crate::schema::{
    checkpoint_actors_schema_ref, checkpoint_blocks_schema_ref,
    checkpoint_export_fields_schema_ref, checkpoint_export_groups_schema_ref,
    checkpoint_fields_schema_ref, checkpoint_guid_entries_schema_ref,
    checkpoint_net_guids_schema_ref,
};
use crate::writer::{Table, TableWriter};

pub struct CheckpointFieldsTable;
pub struct CheckpointActorsTable;
pub struct CheckpointNetGuidsTable;
pub struct CheckpointBlocksTable;
pub struct CheckpointGuidEntriesTable;
pub struct CheckpointExportGroupsTable;
pub struct CheckpointExportFieldsTable;
pub type CheckpointFieldWriter<W> = TableWriter<CheckpointFieldsTable, W>;
pub type CheckpointActorWriter<W> = TableWriter<CheckpointActorsTable, W>;
pub type CheckpointNetGuidWriter<W> = TableWriter<CheckpointNetGuidsTable, W>;
pub type CheckpointBlockWriter<W> = TableWriter<CheckpointBlocksTable, W>;
pub type CheckpointGuidEntryWriter<W> = TableWriter<CheckpointGuidEntriesTable, W>;
pub type CheckpointExportGroupWriter<W> = TableWriter<CheckpointExportGroupsTable, W>;
pub type CheckpointExportFieldWriter<W> = TableWriter<CheckpointExportFieldsTable, W>;

/// A batch of the two identity columns every checkpoint schema starts with,
/// then `columns`.
fn checkpoint_batch<'a>(
    schema: Arc<Schema>,
    identities: impl ExactSizeIterator<Item = &'a CheckpointIdentity> + Clone,
    columns: Vec<ArrayRef>,
) -> Result<RecordBatch, ExportError> {
    let mut all = CheckpointIdentity::columns(identities);
    all.extend(columns);
    batch(schema, all)
}

impl Table for CheckpointGuidEntriesTable {
    type Row = CheckpointGuidEntryRecord;
    const DEFAULT_ROW_GROUP_SIZE: usize = 131_072;
    const MAX_BUFFERED_BYTES: usize = 8 * 1024 * 1024;
    const DICTIONARY_COLUMNS: &'static [&'static str] = &["checkpoint_id", "literal_path", "flags"];
    fn schema() -> Arc<Schema> {
        checkpoint_guid_entries_schema_ref()
    }
    fn retained_bytes(row: &Self::Row) -> usize {
        row.checkpoint.checkpoint_id.len() + row.literal_path.as_ref().map_or(0, String::len)
    }
    fn build_batch(rows: &[Self::Row]) -> Result<RecordBatch, ExportError> {
        let columns = CheckpointGuidEntryRecord::columns(rows.iter());
        checkpoint_batch(Self::schema(), rows.iter().map(|r| &r.checkpoint), columns)
    }
}

impl Table for CheckpointExportGroupsTable {
    type Row = CheckpointExportGroupRecord;
    const DEFAULT_ROW_GROUP_SIZE: usize = 131_072;
    const MAX_BUFFERED_BYTES: usize = 8 * 1024 * 1024;
    const DICTIONARY_COLUMNS: &'static [&'static str] = &["checkpoint_id", "group_path"];
    fn schema() -> Arc<Schema> {
        checkpoint_export_groups_schema_ref()
    }
    fn retained_bytes(row: &Self::Row) -> usize {
        row.checkpoint.checkpoint_id.len() + row.group_path.len()
    }
    fn build_batch(rows: &[Self::Row]) -> Result<RecordBatch, ExportError> {
        let columns = CheckpointExportGroupRecord::columns(rows.iter());
        checkpoint_batch(Self::schema(), rows.iter().map(|r| &r.checkpoint), columns)
    }
}

impl Table for CheckpointExportFieldsTable {
    type Row = CheckpointExportFieldRecord;
    const DEFAULT_ROW_GROUP_SIZE: usize = 131_072;
    const MAX_BUFFERED_BYTES: usize = 8 * 1024 * 1024;
    const DICTIONARY_COLUMNS: &'static [&'static str] =
        &["checkpoint_id", "rendered_name", "fname_kind", "fname_base"];
    fn schema() -> Arc<Schema> {
        checkpoint_export_fields_schema_ref()
    }
    fn retained_bytes(row: &Self::Row) -> usize {
        row.checkpoint.checkpoint_id.len()
            + row.rendered_name.len()
            + row.fname_base.as_ref().map_or(0, String::len)
    }
    fn build_batch(rows: &[Self::Row]) -> Result<RecordBatch, ExportError> {
        let columns = CheckpointExportFieldRecord::columns(rows.iter());
        checkpoint_batch(Self::schema(), rows.iter().map(|r| &r.checkpoint), columns)
    }
}

impl Table for CheckpointBlocksTable {
    type Row = CheckpointBlockRecord;
    const DEFAULT_ROW_GROUP_SIZE: usize = 131_072;
    // Listed numbers 0.76-0.91, unlisted 1.04-4.18.
    const DICTIONARY_COLUMNS: &'static [&'static str] = &[
        "checkpoint_id",
        "class_net_guid",
        "resolved_group_path",
        "group_resolution_source",
        "function_count_source",
        "actor_archetype_path",
        "actor_archetype_outer_path",
        "actor_guid_path",
        "class_guid_path",
        "object_guid_path",
        "object_outer_path",
        "field_row_count",
    ];
    fn schema() -> Arc<Schema> {
        checkpoint_blocks_schema_ref()
    }
    fn build_batch(rows: &[Self::Row]) -> Result<RecordBatch, ExportError> {
        let columns = CheckpointBlockRecord::columns(rows.iter());
        checkpoint_batch(Self::schema(), rows.iter().map(|r| &r.checkpoint), columns)
    }
}

impl Table for CheckpointFieldsTable {
    type Row = CheckpointFieldRecord;
    const DEFAULT_ROW_GROUP_SIZE: usize = 131_072;
    // Listed numbers 0.51-0.91, unlisted 1.08-1.37. raw_bits and value_f64 are
    // listed here, not in `fields`: snapshots restate values (7,084 distinct
    // raw_bits in 343,683 on the reference replay).
    const DICTIONARY_COLUMNS: &'static [&'static str] = &[
        "checkpoint_index",
        "checkpoint_id",
        "time_ms",
        "group_path",
        "handle",
        "field_name",
        "bit_count",
        "raw_bits",
        "value_i64",
        "value_f64",
        "value_str",
    ];
    fn schema() -> Arc<Schema> {
        checkpoint_fields_schema_ref()
    }
    fn build_batch(rows: &[Self::Row]) -> Result<RecordBatch, ExportError> {
        let columns = FieldRecord::columns(rows.iter().map(|r| &r.field));
        checkpoint_batch(Self::schema(), rows.iter().map(|r| &r.checkpoint), columns)
    }
}

impl Table for CheckpointActorsTable {
    type Row = CheckpointActorRecord;
    const DEFAULT_ROW_GROUP_SIZE: usize = 131_072;
    // Listed numbers 0.77-0.98, unlisted 1.07-1.93. The spawn columns are
    // listed here, not in `actors`: each checkpoint restates the live actors
    // (163 distinct spawn_x in 2,549 on the reference replay).
    const DICTIONARY_COLUMNS: &'static [&'static str] = &[
        "checkpoint_id",
        "channel_index",
        "event",
        "class_path",
        "archetype_path",
        "spawn_x",
        "spawn_y",
        "spawn_z",
        "spawn_yaw",
    ];
    fn schema() -> Arc<Schema> {
        checkpoint_actors_schema_ref()
    }
    fn initial_capacity(_: usize) -> usize {
        4096
    }
    fn build_batch(rows: &[Self::Row]) -> Result<RecordBatch, ExportError> {
        let columns = ActorRecord::columns(rows.iter().map(|r| &r.actor));
        checkpoint_batch(Self::schema(), rows.iter().map(|r| &r.checkpoint), columns)
    }
}

impl Table for CheckpointNetGuidsTable {
    type Row = CheckpointNetGuidRecord;
    const DEFAULT_ROW_GROUP_SIZE: usize = 131_072;
    // Listed number 0.92, unlisted 1.78-2.30.
    const DICTIONARY_COLUMNS: &'static [&'static str] =
        &["checkpoint_index", "checkpoint_id", "path"];
    fn schema() -> Arc<Schema> {
        checkpoint_net_guids_schema_ref()
    }
    fn initial_capacity(_: usize) -> usize {
        4096
    }
    fn build_batch(rows: &[Self::Row]) -> Result<RecordBatch, ExportError> {
        let columns = NetGuidRecord::columns(rows.iter().map(|r| &r.net_guid));
        checkpoint_batch(Self::schema(), rows.iter().map(|r| &r.checkpoint), columns)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::record::{ActorRecord, CheckpointIdentity, FieldRecord, NetGuidRecord};
    use crate::schema::fields_schema;
    use arrow_array::Array;
    use arrow_array::cast::AsArray;
    use arrow_array::types::{Int64Type, UInt8Type, UInt32Type, UInt64Type};
    use smallvec::smallvec;

    fn identities() -> [CheckpointIdentity; 2] {
        [
            CheckpointIdentity {
                checkpoint_index: 3,
                checkpoint_id: Arc::from("same"),
            },
            CheckpointIdentity {
                checkpoint_index: 4,
                checkpoint_id: Arc::from("same"),
            },
        ]
    }

    /// The column named `name`.
    fn col<'a>(batch: &'a RecordBatch, name: &str) -> &'a ArrayRef {
        batch
            .column_by_name(name)
            .unwrap_or_else(|| panic!("no column named {name}"))
    }

    fn u32s<'a>(batch: &'a RecordBatch, name: &str) -> &'a [u32] {
        col(batch, name).as_primitive::<UInt32Type>().values()
    }

    #[test]
    fn duplicate_wire_ids_remain_distinct_and_payload_values_are_unchanged() {
        let [a, b] = identities();
        let field = |checkpoint| CheckpointFieldRecord {
            checkpoint,
            field: FieldRecord {
                time_ms: 7,
                packet_id: 0,
                channel_index: 2,
                actor_net_guid: 9,
                object_net_guid: Some(10),
                group_path: Arc::from("group"),
                handle: 11,
                field_name: Some(Arc::from("field")),
                compatible_checksum: Some(12),
                bit_count: 5,
                raw_bits: Some(smallvec![0x15]),
                value_i64: Some(42),
                value_f64: None,
                value_bool: None,
                value_str: None,
            },
        };
        let batch =
            CheckpointFieldsTable::build_batch(&[field(a.clone()), field(b.clone())]).unwrap();
        assert_eq!(u32s(&batch, "checkpoint_index"), &[3, 4]);
        assert_eq!(
            col(&batch, "checkpoint_id").as_string::<i32>().value(0),
            "same"
        );
        assert_eq!(col(&batch, "raw_bits").as_binary::<i32>().value(1), &[0x15]);
        assert_eq!(
            col(&batch, "value_i64")
                .as_primitive::<Int64Type>()
                .value(0),
            42
        );
        assert_eq!(
            fields_schema().fields()[0].name(),
            "time_ms",
            "main schema must not acquire checkpoint identity"
        );

        let actor = |checkpoint| CheckpointActorRecord {
            checkpoint,
            actor: ActorRecord {
                time_ms: 7,
                packet_id: 0,
                channel_index: 2,
                actor_net_guid: 9,
                event: "open",
                class_path: Some("class".into()),
                spawn_x: Some(1.0),
                ..ActorRecord::default()
            },
        };
        let actors =
            CheckpointActorsTable::build_batch(&[actor(a.clone()), actor(b.clone())]).unwrap();
        assert_eq!(u32s(&actors, "checkpoint_index"), &[3, 4]);
        assert_eq!(u32s(&actors, "packet_id"), &[0, 0]);

        let guid = |checkpoint| CheckpointNetGuidRecord {
            checkpoint,
            net_guid: NetGuidRecord {
                net_guid: 9,
                path: "path".into(),
                outer_net_guid: Some(1),
            },
        };
        let guids = CheckpointNetGuidsTable::build_batch(&[guid(a), guid(b)]).unwrap();
        assert_eq!(u32s(&guids, "checkpoint_index"), &[3, 4]);
        assert_eq!(u32s(&guids, "net_guid"), &[9, 9]);

        let [a, b] = identities();
        let block = |checkpoint| CheckpointBlockRecord {
            checkpoint,
            block_index: 0,
            time_ms: 7,
            packet_id: 0,
            channel_index: 2,
            actor_net_guid: 9,
            object_net_guid: Some(0),
            class_net_guid: Some(0),
            outer_net_guid: Some(9),
            has_rep_layout: true,
            is_actor: false,
            is_deleted: false,
            is_stably_named: false,
            delete_flags: 0,
            resolved_group_path: Arc::from("group"),
            group_resolution_source: "replay_declared_group",
            group_declared: true,
            resolution_memo_hit: false,
            function_count: 0,
            function_count_source: "rep_layout_not_applicable",
            actor_archetype_path: None,
            actor_archetype_outer_path: None,
            actor_guid_path: None,
            class_guid_path: None,
            object_guid_path: Some("object".into()),
            object_outer_path: None,
            field_row_start: 12,
            field_row_count: 2,
        };
        let blocks = CheckpointBlocksTable::build_batch(&[block(a), block(b)]).unwrap();
        assert_eq!(u32s(&blocks, "checkpoint_index"), &[3, 4]);
        assert_eq!(u32s(&blocks, "class_net_guid"), &[0, 0]);
        assert_eq!(
            col(&blocks, "field_row_start")
                .as_primitive::<UInt64Type>()
                .values(),
            &[12, 12]
        );
    }

    #[test]
    fn declaration_tables_preserve_raw_forms_sparse_slots_and_empty_groups() {
        let checkpoint = identities()[0].clone();
        let guid_rows = [
            CheckpointGuidEntryRecord {
                checkpoint: checkpoint.clone(),
                ordinal: 0,
                net_guid: 7,
                outer_net_guid: 0,
                path_is_string: true,
                literal_path: Some("18".into()),
                name_index: None,
                flags: 0,
            },
            CheckpointGuidEntryRecord {
                checkpoint: checkpoint.clone(),
                ordinal: 1,
                net_guid: 8,
                outer_net_guid: 7,
                path_is_string: false,
                literal_path: None,
                name_index: Some(18),
                flags: 3,
            },
        ];
        let guids = CheckpointGuidEntriesTable::build_batch(&guid_rows).unwrap();
        let path_is_string = col(&guids, "path_is_string").as_boolean();
        let name_index = col(&guids, "name_index").as_primitive::<UInt32Type>();
        let flags = col(&guids, "flags").as_primitive::<UInt8Type>();
        assert_eq!(
            [path_is_string.value(0), path_is_string.value(1)],
            [true, false]
        );
        assert!(name_index.is_null(0));
        assert_eq!(name_index.value(1), 18);
        assert_eq!(flags.values(), &[0, 3]);

        let groups = CheckpointExportGroupsTable::build_batch(&[CheckpointExportGroupRecord {
            checkpoint: checkpoint.clone(),
            ordinal: 4,
            path_name_index: 18,
            group_path: "18".into(),
            declared_slots: 0,
        }])
        .unwrap();
        assert_eq!(u32s(&groups, "declared_slots"), &[0]);

        let fields = CheckpointExportFieldsTable::build_batch(&[CheckpointExportFieldRecord {
            checkpoint,
            group_ordinal: 9,
            path_name_index: 18,
            slot: 6,
            handle: 31,
            compatible_checksum: 0x1234,
            rendered_name: "44".into(),
            exported_flag: 2,
            fname_kind: 1,
            fname_base: None,
            fname_index: Some(44),
            fname_number: None,
        }])
        .unwrap();
        assert_eq!(u32s(&fields, "slot"), &[6]);
        assert_eq!(
            col(&fields, "exported_flag")
                .as_primitive::<UInt8Type>()
                .value(0),
            2
        );
        assert_eq!(
            col(&fields, "fname_index")
                .as_primitive::<UInt32Type>()
                .value(0),
            44
        );
    }
}
