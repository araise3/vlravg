//! The `fields` table: one row per decoded field, RPC parameter, or preserved
//! whole-block payload.

use std::sync::Arc;

use arrow_array::RecordBatch;
use arrow_schema::Schema;

use super::batch;
use crate::error::ExportError;
use crate::record::FieldRecord;
use crate::schema::fields_schema_ref;
use crate::writer::{Table, TableWriter};

/// Rows per row group by default, 128 Ki: column chunks large enough for ZSTD
/// to reach steady state.
pub const DEFAULT_ROW_GROUP_SIZE: usize = 131_072;

pub struct FieldsTable;

/// Streaming Parquet writer for field records.
pub type FieldWriter<W> = TableWriter<FieldsTable, W>;

impl Table for FieldsTable {
    type Row = FieldRecord;
    const DEFAULT_ROW_GROUP_SIZE: usize = DEFAULT_ROW_GROUP_SIZE;
    // Listed numbers 0.66-0.95, unlisted 1.07-3.16.
    const DICTIONARY_COLUMNS: &'static [&'static str] = &[
        "channel_index",
        "actor_net_guid",
        "group_path",
        "handle",
        "field_name",
        "bit_count",
        "value_i64",
        "value_str",
    ];
    fn schema() -> Arc<Schema> {
        fields_schema_ref()
    }
    fn build_batch(rows: &[FieldRecord]) -> Result<RecordBatch, ExportError> {
        batch(Self::schema(), FieldRecord::columns(rows.iter()))
    }
}
