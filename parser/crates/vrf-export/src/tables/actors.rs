//! The `actors` table: one row per actor channel open, close or dormancy
//! (what it is for: `schema::actors_schema`).

use std::sync::Arc;

use arrow_array::RecordBatch;
use arrow_schema::Schema;

use super::batch;
use crate::error::ExportError;
use crate::record::ActorRecord;
use crate::schema::actors_schema_ref;
use crate::writer::{Table, TableWriter};

/// Rows per row group by default; the ~4 K rows of a match fit in one.
pub const DEFAULT_ACTOR_ROW_GROUP_SIZE: usize = 131_072;

pub struct ActorsTable;

/// Streaming Parquet writer for actor lifecycle records.
pub type ActorWriter<W> = TableWriter<ActorsTable, W>;

impl Table for ActorsTable {
    type Row = ActorRecord;
    const DEFAULT_ROW_GROUP_SIZE: usize = DEFAULT_ACTOR_ROW_GROUP_SIZE;
    // Listed number 0.84, unlisted 1.07-1.77.
    const DICTIONARY_COLUMNS: &'static [&'static str] =
        &["channel_index", "event", "class_path", "archetype_path"];
    fn schema() -> Arc<Schema> {
        actors_schema_ref()
    }
    fn initial_capacity(_batch_rows: usize) -> usize {
        4096
    }
    fn build_batch(rows: &[ActorRecord]) -> Result<RecordBatch, ExportError> {
        batch(Self::schema(), ActorRecord::columns(rows.iter()))
    }
}
