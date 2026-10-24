//! Keep the notebook path index aligned with filesystem changes.
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use flowix_core::memo_file::{
    resource_kind_for_path, FileManagementPolicy, notebook_relative_path, MemoFile,
};
use tauri::{AppHandle, Emitter, Manager};

use crate::watcher::event::{FsEventKind, RawFsEvent};

#[derive(Debug, Clone)]
pub struct NotebookWatchContext {
    pub notebook_id: String,
    pub root: PathBuf,
}

pub struct PathNoteEventProcessor;

#[derive(Debug)]
pub(crate) enum DispatchOutcome {
    PathIndexed { relative_path: String, change: PathChangeKind },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PathChangeKind {
    Created,
    Updated,
    Deleted,
}

fn is_markdown_path(path: &Path) -> bool {
    path.extension().and_then(|value| value.to_str())
        .is_some_and(|value| matches!(value.to_ascii_lowercase().as_str(), "md" | "markdown"))
}

fn indexable_relative_path(ctx: &NotebookWatchContext, path: &Path) -> Result<String, String> {
    let relative_path = notebook_relative_path(&ctx.root, path)?;
    let relative = Path::new(&relative_path);
    if !is_markdown_path(relative) || FileManagementPolicy::from_notebook_root(&ctx.root).is_index_ignored_at(&ctx.root, relative) {
        return Err("not an indexable Markdown path".to_string());
    }
    Ok(relative_path)
}

#[cfg(test)]
pub(crate) fn dispatch_modify_event(
    memo_file: &MemoFile,
    ctx: &NotebookWatchContext,
    path: &Path,
    _event_kind: FsEventKind,
) -> Result<DispatchOutcome, String> {
    let path_was_known = memo_file
        .indexed_note_path_presence(&ctx.notebook_id, &notebook_relative_path(&ctx.root, path)?)
        .ok()
        .flatten();
    refresh_path(memo_file, ctx, path, path_was_known)
}

fn refresh_path(
    memo_file: &MemoFile,
    ctx: &NotebookWatchContext,
    path: &Path,
    path_was_known: Option<bool>,
) -> Result<DispatchOutcome, String> {
    refresh_path_with_content(memo_file, ctx, path, path_was_known, None)
}

fn refresh_path_with_content(
    memo_file: &MemoFile,
    ctx: &NotebookWatchContext,
    path: &Path,
    path_was_known: Option<bool>,
    content: Option<&str>,
) -> Result<DispatchOutcome, String> {
    let relative_path = indexable_relative_path(ctx, path)?;
    match content {
        Some(content) => memo_file.refresh_note_path_with_content(&ctx.notebook_id, &relative_path, content),
        None => memo_file.refresh_note_path(&ctx.notebook_id, &relative_path),
    }.map_err(|error| error.to_string())?;
    let change = if !path.is_file() {
        PathChangeKind::Deleted
    } else if path_was_known == Some(false) {
        PathChangeKind::Created
    } else {
        PathChangeKind::Updated
    };
    Ok(DispatchOutcome::PathIndexed { relative_path, change })
}

fn emit_path_changed(app: &AppHandle, ctx: &NotebookWatchContext, relative_path: &str, deleted: bool) {
    emit_path_changed_with_content(app, ctx, relative_path, deleted, None);
}

fn emit_path_changed_with_content(
    app: &AppHandle,
    ctx: &NotebookWatchContext,
    relative_path: &str,
    deleted: bool,
    _content: Option<&str>,
) {
    emit_path_changed_ui(app, ctx, relative_path, deleted);
    // External edits are not self-writes, so this is exactly the case the
    // FNS engine needs to pick up.
    crate::fns_sync::schedule_notebook_sync(app, &ctx.notebook_id);
}

fn emit_path_changed_ui(app: &AppHandle, ctx: &NotebookWatchContext, relative_path: &str, deleted: bool) {
    let _ = app.emit("flowix:path-note-changed", serde_json::json!({
        "notebookId": ctx.notebook_id,
        "relativePath": relative_path,
        "deleted": deleted,
    }));
}

fn refresh_resource_path(memo_file: &MemoFile, ctx: &NotebookWatchContext, path: &Path) -> Result<(), String> {
    let relative_path = notebook_relative_path(&ctx.root, path)?;
    if FileManagementPolicy::from_notebook_root(&ctx.root)
        .is_ignored_at(&ctx.root, Path::new(&relative_path)) {
        return Ok(());
    }
    memo_file.refresh_indexed_resource_path(&ctx.notebook_id, &relative_path)
        .map_err(|error| error.to_string())
}

fn enclosing_package_document(ctx: &NotebookWatchContext, path: &Path) -> Option<PathBuf> {
    path.ancestors()
        .skip(1)
        .take_while(|ancestor| *ancestor != ctx.root.as_path())
        .find(|ancestor| {
            ancestor.is_dir()
                && ancestor
                    .extension()
                    .and_then(|value| value.to_str())
                    .is_some_and(|extension| matches!(extension.to_ascii_lowercase().as_str(), "pages" | "key"))
        })
        .map(Path::to_path_buf)
}

fn process_indexed_resource_event(
    event: &RawFsEvent,
    memo_file: &Arc<std::sync::RwLock<MemoFile>>,
    ctx: &NotebookWatchContext,
) -> bool {
    if matches!(event.kind, FsEventKind::DirectoryChange) {
        return false;
    }
    let old_resource = event.rename_from.as_ref().is_some_and(|path| resource_kind_for_path(path).is_some());
    let new_resource = resource_kind_for_path(&event.path).is_some();
    if !old_resource && !new_resource {
        return false;
    }
    let Ok(memo_file) = memo_file.read() else { return true; };
    let Ok(_write_guard) = memo_file.operation_locks().notebook_read(&ctx.notebook_id, "watcher_resource_refresh") else { return true; };
    if old_resource && new_resource {
        if let Some(old_path) = event.rename_from.as_ref() {
            if event.rename_from_notebook_id.as_ref().is_none_or(|id| id == &ctx.notebook_id) {
                let old_root = event.rename_from_root.as_ref().unwrap_or(&ctx.root);
                if let (Ok(old_relative), Ok(new_relative)) = (
                    notebook_relative_path(old_root, old_path),
                    notebook_relative_path(&ctx.root, &event.path),
                ) {
                    match memo_file.move_indexed_resource_path(&ctx.notebook_id, &old_relative, &new_relative) {
                        Ok(true) => return true,
                        Ok(false) => {},
                        Err(error) => tracing::warn!("resource rename refresh failed: {error}"),
                    }
                }
            }
        }
    }
    if new_resource {
        if let Err(error) = refresh_resource_path(&memo_file, ctx, &event.path) {
            tracing::warn!(path = %event.path.display(), "resource path refresh failed: {error}");
        }
    }
    if let Some(old_path) = event.rename_from.as_ref().filter(|_| old_resource) {
        let old_ctx = NotebookWatchContext {
            notebook_id: event.rename_from_notebook_id.clone().unwrap_or_else(|| ctx.notebook_id.clone()),
            root: event.rename_from_root.clone().unwrap_or_else(|| ctx.root.clone()),
        };
        if let Err(error) = refresh_resource_path(&memo_file, &old_ctx, old_path) {
            tracing::warn!(path = %old_path.display(), "old resource path refresh failed: {error}");
        }
    }
    // A type-changing rename may also add or remove a Markdown note.
    !is_markdown_path(&event.path)
        && !event.rename_from.as_ref().is_some_and(|path| is_markdown_path(path))
}

/// Ignore attachments even when a user preference broadens the watcher filter.
fn is_under_attachments_dir(ctx: &NotebookWatchContext, path: &Path) -> bool {
    let attachments = crate::watcher::path::normalize_for_compare(&ctx.root.join("attachments"));
    crate::watcher::path::normalize_for_compare(path).starts_with(&attachments)
}

pub(crate) fn wait_for_markdown_copy_to_settle(path: &Path) {
    let mut last_len = None;
    let mut stable_samples = 0;
    for _ in 0..8 {
        let Ok(meta) = std::fs::metadata(path) else {
            std::thread::sleep(Duration::from_millis(50));
            continue;
        };
        if !meta.is_file() { return; }
        let len = meta.len();
        if Some(len) == last_len {
            stable_samples += 1;
            if stable_samples >= 2 && std::fs::File::open(path).is_ok() { return; }
        } else {
            last_len = Some(len);
            stable_samples = 0;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

impl PathNoteEventProcessor {
    pub fn process(
        event: &RawFsEvent,
        app: &AppHandle,
        memo_file: &Arc<std::sync::RwLock<MemoFile>>,
        ctx: &NotebookWatchContext,
        stable_content: Option<&str>,
    ) {
        if let Some(previous) = &event.rename_from {
            crate::commands::external_document_watch::rebase_path(app, previous, &event.path);
        }

        let old_bundle = event.rename_from.as_ref().and_then(|path| {
            let old_ctx = NotebookWatchContext {
                notebook_id: event.rename_from_notebook_id.clone().unwrap_or_else(|| ctx.notebook_id.clone()),
                root: event.rename_from_root.clone().unwrap_or_else(|| ctx.root.clone()),
            };
            enclosing_package_document(&old_ctx, path).map(|bundle| (old_ctx, bundle))
        });
        let new_bundle = enclosing_package_document(ctx, &event.path);
        if old_bundle.is_some() || new_bundle.is_some() {
            if let Ok(memo_file) = memo_file.read() {
                if let Some((old_ctx, bundle)) = &old_bundle {
                    if let Ok(relative) = notebook_relative_path(&old_ctx.root, bundle) {
                        let _ = memo_file.refresh_indexed_resource_path(&old_ctx.notebook_id, &relative);
                    }
                }
                if let Some(bundle) = &new_bundle {
                    if let Ok(relative) = notebook_relative_path(&ctx.root, bundle) {
                        let _ = memo_file.refresh_indexed_resource_path(&ctx.notebook_id, &relative);
                    }
                }
                if new_bundle.is_some()
                    && old_bundle.is_none()
                    && event.rename_from.as_ref().is_some_and(|path| resource_kind_for_path(path).is_some())
                {
                    if let Some(old_path) = &event.rename_from {
                        let old_ctx = NotebookWatchContext {
                            notebook_id: event.rename_from_notebook_id.clone().unwrap_or_else(|| ctx.notebook_id.clone()),
                            root: event.rename_from_root.clone().unwrap_or_else(|| ctx.root.clone()),
                        };
                        let _ = refresh_resource_path(&memo_file, &old_ctx, old_path);
                    }
                }
            }
            if new_bundle.is_some() {
                return;
            }
        }

        if process_indexed_resource_event(event, memo_file, ctx) {
            if let Some(old_path) = event.rename_from.as_ref() {
                if let Ok(memo_file) = memo_file.read() {
                    crate::commands::document_list::rebase_collection_paths_for_move(
                        &memo_file,
                        old_path,
                        &event.path,
                    );
                }
            }
            // Attachment changes are not self-writes, so FNS must observe them
            // explicitly (the resource branch returns before the note path).
            crate::fns_sync::schedule_notebook_sync(app, &ctx.notebook_id);
            if let Some(old_notebook_id) = event.rename_from_notebook_id.as_ref() {
                if old_notebook_id != &ctx.notebook_id {
                    crate::fns_sync::schedule_notebook_sync(app, old_notebook_id);
                }
            }
            return;
        }
        if event.rename_from.is_none()
            && is_under_attachments_dir(ctx, &event.path)
            && FileManagementPolicy::from_notebook_root(&ctx.root)
                .is_ignored_at(&ctx.root, Path::new("attachments")) { return; }
        if let (Some(old_path), Some(old_notebook_id), Some(old_root)) = (
            event.rename_from.as_ref(),
            event.rename_from_notebook_id.as_ref(),
            event.rename_from_root.as_ref(),
        ) {
            if let Ok(memo_file) = memo_file.read() {
                crate::commands::document_list::refresh_view_document_path(&memo_file, old_path);
                crate::commands::document_list::refresh_view_document_path(&memo_file, &event.path);
            }
            let old_ctx = NotebookWatchContext { notebook_id: old_notebook_id.clone(), root: old_root.clone() };
            if let (Ok(old_relative), Ok(new_relative)) = (
                notebook_relative_path(&old_ctx.root, old_path),
                notebook_relative_path(&ctx.root, &event.path),
            ) {
                let state = app.state::<crate::app::state::AppState>();
                if let Err(error) = state.thread_manager.rebase_agent_note_paths(
                    old_notebook_id,
                    &ctx.notebook_id,
                    &old_relative,
                    &new_relative,
                    &old_path.to_string_lossy(),
                    &event.path.to_string_lossy(),
                ) {
                    tracing::warn!(old_notebook_id, new_notebook_id = %ctx.notebook_id, "agent cross-notebook path rebase failed: {error}");
                }
            }
            return;
        }
        let Ok(memo_file) = memo_file.read() else { return; };
        let Ok(_write_guard) = memo_file.operation_locks().notebook_read(&ctx.notebook_id, "watcher_note_refresh") else { return; };

        if let Some(old_path) = &event.rename_from {
            crate::commands::document_list::refresh_view_document_path(&memo_file, old_path);
            crate::commands::document_list::refresh_view_document_path(&memo_file, &event.path);
            let rebase = notebook_relative_path(&ctx.root, old_path).ok()
                .zip(notebook_relative_path(&ctx.root, &event.path).ok());
            if event.path.is_dir() && rebase.as_ref().is_some_and(|(old, new)|
                crate::commands::collection::consume_local_folder_move(&ctx.notebook_id, old, new)) {
                // The collection operation already updated all derived indexes and
                // references before publishing its completion event.
                return;
            }
            app.state::<crate::app::state::AppState>().notebook_background
                .request(&ctx.notebook_id, true, true);
            if event.path.is_dir() {
                let _ = app.state::<crate::app::state::AppState>()
                    .notebook_background
                    .request_media(&ctx.notebook_id);
            }
            drop(_write_guard);
            let old_path_is_markdown = is_markdown_path(old_path);
            let new_path_is_markdown = is_markdown_path(&event.path);
            if event.path.is_dir() || (old_path_is_markdown && new_path_is_markdown) {
                if let (Ok(old_relative), Ok(new_relative)) = (
                    notebook_relative_path(&ctx.root, old_path),
                    notebook_relative_path(&ctx.root, &event.path),
                ) {
                    crate::commands::document_list::rebase_collection_paths(
                        &memo_file,
                        &ctx.notebook_id,
                        &old_relative,
                        &new_relative,
                    );
                }
            }
            if let Some((old_relative, new_relative)) = rebase.as_ref() {
                // The OS supplied a confirmed rename pair. Keep it intact for
                // open editors; separate delete/create notifications would close
                // a tab before the new path could be attached to its identity.
                let _ = app.emit("flowix:path-note-changed", serde_json::json!({
                    "notebookId": ctx.notebook_id,
                    "previousRelativePath": old_relative,
                    "relativePath": new_relative,
                    "kind": "path",
                    "directory": event.path.is_dir(),
                    "deleted": false,
                }));
                crate::fns_sync::schedule_notebook_sync(app, &ctx.notebook_id);
            } else {
                emit_path_changed(app, ctx, "", false);
            }
            drop(memo_file);
            if let Some((old_relative, new_relative)) = rebase {
                let state = app.state::<crate::app::state::AppState>();
                if let Err(error) = state.thread_manager.rebase_agent_note_paths(
                    &ctx.notebook_id,
                    &ctx.notebook_id,
                    &old_relative,
                    &new_relative,
                    &old_path.to_string_lossy(),
                    &event.path.to_string_lossy(),
                ) {
                    tracing::warn!(notebook_id = %ctx.notebook_id, "agent path rebase failed: {error}");
                }
            }
            return;
        }

        match event.kind {
            FsEventKind::Create | FsEventKind::Modify | FsEventKind::Remove => {
                crate::commands::document_list::refresh_view_document_path(&memo_file, &event.path);
match refresh_path_with_content(
                    &memo_file,
                    ctx,
                    &event.path,
                    event.path_was_known,
                    stable_content,
                ) {
                    Ok(DispatchOutcome::PathIndexed { relative_path, change }) => {
                        tracing::debug!(path = %event.path.display(), native_kind = ?event.kind, ?change, "reconciled notebook path");
                        if change == PathChangeKind::Created {
                            crate::commands::path_change::NotebookPathCreated::from_external_tool(
                                ctx.notebook_id.clone(), relative_path.clone(),
                            ).emit(app);
                            crate::fns_sync::schedule_notebook_sync(app, &ctx.notebook_id);
                        } else {
                            emit_path_changed_with_content(
                                app, ctx, &relative_path, change == PathChangeKind::Deleted, stable_content,
                            );
                        }
                    }
                    Err(error) => tracing::debug!(path = %event.path.display(), "path refresh skipped: {error}"),
                }
            }
            FsEventKind::DirectoryChange => {
                Self::reconcile_directory_change(app, &memo_file, ctx);
            }
            FsEventKind::Other => {}
        }
    }

    fn reconcile_directory_change(app: &AppHandle, memo_file: &MemoFile, ctx: &NotebookWatchContext) {
        crate::commands::document_list::refresh_view_document_catalog(memo_file, &ctx.notebook_id, &ctx.root);
        app.state::<crate::app::state::AppState>().notebook_background
            .request(&ctx.notebook_id, false, true);
        let _ = app.state::<crate::app::state::AppState>()
            .notebook_background
            .request_media(&ctx.notebook_id);
        emit_path_changed(app, ctx, "", false);
    }

    pub(crate) fn unregister_and_emit(
        app: &AppHandle,
        memo_file: &Arc<std::sync::RwLock<MemoFile>>,
        ctx: &NotebookWatchContext,
        path: &Path,
    ) {
        if resource_kind_for_path(path).is_some() {
            let Ok(memo_file) = memo_file.read() else { return; };
            let Ok(_write_guard) = memo_file.operation_locks().notebook_read(&ctx.notebook_id, "watcher_resource_removal") else { return; };
            if let Err(error) = refresh_resource_path(&memo_file, ctx, path) {
                tracing::warn!(path = %path.display(), "resource removal refresh failed: {error}");
            }
            return;
        }
        let Ok(memo_file) = memo_file.read() else { return; };
        let Ok(_write_guard) = memo_file.operation_locks().notebook_read(&ctx.notebook_id, "watcher_path_refresh") else { return; };
        crate::commands::document_list::refresh_view_document_path(&memo_file, path);
        if let Ok(DispatchOutcome::PathIndexed { relative_path, change }) = refresh_path(&memo_file, ctx, path, None) {
            emit_path_changed(app, ctx, &relative_path, change == PathChangeKind::Deleted);
        }
    }
}

#[cfg(test)]
mod tests;
