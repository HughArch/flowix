use std::fs;
use std::path::Path;

use tauri::{Manager, State};
use tauri_plugin_opener::OpenerExt;

use crate::lock_utils::read_lock;

use crate::app::state::AppState;

// ==================== 鍩熷唴 helper ====================

mod attachment_fingerprint;
mod attachments;
mod base64_input;
mod upload_quota;
pub(crate) mod upload_sessions;

// ==================== IPC: 鍘熺敓 dialog ====================

#[tauri::command]
pub async fn select_directory(app: tauri::AppHandle) -> Option<String> {
    #[cfg(mobile)]
    {
        // 存储方案 A: 移动端 notebook 根目录固定为 app 私有目录, 无文件夹选择。
        let _ = app;
        return None;
    }

    #[cfg(desktop)]
    {
        use tauri_plugin_dialog::DialogExt;
        tokio::task::spawn_blocking(move || {
            app.dialog()
                .file()
                .set_title("选择笔记本文件夹")
                .blocking_pick_folder()
                .map(|p| {
                    let path = Path::new(&p.to_string()).to_path_buf();
                    record_bookmark_directory(&app, &path);
                    path.to_string_lossy().into_owned()
                })
        })
        .await
        .ok()
        .flatten()
    }
}

#[tauri::command]
pub async fn select_import_directory(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Option<String> {
    #[cfg(mobile)]
    {
        // 同 select_directory: 移动端不提供文件夹选择, 导入走系统文件选择器。
        let _ = (app, window);
        return None;
    }

    #[cfg(desktop)]
    {
        let generation = app
            .state::<AppState>()
            .document_access
            .generation(window.label());
        use tauri_plugin_dialog::DialogExt;
        let handle = app.clone();
        let window_label = window.label().to_owned();
        tokio::task::spawn_blocking(move || {
            handle
                .dialog()
                .file()
                .set_title("选择要导入的文件夹")
                .blocking_pick_folder()
                .and_then(|path| {
                    let path = Path::new(&path.to_string()).to_path_buf();
                    let granted = handle
                        .state::<AppState>()
                        .document_access
                        .grant_directory_for_generation(&window_label, generation, &path);
                    if granted {
                        record_bookmark_directory(&handle, &path);
                    }
                    granted.then(|| path.to_string_lossy().into_owned())
                })
        })
        .await
        .ok()
        .flatten()
    }
}

#[tauri::command]
pub async fn select_files(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    accept: Option<String>,
    multiple: Option<bool>,
) -> Option<Vec<String>> {
    let generation = app
        .state::<AppState>()
        .document_access
        .generation(window.label());
    use tauri_plugin_dialog::DialogExt;
    use tokio::task;

    let handle = app.clone();
    task::spawn_blocking(move || {
        let dialog = handle.dialog().file().set_title("选择文件");
        let dialog = match accept.as_deref() {
            Some("image/*") => dialog.add_filter(
                "图片",
                &[
                    "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif", "tif",
                    "tiff", "heic", "heif",
                ],
            ),
            Some("video/*") => {
                dialog.add_filter("视频", &["mp4", "webm", "mov", "avi", "mkv", "ogg"])
            }
            Some("media/*") => dialog.add_filter(
                "图片和视频",
                &[
                    "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "ico", "tif",
                    "tiff", "heic", "heif", "3gp", "avi", "flv", "m2ts", "m4v", "mkv", "mov",
                    "mp4", "mpeg", "mpg", "mts", "webm", "wmv",
                ],
            ),
            _ => dialog.add_filter(
                "Attachments",
                &[
                    "png", "jpg", "jpeg", "gif", "webp", "svg", "pdf", "doc", "docx", "xls",
                    "xlsx", "ppt", "pptx", "txt", "md", "csv", "json", "mp3", "wav", "ogg", "mp4",
                    "webm", "mov", "avi", "zip", "rar", "7z", "tar", "gz",
                ],
            ),
        };
        let dialog = dialog.add_filter("All files", &["*"]);
        let result = if multiple.unwrap_or(true) {
            dialog.blocking_pick_files()
        } else {
            dialog.blocking_pick_file().map(|path| vec![path])
        }
        .map(|paths| {
            paths
                .into_iter()
                .filter_map(|path| {
                    let path = path.to_string();
                    let granted = handle
                        .state::<AppState>()
                        .document_access
                        .grant_for_generation(window.label(), generation, Path::new(&path));
                    if granted {
                        if let Err(error) = handle
                            .state::<AppState>()
                            .security_bookmarks
                            .record_file(Path::new(&path))
                        {
                            tracing::warn!(%error, "cannot persist selected file bookmark");
                        }
                        Some(path)
                    } else {
                        None
                    }
                })
                .collect::<Vec<String>>()
        });
        result
    })
    .await
    .ok()
    .flatten()
}

fn record_bookmark_directory(app: &tauri::AppHandle, path: &Path) {
    #[cfg(target_os = "macos")]
    if let Err(error) = app
        .state::<AppState>()
        .security_bookmarks
        .record_directory(path)
    {
        tracing::warn!(
            "failed to persist macOS folder bookmark for {}: {error}",
            path.display()
        );
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, path);
}

/// Turn the save dialog result into the value handed back to the web layer.
///
/// Android's document picker returns a `content://` URI whose file was already
/// created by the system picker; it is not a filesystem path and therefore
/// cannot go through [`crate::app::export_access::ExportAccess::grant_for_generation`].
/// Record the URI separately so the later write is still tied to a real user
/// selection.
fn authorize_saved_target(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    generation: u64,
    path: tauri_plugin_dialog::FilePath,
) -> Option<String> {
    let target = path.to_string();
    #[cfg(target_os = "android")]
    {
        let _ = generation;
        app.state::<AppState>()
            .export_access
            .grant_uri(window.label(), &target);
        Some(target)
    }
    #[cfg(not(target_os = "android"))]
    {
        app.state::<AppState>()
            .export_access
            .grant_for_generation(window.label(), generation, Path::new(&target))
            .map(|path| path.to_string_lossy().into_owned())
    }
}

#[tauri::command]
pub async fn save_file_dialog(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    suggested_name: Option<String>,
    filters: Option<Vec<Vec<String>>>,
) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    use tokio::task;

    let handle = app.clone();
    let suggested = suggested_name.unwrap_or_else(|| "Untitled".to_string());
    let filter_list = filters.unwrap_or_default();
    app.state::<AppState>().export_access.revoke(window.label());
    let generation = app
        .state::<AppState>()
        .export_access
        .generation(window.label());

    task::spawn_blocking(move || {
        let mut builder = handle
            .dialog()
            .file()
            .set_title("保存文件")
            .set_file_name(&suggested);

        for filter in &filter_list {
            if filter.is_empty() {
                continue;
            }
            let name = filter[0].clone();
            let exts: Vec<&str> = filter.iter().skip(1).map(|s| s.as_str()).collect();
            if !exts.is_empty() {
                builder = builder.add_filter(&name, &exts);
            }
        }

        let result = builder
            .blocking_save_file()
            .and_then(|path| authorize_saved_target(&handle, &window, generation, path));
        result
    })
    .await
    .ok()
    .flatten()
}

// ==================== IPC: notebook asset import ====================

/// Persist attachment bytes supplied inline (canvas images, clipboard payloads).
///
/// Content-based counterpart of [`save_notebook_asset`]: callers hand over a
/// base64 payload instead of a local path, and the notebook-relative `key` in
/// the result is what note/canvas content persists.
#[tauri::command]
pub async fn save_notebook_asset_content(
    window: tauri::WebviewWindow,
    content_base64: String,
    file_name: String,
    notebook_id: Option<String>,
    note_path: Option<String>,
    deduplicate: Option<bool>,
    state: State<'_, AppState>,
) -> Result<attachments::SavedNotebookAsset, String> {
    let permit = upload_quota::UPLOAD_QUOTA.acquire()?;
    // COSEC: inline payloads may only land next to a document this window is
    // authorized to open.
    if let Some(note_path) = note_path.as_deref() {
        if !super::helpers::can_access_document_path(Path::new(note_path), window.label(), &state) {
            return Err("Notebook asset target is not authorized".to_string());
        }
    }
    let name = file_name.trim().to_string();
    if name.is_empty() || name.contains(['/', '\\']) {
        return Err("Invalid attachment file name".to_string());
    }
    if content_base64.len() > attachments::MAX_ATTACHMENT_BYTES as usize * 4 / 3 + 4 {
        return Err("ATTACHMENT_FILE_TOO_LARGE".to_string());
    }
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(content_base64.as_bytes())
        .map_err(|error| format!("ATTACHMENT_BASE64_INVALID: {error}"))?;
    if bytes.len() as u64 > attachments::MAX_ATTACHMENT_BYTES {
        return Err("ATTACHMENT_FILE_TOO_LARGE".to_string());
    }
    let memo_file = state.memo_file.clone();
    let deduplicate = deduplicate.unwrap_or(true);
    tokio::task::spawn_blocking(move || -> Result<attachments::SavedNotebookAsset, String> {
        let _permit = permit;
        let store = read_lock(&memo_file, "memo_file");
        let mut reader = std::io::Cursor::new(bytes);
        attachments::save_for_owner(
            &store,
            notebook_id.as_deref(),
            note_path.as_deref(),
            &name,
            &mut reader,
            deduplicate,
        )
        .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn save_notebook_asset(
    window: tauri::WebviewWindow,
    source_path: String,
    notebook_id: Option<String>,
    note_path: Option<String>,
    deduplicate: Option<bool>,
    reuse_notebook_file: Option<bool>,
    reuse_existing_attachment: Option<bool>,
    target_directory_path: Option<String>,
    state: State<'_, AppState>,
) -> Result<Option<attachments::SavedNotebookAsset>, String> {
    let permit = upload_quota::UPLOAD_QUOTA.acquire()?;
    let source = Path::new(&source_path);
    let source = dunce::canonicalize(source).map_err(|error| error.to_string())?;
    if !super::helpers::can_access_document_path(&source, window.label(), &state) {
        return Err("Notebook asset source is not authorized".to_string());
    }
    if !source.is_file() {
        return Err("Attachment source is not a regular file".to_string());
    }
    let name = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Invalid file name")?
        .to_string();
    let mut reader = fs::File::open(&source).map_err(|error| error.to_string())?;
    let metadata = reader.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("Notebook asset source is not a regular file".to_string());
    }
    let root = {
        let store = read_lock(&state.memo_file, "memo_file");
        let (owner, _) =
            attachments::resolve_note_owner(&store, notebook_id.as_deref(), note_path.as_deref())
                .map_err(|error| error.to_string())?;
        attachments::notebook_root(&store, Some(&owner)).map_err(|error| error.to_string())?
    };
    // Notebook-local assets are already durable workspace files. Return their
    // canonical path instead of making an attachment copy.
    if reuse_notebook_file.unwrap_or(false) && source.starts_with(&root) {
        return Ok(Some(attachments::SavedNotebookAsset {
            path: source.to_string_lossy().into_owned(),
            key: attachments::notebook_relative_key(&root, &source),
            created: false,
        }));
    }
    if metadata.len() > attachments::MAX_ATTACHMENT_BYTES {
        return Err("ATTACHMENT_FILE_TOO_LARGE".to_string());
    }
    let target_directory = target_directory_path.map(std::path::PathBuf::from);
    let memo_file = state.memo_file.clone();
    let deduplicate = deduplicate.unwrap_or(false);
    tokio::task::spawn_blocking(
        move || -> Result<Option<attachments::SavedNotebookAsset>, String> {
            let _permit = permit;
            let store = read_lock(&memo_file, "memo_file");
            let saved = attachments::save_for_owner_in_directory(
                &store,
                notebook_id.as_deref(),
                note_path.as_deref(),
                &name,
                &mut reader,
                deduplicate,
                target_directory.as_deref(),
                reuse_existing_attachment.unwrap_or(true),
            )
            .map_err(|error| error.to_string())?;
            Ok(Some(saved))
        },
    )
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn copy_attachment_file(
    window: tauri::WebviewWindow,
    source_path: String,
    target_path: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let source = attachments::authorized_attachment(
        &read_lock(&state.memo_file, "memo_file"),
        Path::new(&source_path),
    )
    .map_err(|error| error.to_string())?;
    let source = source.as_path();

    let mut reader = fs::File::open(source).map_err(|error| error.to_string())?;
    state
        .export_access
        .save(
            window.label(),
            Path::new(&target_path),
            &mut reader,
            &read_lock(&state.memo_file, "memo_file"),
        )
        .map_err(|error| error.to_string())?;
    Ok(true)
}

#[tauri::command]
pub async fn open_attachment_file(
    app: tauri::AppHandle,
    source_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let source = attachments::authorized_attachment(
        &read_lock(&state.memo_file, "memo_file"),
        Path::new(&source_path),
    )
    .map_err(|error| error.to_string())?;
    let source = source.as_path();

    app.opener()
        .open_path(source.display().to_string(), None::<String>)
        .map_err(|e| e.to_string())
}

/// Read an attachment bitmap by storage key for canvas hydration.
///
/// The key is notebook-relative and resolved against the owner notebook of the
/// canvas file, so identical canvas JSON renders on every device regardless of
/// where the notebook root lives.
#[tauri::command]
pub async fn read_notebook_asset_content(
    window: tauri::WebviewWindow,
    storage_key: String,
    note_path: Option<String>,
    notebook_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    if let Some(note_path) = note_path.as_deref() {
        if !super::helpers::can_access_document_path(Path::new(note_path), window.label(), &state) {
            return Err("Notebook asset source is not authorized".to_string());
        }
    }
    let key = storage_key.trim().trim_start_matches(['/', '\\']).to_string();
    let invalid_key = key.is_empty()
        || Path::new(&key)
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)));
    if invalid_key {
        return Err("Invalid attachment storage key".to_string());
    }
    let memo_file = state.memo_file.clone();
    tokio::task::spawn_blocking(move || -> Result<Option<String>, String> {
        let store = read_lock(&memo_file, "memo_file");
        let (owner, _) = attachments::resolve_note_owner(&store, notebook_id.as_deref(), note_path.as_deref())
            .map_err(|error| error.to_string())?;
        let root = attachments::notebook_root(&store, Some(&owner)).map_err(|error| error.to_string())?;
        let path = root.join(&key);
        // The key was component-validated above, so the join cannot escape the
        // notebook root; this is a belt-and-braces containment re-check.
        if !path.starts_with(&root) || !path.is_file() {
            return Ok(None);
        }
        let mime = match path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
            Some("png") => "image/png",
            Some("jpg") | Some("jpeg") => "image/jpeg",
            Some("gif") => "image/gif",
            Some("webp") => "image/webp",
            Some("svg") => "image/svg+xml",
            Some("bmp") => "image/bmp",
            Some("avif") => "image/avif",
            _ => return Ok(None),
        };
        let bytes = fs::read(&path).map_err(|error| error.to_string())?;
        use base64::Engine as _;
        Ok(Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Binary counterpart of [`write_export_file`] (PNG exports, images).
#[tauri::command(async)]
pub fn write_export_file_bytes(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    file_path: String,
    content_base64: String,
    state: State<'_, AppState>,
) -> bool {
    #[cfg(target_os = "android")]
    {
        return state.export_access.take_uri(window.label(), &file_path)
            && crate::mobile_export::write_base64(&app, &file_path, &content_base64).is_ok();
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = &app;
        use base64::Engine as _;
        let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(content_base64.as_bytes()) else {
            return false;
        };
        state
            .export_access
            .save(
                window.label(),
                Path::new(&file_path),
                &mut bytes.as_slice(),
                &read_lock(&state.memo_file, "memo_file"),
            )
            .is_ok()
    }
}

// ==================== IPC: 瀵煎嚭 ====================

// Async dispatch keeps the command off the main thread: on Android it awaits
// the Kotlin export plugin, whose commands are dispatched on the main thread.
#[tauri::command(async)]
pub fn write_export_file(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    file_path: String,
    content: String,
    state: State<'_, AppState>,
) -> bool {
    #[cfg(target_os = "android")]
    {
        return state.export_access.take_uri(window.label(), &file_path)
            && crate::mobile_export::write_text(&app, &file_path, &content).is_ok();
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = &app;
        state
            .export_access
            .save(
                window.label(),
                Path::new(&file_path),
                &mut content.as_bytes(),
                &read_lock(&state.memo_file, "memo_file"),
            )
            .is_ok()
    }
}
