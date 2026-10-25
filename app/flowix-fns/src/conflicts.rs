//! Durable record of unresolved sync conflicts.
//!
//! Loop prevention lives in `SyncState::pending_conflicts`; this store holds
//! the *contents* needed to settle those conflicts later — the server and
//! base snapshots captured when a push was rejected with code 530. Records
//! live in `<notebook>/.flowix/conflicts/` so they travel with the notebook
//! and survive restarts.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::hash::path_hash;

/// One unresolved conflict: the versions involved when a push was rejected.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictRecord {
    pub path: String,
    /// Content the server held when the push was rejected.
    pub server_content: String,
    pub server_hash: String,
    /// Content both sides diverged from, as reported by the server. Equals
    /// `server_content` when the server's history lookup missed; see
    /// [`ConflictRecord::has_independent_base`].
    pub base_content: String,
    /// Base hash the conflicting push was sent with; `None` for a fresh note.
    #[serde(default)]
    pub base_hash: Option<String>,
    /// Epoch milliseconds of the latest detection.
    pub detected_at: i64,
}

impl ConflictRecord {
    /// True when the base is a genuine common ancestor rather than the
    /// server's fallback ("history lookup missed → use my content as base").
    ///
    /// A genuine base equal to the server content is impossible: identical
    /// contents imply identical hashes, and equal hashes are never reported
    /// as a conflict. So equality here reliably marks the degraded case,
    /// where a three-way merge would silently drop one side.
    pub fn has_independent_base(&self) -> bool {
        !self.base_content.is_empty() && self.base_content != self.server_content
    }
}

/// File-backed storage for pending conflict records.
#[derive(Debug, Clone)]
pub struct ConflictStore {
    root: PathBuf,
}

impl ConflictStore {
    /// Store rooted at `<notebook>/.flowix/conflicts/`.
    pub fn new(notebook_root: &Path) -> Self {
        Self {
            root: notebook_root.join(".flowix").join("conflicts"),
        }
    }

    /// Persist (or refresh) the record for a path. Atomic like the sync
    /// state: a crash must not leave a half-written record behind.
    pub fn record(&self, record: &ConflictRecord) -> io::Result<()> {
        fs::create_dir_all(&self.root)?;
        let path = self.path_for(&record.path);
        let body = serde_json::to_vec_pretty(record)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        let temporary = path.with_extension("json.tmp");
        fs::write(&temporary, body)?;
        fs::rename(&temporary, &path)
    }

    /// Drop the record for a path; a missing record counts as removed.
    pub fn remove(&self, path: &str) -> io::Result<()> {
        match fs::remove_file(self.path_for(path)) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        }
    }

    /// Load the record for a path, if one is stored.
    pub fn load(&self, path: &str) -> io::Result<Option<ConflictRecord>> {
        let bytes = match fs::read(self.path_for(path)) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
    }

    /// All stored records, ordered by path.
    pub fn list(&self) -> io::Result<Vec<ConflictRecord>> {
        let mut records = Vec::new();
        let entries = match fs::read_dir(&self.root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(records),
            Err(error) => return Err(error),
        };
        for entry in entries {
            let entry = entry?;
            let path = entry.path();
            if path.extension().is_none_or(|extension| extension != "json") {
                continue;
            }
            let bytes = fs::read(&path)?;
            match serde_json::from_slice::<ConflictRecord>(&bytes) {
                Ok(record) => records.push(record),
                Err(error) => {
                    let name = path.display().to_string();
                    tracing::warn!(file = %name, %error, "skipping unreadable conflict record");
                }
            }
        }
        records.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(records)
    }

    /// File name for a path: a sanitized readable tail plus the path hash,
    /// so notes with non-ASCII names stay inspectable on disk while
    /// remaining collision-free.
    fn path_for(&self, path: &str) -> PathBuf {
        let sanitized: String = path
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        // Everything above is ASCII, so slicing on a byte offset is safe.
        // Keeping the tail (file-name part) makes related conflicts sort
        // together in directory listings.
        let start = sanitized.len().saturating_sub(48);
        let tail = &sanitized[start..];
        self.root.join(format!("{tail}-{}.json", path_hash(path)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hash::content_hash;

    fn sample(path: &str) -> ConflictRecord {
        ConflictRecord {
            path: path.to_owned(),
            server_content: "server".to_owned(),
            server_hash: content_hash("server"),
            base_content: "base".to_owned(),
            base_hash: Some(content_hash("base")),
            detected_at: 1730000000000,
        }
    }

    #[test]
    fn record_load_remove_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let store = ConflictStore::new(dir.path());

        assert!(store.load("notes/a.md").unwrap().is_none());

        store.record(&sample("notes/a.md")).unwrap();
        let loaded = store.load("notes/a.md").unwrap().unwrap();
        assert_eq!(loaded, sample("notes/a.md"));

        // Re-recording refreshes instead of duplicating.
        let mut updated = sample("notes/a.md");
        updated.detected_at = 1730000000001;
        store.record(&updated).unwrap();
        assert_eq!(store.list().unwrap().len(), 1);

        store.remove("notes/a.md").unwrap();
        assert!(store.load("notes/a.md").unwrap().is_none());
        // Removing again stays a success.
        store.remove("notes/a.md").unwrap();
    }

    #[test]
    fn list_orders_by_path_and_skips_garbage() {
        let dir = tempfile::tempdir().unwrap();
        let store = ConflictStore::new(dir.path());
        store.record(&sample("b.md")).unwrap();
        store.record(&sample("a.md")).unwrap();
        fs::write(store.root.join("broken.json"), b"not json").unwrap();

        let records = store.list().unwrap();
        let paths: Vec<&str> = records.iter().map(|r| r.path.as_str()).collect();
        assert_eq!(paths, ["a.md", "b.md"]);
    }

    #[test]
    fn non_ascii_paths_map_to_distinct_files() {
        let dir = tempfile::tempdir().unwrap();
        let store = ConflictStore::new(dir.path());
        store.record(&sample("笔记/测试.md")).unwrap();
        store.record(&sample("笔记/测试2.md")).unwrap();
        assert_eq!(store.list().unwrap().len(), 2);
        assert!(store.load("笔记/测试.md").unwrap().is_some());
    }

    #[test]
    fn degraded_base_is_detected() {
        let mut record = sample("a.md");
        assert!(record.has_independent_base());

        record.base_content = record.server_content.clone();
        assert!(!record.has_independent_base());

        record.base_content = String::new();
        assert!(!record.has_independent_base());
    }
}
