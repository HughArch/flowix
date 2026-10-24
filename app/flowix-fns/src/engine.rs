//! One-shot bidirectional reconciliation between a notebook and its vault.
//!
//! The engine is deliberately pure: it takes a connected [`FnsClient`], a
//! [`LocalNoteStore`] and the notebook's [`SyncState`], and returns a report.
//! Persisting the returned cursor and scheduling runs is the caller's job.

use std::collections::BTreeSet;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::client::{FnsClient, FnsError, Result};
use crate::file::{download_file, pull_files, upload_file};
use crate::hash::{content_hash, path_hash};
use crate::local::{LocalFileStore, LocalNoteStore, Result as LocalResult};
use crate::protocol::{
    FileSyncCheckRequest, FileSyncDelFile, NoteSyncCheckRequest, NoteSyncDelNote,
    OfflineSyncStrategy,
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
    /// Notes the server refused to merge automatically.
    pub conflicts: Vec<String>,
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
    }
}

/// Sync knobs that depend on user settings.
#[derive(Debug, Clone, Copy)]
pub struct SyncOptions {
    /// Attachments larger than this are neither uploaded nor downloaded.
    /// `0` disables attachment sync entirely.
    pub max_attachment_bytes: i64,
}

impl Default for SyncOptions {
    fn default() -> Self {
        Self {
            max_attachment_bytes: 20 * 1024 * 1024,
        }
    }
}

/// Run one full reconciliation pass.
pub async fn sync_notebook(
    client: &mut FnsClient,
    store: &dyn LocalNoteStore,
    file_store: &dyn LocalFileStore,
    state: &mut SyncState,
    strategy: OfflineSyncStrategy,
    options: &SyncOptions,
) -> Result<SyncReport> {
    let local = store.list_notes().map_err(local_error)?;
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
    for note in &pulled.modified {
        let current = store.read_note(&note.path).map_err(local_error)?;
        if current.as_deref() == Some(note.content.as_str()) {
            continue;
        }
        store
            .write_note(&note.path, &note.content, note.mtime)
            .map_err(local_error)?;
        report.pulled += 1;
    }

    for note in &pulled.deleted {
        if store.read_note(&note.path).map_err(local_error)?.is_some() {
            store.delete_note(&note.path).map_err(local_error)?;
            report.deleted_local += 1;
        }
    }

    for rename in &pulled.renamed {
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
    // copy; with `newTimeMerge` the server reconciles by mtime.
    for note in &pulled.need_push {
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
                base_hash: None,
                create_only: false,
            },
        )
        .await;
        match result {
            Ok(_) => report.pushed += 1,
            Err(FnsError::Conflict { .. }) => report.conflicts.push(note.path.clone()),
            Err(error) => return Err(error),
        }
    }

    state.last_time = report.last_time;
    state.last_sync_at = now_ms();
    // Snapshot after all remote changes have been applied, so the next run can
    // distinguish local deletions from files that never existed.
    let after = store.list_notes().map_err(local_error)?;
    state.record_snapshot(&after);

    if options.max_attachment_bytes > 0 {
        let (pulled, pushed, deleted) =
            sync_files(client, file_store, state, options.max_attachment_bytes).await?;
        report.files_pulled = pulled;
        report.files_pushed = pushed;
        report.files_deleted_local = deleted;
    }

    Ok(report)
}

/// Reconcile attachments. Returns `(downloaded, uploaded, deleted_locally)`.
async fn sync_files(
    client: &mut FnsClient,
    store: &dyn LocalFileStore,
    state: &mut SyncState,
    max_bytes: i64,
) -> Result<(usize, usize, usize)> {
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

    for file in &pulled.updated {
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

    for upload in &pulled.uploads {
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
}
