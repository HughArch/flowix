//! Local document version history IPC.
//!
//! Restoring a version is a purely local write: snapshot the current bytes,
//! then replace the file while guarding against a concurrent external edit.
//! The replaced-in-flight bytes are preserved as a conflict copy instead of
//! being silently discarded.

use std::path::{Path, PathBuf};

use flowix_core::memo_file::{notebook_relative_path, IsMd, MemoVersionSource};
use tauri::{AppHandle, Emitter, State};

use crate::app::state::AppState;
use crate::lock_utils::read_lock;

#[tauri::command]
pub fn list_local_path_archives(
    state: State<'_, AppState>,
) -> Vec<flowix_core::memo_file::PathArchiveSummary> {
    read_lock(&state.memo_file, "memo_file").list_path_archives()
}

#[tauri::command]
pub fn restore_local_path_version(
    notebook_id: String,
    relative_path: String,
    version_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let _guard = memo_file
        .operation_locks()
        .notebook_change(&[&notebook_id], "restore_local_path_version")
        .map_err(|error| error.to_string())?;
    let notebook = memo_file
        .get_notebook_config_by_id(&notebook_id)
        .ok_or_else(|| "NOTEBOOK_NOT_FOUND".to_string())?;
    let root = Path::new(&notebook.path);
    let attachment = relative_path.starts_with("attachments/");
    if !attachment && !Path::new(&relative_path).is_md() {
        return Err("HISTORY_INVALID_PATH".into());
    }
    let path = safe_archive_path(root, &relative_path, attachment)?;
    let target = memo_file
        .read_path_version_bytes(&notebook_id, &relative_path, &version_id)
        .ok_or_else(|| "HISTORY_VERSION_NOT_FOUND".to_string())?;
    if !attachment && std::str::from_utf8(&target).is_err() {
        return Err("HISTORY_INVALID_MARKDOWN".into());
    }
    let current = match std::fs::read(&path) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.to_string()),
    };
    if current.as_deref() == Some(target.as_slice()) {
        return Ok(());
    }
    if let Some(bytes) = current.as_deref() {
        memo_file
            .create_path_version_bytes(
                &notebook_id,
                &relative_path,
                bytes,
                MemoVersionSource::RestoreBackup,
            )
            .map_err(|error| error.to_string())?;
    }
    let conflict_copy = conflict_copy_path(&path, &format!("restore-{version_id}"));
    match restore_contents(&path, current.as_deref(), &target, &conflict_copy)? {
        RestoreOutcome::Applied => {}
        RestoreOutcome::Interrupted { preserved } => {
            if let Some(preserved) = preserved {
                register_preserved_copy(&memo_file, &notebook_id, root, &preserved, attachment)?;
            }
            return Err("HISTORY_LOCAL_CHANGED".into());
        }
    }
    crate::watcher::runtime::mark_self_write_content_for(&app, &path, &target);
    // The self-write marker suppresses the watcher's own FNS trigger, so the
    // restored content must be scheduled explicitly.
    crate::fns_sync::schedule_notebook_sync(&app, &notebook_id);
    if attachment {
        memo_file
            .refresh_indexed_resource_path(&notebook_id, &relative_path)
            .map_err(|error| error.to_string())?;
        let _ = app.emit(
            "media-properties-changed",
            serde_json::json!({ "notebookId": notebook_id }),
        );
    } else {
        memo_file
            .refresh_note_path(&notebook_id, &relative_path)
            .map_err(|error| error.to_string())?;
        crate::commands::path_change::NotebookPathInvalidated::new(
            notebook_id.clone(),
            relative_path.clone(),
        )
        .emit(&app);
    }
    Ok(())
}

enum RestoreOutcome {
    Applied,
    Interrupted { preserved: Option<PathBuf> },
}

/// Resolve a notebook-relative archive path, rejecting traversal, hidden
/// components, symlinks, and paths outside the notebook root.
fn safe_archive_path(root: &Path, relative_path: &str, attachment: bool) -> Result<PathBuf, String> {
    let candidate = Path::new(relative_path);
    if (!attachment && !candidate.is_md())
        || (attachment && !relative_path.starts_with("attachments/"))
        || relative_path.contains('\\')
        || relative_path.starts_with('/')
        || candidate
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
        || candidate
            .components()
            .any(|component| component.as_os_str().to_string_lossy().starts_with('.'))
    {
        return Err("HISTORY_INVALID_PATH".to_string());
    }
    let mut path = root.to_path_buf();
    for component in candidate.components() {
        path.push(component.as_os_str());
        if let Ok(metadata) = std::fs::symlink_metadata(&path) {
            if metadata.file_type().is_symlink() {
                return Err("HISTORY_PATH_SYMLINK".to_string());
            }
        }
    }
    Ok(path)
}

fn restore_contents(
    path: &Path,
    expected: Option<&[u8]>,
    replacement: &[u8],
    conflict_copy: &Path,
) -> Result<RestoreOutcome, String> {
    let Some(expected) = expected else {
        return match flowix_core::memo_file::atomic_create_bytes(path, replacement) {
            Ok(()) => Ok(RestoreOutcome::Applied),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let current = std::fs::read(path).map_err(|error| error.to_string())?;
                let preserved = save_conflict_copy(conflict_copy, &current)?;
                Ok(RestoreOutcome::Interrupted {
                    preserved: Some(preserved),
                })
            }
            Err(error) => Err(error.to_string()),
        };
    };
    let current = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(RestoreOutcome::Interrupted { preserved: None });
        }
        Err(error) => return Err(error.to_string()),
    };
    if current != expected {
        let preserved = save_conflict_copy(conflict_copy, &current)?;
        return Ok(RestoreOutcome::Interrupted {
            preserved: Some(preserved),
        });
    }
    flowix_core::memo_file::atomic_write_bytes(path, replacement)
        .map_err(|error| error.to_string())?;
    Ok(RestoreOutcome::Applied)
}

fn conflict_copy_path(path: &Path, operation_id: &str) -> PathBuf {
    let operation_key: String = operation_id
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || *character == '-')
        .take(48)
        .collect();
    let stem: String = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Note")
        .chars()
        .take(80)
        .collect();
    let name = match path.extension().and_then(|value| value.to_str()) {
        Some(extension) => format!("{stem} (Flowix conflict {operation_key}).{extension}"),
        None => format!("{stem} (Flowix conflict {operation_key})"),
    };
    path.with_file_name(name)
}

fn save_conflict_copy(primary: &Path, bytes: &[u8]) -> Result<PathBuf, String> {
    if primary.exists() {
        if std::fs::read(primary).map_err(|error| error.to_string())? == bytes {
            return Ok(primary.to_path_buf());
        }
        let stem = primary
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("Note");
        let extension = primary.extension().and_then(|value| value.to_str());
        for suffix in 1..100 {
            let name = match (extension, suffix) {
                (Some(extension), suffix) => format!("{stem}-{suffix}.{extension}"),
                (None, suffix) => format!("{stem}-{suffix}"),
            };
            let candidate = primary.with_file_name(name);
            if candidate.exists() {
                if std::fs::read(&candidate).map_err(|error| error.to_string())? == bytes {
                    return Ok(candidate);
                }
                continue;
            }
            match flowix_core::memo_file::atomic_create_bytes(&candidate, bytes) {
                Ok(()) => return Ok(candidate),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    if std::fs::read(&candidate).map_err(|error| error.to_string())? == bytes {
                        return Ok(candidate);
                    }
                }
                Err(error) => return Err(error.to_string()),
            }
        }
        return Err("HISTORY_CONFLICT_COPY_COLLISION".into());
    }
    flowix_core::memo_file::atomic_create_bytes(primary, bytes)
        .map_err(|error| error.to_string())?;
    Ok(primary.to_path_buf())
}

fn register_preserved_copy(
    memo_file: &flowix_core::memo_file::MemoFile,
    notebook_id: &str,
    notebook_root: &Path,
    path: &Path,
    attachment: bool,
) -> Result<(), String> {
    let relative = notebook_relative_path(notebook_root, path)
        .map_err(|error| error.to_string())?;
    if attachment {
        memo_file
            .refresh_indexed_resource_path(notebook_id, &relative)
            .map_err(|error| error.to_string())
    } else {
        memo_file
            .refresh_note_path(notebook_id, &relative)
            .map_err(|error| error.to_string())
    }
}
