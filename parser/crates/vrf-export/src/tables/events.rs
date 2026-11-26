//! The `events` table: one row per Event chunk, the server's own labelled
//! timeline (round starts, deaths, plants, defuses; see `schema::events_schema`).

use std::sync::Arc;

use arrow_array::RecordBatch;
use arrow_schema::Schema;

use super::batch;
use crate::error::ExportError;
use crate::record::EventRecord;
use crate::schema::events_schema_ref;
use crate::writer::{Table, TableWriter};

/// Rows per row group by default; a match's couple of hundred rows fit in one.
pub const DEFAULT_EVENT_ROW_GROUP_SIZE: usize = 131_072;

pub struct EventsTable;

/// Streaming Parquet writer for Event chunks.
pub type EventWriter<W> = TableWriter<EventsTable, W>;

impl Table for EventsTable {
    type Row = EventRecord;
    const DEFAULT_ROW_GROUP_SIZE: usize = DEFAULT_EVENT_ROW_GROUP_SIZE;
    // Listed numbers 0.74-0.91, unlisted 1.14-1.32; `id` 1.07 and `metadata`
    // 1.49, near-unique per row, are listed only as strings.
    const DICTIONARY_COLUMNS: &'static [&'static str] = &[
        "id",
        "group",
        "metadata",
        "payload_size",
        "word0",
        "word1",
        "payload_tag",
        "payload_name",
    ];
    fn schema() -> Arc<Schema> {
        events_schema_ref()
    }
    fn initial_capacity(_batch_rows: usize) -> usize {
        256
    }
    fn build_batch(rows: &[EventRecord]) -> Result<RecordBatch, ExportError> {
        batch(Self::schema(), EventRecord::columns(rows.iter()))
    }
}
