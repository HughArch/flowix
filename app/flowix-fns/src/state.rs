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
}

impl SyncState {
    pub fn new(vault: impl Into<String>, device_id: impl Into<String>) -> Self {
        Self {
            version: STATE_VERSION,
            vault: vault.into(),
            last_time: 0,
            file_last_time: 0,
            device_id: device_id.into(),
            last_sync_at: 0,
            notes: BTreeMap::new(),
            files: BTreeMap::new(),
        }
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

    /// Replace the snapshot with the current local state.
    pub fn record_snapshot(&mut self, current: &[crate::local::LocalNote]) {
        self.notes = current
            .iter()
            .map(|note| {
                (
                    note.path.clone(),
                    NoteSnapshot {
                        content_hash: note.content_hash.clone(),
                        mtime_ms: note.mtime_ms,
                    },
                )
            })
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
}
