//! Filesystem-backed [`LocalNoteStore`].
//!
//! This is the reference implementation used by the CLI and by end-to-end
//! tests. The desktop shell uses its own adapter over `MemoFile` so writes keep
//! going through Flowix's locks and index updates.

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use walkdir::WalkDir;

use crate::hash::content_hash;
use crate::local::{LocalError, LocalFile, LocalFileStore, LocalNote, LocalNoteStore, Result};

/// Directories that never participate in sync.
const SKIPPED_DIRS: &[&str] = &[
    ".flowix",
    ".plugin-output",
    "attachments",
    "attachments-cache",
    "node_modules",
    "bower_components",
    "__pycache__",
];

#[derive(Debug, Clone)]
pub struct FsNoteStore {
    root: PathBuf,
}

impl FsNoteStore {
    pub fn new(root: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        if !root.is_dir() {
            return Err(LocalError::InvalidPath(format!(
                "notebook root is not a directory: {}",
                root.display()
            )));
        }
        Ok(Self {
            root: root.canonicalize()?,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Resolve a notebook-relative path, rejecting escapes and non-normal
    /// components.
    fn resolve(&self, path: &str) -> Result<PathBuf> {
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

    fn walk(&self, dir: &Path, out: &mut Vec<LocalNote>) -> Result<()> {
        let entries = match fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.into()),
        };

        for entry in entries {
            let entry = entry?;
            let path = entry.path();
            let name = entry.file_name();
            let name = name.to_string_lossy();

            let file_type = entry.file_type()?;
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                if !is_skipped_dir(&name) {
                    self.walk(&path, out)?;
                }
                continue;
            }
            if !is_markdown(&name) || name.starts_with('.') {
                continue;
            }

            let metadata = entry.metadata()?;
            let content = match fs::read_to_string(&path) {
                Ok(content) => content,
                Err(_) => continue,
            };
            let relative = path
                .strip_prefix(&self.root)
                .map_err(|_| LocalError::InvalidPath(path.display().to_string()))?
                .to_string_lossy()
                .replace('\\', "/");
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

            out.push(LocalNote {
                path: relative,
                content_hash: content_hash(&content),
                mtime_ms,
                ctime_ms,
            });
        }
        Ok(())
    }
}

impl LocalNoteStore for FsNoteStore {
    fn list_notes(&self) -> Result<Vec<LocalNote>> {
        let mut notes = Vec::new();
        self.walk(&self.root, &mut notes)?;
        notes.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(notes)
    }

    fn read_note(&self, path: &str) -> Result<Option<String>> {
        let target = self.resolve(path)?;
        match fs::read_to_string(&target) {
            Ok(content) => Ok(Some(content)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    fn write_note(&self, path: &str, content: &str, mtime_ms: i64) -> Result<()> {
        let target = self.resolve(path)?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        // Atomic replace so a crash cannot truncate an existing note.
        let temporary = target.with_extension("md.flowix-sync.tmp");
        fs::write(&temporary, content)?;
        fs::rename(&temporary, &target)?;

        // Preserve the remote mtime so the next sync does not classify this
        // write as a local edit.
        if let Some(time) = SystemTime::UNIX_EPOCH
            .checked_add(std::time::Duration::from_millis(mtime_ms.max(0) as u64))
        {
            let _ = filetime::set_file_mtime(&target, filetime::FileTime::from_system_time(time));
        }
        Ok(())
    }

    fn delete_note(&self, path: &str) -> Result<()> {
        let target = self.resolve(path)?;
        match fs::remove_file(&target) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    fn touch_note(&self, path: &str, mtime_ms: i64) -> Result<()> {
        let target = self.resolve(path)?;
        if !target.is_file() {
            return Ok(());
        }
        if let Some(time) = SystemTime::UNIX_EPOCH
            .checked_add(std::time::Duration::from_millis(mtime_ms.max(0) as u64))
        {
            filetime::set_file_mtime(&target, filetime::FileTime::from_system_time(time))?;
        }
        Ok(())
    }
}

fn is_markdown(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".md") || lower.ends_with(".markdown")
}

/// Attachment-side directory filter: unlike the note walker this one *keeps*
/// `attachments/`.
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

impl LocalFileStore for FsNoteStore {
    fn list_files(&self, max_bytes: i64) -> Result<Vec<LocalFile>> {
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
            let file_name = path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default();
            if is_markdown(&file_name) {
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
            let relative = match path.strip_prefix(&self.root) {
                Ok(relative) => relative.to_string_lossy().replace('\\', "/"),
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
            files.push(LocalFile {
                path: relative,
                content_hash: crate::hash::encode_hash32_bytes(&data),
                size: data.len() as i64,
                mtime_ms,
                ctime_ms,
            });
        }
        files.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(files)
    }

    fn read_file(&self, path: &str) -> Result<Option<Vec<u8>>> {
        let target = self.resolve(path)?;
        match fs::read(&target) {
            Ok(data) => Ok(Some(data)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    fn write_file(&self, path: &str, data: &[u8], mtime_ms: i64) -> Result<()> {
        let target = self.resolve(path)?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        let temporary = target.with_extension("flowix-sync.tmp");
        fs::write(&temporary, data)?;
        fs::rename(&temporary, &target)?;
        if let Some(time) = SystemTime::UNIX_EPOCH
            .checked_add(std::time::Duration::from_millis(mtime_ms.max(0) as u64))
        {
            let _ = filetime::set_file_mtime(&target, filetime::FileTime::from_system_time(time));
        }
        Ok(())
    }

    fn delete_file(&self, path: &str) -> Result<()> {
        let target = self.resolve(path)?;
        match fs::remove_file(&target) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    fn touch_file(&self, path: &str, mtime_ms: i64) -> Result<()> {
        let target = self.resolve(path)?;
        if target.is_file() {
            if let Some(time) = SystemTime::UNIX_EPOCH
                .checked_add(std::time::Duration::from_millis(mtime_ms.max(0) as u64))
            {
                filetime::set_file_mtime(&target, filetime::FileTime::from_system_time(time))?;
            }
        }
        Ok(())
    }
}

fn is_skipped_dir(name: &str) -> bool {
    name.starts_with('.') || SKIPPED_DIRS.iter().any(|skipped| name.eq_ignore_ascii_case(skipped))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_only_syncable_markdown() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("sub")).unwrap();
        fs::create_dir_all(dir.path().join(".flowix")).unwrap();
        fs::create_dir_all(dir.path().join("attachments")).unwrap();
        fs::write(dir.path().join("a.md"), "a").unwrap();
        fs::write(dir.path().join("sub/b.markdown"), "b").unwrap();
        fs::write(dir.path().join("sub/ignore.txt"), "x").unwrap();
        fs::write(dir.path().join(".hidden.md"), "x").unwrap();
        fs::write(dir.path().join(".flowix/db.md"), "x").unwrap();
        fs::write(dir.path().join("attachments/image.md"), "x").unwrap();

        let store = FsNoteStore::new(dir.path()).unwrap();
        let paths: Vec<_> = store.list_notes().unwrap().into_iter().map(|n| n.path).collect();
        assert_eq!(paths, vec!["a.md", "sub/b.markdown"]);
    }

    #[test]
    fn rejects_path_escapes() {
        let dir = tempfile::tempdir().unwrap();
        let store = FsNoteStore::new(dir.path()).unwrap();
        assert!(store.read_note("../x.md").is_err());
        assert!(store.read_note("/etc/passwd").is_err());
    }
}
