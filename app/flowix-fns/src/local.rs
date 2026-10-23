//! Local notebook access used by the sync engine.
//!
//! The engine never touches the filesystem directly: the desktop shell
//! implements this trait on top of `MemoFile` so writes keep going through the
//! existing locks, atomic writes, index updates and watcher self-write
//! suppression.

use std::io;

pub type Result<T> = std::result::Result<T, LocalError>;

#[derive(Debug, thiserror::Error)]
pub enum LocalError {
    #[error("io error: {0}")]
    Io(#[from] io::Error),
    #[error("invalid path: {0}")]
    InvalidPath(String),
}

/// Metadata for one local Markdown file, in the shape the server expects.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalNote {
    /// Notebook-relative path using `/` separators.
    pub path: String,
    pub content_hash: String,
    pub mtime_ms: i64,
    pub ctime_ms: i64,
}

/// Storage operations the sync engine needs.
///
/// Implementations must be deterministic: listing the same notebook twice
/// without changes returns the same set of notes.
pub trait LocalNoteStore: Send + Sync {
    /// All syncable Markdown notes, already filtered by the notebook's file
    /// management policy.
    fn list_notes(&self) -> Result<Vec<LocalNote>>;

    /// Read a note's text, or `None` when it no longer exists.
    fn read_note(&self, path: &str) -> Result<Option<String>>;

    /// Write a note fetched from the server.
    ///
    /// Implementations should set the file mtime to `mtime_ms` so the next
    /// sync does not mistake a remote-applied write for a local edit.
    fn write_note(&self, path: &str, content: &str, mtime_ms: i64) -> Result<()>;

    /// Delete a note that was removed remotely.
    fn delete_note(&self, path: &str) -> Result<()>;

    /// Update only the file mtime, used when the server reports that the
    /// content matches but the timestamp differs.
    fn touch_note(&self, _path: &str, _mtime_ms: i64) -> Result<()> {
        Ok(())
    }
}

/// In-memory store used by unit tests and as a reference implementation.
#[derive(Debug, Default)]
pub struct MemoryNoteStore {
    inner: std::sync::Mutex<std::collections::BTreeMap<String, (String, i64)>>,
}

impl MemoryNoteStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&self, path: &str, content: &str, mtime_ms: i64) {
        self.inner
            .lock()
            .unwrap()
            .insert(path.to_owned(), (content.to_owned(), mtime_ms));
    }

    pub fn get(&self, path: &str) -> Option<String> {
        self.inner
            .lock()
            .unwrap()
            .get(path)
            .map(|(content, _)| content.clone())
    }

    pub fn paths(&self) -> Vec<String> {
        self.inner.lock().unwrap().keys().cloned().collect()
    }
}

impl LocalNoteStore for MemoryNoteStore {
    fn list_notes(&self) -> Result<Vec<LocalNote>> {
        let guard = self.inner.lock().unwrap();
        Ok(guard
            .iter()
            .map(|(path, (content, mtime))| LocalNote {
                path: path.clone(),
                content_hash: crate::hash::content_hash(content),
                mtime_ms: *mtime,
                ctime_ms: *mtime,
            })
            .collect())
    }

    fn read_note(&self, path: &str) -> Result<Option<String>> {
        Ok(self
            .inner
            .lock()
            .unwrap()
            .get(path)
            .map(|(content, _)| content.clone()))
    }

    fn write_note(&self, path: &str, content: &str, mtime_ms: i64) -> Result<()> {
        self.inner
            .lock()
            .unwrap()
            .insert(path.to_owned(), (content.to_owned(), mtime_ms));
        Ok(())
    }

    fn delete_note(&self, path: &str) -> Result<()> {
        self.inner.lock().unwrap().remove(path);
        Ok(())
    }

    fn touch_note(&self, path: &str, mtime_ms: i64) -> Result<()> {
        if let Some((_, mtime)) = self.inner.lock().unwrap().get_mut(path) {
            *mtime = mtime_ms;
        }
        Ok(())
    }
}
