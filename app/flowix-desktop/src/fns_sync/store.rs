//! `LocalNoteStore` backed by Flowix's own storage pipeline.
//!
//! Every write goes through `MemoFile::with_file_write` so it shares the
//! cross-process lock with user saves, then refreshes the note index and marks
//! the path as a self-write so the watcher does not treat remote changes as
//! external edits.

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use flowix_core::memo_file::{FileLockIntent, FileManagementPolicy, MemoFile};
use flowix_fns::hash::{content_hash, encode_hash32_bytes};
use flowix_fns::local::{
    LocalError, LocalFile, LocalFileStore, LocalNote, LocalNoteStore,
};
use tauri::AppHandle;
use walkdir::WalkDir;

use crate::commands::helpers::refresh_notebook_note_index;
use crate::lock_utils::read_lock;
use crate::watcher::runtime::mark_self_write_for;

pub struct MemoFileStore {
    app: AppHandle,
    memo_file: Arc<RwLock<MemoFile>>,
    notebook_id: String,
    root: PathBuf,
    policy: FileManagementPolicy,
}

impl MemoFileStore {
    pub fn new(
        app: AppHandle,
        memo_file: Arc<RwLock<MemoFile>>,
        notebook_id: String,
        root: PathBuf,
    ) -> Self {
        let policy = FileManagementPolicy::from_notebook_root(&root);
        Self {
            app,
            memo_file,
            notebook_id,
            root,
            policy,
        }
    }

    fn resolve(&self, path: &str) -> Result<PathBuf, LocalError> {
        if path.is_empty() {
            return Err(LocalError::InvalidPath("empty path".into()));
        }
        let normalized = path.replace('\\', "/");
        let mut out = self.root.clone();
        for component in Path::new(&normalized).components() {
            match component {
                Component::Normal(name) => out.push(name),
                _ => {
                    return Err(LocalError::InvalidPath(format!(
                        "path escapes notebook: {path}"
                    )))
                }
            }
        }
        Ok(out)
    }

    fn write_locked(&self, path: &Path, content: &str) -> std::io::Result<()> {
        let intent = if path.is_file() {
            FileLockIntent::Existing
        } else {
            FileLockIntent::Create
        };
        let memo_file = read_lock(&self.memo_file, "memo_file");
        memo_file.with_file_write(
            &self.notebook_id,
            path,
            intent,
            "fns_sync_write",
            |locked| {
                if locked.is_file() {
                    flowix_core::memo_file::atomic_write_bytes(locked, content.as_bytes())
                } else {
                    flowix_core::memo_file::atomic_create_bytes(locked, content.as_bytes())
                }
            },
        )
    }
}

impl LocalNoteStore for MemoFileStore {
    fn list_notes(&self) -> Result<Vec<LocalNote>, LocalError> {
        let mut notes = Vec::new();
        for entry in WalkDir::new(&self.root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|entry| !should_skip_entry(entry.path(), &self.root))
        {
            let Ok(entry) = entry else { continue };
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path();
            if !is_markdown(path) || FileManagementPolicy::has_hidden_attribute(path) {
                continue;
            }
            let Ok(relative_path) = path.strip_prefix(&self.root) else {
                continue;
            };
            if self
                .policy
                .is_index_ignored_at(&self.root, relative_path)
            {
                continue;
            }
            let Ok(content) = fs::read_to_string(path) else {
                // Skip unreadable or non-UTF-8 files rather than failing the
                // whole sync.
                continue;
            };
            let metadata = match entry.metadata() {
                Ok(metadata) => metadata,
                Err(_) => continue,
            };
            let mtime_ms = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or_else(now_ms);
            let ctime_ms = metadata
                .created()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(mtime_ms);

            notes.push(LocalNote {
                path: relative_path.to_string_lossy().replace('\\', "/"),
                content_hash: content_hash(&content),
                mtime_ms,
                ctime_ms,
            });
        }
        notes.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(notes)
    }

    fn read_note(&self, path: &str) -> Result<Option<String>, LocalError> {
        let target = self.resolve(path)?;
        match fs::read_to_string(&target) {
            Ok(content) => Ok(Some(content)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(LocalError::Io(error)),
        }
    }

    fn write_note(&self, path: &str, content: &str, mtime_ms: i64) -> Result<(), LocalError> {
        let target = self.resolve(path)?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        self.write_locked(&target, content)?;
        mark_self_write_for(&self.app, &target);
        let memo_file = read_lock(&self.memo_file, "memo_file");
        refresh_notebook_note_index(&memo_file, &target);
        set_mtime(&target, mtime_ms);
        Ok(())
    }

    fn delete_note(&self, path: &str) -> Result<(), LocalError> {
        let target = self.resolve(path)?;
        if !target.is_file() {
            return Ok(());
        }
        {
            let memo_file = read_lock(&self.memo_file, "memo_file");
            memo_file.with_file_write(
                &self.notebook_id,
                &target,
                FileLockIntent::Existing,
                "fns_sync_delete",
                |locked| fs::remove_file(locked),
            )?;
            refresh_notebook_note_index(&memo_file, &target);
        }
        mark_self_write_for(&self.app, &target);
        Ok(())
    }

    fn touch_note(&self, path: &str, mtime_ms: i64) -> Result<(), LocalError> {
        let target = self.resolve(path)?;
        if !target.is_file() {
            return Ok(());
        }
        set_mtime(&target, mtime_ms);
        mark_self_write_for(&self.app, &target);
        Ok(())
    }
}

fn should_skip_entry(path: &Path, root: &Path) -> bool {    if path == root {
        return false;
    }
    let Some(name) = path.file_name().map(|name| name.to_string_lossy()) else {
        return true;
    };
    if path.is_dir() {
        return name.starts_with('.')
            || matches!(
                name.as_ref(),
                "attachments"
                    | "attachments-cache"
                    | "node_modules"
                    | "bower_components"
                    | "__pycache__"
            );
    }
    false
}

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            let lower = extension.to_ascii_lowercase();
            lower == "md" || lower == "markdown"
        })
        .unwrap_or(false)
}

fn set_mtime(path: &Path, mtime_ms: i64) {
    if let Some(time) = SystemTime::UNIX_EPOCH
        .checked_add(std::time::Duration::from_millis(mtime_ms.max(0) as u64))
    {
        let _ = filetime::set_file_mtime(path, filetime::FileTime::from_system_time(time));
    }
}

/// Attachment-side walker filter. Unlike the note walker this keeps
/// `attachments/` and skips only hidden/internal directories and temp files.
fn should_skip_attachment_entry(path: &Path, root: &Path) -> bool {
    if path == root {
        return false;
    }
    let Some(name) = path.file_name().map(|name| name.to_string_lossy()) else {
        return true;
    };
    if path.is_dir() {
        return name.starts_with('.')
            || matches!(
                name.as_ref(),
                "node_modules" | "bower_components" | "__pycache__" | "attachments-cache"
            );
    }
    let name = name.as_ref();
    name.starts_with('.')
        || matches!(name, "Thumbs.db" | "ehthumbs.db" | "desktop.ini")
        || name.ends_with(".tmp")
        || name.ends_with(".swp")
        || name.ends_with(".bak")
        || name.ends_with(".lock")
        || name.ends_with('~')
}

impl MemoFileStore {
    fn write_bytes_locked(&self, path: &Path, content: &[u8]) -> std::io::Result<()> {
        let intent = if path.is_file() {
            FileLockIntent::Existing
        } else {
            FileLockIntent::Create
        };
        let memo_file = read_lock(&self.memo_file, "memo_file");
        memo_file.with_file_write(
            &self.notebook_id,
            path,
            intent,
            "fns_sync_file_write",
            |locked| {
                if locked.is_file() {
                    flowix_core::memo_file::atomic_write_bytes(locked, content)
                } else {
                    flowix_core::memo_file::atomic_create_bytes(locked, content)
                }
            },
        )
    }
}

impl LocalFileStore for MemoFileStore {
    fn list_files(&self, max_bytes: i64) -> Result<Vec<LocalFile>, LocalError> {
        let mut files = Vec::new();
        for entry in WalkDir::new(&self.root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|entry| !should_skip_attachment_entry(entry.path(), &self.root))
        {
            let Ok(entry) = entry else { continue };
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path();
            if is_markdown(path) {
                continue;
            }
            let metadata = match entry.metadata() {
                Ok(metadata) => metadata,
                Err(_) => continue,
            };
            if metadata.len() as i64 > max_bytes {
                continue;
            }
            let Ok(data) = fs::read(path) else { continue };
            let Ok(relative) = path.strip_prefix(&self.root) else {
                continue;
            };
            let mtime_ms = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or_else(now_ms);
            let ctime_ms = metadata
                .created()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(mtime_ms);
            files.push(LocalFile {
                path: relative.to_string_lossy().replace('\\', "/"),
                content_hash: encode_hash32_bytes(&data),
                size: data.len() as i64,
                mtime_ms,
                ctime_ms,
            });
        }
        files.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(files)
    }

    fn read_file(&self, path: &str) -> Result<Option<Vec<u8>>, LocalError> {
        let target = self.resolve(path)?;
        match fs::read(&target) {
            Ok(data) => Ok(Some(data)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(LocalError::Io(error)),
        }
    }

    fn write_file(&self, path: &str, data: &[u8], mtime_ms: i64) -> Result<(), LocalError> {
        let target = self.resolve(path)?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        self.write_bytes_locked(&target, data)?;
        mark_self_write_for(&self.app, &target);
        set_mtime(&target, mtime_ms);
        Ok(())
    }

    fn delete_file(&self, path: &str) -> Result<(), LocalError> {
        let target = self.resolve(path)?;
        if !target.is_file() {
            return Ok(());
        }
        {
            let memo_file = read_lock(&self.memo_file, "memo_file");
            memo_file.with_file_write(
                &self.notebook_id,
                &target,
                FileLockIntent::Existing,
                "fns_sync_file_delete",
                |locked| fs::remove_file(locked),
            )?;
        }
        mark_self_write_for(&self.app, &target);
        Ok(())
    }

    fn touch_file(&self, path: &str, mtime_ms: i64) -> Result<(), LocalError> {
        let target = self.resolve(path)?;
        if !target.is_file() {
            return Ok(());
        }
        set_mtime(&target, mtime_ms);
        mark_self_write_for(&self.app, &target);
        Ok(())
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}
