//! Parquet writers running off the packet loop: inline, encoding `fields` and
//! `movement` was 37% of an export. Each table is an independent file, so each
//! runs on its own thread behind a bounded channel (backpressure); one
//! consumer sees every record once, in stream order, and row groups close on
//! the same counts, so the bytes are unchanged. `actors`, `net_guids` and
//! `events` stay inline: under 1% of the write cost.
//!
//! No error is dropped. A failed writer drops its receiver, so the next send
//! fails and `ship` joins the thread and returns the writer's own error: the
//! packet loop returns from there without reaching `finish`, and `Drop`
//! discards what it joins. A panic is an error, and a writer that failed never
//! finishes `Ok`.

use std::io::Write;
use std::sync::mpsc::{Receiver, SyncSender, sync_channel};
use std::thread;

use vrf_export::{ExportError, Table, TableWriter};

use crate::error::CliError;

/// Rows per message to a writer: one message per packet would cost more in
/// channel traffic than the encoding it hides (02d4d478: 2.44 `fields` and
/// 3.48 `movement` rows per packet, about 80 and 113 batches).
const WRITER_BATCH_ROWS: usize = 16_384;

/// Batches in flight per writer, bounding memory: four field batches are about
/// 10 MB.
const WRITER_QUEUE_DEPTH: usize = 4;

/// A writer running on its own thread, plus the handle needed to collect its
/// result. `T` is the record type of the table it owns.
pub(super) struct WriterThread<T> {
    tx: Option<SyncSender<Vec<T>>>,
    recycled: Receiver<Vec<T>>,
    handle: Option<thread::JoinHandle<Result<(), ExportError>>>,
    batch: Vec<T>,
    /// Names the failing table in an error message.
    table: &'static str,
    /// Why the writer stopped, once `ship` joined it. The error went to that
    /// caller (it is not `Clone`); a later `finish` names the same cause.
    failure: Option<String>,
}

impl<T: Send + 'static> WriterThread<T> {
    /// Spawn `run`, which consumes every batch in stream order, may hand each
    /// emptied batch back for reuse, and then finalises the file.
    pub(super) fn spawn<F>(table: &'static str, run: F) -> Self
    where
        F: FnOnce(Receiver<Vec<T>>, SyncSender<Vec<T>>) -> Result<(), ExportError> + Send + 'static,
    {
        let (tx, rx) = sync_channel(WRITER_QUEUE_DEPTH);
        // One emptied batch waits for reuse, so shipping rarely allocates a
        // fresh multi-MB Vec the OS must zero (02d4d478: 255k -> 147k page
        // faults); a deeper pool only kept more idle pages resident.
        let (give_back, recycled) = sync_channel(1);
        let handle = thread::spawn(move || run(rx, give_back));
        Self {
            tx: Some(tx),
            recycled,
            handle: Some(handle),
            batch: Vec::with_capacity(WRITER_BATCH_ROWS),
            table,
            failure: None,
        }
    }

    /// A thread pushing every batch into `writer`.
    pub(super) fn spawn_table<Tb, W>(table: &'static str, mut writer: TableWriter<Tb, W>) -> Self
    where
        Tb: Table<Row = T> + 'static,
        W: Write + Send + 'static,
    {
        Self::spawn(table, move |batches, give_back| {
            for mut batch in batches {
                writer.push_batch(batch.drain(..))?;
                let _ = give_back.try_send(batch);
            }
            writer.finish()
        })
    }

    /// Move `records` into the pending batch, shipping it once it is full.
    pub(super) fn append(&mut self, records: &mut Vec<T>) -> Result<(), CliError> {
        self.batch.append(records);
        if self.batch.len() >= WRITER_BATCH_ROWS {
            self.ship()?;
        }
        Ok(())
    }

    fn ship(&mut self) -> Result<(), CliError> {
        let next =
            (self.recycled.try_recv()).unwrap_or_else(|_| Vec::with_capacity(WRITER_BATCH_ROWS));
        let full = std::mem::replace(&mut self.batch, next);
        let tx = self
            .tx
            .as_ref()
            .ok_or_else(|| CliError::Usage(format!("{} writer already closed", self.table)))?;
        if tx.send(full).is_ok() {
            return Ok(());
        }
        // A send fails only once the receiver is gone, so this join cannot
        // block, and it is the last place the writer's own error exists (see
        // the module doc).
        self.tx = None;
        let error = match self.handle.take().map(thread::JoinHandle::join) {
            Some(Ok(Err(e))) => CliError::Export(e),
            Some(Err(_)) => CliError::Usage(format!("{} writer thread panicked", self.table)),
            // Returned `Ok` without draining its channel: nothing more
            // specific to say. (`None` cannot happen while `tx` was `Some`.)
            Some(Ok(Ok(()))) | None => {
                CliError::Usage(format!("{} writer stopped early", self.table))
            }
        };
        self.failure = Some(error.to_string());
        Err(error)
    }

    /// Ship the trailing partial batch, close the channel and return the
    /// writer's own result; a panic is an error, never a completed file.
    pub(super) fn finish(mut self) -> Result<(), CliError> {
        let table = self.table;
        // An earlier `ship` joined the stopped writer and returned its error;
        // the file is incomplete, so finishing can only fail.
        if let Some(cause) = self.failure.take() {
            return Err(CliError::Usage(format!(
                "{table} writer had already failed: {cause}"
            )));
        }
        // A failing `ship` has joined the writer and returns its own error.
        if !self.batch.is_empty() {
            self.ship()?;
        }
        // Dropping the sender is what ends the writer loop.
        self.tx = None;
        match self.handle.take().map(thread::JoinHandle::join) {
            Some(Ok(result)) => result.map_err(CliError::Export),
            Some(Err(_)) => Err(CliError::Usage(format!("{table} writer thread panicked"))),
            // Only a failed `ship` joins early, and that returned above.
            // Never `Ok` regardless: there is no file.
            None => Err(CliError::Usage(format!(
                "{table} writer was joined before finishing"
            ))),
        }
    }
}

impl<T> Drop for WriterThread<T> {
    fn drop(&mut self) {
        // Close the producer side and join: a detached thread could still be
        // writing into a staging directory the caller removes or publishes.
        self.tx = None;
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier, mpsc};
    use std::time::Duration;

    #[test]
    fn dropping_a_writer_closes_and_joins_its_thread() {
        let gate = Arc::new(Barrier::new(2));
        let writer_gate = Arc::clone(&gate);
        let writer = WriterThread::<u8>::spawn("test", move |rx, _| {
            for _ in rx {}
            writer_gate.wait();
            Ok(())
        });
        let (drop_done, dropped) = mpsc::channel();
        let dropper = thread::spawn(move || {
            drop(writer);
            drop_done.send(()).unwrap();
        });

        assert!(
            dropped.recv_timeout(Duration::from_millis(50)).is_err(),
            "drop returned while its writer thread was still running"
        );
        gate.wait();
        dropped.recv_timeout(Duration::from_secs(1)).unwrap();
        dropper.join().unwrap();
    }

    /// The case only `finish` can catch: a writer that drained its channel and
    /// then failed (a disk full on the footer), so no send fails and the error
    /// exists only in the join. A mid-stream failure cannot test this arm: a
    /// send always sees it first.
    #[test]
    fn a_writer_that_fails_after_draining_its_channel_fails_finish() {
        let mut writer = WriterThread::<u8>::spawn("test", |rx, _| {
            for _ in rx {}
            Err(ExportError::Usage("footer failed".into()))
        });
        writer.append(&mut vec![0u8; 3]).unwrap();
        let error = writer
            .finish()
            .expect_err("a writer whose footer failed must not finish");
        assert!(error.to_string().contains("footer failed"), "got: {error}");
    }

    /// Append full batches until one is refused. The channel holds
    /// `WRITER_QUEUE_DEPTH` batches, so once the writer has stopped reading,
    /// a send fails within that many more plus the one it took: bounded, not
    /// a race.
    fn append_until_refused(writer: &mut WriterThread<u8>) -> CliError {
        for _ in 0..(WRITER_QUEUE_DEPTH + 2) {
            let mut batch = vec![0u8; WRITER_BATCH_ROWS];
            if let Err(error) = writer.append(&mut batch) {
                return error;
            }
        }
        panic!("the writer stopped reading, so a send must have failed by now");
    }

    /// `append`'s error is the one the export reports (see the module doc).
    #[test]
    fn append_reports_the_writer_threads_own_error() {
        let mut writer = WriterThread::<u8>::spawn("test", |rx, _| {
            let _ = rx.recv();
            Err(ExportError::Usage("writer failed".into()))
        });
        let error = append_until_refused(&mut writer);
        assert!(
            matches!(error, CliError::Export(_)),
            "the writer's error keeps its class: {error:?}"
        );
        assert!(
            error.to_string().contains("writer failed"),
            "append must surface the writer's own error, got: {error}"
        );
        // Already reported and joined: `finish` must neither panic on the
        // missing handle nor report a finished file.
        let error = writer
            .finish()
            .expect_err("a writer that failed must not finish successfully");
        assert!(
            error.to_string().contains("writer failed"),
            "finish must name the same cause, got: {error}"
        );
    }

    /// The panic message `cargo test` prints here is expected.
    #[test]
    fn append_reports_a_panicking_writer_as_a_panic() {
        let mut writer = WriterThread::<u8>::spawn("test", |rx, _| {
            let _ = rx.recv();
            panic!("writer died")
        });
        let error = append_until_refused(&mut writer);
        assert!(error.to_string().contains("panicked"), "got: {error}");
        assert!(writer.finish().is_err());
    }

    #[test]
    fn append_reports_a_writer_that_returned_ok_early_as_stopped() {
        let mut writer = WriterThread::<u8>::spawn("test", |rx, _| {
            let _ = rx.recv();
            Ok(())
        });
        let error = append_until_refused(&mut writer);
        assert!(error.to_string().contains("stopped early"), "got: {error}");
        assert!(writer.finish().is_err());
    }

    /// The panic message `cargo test` prints here is expected.
    #[test]
    fn a_panicking_writer_thread_is_reported_not_swallowed() {
        let writer = WriterThread::<u8>::spawn("test", |_, _| panic!("writer died"));
        let err = writer
            .finish()
            .expect_err("a panicking writer must not report success");
        assert!(
            err.to_string().contains("panicked"),
            "finish must name the panic, got: {err}"
        );
    }
}
