//! The `net_guids` table: one row per NetGUID the replay registered, with its
//! object path and containing object (why: `schema::net_guids_schema`).

use std::sync::Arc;

use arrow_array::RecordBatch;
use arrow_schema::Schema;

use super::batch;
use crate::error::ExportError;
use crate::record::NetGuidRecord;
use crate::schema::net_guids_schema_ref;
use crate::writer::{Table, TableWriter};

/// Rows per row group by default; the ~16 K rows of a match fit in one.
pub const DEFAULT_NET_GUID_ROW_GROUP_SIZE: usize = 131_072;

pub struct NetGuidsTable;

/// Streaming Parquet writer for NetGUID registrations.
pub type NetGuidWriter<W> = TableWriter<NetGuidsTable, W>;

impl Table for NetGuidsTable {
    type Row = NetGuidRecord;
    const DEFAULT_ROW_GROUP_SIZE: usize = DEFAULT_NET_GUID_ROW_GROUP_SIZE;
    // `path` 0.98, smaller on 30 of 45; unlisted 1.74-2.07.
    const DICTIONARY_COLUMNS: &'static [&'static str] = &["path"];
    fn schema() -> Arc<Schema> {
        net_guids_schema_ref()
    }
    fn initial_capacity(_batch_rows: usize) -> usize {
        4096
    }
    fn build_batch(rows: &[NetGuidRecord]) -> Result<RecordBatch, ExportError> {
        batch(Self::schema(), NetGuidRecord::columns(rows.iter()))
    }
}
