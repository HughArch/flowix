//! macOS security-scoped bookmarks for authorized directories and selected files.
//!
//! OS grants are persisted separately from Flowix notebook and document grants.
//! A file bookmark never authorizes its parent directory.

use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use serde::{Deserialize, Serialize};

use crate::config::user::{atomic_write_json, UserConfigError};

const BOOT_DIR_NAME: &str = "boot";

fn bookmarks_file_name() -> &'static str {
    if option_env!("FLOWIX_DEV_MODE") == Some("1") {
        "bookmark.dev.json"
    } else {
        "bookmark.json"
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BookmarkEntry {
    path: String,
    bookmark: String,
    updated_at: i64,
    #[serde(default = "directory_default")]
    directory: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BookmarkConfig {
    #[serde(default = "default_version")]
    version: u32,
    #[serde(default)]
    entries: BTreeMap<String, BookmarkEntry>,
}

impl Default for BookmarkConfig {
    fn default() -> Self {
        Self {
            version: 1,
            entries: BTreeMap::new(),
        }
    }
}

fn directory_default() -> bool {
    true
}

fn default_version() -> u32 {
    1
}

fn normalize_path(path: &Path) -> String {
    let path = dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let normalized = path.to_string_lossy().to_string();
    if normalized.len() > 1 {
        normalized
            .trim_end_matches(|c| c == '/' || c == '\\')
            .to_string()
    } else {
        normalized
    }
}

pub struct SecurityBookmarkStore {
    /// User config root (`~/.flowix`). Bookmark JSON is stored under `boot/`.
    config_dir: PathBuf,
    inner: RwLock<BookmarkConfig>,
    #[cfg(target_os = "macos")]
    active: RwLock<Vec<macos::ScopedAccess>>,
}

impl SecurityBookmarkStore {
    pub fn new(config_dir: PathBuf) -> Self {
        let config = read_from_disk(&config_dir)
            .ok()
            .flatten()
            .unwrap_or_default();
        let store = Self {
            config_dir,
            inner: RwLock::new(config),
            #[cfg(target_os = "macos")]
            active: RwLock::new(Vec::new()),
        };
        store.restore_all();
        store
    }

    pub fn record_directory(&self, path: &Path) -> Result<(), UserConfigError> {
        #[cfg(target_os = "macos")]
        {
            let bookmark = macos::bookmark_for_directory(path).ok_or_else(|| {
                UserConfigError::Io(io::Error::new(
                    io::ErrorKind::Other,
                    format!(
                        "failed to create security-scoped bookmark for {}",
                        path.display()
                    ),
                ))
            })?;
            self.record_directory_bookmark(path, bookmark)?;
        }
        #[cfg(not(target_os = "macos"))]
        let _ = path;
        Ok(())
    }

    pub fn record_file(&self, path: &Path) -> Result<(), UserConfigError> {
        #[cfg(target_os = "macos")]
        {
            let url = objc2_foundation::NSURL::from_file_path(path).ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidInput, "invalid selected file URL")
            })?;
            let bookmark = macos::bookmark_for_url(&url).ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "cannot bookmark selected file",
                )
            })?;
            self.upsert(path, bookmark, false)?;
            self.start_accessing_path(path);
        }
        #[cfg(not(target_os = "macos"))]
        let _ = path;
        Ok(())
    }

    /// Called only for a directory already authorized by Flowix. Successful
    /// enumeration means macOS has allowed access (including a TCC prompt).
    pub fn record_accessible_directory(&self, path: &Path) {
        #[cfg(target_os = "macos")]
        {
            if self.start_accessing_for_path(path) {
                return;
            }
            if std::fs::read_dir(path).is_ok() {
                if let Err(error) = self.record_directory(path) {
                    tracing::warn!(%error, path = %path.display(), "cannot persist granted directory access");
                }
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = path;
    }

    #[cfg(target_os = "macos")]
    fn refresh_stale(&self, old_path: &str, directory: bool, access: &macos::ScopedAccess) {
        if !access.is_stale() {
            return;
        }
        let Some(bookmark) = access.refreshed_bookmark() else {
            return;
        };
        let mut current = self.inner.write().unwrap_or_else(|p| p.into_inner());
        let mut next = current.clone();
        next.entries.remove(old_path);
        let path = access.path_key().to_string();
        next.entries.insert(
            path.clone(),
            BookmarkEntry {
                path,
                bookmark,
                directory,
                updated_at: chrono::Utc::now().timestamp_millis(),
            },
        );
        match serde_json::to_string_pretty(&next) {
            Ok(content) => {
                match atomic_write_json(&bookmarks_file_path(&self.config_dir), &content) {
                    Ok(()) => *current = next,
                    Err(error) => tracing::warn!(%error, "cannot refresh stale bookmark"),
                }
            }
            Err(error) => tracing::warn!(%error, "cannot serialize refreshed bookmark"),
        }
    }

    pub fn record_directory_bookmark(
        &self,
        path: &Path,
        bookmark: String,
    ) -> Result<(), UserConfigError> {
        self.upsert(path, bookmark, true)?;
        self.start_accessing_path(path);
        Ok(())
    }

    pub fn restore_all(&self) {
        #[cfg(target_os = "macos")]
        {
            let entries: Vec<BookmarkEntry> = self
                .inner
                .read()
                .unwrap_or_else(|p| p.into_inner())
                .entries
                .values()
                .cloned()
                .collect();
            let mut active = self.active.write().unwrap_or_else(|p| p.into_inner());
            active.clear();
            for entry in entries {
                match macos::resolve_bookmark(&entry.bookmark) {
                    Some(access) => {
                        self.refresh_stale(&entry.path, entry.directory, &access);
                        active.push(access);
                    }
                    None => tracing::warn!(
                        "[security_bookmark] failed to resolve bookmark for {}",
                        entry.path
                    ),
                }
            }
        }
    }

    pub fn start_accessing_path(&self, path: &Path) {
        #[cfg(target_os = "macos")]
        {
            let key = normalize_path(path);
            let bookmark = {
                self.inner
                    .read()
                    .unwrap_or_else(|p| p.into_inner())
                    .entries
                    .get(&key)
                    .map(|entry| entry.bookmark.clone())
            };
            if let Some(bookmark) = bookmark {
                self.activate_bookmark(key, bookmark, path);
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = path;
    }

    pub fn start_accessing_for_path(&self, path: &Path) -> bool {
        #[cfg(target_os = "macos")]
        {
            let Some((key, bookmark)) = self.bookmark_for_containing_path(path) else {
                return false;
            };
            self.activate_bookmark(key, bookmark, path)
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = path;
            false
        }
    }

    #[cfg(target_os = "macos")]
    fn activate_bookmark(&self, key: String, bookmark: String, requested_path: &Path) -> bool {
        if self
            .active
            .read()
            .is_ok_and(|active| active.iter().any(|existing| existing.path_key() == key))
        {
            return true;
        }
        if let Some(access) = macos::resolve_bookmark(&bookmark) {
            let directory = self
                .inner
                .read()
                .unwrap_or_else(|p| p.into_inner())
                .entries
                .get(&key)
                .map(|entry| entry.directory)
                .unwrap_or(true);
            self.refresh_stale(&key, directory, &access);
            let mut active = self.active.write().unwrap_or_else(|p| p.into_inner());
            if !active.iter().any(|existing| existing.path_key() == key) {
                active.push(access);
            }
            return true;
        }
        tracing::warn!(
            "[security_bookmark] failed to activate bookmark for {} via {}",
            requested_path.display(),
            key
        );
        false
    }

    #[cfg(target_os = "macos")]
    fn bookmark_for_containing_path(&self, path: &Path) -> Option<(String, String)> {
        self.inner
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .entries
            .iter()
            .filter(|(_, entry)| {
                if entry.directory {
                    super::path_scope::path_is_inside(path, Path::new(&entry.path))
                } else {
                    normalize_path(path) == entry.path
                }
            })
            .max_by_key(|(key, _)| key.len())
            .map(|(key, entry)| (key.clone(), entry.bookmark.clone()))
    }

    fn upsert(
        &self,
        path: &Path,
        bookmark: String,
        directory: bool,
    ) -> Result<(), UserConfigError> {
        let key = normalize_path(path);
        let mut current = self.inner.write().unwrap_or_else(|p| p.into_inner());
        let mut next = current.clone();
        next.entries.insert(
            key,
            BookmarkEntry {
                path: normalize_path(path),
                bookmark,
                updated_at: chrono::Utc::now().timestamp_millis(),
                directory,
            },
        );
        let content = serde_json::to_string_pretty(&next)?;
        atomic_write_json(&bookmarks_file_path(&self.config_dir), &content)?;
        *current = next;
        Ok(())
    }
}

fn bookmarks_file_path(config_dir: &Path) -> PathBuf {
    config_dir.join(BOOT_DIR_NAME).join(bookmarks_file_name())
}

fn read_from_disk(config_dir: &Path) -> std::io::Result<Option<BookmarkConfig>> {
    read_bookmark_config_file(&bookmarks_file_path(config_dir))
}

fn read_bookmark_config_file(path: &Path) -> std::io::Result<Option<BookmarkConfig>> {
    if !path.exists() {
        return Ok(None);
    }
    let content = std::fs::read_to_string(path)?;
    if content.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some(serde_json::from_str(&content).unwrap_or_default()))
}

#[cfg(target_os = "macos")]
mod macos {
    use std::path::{Path, PathBuf};

    use base64::Engine;
    use objc2::rc::Retained;
    use objc2_foundation::{
        NSData, NSURLBookmarkCreationOptions, NSURLBookmarkResolutionOptions, NSURL,
    };

    use super::normalize_path;

    pub struct ScopedAccess {
        url: Retained<NSURL>,
        path_key: String,
        active: bool,
        stale: bool,
    }

    impl ScopedAccess {
        pub fn path_key(&self) -> &str {
            &self.path_key
        }

        pub fn refreshed_bookmark(&self) -> Option<String> {
            bookmark_for_url(&self.url)
        }

        pub fn is_stale(&self) -> bool {
            self.stale
        }
    }

    impl Drop for ScopedAccess {
        fn drop(&mut self) {
            if self.active {
                unsafe { self.url.stopAccessingSecurityScopedResource() };
            }
        }
    }

    pub fn bookmark_for_directory(path: &Path) -> Option<String> {
        let url = NSURL::from_directory_path(path)?;
        bookmark_for_url(&url)
    }

    pub fn bookmark_for_url(url: &NSURL) -> Option<String> {
        let data = url
            .bookmarkDataWithOptions_includingResourceValuesForKeys_relativeToURL_error(
                NSURLBookmarkCreationOptions::WithSecurityScope,
                None,
                None,
            )
            .map_err(|e| {
                tracing::warn!(
                    "[security_bookmark] failed to create bookmark for {:?}: {:?}",
                    url,
                    e
                );
            })
            .ok()?;
        Some(base64::engine::general_purpose::STANDARD.encode(data.iter().collect::<Vec<_>>()))
    }

    pub fn resolve_bookmark(bookmark: &str) -> Option<ScopedAccess> {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(bookmark)
            .ok()?;
        let data = NSData::with_bytes(&bytes);
        let mut stale = objc2::runtime::Bool::NO;
        let url = unsafe {
            NSURL::URLByResolvingBookmarkData_options_relativeToURL_bookmarkDataIsStale_error(
                &data,
                NSURLBookmarkResolutionOptions::WithSecurityScope,
                None,
                &mut stale,
            )
        }
        .map_err(|e| {
            tracing::warn!("[security_bookmark] failed to resolve bookmark: {:?}", e);
        })
        .ok()?;
        if stale.as_bool() {
            tracing::warn!("[security_bookmark] resolved stale bookmark");
        }
        let active = unsafe { url.startAccessingSecurityScopedResource() };
        if !active {
            tracing::warn!("[security_bookmark] macOS refused scoped access for resolved bookmark");
            return None;
        }
        let path = url.to_file_path().unwrap_or_else(PathBuf::new);
        Some(ScopedAccess {
            path_key: normalize_path(&path),
            url,
            active,
            stale: stale.as_bool(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_config() -> BookmarkConfig {
        let mut config = BookmarkConfig::default();
        config.entries.insert(
            "/tmp/flowix-bookmark-test".to_string(),
            BookmarkEntry {
                path: "/tmp/flowix-bookmark-test".to_string(),
                bookmark: "bookmark-data".to_string(),
                updated_at: 1,
                directory: true,
            },
        );
        config
    }

    #[test]
    fn reads_bookmarks_from_boot_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let config = sample_config();
        let content = serde_json::to_string_pretty(&config).unwrap();
        atomic_write_json(&bookmarks_file_path(tmp.path()), &content).unwrap();

        let loaded = read_from_disk(tmp.path()).unwrap().unwrap();

        assert_eq!(loaded.entries.len(), 1);
        assert!(loaded.entries.contains_key("/tmp/flowix-bookmark-test"));
    }
}
