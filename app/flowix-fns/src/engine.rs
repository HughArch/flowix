//! One-shot bidirectional reconciliation between a notebook and its vault.
//!
//! The engine is deliberately pure: it takes a connected [`FnsClient`], a
//! [`LocalNoteStore`] and the notebook's [`SyncState`], and returns a report.
//! Persisting the returned cursor and scheduling runs is the caller's job.

use std::collections::BTreeSet;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::client::{FnsClient, FnsError, Result};
use crate::conflicts::{ConflictRecord, ConflictStore};
use crate::file::{download_file, pull_files, upload_file};
use crate::hash::{content_hash, path_hash};
use crate::local::{LocalFileStore, LocalNoteStore, Result as LocalResult};
use crate::protocol::{
    ConflictPayload, FileSyncCheckRequest, FileSyncDelFile, NoteSyncCheckRequest,
    NoteSyncDelNote, OfflineSyncStrategy,
};
use crate::state::SyncState;
use crate::sync::{pull_notes, push_note, PushNote};

#[derive(Debug, Default)]
pub struct SyncReport {
    /// Notes written locally from remote changes.
    pub pulled: usize,
    /// Notes uploaded from local changes.
    pub pushed: usize,
    pub deleted_local: usize,
    pub renamed: usize,
    /// Attachments downloaded from the server.
    pub files_pulled: usize,
    /// Attachments uploaded to the server.
    pub files_pushed: usize,
    pub files_deleted_local: usize,
    /// Notes the server refused to merge automatically and that are still
    /// unresolved — surfaced to the UI, one entry per pending path.
    pub conflicts: Vec<String>,
    /// Conflicts settled during this run without user interaction: the
    /// three-way merge succeeded and the server accepted the resolution.
    pub conflicts_auto_resolved: usize,
    /// New cursor; assign to `SyncState::last_time` after a successful run.
    pub last_time: i64,
}

impl SyncReport {
    pub fn is_empty(&self) -> bool {
        self.pulled == 0
            && self.pushed == 0
            && self.deleted_local == 0
            && self.renamed == 0
            && self.files_pulled == 0
            && self.files_pushed == 0
            && self.files_deleted_local == 0
            && self.conflicts.is_empty()
            && self.conflicts_auto_resolved == 0
    }
}

/// Which part of the sync is running.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SyncPhase {
    Scanning,
    NotesPull,
    NotesPush,
    FilesPull,
    FilesPush,
}

/// A progress snapshot emitted while a sync runs.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncProgress {
    pub phase: SyncPhase,
    pub total: usize,
    pub completed: usize,
    pub current_path: Option<String>,
}

/// Receives progress updates. Implementations must be cheap and non-blocking.
pub trait SyncProgressSink: Send + Sync {
    fn report(&self, progress: SyncProgress);
}

/// Sink used when callers do not care about progress.
pub struct NoProgress;

impl SyncProgressSink for NoProgress {
    fn report(&self, _progress: SyncProgress) {}
}

/// Conservative three-way merge used for conflict auto-resolution:
/// `(base, local, remote) -> merged`, or `None` when the merge has a real
/// conflict. Supplied by the shell so this crate keeps no dependency on any
/// particular merge implementation.
pub type AutoMergeFn = fn(&str, &str, &str) -> Option<String>;

/// Sync knobs that depend on user settings.
#[derive(Debug, Clone, Copy)]
pub struct SyncOptions {
    /// Attachments larger than this are neither uploaded nor downloaded.
    /// `0` disables attachment sync entirely.
    pub max_attachment_bytes: i64,
    /// Merge used to auto-resolve conflicts without user interaction. `None`
    /// (or a `None` result) leaves the conflict pending for manual
    /// resolution.
    pub auto_merge: Option<AutoMergeFn>,
}

impl Default for SyncOptions {
    fn default() -> Self {
        Self {
            max_attachment_bytes: 20 * 1024 * 1024,
            auto_merge: None,
        }
    }
}

/// Run one full reconciliation pass.
#[allow(clippy::too_many_arguments)]
pub async fn sync_notebook(
    client: &mut FnsClient,
    store: &dyn LocalNoteStore,
    file_store: &dyn LocalFileStore,
    state: &mut SyncState,
    strategy: OfflineSyncStrategy,
    options: &SyncOptions,
    conflicts: &ConflictStore,
    progress: &dyn SyncProgressSink,
) -> Result<SyncReport> {
    progress.report(SyncProgress {
        phase: SyncPhase::Scanning,
        total: 0,
        completed: 0,
        current_path: None,
    });
    let local = store.list_notes().map_err(local_error)?;
    tracing::info!(count = local.len(), "FNS sync: scanned local notes");
    // Only report notes whose content changed since the previous successful
    // sync. The server treats any reported note it does not see in the current
    // incremental window as "missing on the server" and asks for an upload, so
    // resending an unchanged full list would cause spurious pushes on every
    // idle sync.
    let check_requests = local
        .iter()
        .filter(|note| {
            state
                .notes
                .get(&note.path)
                .is_none_or(|snapshot| snapshot.content_hash != note.content_hash)
        })
        .map(|note| NoteSyncCheckRequest {
            path: note.path.clone(),
            path_hash: crate::hash::path_hash(&note.path),
            content_hash: note.content_hash.clone(),
            mtime: note.mtime_ms,
            ctime: note.ctime_ms,
        })
        .collect();

    // Files that existed after the previous sync but are gone now. Without
    // this the server would treat them as "missing on the client" and push
    // them back.
    let del_notes = state
        .locally_deleted(&local)
        .into_iter()
        .map(|path| NoteSyncDelNote {
            path: path.to_owned(),
            path_hash: crate::hash::path_hash(path),
        })
        .collect();

    let pulled = pull_notes(
        client,
        &state.vault,
        state.last_time,
        check_requests,
        del_notes,
        strategy,
    )
    .await?;

    let mut report = SyncReport {
        last_time: pulled.last_time,
        ..Default::default()
    };

    // Remote creations/updates win by path. Skip when the content already
    // matches so we do not rewrite files the server merely re-announced.
    let pull_total = pulled.modified.len() + pulled.renamed.len();
    let mut pull_done = 0;
    for note in &pulled.modified {
        progress.report(SyncProgress {
            phase: SyncPhase::NotesPull,
            total: pull_total,
            completed: pull_done,
            current_path: Some(note.path.clone()),
        });
        let current = store.read_note(&note.path).map_err(local_error)?;
        if current.as_deref() == Some(note.content.as_str()) {
            pull_done += 1;
            continue;
        }
        store
            .write_note(&note.path, &note.content, note.mtime)
            .map_err(local_error)?;
        report.pulled += 1;
        pull_done += 1;
    }

    for note in &pulled.deleted {
        if store.read_note(&note.path).map_err(local_error)?.is_some() {
            store.delete_note(&note.path).map_err(local_error)?;
            report.deleted_local += 1;
        }
    }

    for rename in &pulled.renamed {
        progress.report(SyncProgress {
            phase: SyncPhase::NotesPull,
            total: pull_total,
            completed: pull_done,
            current_path: Some(rename.path.clone()),
        });
        pull_done += 1;
        if rename.old_path.is_empty() || rename.path.is_empty() {
            continue;
        }
        let Some(content) = store.read_note(&rename.old_path).map_err(local_error)? else {
            continue;
        };
        store
            .write_note(&rename.path, &content, rename.mtime)
            .map_err(local_error)?;
        store.delete_note(&rename.old_path).map_err(local_error)?;
        report.renamed += 1;
    }

    // Content already matches; align the local mtime so the next sync stops
    // reporting a timestamp-only difference.
    for note in &pulled.mtime_only {
        store.touch_note(&note.path, note.mtime).map_err(local_error)?;
    }

    // The server asked for these because both sides changed. Upload the local
    // copy. The snapshot hash is the version the server acknowledged at the
    // last successful sync — the base the local edit grew from. The server
    // fast-forwards when it is still on that version, and can run a real
    // three-way merge when it has moved on. Sending no base would push the
    // server into its "unknown base" path, which always force-merges and
    // writes a `.conflict.` copy — one per edit.
    let push_total = pulled.need_push.len();
    let mut push_done = 0;
    for note in &pulled.need_push {
        progress.report(SyncProgress {
            phase: SyncPhase::NotesPush,
            total: push_total,
            completed: push_done,
            current_path: Some(note.path.clone()),
        });
        push_done += 1;

        // An unresolved conflict must not be re-pushed: the server would
        // reject it with 530 again, forever. Pending paths are also kept out
        // of the snapshot below, so the server keeps asking for them until
        // the conflict settles instead of the marker going silent.
        if state.is_pending_conflict(&note.path) {
            self_heal_conflict(store, state, conflicts, &note.path);
            continue;
        }

        let Some(content) = store.read_note(&note.path).map_err(local_error)? else {
            continue;
        };
        let now = now_ms();
        let result = push_note(
            client,
            PushNote {
                vault: &state.vault,
                path: &note.path,
                content: &content,
                ctime_ms: now,
                mtime_ms: now,
                base_hash: state.base_hash_for(&note.path),
                create_only: false,
                conflict_resolved: false,
            },
        )
        .await;
        match result {
            Ok(_) => report.pushed += 1,
            Err(FnsError::Conflict { path, payload }) => {
                if resolve_conflict(client, store, state, conflicts, options, &path, &payload)
                    .await
                {
                    report.conflicts_auto_resolved += 1;
                } else {
                    report.conflicts.push(path);
                }
            }
            Err(error) => return Err(error),
        }
    }

    state.last_time = report.last_time;
    state.last_sync_at = now_ms();
    // Snapshot after all remote changes have been applied, so the next run can
    // distinguish local deletions from files that never existed. Pending
    // conflicts stay unsnapshotted; see `record_snapshot_ignoring_pending`.
    let after = store.list_notes().map_err(local_error)?;
    state.record_snapshot_ignoring_pending(&after);

    if options.max_attachment_bytes > 0 {
        let (pulled, pushed, deleted) = sync_files(
            client,
            file_store,
            state,
            options.max_attachment_bytes,
            progress,
        )
        .await?;
        report.files_pulled = pulled;
        report.files_pushed = pushed;
        report.files_deleted_local = deleted;
    }

    Ok(report)
}

/// Handle a push rejected with 530: record the conflict, then try to settle
/// it without user interaction. Returns `true` when the conflict was resolved
/// and the server accepted the merged content; otherwise the path stays
/// pending (in `SyncState` and the conflict store) for manual resolution.
///
/// Local IO and push failures are deliberately non-fatal here: the sync run
/// has already done most of its work, and a pending conflict is retried on
/// the next run anyway.
async fn resolve_conflict(
    client: &mut FnsClient,
    store: &dyn LocalNoteStore,
    state: &mut SyncState,
    conflicts: &ConflictStore,
    options: &SyncOptions,
    path: &str,
    payload: &ConflictPayload,
) -> bool {
    let now = now_ms();
    state.record_pending_conflict(path, now);

    let record = ConflictRecord {
        path: path.to_owned(),
        server_content: payload.server_content.clone(),
        server_hash: payload.server_hash.clone(),
        base_content: payload.base_content.clone(),
        base_hash: state.base_hash_for(path),
        detected_at: now,
    };
    if let Err(error) = conflicts.record(&record) {
        // Loop prevention lives in sync-state.json; a failed record only
        // degrades later manual resolution.
        tracing::warn!(path, %error, "failed to persist conflict record");
    }

    let local = store.read_note(path).ok().flatten();
    match plan_conflict_resolution(options.auto_merge, &record, local.as_deref()) {
        ConflictResolution::Merged(content) => {
            if let Err(error) = store.write_note(path, &content, now) {
                tracing::warn!(path, %error, "failed to write auto-merged content");
                return false;
            }
            let result = push_note(
                client,
                PushNote {
                    vault: &state.vault,
                    path,
                    content: &content,
                    ctime_ms: now,
                    mtime_ms: now,
                    base_hash: record.base_hash.clone(),
                    create_only: false,
                    conflict_resolved: true,
                },
            )
            .await;
            match result {
                Ok(_) => {
                    state.clear_pending_conflict(path);
                    let _ = conflicts.remove(path);
                    tracing::info!(path, "conflict auto-resolved via three-way merge");
                    true
                }
                Err(error) => {
                    // The merged content is now the local version; the next
                    // run re-reports the path (snapshot exclusion) and can
                    // retry the resolution push.
                    tracing::warn!(path, %error, "conflict resolution push failed");
                    false
                }
            }
        }
        ConflictResolution::NeedsHuman(reason) => {
            tracing::info!(path, reason, "conflict left pending for manual resolution");
            false
        }
    }
}

/// Outcome of examining a fresh conflict without touching the network.
#[derive(Debug)]
enum ConflictResolution {
    /// A merged result that supersedes the local file and must be pushed
    /// with `conflict_resolved`.
    Merged(String),
    /// Leave the decision to the user; carries the reason for the log.
    NeedsHuman(&'static str),
}

/// Pure decision core of [`resolve_conflict`], kept separate so the state
/// machine can be unit-tested without a server.
fn plan_conflict_resolution(
    auto_merge: Option<AutoMergeFn>,
    record: &ConflictRecord,
    local: Option<&str>,
) -> ConflictResolution {
    let Some(merge) = auto_merge else {
        return ConflictResolution::NeedsHuman("no auto-merge configured");
    };
    // The server substitutes its current content for the base when its
    // history lookup misses; merging against that pseudo-base would keep
    // only the local side, silently dropping the remote edits.
    if !record.has_independent_base() {
        return ConflictResolution::NeedsHuman("no independent base available");
    }
    let Some(local) = local else {
        return ConflictResolution::NeedsHuman("local note is missing");
    };
    match merge(&record.base_content, local, &record.server_content) {
        Some(merged) => ConflictResolution::Merged(merged),
        None => ConflictResolution::NeedsHuman("auto-merge reported a conflict"),
    }
}

/// Drop a stale pending marker when the conflict has already settled: the
/// local file now carries exactly the content the conflict recorded as the
/// server version — the other side's resolution arrived via pull, or the
/// user copied it in by hand.
fn self_heal_conflict(
    store: &dyn LocalNoteStore,
    state: &mut SyncState,
    conflicts: &ConflictStore,
    path: &str,
) {
    let Ok(Some(record)) = conflicts.load(path) else {
        return;
    };
    let Ok(Some(local)) = store.read_note(path) else {
        return;
    };
    if !record.server_hash.is_empty() && content_hash(&local) == record.server_hash {
        state.clear_pending_conflict(path);
        let _ = conflicts.remove(path);
        tracing::info!(path, "pending conflict cleared: server content is now local");
    }
}

/// Reconcile attachments. Returns `(downloaded, uploaded, deleted_locally)`.
async fn sync_files(
    client: &mut FnsClient,
    store: &dyn LocalFileStore,
    state: &mut SyncState,
    max_bytes: i64,
    progress: &dyn SyncProgressSink,
) -> Result<(usize, usize, usize)> {
    progress.report(SyncProgress {
        phase: SyncPhase::Scanning,
        total: 0,
        completed: 0,
        current_path: None,
    });
    let local = store.list_files(max_bytes).map_err(local_error)?;
    let present: BTreeSet<&str> = local.iter().map(|file| file.path.as_str()).collect();

    // A path in the snapshot that is no longer listable is either deleted or
    // grew past the size limit. Only report real deletions; an oversized file
    // stays on disk and must not be removed server-side.
    let mut del_files = Vec::new();
    for path in state.files.keys() {
        if present.contains(path.as_str()) {
            continue;
        }
        if store.read_file(path).map_err(local_error)?.is_none() {
            del_files.push(FileSyncDelFile {
                path: path.clone(),
                path_hash: path_hash(path),
            });
        }
    }

    let check_requests = local
        .iter()
        .filter(|file| {
            state
                .files
                .get(&file.path)
                .is_none_or(|snapshot| snapshot.content_hash != file.content_hash)
        })
        .map(|file| FileSyncCheckRequest {
            path: file.path.clone(),
            path_hash: path_hash(&file.path),
            content_hash: file.content_hash.clone(),
            mtime: file.mtime_ms,
            ctime: file.ctime_ms,
            size: file.size,
        })
        .collect();

    let pulled = pull_files(
        client,
        &state.vault,
        state.file_last_time,
        check_requests,
        del_files,
    )
    .await?;

    let mut downloaded = 0;
    let mut uploaded = 0;
    let mut deleted = 0;

    for file in &pulled.deleted {
        if store.read_file(&file.path).map_err(local_error)?.is_some() {
            store.delete_file(&file.path).map_err(local_error)?;
            deleted += 1;
        }
    }

    for file in &pulled.mtime_only {
        store.touch_file(&file.path, file.mtime).map_err(local_error)?;
    }

    let pull_total = pulled.updated.len();
    let mut pull_done = 0;
    for file in &pulled.updated {
        progress.report(SyncProgress {
            phase: SyncPhase::FilesPull,
            total: pull_total,
            completed: pull_done,
            current_path: Some(file.path.clone()),
        });
        pull_done += 1;
        if file.size > max_bytes {
            tracing::debug!(
                path = file.path,
                size = file.size,
                max_bytes,
                "skipping oversized remote attachment"
            );
            continue;
        }
        let data = download_file(client, &state.vault, &file.path, &file.path_hash).await?;
        store
            .write_file(&file.path, &data, file.mtime)
            .map_err(local_error)?;
        downloaded += 1;
    }

    let push_total = pulled.uploads.len();
    let mut push_done = 0;
    for upload in &pulled.uploads {
        progress.report(SyncProgress {
            phase: SyncPhase::FilesPush,
            total: push_total,
            completed: push_done,
            current_path: Some(upload.path.clone()),
        });
        push_done += 1;
        let Some(data) = store.read_file(&upload.path).map_err(local_error)? else {
            continue;
        };
        if data.len() as i64 > max_bytes {
            continue;
        }
        upload_file(client, upload, &data).await?;
        uploaded += 1;
    }

    state.file_last_time = pulled.last_time;
    let after = store.list_files(max_bytes).map_err(local_error)?;
    state.record_file_snapshot(&after);

    Ok((downloaded, uploaded, deleted))
}

fn local_error(error: crate::local::LocalError) -> FnsError {
    FnsError::Protocol(format!("local store error: {error}"))
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

/// Convenience wrapper that keeps `MemoryNoteStore` tests honest.
pub fn local_hash(content: &str) -> String {
    content_hash(content)
}

#[allow(dead_code)]
fn _assert_local_result(_: LocalResult<()>) {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local::MemoryNoteStore;

    #[test]
    fn report_emptiness() {
        assert!(SyncReport::default().is_empty());
        let report = SyncReport {
            pulled: 1,
            ..Default::default()
        };
        assert!(!report.is_empty());
    }

    #[test]
    fn memory_store_lists_expected_metadata() {
        let store = MemoryNoteStore::new();
        store.insert("a.md", "hello", 1);
        let notes = store.list_notes().unwrap();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].path, "a.md");
        assert_eq!(notes[0].content_hash, content_hash("hello"));
    }

    /// Toy merge for the decision core: succeeds only when the server
    /// content extends the base (the server appended; the local edit is the
    /// only other difference), so tests can drive both outcomes.
    fn toy_merge(base: &str, local: &str, remote: &str) -> Option<String> {
        remote
            .strip_prefix(base)
            .map(|added| format!("{local}{added}"))
    }

    fn conflict_record(base: &str, server: &str) -> ConflictRecord {
        ConflictRecord {
            path: "a.md".to_owned(),
            server_content: server.to_owned(),
            server_hash: content_hash(server),
            base_content: base.to_owned(),
            base_hash: Some(content_hash(base)),
            detected_at: 0,
        }
    }

    fn needs_human(outcome: ConflictResolution) -> String {
        match outcome {
            ConflictResolution::NeedsHuman(reason) => reason.to_owned(),
            ConflictResolution::Merged(_) => panic!("expected NeedsHuman, got Merged"),
        }
    }

    #[test]
    fn report_emptiness_counts_auto_resolved() {
        let report = SyncReport {
            conflicts_auto_resolved: 1,
            ..Default::default()
        };
        assert!(!report.is_empty());
    }

    #[test]
    fn auto_resolution_requires_merge_independent_base_and_local() {
        let record = conflict_record("base", "server");

        let reason = needs_human(plan_conflict_resolution(None, &record, Some("local")));
        assert!(reason.contains("no auto-merge"));

        // Degraded base (server history lookup missed): merging would drop
        // one side, so the decision core must refuse.
        let degraded = conflict_record("server", "server");
        let reason = needs_human(plan_conflict_resolution(
            Some(toy_merge),
            &degraded,
            Some("local"),
        ));
        assert!(reason.contains("independent base"));

        let reason = needs_human(plan_conflict_resolution(Some(toy_merge), &record, None));
        assert!(reason.contains("missing"));

        // A real merge conflict is deferred to the user.
        let reason = needs_human(plan_conflict_resolution(Some(toy_merge), &record, Some("local")));
        assert!(reason.contains("conflict"));
    }

    #[test]
    fn auto_resolution_merges_when_clean() {
        let record = conflict_record("base", "base-more");
        match plan_conflict_resolution(Some(toy_merge), &record, Some("local")) {
            ConflictResolution::Merged(content) => assert_eq!(content, "local-more"),
            outcome => panic!("expected Merged, got {outcome:?}"),
        }
    }

    #[test]
    fn self_heal_clears_pending_only_when_local_matches_server() {
        let dir = tempfile::tempdir().unwrap();
        let conflicts = ConflictStore::new(dir.path());
        let store = MemoryNoteStore::new();
        let mut state = SyncState::new("vault", "device-1");

        store.insert("a.md", "server text", 1);
        state.record_pending_conflict("a.md", 1);
        conflicts
            .record(&conflict_record("base", "server text"))
            .unwrap();

        self_heal_conflict(&store, &mut state, &conflicts, "a.md");
        assert!(!state.is_pending_conflict("a.md"));
        assert!(conflicts.load("a.md").unwrap().is_none());

        // Diverging local content keeps the conflict pending.
        conflicts
            .record(&conflict_record("base", "server text"))
            .unwrap();
        store.insert("a.md", "user kept editing", 2);
        state.record_pending_conflict("a.md", 2);
        self_heal_conflict(&store, &mut state, &conflicts, "a.md");
        assert!(state.is_pending_conflict("a.md"));
    }
}
