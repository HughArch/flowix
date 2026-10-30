// ==================== Reads ====================

use std::fs;
use std::path::Path;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::lock_utils::read_lock;
use flowix_core::memo_file::{
    normalize_markdown_encoding_boundaries,
    notebook_path_from_relative, notebook_relative_path, Memo, MemoFile,
    NoteEntry, NoteTitleFilter,
};
use flowix_core::service::{NoteSaveOutcome, NotePageQuery};
use flowix_core::{FlowixError, NoteService};

use crate::app::state::AppState;
use crate::watcher::runtime::mark_self_write_for;

use super::helpers::*;
use super::*;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownLocation {
    path: String,
    notebook_id: Option<String>,
    relative_path: Option<String>,
    notebook_path: Option<String>,
    indexable: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum NotePathStatus {
    Present,
    Missing,
}

/// Report absence separately from permission and I/O errors for stale-note actions.
#[tauri::command]
pub fn note_path_status(file_path: String, state: State<AppState>) -> Result<NotePathStatus, String> {
    let path = Path::new(&file_path);
    if !path.is_absolute() {
        return Err("absolute note path required".into());
    }
    let memo_file = read_lock(&state.memo_file, "memo_file");
    super::helpers::notebook_note_address(&memo_file, path)?
        .ok_or_else(|| "note path is outside a notebook or is not Markdown".to_string())?;
    drop(memo_file);
    match fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => Ok(NotePathStatus::Present),
        Ok(_) => Err("note path is not a file".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(NotePathStatus::Missing),
        Err(error) => Err(format!("cannot access note path: {error}")),
    }
}

/// Classify a Markdown file by notebook-relative path, independently of its opening UI.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn resolve_markdown_location(
    filePath: String,
    app: AppHandle,
) -> Result<MarkdownLocation, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let memo_file = read_lock(&state.memo_file, "memo_file");
        let requested = Path::new(&filePath);
        if !requested.is_absolute() {
            return Err("absolute document path required".to_string());
        }
        let path = dunce::canonicalize(requested).unwrap_or_else(|_| requested.to_path_buf());
        let mut notebooks = memo_file.read_notebook_configs().map_err(|error| error.to_string())?;
        notebooks.sort_by_key(|notebook| std::cmp::Reverse(notebook.path.len()));
        for notebook in notebooks {
            let root = Path::new(&notebook.path);
            let canonical_root = dunce::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
            let Ok(relative_path) = notebook_relative_path(&canonical_root, &path) else {
                continue;
            };
            let relative = Path::new(&relative_path);
            let markdown = relative.extension().and_then(|ext| ext.to_str())
                .is_some_and(|ext| matches!(ext.to_ascii_lowercase().as_str(), "md" | "markdown"));
            let policy = memo_file.file_management_policy(&notebook.id);
            let indexable = markdown && !policy.is_index_ignored_at(&canonical_root, relative);
            return Ok(MarkdownLocation {
                path: path.to_string_lossy().into_owned(),
                notebook_id: Some(notebook.id),
                relative_path: Some(relative_path),
                notebook_path: Some(notebook.path),
                indexable,
            });
        }
        Ok(MarkdownLocation {
            path: path.to_string_lossy().into_owned(),
            notebook_id: None,
            relative_path: None,
            notebook_path: None,
            indexable: false,
        })
    }).await.map_err(|error| format!("Markdown location task failed: {error}"))?
}
/// List the notebook's rebuildable note projection, keyed by relative path.
#[tauri::command]
pub async fn list_notes_by_path(
    notebook_id: String,
    app: AppHandle,
) -> Result<Vec<NoteEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let memo_file = read_lock(&state.memo_file, "memo_file");
        NoteService::new(&memo_file)
            .list(&notebook_id)
            .map_err(|error| crate::app::notebook_background::query_error(state.inner(), &notebook_id, error))
    })
    .await
    .map_err(|error| format!("path-based note list task failed: {error}"))?
}

/// Read one note from the current index projection without changing index state.
#[tauri::command]
pub async fn get_indexed_note_by_path(
    notebook_id: String,
    relative_path: String,
    app: AppHandle,
) -> Result<Option<NoteEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let memo_file = read_lock(&state.memo_file, "memo_file");
        memo_file.read_indexed_note_entry_by_path(&notebook_id, &relative_path)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("indexed note read task failed: {error}"))?
}

/// Return one page from the path-keyed Note index without consulting Memo IDs.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn get_path_notes(
    notebook_id: String,
    filter: Option<String>,
    sort: Option<String>,
    tag_id: Option<String>,
    color: Option<String>,
    cursor: Option<String>,
    limit: Option<usize>,
    title_filter: Option<NoteTitleFilter>,
    app: AppHandle,
) -> Result<GetPathNotesResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let memo_file = read_lock(&state.memo_file, "memo_file");
        let mut service = NoteService::new(&memo_file);
        let page = service
            .list_indexed_page_query(&notebook_id, NotePageQuery {
                filter: filter.as_deref().unwrap_or("all"),
                sort: sort.as_deref().unwrap_or("createdAt"),
                tag_id: tag_id.as_deref(),
                color: color.as_deref(),
                cursor: cursor.as_deref(),
                limit,
                title_filter: title_filter.as_ref(),
            })
            .map_err(|error: FlowixError| crate::app::notebook_background::query_error(state.inner(), &notebook_id, error))?;
        Ok(GetPathNotesResponse {
            notes: page.notes,
            next_cursor: page.next_cursor,
            has_more: page.has_more,
        })
    })
    .await
    .map_err(|error| format!("path note list task failed: {error}"))?
}
#[tauri::command]
pub async fn get_used_memo_tag_ids(
    notebook_id: Option<String>,
    app: AppHandle,
) -> Result<UsedMemoTagIdsResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let memo_file = read_lock(&state.memo_file, "memo_file");
        let id = notebook_id.or_else(|| memo_file.current_notebook_id_value()).unwrap_or_default();
        let (used_tag_ids, tag_counts, total_memo_count, agent_memo_count, todo_memo_count) =
            memo_file.read_tag_usage_summary_for_notebook_id(Some(&id))
                .map_err(|error| crate::app::notebook_background::query_error(state.inner(), &id, error))?;
        Ok(UsedMemoTagIdsResponse {
            used_tag_ids,
            tag_counts: tag_counts
                .into_iter()
                .map(|(tag_id, count)| MemoTagCount { tag_id, count })
                .collect(),
            total_memo_count,
            agent_memo_count,
            todo_memo_count,
        })
    })
    .await
    .map_err(|error| format!("tag summary task failed: {error}"))?
}

#[tauri::command]
pub async fn read_document(
    window: tauri::WebviewWindow,
    file_path: String,
    app: AppHandle,
) -> Option<String> {
    crate::document_io::run("read", move || {
        let state = app.state::<AppState>();
        if !crate::commands::helpers::can_access_document_path(
            Path::new(&file_path),
            window.label(),
            &state,
        ) {
            eprintln!("[read_document] refused out-of-scope path: {}", file_path);
            return None;
        }
        let requested_path = Path::new(&file_path);
        let memo_file = read_lock(&state.memo_file, "memo_file");
        match notebook_note_address(&memo_file, requested_path) {
            Ok(Some((notebook_id, relative_path))) => {
                let mut service = NoteService::new(&memo_file);
                if let Err(error) = service.get(&notebook_id, &relative_path) {
                    tracing::debug!(
                        notebook_id = %notebook_id,
                        relative_path = %relative_path,
                        "note read is falling back to Markdown after path-index failure: {error}"
                    );
                }
            }
            Err(error) => {
                tracing::warn!(path = %requested_path.display(), "refusing note path: {error}");
                return None;
            }
            Ok(None) => {}
        }
        fs::read_to_string(requested_path)
            .ok()
            .map(|content| normalize_markdown_encoding_boundaries(&content).into_owned())
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
pub async fn get_document_modified_at(
    window: tauri::WebviewWindow,
    file_path: String,
    app: AppHandle,
) -> Option<u64> {
    crate::document_io::run("metadata", move || {
        let state = app.state::<AppState>();
        let path = Path::new(&file_path);
        if !crate::commands::helpers::can_access_document_path(path, window.label(), &state) {
            return None;
        }
        fs::metadata(path).ok()?.modified().ok()?
            .duration_since(std::time::UNIX_EPOCH).ok()
            .map(|duration| duration.as_millis() as u64)
    })
    .await
    .ok()
    .flatten()
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteDocumentResult {
    pub path: String,
    pub content: String,
    #[serde(flatten)]
    pub commit: Option<crate::document_mutation::DocumentCommit>,
}

/// Save a notebook note by path. Standalone documents use the independent
/// `write_external_document` command and never enter this path.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn write_document(
    operation_id: Option<String>,
    filePath: String,
    content: String,
    expectedContent: Option<String>,
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Option<WriteDocumentResult>, String> {
    let origin_window_label = window.label().to_owned();
    crate::commands::document_operations::run(
        "save",
        operation_id,
        origin_window_label.clone(),
        move || {
            let state = app.state::<AppState>();
            write_document_internal(
                &filePath,
                &content,
                expectedContent.as_deref(),
                &state,
                &app,
                &origin_window_label,
            )
        },
    )
    .await
}

/// Save the existing file at an exact absolute path with content validation.
fn write_document_internal(
    file_path: &str,
    content: &str,
    expected_content: Option<&str>,
    state: &State<AppState>,
    app: &AppHandle,
    origin_window_label: &str,
) -> Result<Option<WriteDocumentResult>, String> {
    if !Path::new(file_path).is_absolute() {
        return Err("absolute document path required".into());
    }
    let requested_path = Path::new(file_path);
    let (notebook_id, relative_path) =
        notebook_note_address(&read_lock(&state.memo_file, "memo_file"), requested_path)?
            .ok_or_else(|| {
                "document is not a Markdown note inside a registered notebook".to_string()
            })?;

    let current_content = fs::read_to_string(requested_path).map_err(|error| error.to_string())?;
    if expected_content
        .is_some_and(|expected| !cas_content_matches(&current_content, expected, content))
    {
        return Ok(None);
    }

    let (saved_path, saved_content, entry) = {
        let memo_file = read_lock(&state.memo_file, "memo_file");
        let mut service = NoteService::new(&memo_file);
        mark_self_write_for(app, requested_path);
        match service.save(
            &notebook_id,
            &relative_path,
            content,
            Some(&current_content),
        ) {
            Ok(NoteSaveOutcome::Saved(document)) => {
                (document.path, document.body, document.entry)
            }
            Ok(NoteSaveOutcome::Conflict { .. }) => return Ok(None),
            Err(error) => return Err(error.to_string()),
        }
    };

    mark_self_write_for(app, &saved_path);
    let _ = app.emit("flowix:path-note-changed", serde_json::json!({
        "changeId": uuid::Uuid::new_v4().to_string(),
        "notebookId": notebook_id,
        "relativePath": relative_path,
        "entry": entry,
        "originWindowLabel": origin_window_label,
    }));

    Ok(Some(WriteDocumentResult {
        path: saved_path.display().to_string(),
        content: saved_content,
        commit: None,
    }))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathNoteSearchHit {
    notebook_id: String,
    relative_path: String,
    title: String,
    snippet: String,
    matched_in: String,
}

#[tauri::command]
pub async fn search_path_notes(
    notebook_id: String,
    query: String,
    limit: Option<usize>,
    app: AppHandle,
) -> Result<Vec<PathNoteSearchHit>, String> {
    // Search runs a SQLite query plus a full-text scan. A synchronous command
    // executes on the main thread, which froze the Webview while typing or
    // while a background reconcile held the read lock.
    let memo_file = app.state::<AppState>().memo_file.clone();
    let limit = limit.unwrap_or(30).clamp(1, 100);
    tauri::async_runtime::spawn_blocking(move || {
        let memo_file = read_lock(&memo_file, "memo_file");
        NoteService::new(&memo_file)
            .search(&notebook_id, &query, limit)
            .map_err(|error| error.to_string())
            .map(|hits| {
                hits.into_iter()
                    .map(|hit| PathNoteSearchHit {
                        notebook_id: notebook_id.clone(),
                        relative_path: hit.relative_path,
                        title: hit.title,
                        snippet: hit.snippet,
                        matched_in: hit.matched_in,
                    })
                    .collect()
            })
    })
    .await
    .map_err(|error| error.to_string())?
}

/// One note card rendered on a canvas board.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteCardSummary {
    /// Echoed so the board can map results back to its cards.
    pub file_path: String,
    pub title: String,
    pub excerpt: String,
    pub tags: Vec<String>,
    pub modified_at: u64,
    pub char_count: usize,
}

const NOTE_CARD_SUMMARY_LIMIT: usize = 500;
const NOTE_CARD_EXCERPT_CHARS: usize = 240;

/// Batch summaries for canvas board note cards.
///
/// `preview` in the note index is the title line, so cards need a real body
/// excerpt; one batched call avoids one IPC round-trip per card.
#[tauri::command]
pub async fn read_note_card_summaries(
    window: tauri::WebviewWindow,
    file_paths: Vec<String>,
    app: AppHandle,
) -> Vec<NoteCardSummary> {
    crate::document_io::run("read_note_card_summaries", move || {
        let state = app.state::<AppState>();
        let mut summaries = Vec::new();
        for file_path in file_paths.into_iter().take(NOTE_CARD_SUMMARY_LIMIT) {
            let path = Path::new(&file_path);
            if !crate::commands::helpers::can_access_document_path(path, window.label(), &state) {
                continue;
            }
            let Ok(metadata) = fs::metadata(path) else { continue };
            if !metadata.is_file() {
                continue;
            }
            let Ok(content) = fs::read_to_string(path) else { continue };
            let (title, _) = flowix_core::memo_file::extract_title_and_preview(&content);
            let excerpt = flowix_core::memo_file::extract_card_excerpt(&content, NOTE_CARD_EXCERPT_CHARS);
            let tags = flowix_core::memo_file::extract_document_metadata(&content)
                .map(|metadata| metadata.tags)
                .unwrap_or_default();
            let modified_at = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as u64)
                .unwrap_or(0);
            let char_count = content.chars().filter(|character| !character.is_whitespace()).count();
            summaries.push(NoteCardSummary {
                file_path,
                title,
                excerpt,
                tags,
                modified_at,
                char_count,
            });
        }
        summaries
    })
    .await
    .unwrap_or_default()
}

/// Full note content for canvas board cards that render the body inline.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteCardContent {
    /// Echoed so the board can map results back to its cards.
    pub file_path: String,
    /// `None` when the note is unreadable or outside the window's scope.
    pub content: Option<String>,
    /// Content was cut at `NOTE_CARD_CONTENT_MAX_BYTES`; the body renders partial.
    pub truncated: bool,
    pub modified_at: u64,
}

const NOTE_CARD_CONTENT_LIMIT: usize = 500;
const NOTE_CARD_CONTENT_MAX_BYTES: usize = 256 * 1024;
/// One board's inline bodies must fit through a single IPC payload.
const NOTE_CARD_CONTENT_TOTAL_BYTES: usize = 8 * 1024 * 1024;

/// Batch full content for canvas board note cards.
///
/// Mirrors `read_note_card_summaries`: one IPC round-trip per board, scope
/// check per path, missing/unauthorized files come back as `content: null`
/// so the card can keep its excerpt face.
#[tauri::command]
pub async fn read_note_card_contents(
    window: tauri::WebviewWindow,
    file_paths: Vec<String>,
    app: AppHandle,
) -> Vec<NoteCardContent> {
    crate::document_io::run("read_note_card_contents", move || {
        let state = app.state::<AppState>();
        let mut results = Vec::new();
        let mut total_bytes = 0usize;
        for file_path in file_paths.into_iter().take(NOTE_CARD_CONTENT_LIMIT) {
            let path = Path::new(&file_path);
            if !crate::commands::helpers::can_access_document_path(path, window.label(), &state) {
                continue;
            }
            if total_bytes >= NOTE_CARD_CONTENT_TOTAL_BYTES {
                // Budget exhausted: later cards keep their excerpt face.
                results.push(NoteCardContent {
                    file_path,
                    content: None,
                    truncated: true,
                    modified_at: 0,
                });
                continue;
            }
            let Ok(metadata) = fs::metadata(path) else { continue };
            if !metadata.is_file() {
                continue;
            }
            let Ok(raw) = fs::read_to_string(path) else { continue };
            let truncated = raw.len() > NOTE_CARD_CONTENT_MAX_BYTES;
            let content = if truncated {
                let mut end = NOTE_CARD_CONTENT_MAX_BYTES;
                while !raw.is_char_boundary(end) {
                    end -= 1;
                }
                raw[..end].to_string()
            } else {
                raw
            };
            total_bytes = total_bytes.saturating_add(content.len());
            let modified_at = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as u64)
                .unwrap_or(0);
            results.push(NoteCardContent {
                file_path,
                content: Some(content),
                truncated,
                modified_at,
            });
        }
        results
    })
    .await
    .unwrap_or_default()
}
