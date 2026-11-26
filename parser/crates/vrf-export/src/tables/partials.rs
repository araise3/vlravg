use super::batch;
use crate::schema::partials_schema_ref;
use crate::writer::{Table, TableWriter};
use crate::{ExportError, PartialRecord};
use arrow_array::RecordBatch;
use arrow_schema::Schema;
use std::sync::Arc;

pub struct PartialsTable;
pub type PartialWriter<W> = TableWriter<PartialsTable, W>;

impl Table for PartialsTable {
    type Row = PartialRecord;
    const DEFAULT_ROW_GROUP_SIZE: usize = 131_072;
    // Unmeasured: no sample replay wrote a partial row. Strings by rule only.
    const DICTIONARY_COLUMNS: &'static [&'static str] =
        &["source", "checkpoint_id", "payload_kind", "reason"];
    const MAX_BUFFERED_BYTES: usize = 8 * 1024 * 1024;
    fn retained_bytes(row: &PartialRecord) -> usize {
        row.raw_bits.len() + row.checkpoint_id.as_ref().map_or(0, String::len)
    }
    fn schema() -> Arc<Schema> {
        partials_schema_ref()
    }
    fn initial_capacity(_: usize) -> usize {
        256
    }
    fn build_batch(rows: &[PartialRecord]) -> Result<RecordBatch, ExportError> {
        batch(Self::schema(), PartialRecord::columns(rows.iter()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(bytes: usize) -> PartialRecord {
        PartialRecord {
            source: "main",
            checkpoint_id: None,
            payload_kind: "current_fragment",
            reason: "missing_initial",
            source_packet_id: 0,
            source_payload_bit_offset: 0,
            rejection_packet_id: Some(0),
            channel_index: 1,
            channel_sequence: 1,
            open: false,
            close: false,
            dormant: false,
            replication_paused: false,
            reliable: false,
            partial: true,
            partial_initial: false,
            partial_final: true,
            has_package_map_exports: false,
            has_must_be_mapped_guids: false,
            close_reason: 0,
            source_payload_bit_count: (bytes * 8) as i32,
            bit_count: (bytes * 8) as u64,
            raw_bits: vec![0; bytes],
        }
    }

    #[test]
    fn raw_payload_budget_flushes_before_growth_and_immediately_after_an_oversized_row() {
        use parquet::file::reader::{FileReader, SerializedFileReader};
        let path = std::env::temp_dir().join(format!(
            "vrfkit-partial-budget-{}.parquet",
            std::process::id()
        ));
        let file = std::fs::File::create(&path).unwrap();
        let mut writer = PartialWriter::new(file).unwrap();
        writer.push(row(5 * 1024 * 1024)).unwrap();
        assert_eq!(writer.buffered_rows(), 1);
        writer.push(row(5 * 1024 * 1024)).unwrap();
        assert_eq!(
            writer.buffered_rows(),
            1,
            "the first row flushed before adding the second"
        );
        writer.push(row(9 * 1024 * 1024)).unwrap();
        assert_eq!(
            writer.buffered_rows(),
            0,
            "an individually oversized row flushes immediately"
        );
        writer.finish().unwrap();
        let reader = SerializedFileReader::new(std::fs::File::open(&path).unwrap()).unwrap();
        assert_eq!(
            reader.num_row_groups(),
            3,
            "each byte-budget flush closes its row group"
        );
        std::fs::remove_file(path).unwrap();
    }
}
