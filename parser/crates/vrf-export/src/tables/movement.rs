//! The `movement` table: one row per movement sample, the densest data in a
//! replay (~1.8 M rows a match).

use std::sync::Arc;

use arrow_array::RecordBatch;
use arrow_schema::Schema;

use super::batch;
use crate::error::ExportError;
use crate::record::MovementRecord;
use crate::schema::movement_schema_ref;
use crate::writer::{Table, TableWriter};

/// Rows per row group by default, 256 Ki: at 50 bytes a row uncompressed,
/// ~13 MB a group, a good ZSTD chunk.
pub const DEFAULT_MOVEMENT_ROW_GROUP_SIZE: usize = 262_144;

pub struct MovementTable;

/// Streaming Parquet writer for movement records.
pub type MovementWriter<W> = TableWriter<MovementTable, W>;

impl Table for MovementTable {
    type Row = MovementRecord;
    const DEFAULT_ROW_GROUP_SIZE: usize = DEFAULT_MOVEMENT_ROW_GROUP_SIZE;
    // No strings. Listed 0.76-0.95, unlisted 1.36-5.19.
    const DICTIONARY_COLUMNS: &'static [&'static str] = &[
        "character_net_guid",
        "vel_x",
        "vel_y",
        "vel_z",
        "movement_state",
        "move_type",
    ];
    fn schema() -> Arc<Schema> {
        movement_schema_ref()
    }
    fn build_batch(rows: &[MovementRecord]) -> Result<RecordBatch, ExportError> {
        batch(Self::schema(), MovementRecord::columns(rows.iter()))
    }
}
