//! Notebook folder listings and collection-to-note reference maintenance.
use crate::{app::state::AppState, lock_utils::read_lock};
use flowix_core::memo_file::{FileManagementPolicy, FileWriteOutcome, MemoFile};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{fs, path::Path, time::UNIX_EPOCH};
use tauri::State;
const DEFAULT_LIMIT: usize = 48;
const MAX_LIMIT: usize = 100;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentPageRequest {
    pub notebook_id: String,
    pub folder_path: String,
    #[serde(default)]
    pub resource_kinds: Vec<String>,
    pub cursor: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentPageItem {
    pub full_path: String,
    pub name: String,
    pub resource_kind: String,
    pub size_bytes: Option<u64>,
    pub modified_ms: Option<u64>,
    pub created_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentPage {
    pub folders: Vec<DocumentPageItem>,
    pub items: Vec<DocumentPageItem>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
}

fn kind(path: &Path) -> &'static str {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match extension.as_str() {
        "md" | "markdown" => "note",
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg" | "avif" | "ico" | "tif"
        | "tiff" | "heic" => "image",
        "3gp" | "avi" | "flv" | "m2ts" | "m4v" | "mkv" | "mov" | "mp4" | "mpeg" | "mpg" | "mts"
        | "webm" | "wmv" => "video",
        _ => "other",
    }
}

fn setup(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS media_resources (
        id TEXT PRIMARY KEY, notebook_id TEXT NOT NULL, relative_path TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('image', 'video')), size_bytes INTEGER NOT NULL, modified_ms INTEGER NOT NULL,
        fingerprint TEXT, properties TEXT NOT NULL DEFAULT '{}', properties_revision INTEGER NOT NULL DEFAULT 0,
        missing_since INTEGER, deleted_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(notebook_id, relative_path)
    );
")
        .map_err(|error| error.to_string())
}
pub(crate) fn is_table_document_path(path: &Path) -> bool {
    super::collection::collection_type_for_path(path)
        == Some(flowix_core::collection::CollectionType::Table)
}
pub(crate) fn refresh_table_document_path(memo: &MemoFile, path: &Path) {
    super::collection::refresh_path(memo, path);
}
pub(crate) fn refresh_view_document_path(memo: &MemoFile, path: &Path) {
    super::collection::refresh_path(memo, path);
}
pub(crate) fn refresh_view_document_catalog_checked(
    memo: &MemoFile,
    id: &str,
    _root: &Path,
) -> Result<(), String> {
    super::collection::refresh_catalog(memo, id)
}
pub(crate) fn refresh_view_document_catalog(memo: &MemoFile, id: &str, root: &Path) {
    if let Err(error) = refresh_view_document_catalog_checked(memo, id, root) {
        tracing::warn!(%error, "collection catalog refresh failed");
    }
}

fn rebase_collection_document_paths(source: &str, notebook_id: &str, old_path: &str, new_path: &str) -> Option<String> {
    let mut document = flowix_core::collection::CollectionDocument::parse(source).ok()?.normalized_v2().ok()?;
    if !document.rebase_paths_for_notebook(notebook_id, old_path, new_path).ok()? { return None; }
    document.revise().ok()?;
    document.serialize().ok()
}

fn remove_table_document_note_records(source: &str, note_path: &str) -> Option<String> {
    let mut document = flowix_core::collection::CollectionDocument::parse(source)
        .ok()?
        .normalized_v2()
        .ok()?;
    if document.collection.kind != flowix_core::collection::CollectionType::Table {
        return None;
    }
    let normalized_note_path = note_path.replace('\\', "/");
    let dataset = document.payload.get_mut("dataset")?;
    let records = dataset.get_mut("records")?;
    let mut changed = false;
    for key in ["include", "exclude"] {
        let Some(items) = records
            .get_mut(key)
            .and_then(serde_json::Value::as_array_mut)
        else {
            continue;
        };
        let original_len = items.len();
        items.retain(|record| {
            record
                .get("note_path")
                .and_then(serde_json::Value::as_str)
                .is_none_or(|path| path.replace('\\', "/") != normalized_note_path)
        });
        changed |= items.len() != original_len;
    }
    if !changed {
        return None;
    }
    document.collection.revision = document.collection.revision.checked_add(1)?;
    document.collection.updated_at =
        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    document.serialize().ok()
}

/// Remove persisted references to a note after deletion. Collection documents
/// are independent user files, so conflicts or write failures must not undo
/// the note deletion.
pub(crate) fn remove_table_note_records(memo_file: &MemoFile, notebook_id: &str, note_path: &str) {
    if note_path.is_empty() {
        return;
    }
    let Some(notebook) = memo_file.get_notebook_config_by_id(notebook_id) else {
        return;
    };
    let Ok(root) = dunce::canonicalize(&notebook.path) else {
        return;
    };
    let Ok(documents) = super::collection::list_for_rebase(memo_file, notebook_id) else {
        return;
    };

    for item in documents.into_iter().filter(|item| {
        item.collection_type == flowix_core::collection::CollectionType::Table
            && item.parse_state == "valid"
    }) {
        let path = root.join(&item.relative_path);
        for _ in 0..2 {
            let Ok(source) = fs::read_to_string(&path) else {
                break;
            };
            let Some(next) = remove_table_document_note_records(&source, note_path) else {
                break;
            };
            match memo_file.write_file_if_matches_for_notebook(
                notebook_id,
                &path,
                &next,
                Some(&source),
            ) {
                Ok(FileWriteOutcome::Saved) => {
                    refresh_table_document_path(memo_file, &path);
                    break;
                }
                Ok(FileWriteOutcome::Conflict { .. }) => {
                    tracing::debug!(path = %path.display(), "table note reference removal retry after concurrent edit");
                }
                Err(error) => {
                    tracing::debug!(path = %path.display(), "table note reference removal skipped: {error}");
                    break;
                }
            }
        }
    }
}

/// Best-effort maintenance of note/media collection references after a generic path move.
/// Collection folder mutations perform the same transformation inside their operation journal.
pub(crate) fn rebase_collection_paths(
    memo_file: &MemoFile,
    notebook_id: &str,
    old_relative_path: &str,
    new_relative_path: &str,
) {
    if old_relative_path == new_relative_path
        || old_relative_path.is_empty()
        || new_relative_path.is_empty()
    {
        return;
    }
    let Some(notebook) = memo_file.get_notebook_config_by_id(notebook_id) else {
        return;
    };
    let Ok(root) = dunce::canonicalize(&notebook.path) else {
        return;
    };
    let Ok(documents) = super::collection::list_for_rebase(memo_file, notebook_id) else {
        return;
    };

    for item in documents.into_iter().filter(|item| {
        item.parse_state == "valid"
    }) {
        let path = root.join(&item.relative_path);
        let Ok(source) = fs::read_to_string(&path) else {
            continue;
        };
        let Some(next) = rebase_collection_document_paths(&source, notebook_id, old_relative_path, new_relative_path)
        else {
            continue;
        };
        match memo_file.write_file_if_matches_for_notebook(notebook_id, &path, &next, Some(&source))
        {
            Ok(FileWriteOutcome::Saved) => refresh_table_document_path(memo_file, &path),
            Ok(FileWriteOutcome::Conflict { .. }) => {
                tracing::debug!(path = %path.display(), "table reference rebase skipped after concurrent edit")
            }
            Err(error) => {
                tracing::debug!(path = %path.display(), "table reference rebase skipped: {error}")
            }
        }
    }
}

/// Rebase references for a file or folder move when both paths belong to the
/// same notebook. This path-based wrapper is used by generic file operations.
pub(crate) fn rebase_collection_paths_for_move(memo_file: &MemoFile, source: &Path, target: &Path) {
    let Ok(notebooks) = memo_file.read_notebook_configs() else {
        return;
    };
    for notebook in notebooks {
        let Ok(root) = dunce::canonicalize(&notebook.path) else {
            continue;
        };
        let (Ok(old_relative), Ok(new_relative)) =
            (source.strip_prefix(&root), target.strip_prefix(&root))
        else {
            continue;
        };
        rebase_collection_paths(
            memo_file,
            &notebook.id,
            &old_relative.to_string_lossy().replace('\\', "/"),
            &new_relative.to_string_lossy().replace('\\', "/"),
        );
        break;
    }
}

fn decode_cursor(cursor: &str) -> Result<(i64, String), String> {
    let (time, path) = cursor.split_once(':').ok_or("INVALID_CURSOR")?;
    let time = time.parse::<i64>().map_err(|_| "INVALID_CURSOR")?;
    if path.contains('\0') {
        return Err("INVALID_CURSOR".into());
    }
    Ok((time, path.to_owned()))
}

#[derive(Debug)]
struct FolderFileEntry {
    relative_path: String,
    resource_kind: String,
    modified_ms: i64,
    created_ms: Option<i64>,
    size_bytes: u64,
}

#[tauri::command]
pub async fn list_document_page(
    request: DocumentPageRequest,
    state: State<'_, AppState>,
) -> Result<DocumentPage, String> {
    let (root, database) = {
        let store = read_lock(&state.memo_file, "memo_file");
        let config = store
            .get_notebook_config_by_id(&request.notebook_id)
            .ok_or("NOTEBOOK_NOT_FOUND")?;
        (
            dunce::canonicalize(&config.path).map_err(|error| error.to_string())?,
            store
                .notebook_db_path(&request.notebook_id)
                .map_err(|error| error.to_string())?,
        )
    };
    let folder = dunce::canonicalize(&request.folder_path).map_err(|error| error.to_string())?;
    let policy = FileManagementPolicy::from_notebook_root(&root);
    if !folder.is_dir()
        || !folder.starts_with(&root)
        || folder
            .strip_prefix(&root)
            .is_ok_and(|relative| policy.is_ignored_at(&root, relative))
    {
        return Err("INVALID_NOTEBOOK_FOLDER".into());
    }
    let cursor = request.cursor.as_deref().map(decode_cursor).transpose()?;
    let limit = request.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let resource_kinds = request.resource_kinds;
    tauri::async_runtime::spawn_blocking(move || {
        let conn = Connection::open(&database).map_err(|error| error.to_string())?;
        conn.busy_timeout(std::time::Duration::from_secs(10)).map_err(|error| error.to_string())?;
        setup(&conn)?;
        let mut folders = Vec::new();
        let mut entries = Vec::new();
        for entry in fs::read_dir(&folder).map_err(|error| error.to_string())? {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => { tracing::debug!("skip unreadable document folder entry: {error}"); continue; }
            };
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(error) => { tracing::debug!(path = %entry.path().display(), "skip unreadable document entry: {error}"); continue; }
            };
            let path = entry.path();
            if entry.file_name().to_string_lossy().eq_ignore_ascii_case(".index.yaml") {
                continue;
            }
            let relative = match path.strip_prefix(&root) {
                Ok(relative) => relative,
                Err(_) => continue,
            };
            if policy.is_ignored_at(&root, relative) {
                continue;
            }
            if file_type.is_dir() {
                if cursor.is_none() {
                    let metadata = match entry.metadata() {
                        Ok(metadata) => metadata,
                        Err(error) => { tracing::debug!(path = %path.display(), "skip unreadable document folder metadata: {error}"); continue; }
                    };
                    let modified = metadata.modified().ok().and_then(|time| time.duration_since(UNIX_EPOCH).ok()).map(|duration| duration.as_millis().min(u64::MAX as u128) as u64);
                    let created = metadata.created().ok().and_then(|time| time.duration_since(UNIX_EPOCH).ok()).map(|duration| duration.as_millis().min(u64::MAX as u128) as u64);
                    folders.push(DocumentPageItem {
                        name: entry.file_name().to_string_lossy().into_owned(),
                        full_path: path.to_string_lossy().into_owned(),
                        resource_kind: "folder".into(),
                        size_bytes: None,
                        modified_ms: modified,
                        created_ms: created,
                    });
                }
                continue;
            }
            if !file_type.is_file() { continue; }
            let metadata = match fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(error) => { tracing::debug!(path = %path.display(), "skip unreadable document metadata: {error}"); continue; }
            };
            let modified_ms = metadata.modified().ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map_or(0, |duration| duration.as_millis().min(i64::MAX as u128) as i64);
            let created_ms = metadata.created().ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64);
            entries.push(FolderFileEntry {
                relative_path: relative.to_string_lossy().replace('\\', "/"),
                resource_kind: kind(&path).to_owned(),
                modified_ms,
                created_ms,
                size_bytes: metadata.len(),
            });
        }
        folders.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()).then_with(|| left.name.cmp(&right.name)));
        entries.sort_by(|left, right| right.modified_ms.cmp(&left.modified_ms).then_with(|| left.relative_path.cmp(&right.relative_path)));

        let mut items = Vec::new();
        let mut last = None;
        let mut has_more = false;
        for entry in entries {
            if cursor.as_ref().is_some_and(|(time, path)| {
                entry.modified_ms > *time || (entry.modified_ms == *time && entry.relative_path <= *path)
            }) {
                continue;
            }
            if !resource_kinds.is_empty() && !resource_kinds.iter().any(|kind| kind == &entry.resource_kind) { continue; }
            if items.len() == limit { has_more = true; break; }
            last = Some(format!("{}:{}", entry.modified_ms, entry.relative_path));
            let full_path = root.join(Path::new(&entry.relative_path));
            items.push(DocumentPageItem {
                name: full_path.file_name().unwrap_or_default().to_string_lossy().into_owned(),
                full_path: full_path.to_string_lossy().into_owned(),
                resource_kind: entry.resource_kind,
                modified_ms: Some(entry.modified_ms.max(0) as u64),
                created_ms: entry.created_ms.map(|value| value.max(0) as u64),
                size_bytes: Some(entry.size_bytes),
            });
        }
        Ok(DocumentPage { folders, next_cursor: if has_more { last } else { None }, has_more, items })
    }).await.map_err(|error| error.to_string())?
}
