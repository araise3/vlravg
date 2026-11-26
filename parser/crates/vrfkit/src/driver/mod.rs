//! `export` subcommand driver -- full pipeline from .vrf to Parquet.
//!
//! One wire-order pass: the frame walk applies a frame's ExportData, then
//! lends that exact cache state to its packets, so packet-side export
//! mutations precede the next packet and a later frame's schema cannot leak
//! backward. [`writers`] runs the large tables off the packet loop,
//! [`checkpoints`] is the optional snapshot pass on its own thread,
//! [`publish`] stages and publishes the directory, and [`summary`] prints the
//! stderr report whose labels the Python harnesses parse.

pub(crate) mod checkpoints;
pub(crate) mod compact;
mod publish;
mod summary;
mod writers;

use std::fs;
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::thread;
use std::time::Instant;

use vrf_container::{
    event_payload_seconds_matches_time, known_event_word_count, parse_event_chunk,
    parse_known_event_payload, parse_preamble,
};
use vrf_export::{
    ActorWriter, EventRecord, EventWriter, FieldWriter, MovementWriter, NetGuidRecord,
    NetGuidWriter, PartialRecord, PartialWriter,
};
use vrf_schema::NetGuidCache;

use crate::error::CliError;
use crate::manifest::{self, ManifestQuality};
use crate::pass::{Chunk, Pass, Replay, for_each_chunk};
use publish::OutputTransaction;
pub(crate) use summary::RunTotals;
use writers::WriterThread;

/// The six tables every export writes. With [`CHECKPOINT_TABLES`] and
/// [`MANIFEST`], every name `run` creates: `publish` refuses a destination
/// holding anything else, so a table missing here makes the next export to
/// that directory refuse it.
const MAIN_TABLES: [&str; 6] = [
    "fields.parquet",
    "movement.parquet",
    "actors.parquet",
    "net_guids.parquet",
    "events.parquet",
    "partials.parquet",
];
/// The tables written only when `--checkpoints` asks for them.
const CHECKPOINT_TABLES: [&str; 7] = [
    "checkpoint_fields.parquet",
    "checkpoint_actors.parquet",
    "checkpoint_net_guids.parquet",
    "checkpoint_blocks.parquet",
    "checkpoint_guid_entries.parquet",
    "checkpoint_export_groups.parquet",
    "checkpoint_export_fields.parquet",
];
/// Written after every table is complete.
const MANIFEST: &str = "manifest.json";

pub fn run(
    vrf_path: &str,
    out_dir: &str,
    with_checkpoints: bool,
    compact_meta: Option<compact::CompactMeta>,
    require_pass: bool,
) -> Result<u8, CliError> {
    let start = Instant::now();

    eprintln!("reading {vrf_path}...");
    let data = fs::read(vrf_path)?;
    let file_size = data.len();

    let preamble = parse_preamble(&data)?;
    let replay = Replay::new(&preamble);
    eprintln!(
        "branch: {}, flags: 0x{:04X}, compressed: {}, duration: {} ms",
        replay.branch, replay.flags, replay.compressed, preamble.info.length_in_ms
    );

    let destination = PathBuf::from(out_dir);
    let output = OutputTransaction::begin(&destination)?;
    let out_path = output.path();

    let create = |name: &str| -> Result<BufWriter<fs::File>, CliError> {
        Ok(BufWriter::new(fs::File::create(out_path.join(name))?))
    };

    let mut actor_writer = ActorWriter::new(create("actors.parquet")?)?;
    // A couple of hundred rows, so inline like `actors`: far below a thread's
    // worth of encoding.
    let mut event_writer = EventWriter::new(create("events.parquet")?)?;
    let mut partial_writer = PartialWriter::new(create("partials.parquet")?)?;
    let checkpoint_writers = with_checkpoints
        .then(|| checkpoints::CheckpointWriters::new(create))
        .transpose()?;

    let mut fields =
        WriterThread::spawn_table("fields", FieldWriter::new(create("fields.parquet")?)?);
    let mut movement = WriterThread::spawn_table(
        "movement",
        MovementWriter::new(create("movement.parquet")?)?,
    );

    let mut pass = Pass::new(&replay)?;
    let mut totals = RunTotals::default();
    let mut collector = compact_meta.as_ref().map(|_| compact::CompactCollector::default());

    // The checkpoint pass shares only the chunk list with this one, so it runs
    // beside it; a main-pass error waits for it and wins.
    let (main, checkpoints) = thread::scope(|scope| {
        let worker = checkpoint_writers
            .map(|writers| scope.spawn(|| checkpoints::run(&data, &replay, writers)));
        let main = for_each_chunk(&data, &replay, |chunk| {
            match chunk {
                Chunk::Event(payload) => {
                    write_event(payload, &mut event_writer, &mut totals, collector.as_mut())?;
                }
                Chunk::ReplayData(frames, unread) => {
                    totals.replay_data_trailing_bytes += unread as u64;
                    pass.walk(&frames, &mut totals.sink, |buffers| {
                        fields.append(&mut buffers.fields)?;
                        totals.movement_rows += buffers.movement.len() as u64;
                        if let Some(c) = collector.as_mut() {
                            c.movement(&buffers.movement);
                        }
                        movement.append(&mut buffers.movement)?;
                        actor_writer.push_batch(buffers.actors.drain(..))?;
                        push_partials(
                            &mut partial_writer,
                            buffers.partials.drain(..),
                            &mut totals.partial_rows,
                            &mut totals.partial_bits,
                        )
                    })?;
                    totals.chunks_processed += 1;
                }
                Chunk::Checkpoint(_) => {}
            }
            Ok(())
        });
        let checkpoints = worker.map(|worker| {
            (worker.join())
                .unwrap_or_else(|_| Err(CliError::Usage("checkpoint pass panicked".to_owned())))
        });
        (main, checkpoints.transpose())
    });
    totals.unknown_chunks = main?;
    let mut checkpoints = checkpoints?;

    // Joined before the elapsed time is taken and any file size is read, so
    // both files are complete and both results are checked.
    fields.finish()?;
    movement.finish()?;
    pass.finish();
    push_partials(
        &mut partial_writer,
        pass.buffers.partials.drain(..),
        &mut totals.partial_rows,
        &mut totals.partial_bits,
    )?;
    // Both passes' decode errors: the only place a checkpoint-only one surfaces.
    let mut error_report = std::mem::take(&mut totals.sink.overlay.error_report);
    // After every main-pass row: partials.parquet is ordered by pass, then
    // stream position.
    if let Some(cp) = checkpoints.as_mut() {
        error_report.merge_from(&cp.stats.sink.overlay.error_report);
        push_partials(
            &mut partial_writer,
            cp.partials.drain(..),
            &mut cp.stats.partial_rows,
            &mut cp.stats.partial_bits,
        )?;
    }
    actor_writer.finish()?;
    event_writer.finish()?;
    partial_writer.finish()?;

    // After the pass: a GUID's outer may be declared in a later chunk than the
    // one that first referenced it.
    let net_guids = net_guid_rows(&pass.cache);
    totals.net_guid_rows = net_guids.len();
    let mut net_guid_writer = NetGuidWriter::new(create("net_guids.parquet")?)?;
    net_guid_writer.push_batch(net_guids)?;
    net_guid_writer.finish()?;

    let net_stats = pass.reader.stats();
    totals.export_groups = pass.cache.group_count();
    totals.total_packets = pass.packets;
    totals.frames = pass.frames;
    totals.frame_skips = pass.frame_skips;
    totals.non_finite_frame_times = pass.non_finite_frame_times;
    totals.elapsed = start.elapsed();

    // Before the summary, so the path it prints names a file that exists.
    let staged_manifest_path = out_path.join(MANIFEST);
    let mut players: Vec<_> = (pass.channels.players().iter())
        .filter(|(_, id)| id.subject.is_some())
        .map(|(&guid, id)| (guid, id))
        .collect();
    players.sort_unstable_by_key(|(guid, _)| *guid);
    manifest::write_manifest(
        &staged_manifest_path,
        vrf_path,
        file_size,
        &preamble,
        &pass.cache,
        &players,
        &ManifestQuality {
            run: &totals,
            net: net_stats,
            error_report: &error_report,
            checkpoints: checkpoints.as_ref().map(|cp| &cp.stats),
        },
    )?;

    // `validate`'s verdict, from this pass's own counters: the same oracle
    // over the same ReplayData stream, without a second decode.
    let verdict = crate::oracle::verdict_from_stats(net_stats, totals.replay_data_trailing_bytes);
    if require_pass && verdict != crate::oracle::Verdict::Passed {
        eprintln!("error: oracle verdict {verdict:?}; nothing published");
        return Ok(crate::cli::EXIT_DECODER);
    }

    // The compact document, from the same pass; written beside the export.
    if let (Some(meta), Some(collector)) = (compact_meta.as_ref(), collector) {
        let quality = compact::CompactQuality {
            content_blocks_lost: net_stats.lost_content_blocks(),
            movement_rows: totals.movement_rows,
            event_rows: totals.event_rows,
            malformed_packets: net_stats.malformed_packets,
            transform_failures: net_stats.transform_failures,
        };
        let facts = compact::ReplayFacts::from_preamble(&preamble);
        match compact::build(meta, collector, &facts, &players, &quality) {
            Ok(doc) => fs::write(&meta.out, doc)?,
            Err(e) => {
                eprintln!("error: {e}");
                return Ok(crate::cli::EXIT_COMPACT);
            }
        }
    }

    // Before `publish`: see `summary::stale_checkpoint_note`.
    totals.stale_checkpoint_note = summary::stale_checkpoint_note(&destination, with_checkpoints);

    // Every table and the manifest are complete and closed. A run that failed
    // before here dropped the guard, removing staging only.
    output.publish()?;
    let manifest_path = destination.join(MANIFEST);

    summary::print(
        &destination,
        net_stats,
        &totals,
        &error_report,
        checkpoints.as_ref().map(|cp| &cp.stats),
        &manifest_path,
    );

    Ok(0)
}

/// The server's own labelled timeline: uncompressed and independent of
/// replication, so written straight out. Layout [u32 tag][N x u32
/// words][FString][f32] for groups whose word count, tag and public name are
/// established; the parse must consume it exactly and its seconds must match
/// Time1. A mismatch is counted, never guessed at; `raw_payload` keeps every
/// byte.
fn write_event<W: Write + Send>(
    payload: &[u8],
    writer: &mut EventWriter<W>,
    totals: &mut RunTotals,
    collector: Option<&mut compact::CompactCollector>,
) -> Result<(), CliError> {
    let event = parse_event_chunk(payload)?;
    totals.event_trailing_bytes += event.trailing_bytes as u64;
    let parsed_payload = match known_event_word_count(&event.group) {
        Some(count) => {
            let parsed = parse_known_event_payload(&event.group, event.payload)
                .filter(|payload| event_payload_seconds_matches_time(event.time1, payload.seconds));
            if parsed.is_some() {
                totals.event_payloads_decoded += 1;
            } else {
                totals.event_layout_mismatches += 1;
                totals.event_first_layout_mismatch.get_or_insert_with(|| {
                    format!(
                        "{} declared {count} word(s), public tag/name and millisecond time but its {}-byte payload does not fit that layout",
                        event.group,
                        event.payload.len()
                    )
                });
            }
            parsed
        }
        None => {
            totals.event_payload_unknown_groups += 1;
            None
        }
    };
    let (word0, word1, payload_tag, payload_name, payload_seconds) = match parsed_payload {
        Some(parsed) => (
            parsed.words.first().copied(),
            parsed.words.get(1).copied(),
            Some(parsed.tag),
            Some(parsed.name),
            Some(parsed.seconds),
        ),
        None => (None, None, None, None, None),
    };
    if let Some(c) = collector {
        c.event(event.time1, &event.id, &event.group, word0, word1);
    }
    writer.push(EventRecord {
        id: event.id,
        group: event.group,
        metadata: event.metadata,
        time1: event.time1,
        time2: event.time2,
        payload_size: event.size_in_bytes,
        raw_payload: event.payload.to_vec(),
        word0,
        word1,
        payload_tag,
        payload_name,
        payload_seconds,
    })?;
    totals.event_rows += 1;
    Ok(())
}

/// Write `records`, counting each into `rows` and `bits` as it reaches the
/// writer. The checkpoint pass labels its own rows; the rest are the main
/// pass's.
fn push_partials<W: Write + Send>(
    writer: &mut PartialWriter<W>,
    records: impl IntoIterator<Item = PartialRecord>,
    rows: &mut u64,
    bits: &mut u64,
) -> Result<(), CliError> {
    writer.push_batch(records.into_iter().map(|mut record| {
        *rows += 1;
        *bits += record.bit_count;
        if record.checkpoint_id.is_none() {
            record.source = "main";
        }
        record
    }))?;
    Ok(())
}

/// The cache's GUID table as rows, sorted: the cache is a HashMap and the file
/// must be byte-reproducible.
fn net_guid_rows(cache: &NetGuidCache) -> Vec<NetGuidRecord> {
    let mut entries = cache.net_guid_entries();
    entries.sort_unstable_by_key(|entry| entry.net_guid);
    entries
        .into_iter()
        .map(|entry| NetGuidRecord {
            net_guid: entry.net_guid,
            path: entry.path.to_owned(),
            outer_net_guid: entry.outer_net_guid,
        })
        .collect()
}
