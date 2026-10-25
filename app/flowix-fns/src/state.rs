//! Per-notebook sync state.
//!
//! Stored as `<notebook>/.flowix/sync-state.json`, alongside
//! `view-preferences.json`. It must travel with the notebook so that moving
//! or copying a notebook keeps its vault binding.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const STATE_VERSION: u32 = 1;
pub const STATE_FILE_NAME: &str = "sync-state.json";

/// Last-seen snapshot of one note, used to detect local deletions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteSnapshot {
    pub content_hash: String,
    pub mtime_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncState {
    pub version: u32,
    /// FNS vault name bound to this notebook. Defaults to the notebook name on
    /// first bind and is intentionally *not* renamed when the notebook is.
    pub vault: String,
    /// Id of the token (stored in the app config, never here) used for this
    /// notebook. Empty means "the only configured token", for older state.
    #[serde(default)]
    pub token_id: String,
    /// Server-side incremental cursor for notes, in milliseconds.
    pub last_time: i64,
    /// Separate cursor for attachments. Notes and files advance at different
    /// times, so sharing one cursor would skip changes.
    #[serde(default)]
    pub file_last_time: i64,
    /// Stable id for this device, used to distinguish writers.
    pub device_id: String,
    /// Wall-clock time of the last successful sync, in milliseconds.
    pub last_sync_at: i64,
    /// Notes present at the end of the last successful sync. A path that
    /// existed then but is gone now is a local deletion, which the protocol
    /// requires us to report explicitly.
    #[serde(default)]
    pub notes: BTreeMap<String, NoteSnapshot>,
    /// Same bookkeeping for attachments.
    #[serde(default)]
    pub files: BTreeMap<String, NoteSnapshot>,
    /// Paths with an unresolved sync conflict, mapped to the epoch-ms time of
    /// their latest detection. The engine must not auto-push these; the
    /// contents needed to settle them live in `.flowix/conflicts/`
    /// ([`crate::conflicts::ConflictStore`]).
    #[serde(default)]
    pub pending_conflicts: BTreeMap<String, i64>,
}

fn note_snapshot(note: &crate::local::LocalNote) -> (String, NoteSnapshot) {
    (
        note.path.clone(),
        NoteSnapshot {
            content_hash: note.content_hash.clone(),
            mtime_ms: note.mtime_ms,
        },
    )
}

impl SyncState {
    pub fn new(vault: impl Into<String>, device_id: impl Into<String>) -> Self {
        Self {
            version: STATE_VERSION,
            vault: vault.into(),
            token_id: String::new(),
            last_time: 0,
            file_last_time: 0,
            device_id: device_id.into(),
            last_sync_at: 0,
            notes: BTreeMap::new(),
            files: BTreeMap::new(),
            pending_conflicts: BTreeMap::new(),
        }
    }

    /// Bind this notebook to a specific token.
    pub fn bind_token(&mut self, token_id: impl Into<String>) {
        self.token_id = token_id.into();
    }

    /// Paths that existed at the end of the previous sync but are gone now.
    pub fn locally_deleted<'a>(&'a self, current: &'a [crate::local::LocalNote]) -> Vec<&'a str> {
        let present: std::collections::BTreeSet<&str> =
            current.iter().map(|note| note.path.as_str()).collect();
        self.notes
            .keys()
            .map(String::as_str)
            .filter(|path| !present.contains(path))
            .collect()
    }

    /// Content hash of the version the server acknowledged at the last
    /// successful sync — the base a pending local edit grew from. `None` for
    /// a path the server has never seen from this client (a fresh note).
    pub fn base_hash_for(&self, path: &str) -> Option<String> {
        self.notes
            .get(path)
            .map(|snapshot| snapshot.content_hash.clone())
    }

    /// Mark a path as conflict-pending. Re-detections refresh the timestamp.
    /// Returns `true` when the path was not pending before.
    pub fn record_pending_conflict(&mut self, path: &str, detected_at: i64) -> bool {
        self.pending_conflicts
            .insert(path.to_owned(), detected_at)
            .is_none()
    }

    /// Drop a pending conflict marker. Returns `true` when it existed.
    pub fn clear_pending_conflict(&mut self, path: &str) -> bool {
        self.pending_conflicts.remove(path).is_some()
    }

    pub fn is_pending_conflict(&self, path: &str) -> bool {
        self.pending_conflicts.contains_key(path)
    }

    /// Replace the snapshot with the current local state.
    pub fn record_snapshot(&mut self, current: &[crate::local::LocalNote]) {
        self.notes = current.iter().map(note_snapshot).collect();
    }

    /// Like [`SyncState::record_snapshot`], but keeps conflict-pending paths
    /// out. Their local content was never acknowledged by the server, so it
    /// must not become the next push base — and a pending path must stay in
    /// every `NoteSync` report until the conflict settles, because the
    /// server only asks for pushes on notes it sees reported.
    pub fn record_snapshot_ignoring_pending(&mut self, current: &[crate::local::LocalNote]) {
        self.notes = current
            .iter()
            .filter(|note| !self.pending_conflicts.contains_key(&note.path))
            .map(note_snapshot)
            .collect();
    }

    pub fn record_file_snapshot(&mut self, current: &[crate::local::LocalFile]) {
        self.files = current
            .iter()
            .map(|file| {
                (
                    file.path.clone(),
                    NoteSnapshot {
                        content_hash: file.content_hash.clone(),
                        mtime_ms: file.mtime_ms,
                    },
                )
            })
            .collect();
    }

    /// `<notebook>/.flowix/sync-state.json`
    pub fn path_for(notebook_root: &Path) -> PathBuf {
        notebook_root.join(".flowix").join(STATE_FILE_NAME)
    }

    /// Load the binding for a notebook, or `None` when it has never synced.
    pub fn load(notebook_root: &Path) -> io::Result<Option<Self>> {
        let path = Self::path_for(notebook_root);
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        let state: Self = serde_json::from_slice(&bytes)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        if state.version != STATE_VERSION {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("unsupported sync state version: {}", state.version),
            ));
        }
        Ok(Some(state))
    }

    pub fn save(&self, notebook_root: &Path) -> io::Result<()> {
        let path = Self::path_for(notebook_root);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let body = serde_json::to_vec_pretty(self)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        // Write via a temporary file so a crash never leaves a half-written
        // cursor behind; a corrupt cursor would force a full re-sync.
        let temporary = path.with_extension("json.tmp");
        fs::write(&temporary, body)?;
        fs::rename(&temporary, &path)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrips_and_reports_missing() {
        let dir = tempfile::tempdir().unwrap();
        assert!(SyncState::load(dir.path()).unwrap().is_none());

        let state = SyncState::new("工作", "device-1");
        state.save(dir.path()).unwrap();
        let loaded = SyncState::load(dir.path()).unwrap().unwrap();
        assert_eq!(loaded, state);
    }

    #[test]
    fn rejects_unknown_version() {
        let dir = tempfile::tempdir().unwrap();
        let path = SyncState::path_for(dir.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, br#"{"version":99,"vault":"v","lastTime":0,"deviceId":"d","lastSyncAt":0}"#).unwrap();
        assert!(SyncState::load(dir.path()).is_err());
    }

    #[test]
    fn base_hash_tracks_last_synced_version() {
        use crate::local::LocalNoteStore;

        let mut state = SyncState::new("vault", "device-1");
        assert_eq!(state.base_hash_for("a.md"), None);

        let store = crate::local::MemoryNoteStore::new();
        store.insert("a.md", "hello", 1);
        state.record_snapshot(&store.list_notes().unwrap());
        assert_eq!(
            state.base_hash_for("a.md"),
            Some(crate::hash::content_hash("hello"))
        );
    }

    #[test]
    fn pending_conflicts_refresh_and_clear() {
        let mut state = SyncState::new("vault", "device-1");
        assert!(!state.is_pending_conflict("a.md"));

        assert!(state.record_pending_conflict("a.md", 1));
        assert!(!state.record_pending_conflict("a.md", 2));
        assert_eq!(state.pending_conflicts.get("a.md"), Some(&2));

        assert!(state.clear_pending_conflict("a.md"));
        assert!(!state.clear_pending_conflict("a.md"));
        assert!(!state.is_pending_conflict("a.md"));
    }

    #[test]
    fn snapshot_exclusion_keeps_pending_paths_reported() {
        use crate::local::LocalNoteStore;

        let mut state = SyncState::new("vault", "device-1");
        state.record_pending_conflict("conflicted.md", 1);

        let store = crate::local::MemoryNoteStore::new();
        store.insert("clean.md", "clean", 1);
        store.insert("conflicted.md", "local edit", 2);
        state.record_snapshot_ignoring_pending(&store.list_notes().unwrap());

        assert!(state.notes.contains_key("clean.md"));
        assert!(!state.notes.contains_key("conflicted.md"));
        // Excluded paths must not be mistaken for local deletions.
        assert!(state.locally_deleted(&store.list_notes().unwrap()).is_empty());
        // The plain snapshot keeps its behaviour.
        state.record_snapshot(&store.list_notes().unwrap());
        assert!(state.notes.contains_key("conflicted.md"));
    }
}
