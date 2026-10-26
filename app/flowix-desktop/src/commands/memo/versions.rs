// ==================== Versions ====================
//
// Path-addressed version history IPC.

use std::fs;

use tauri::{AppHandle, State};

use crate::lock_utils::read_lock;
use flowix_core::memo_file::{atomic_write_bytes, FileLockIntent, IsMd, MemoVersionSource, PathVersionMeta};

use crate::app::state::AppState;
use crate::watcher::runtime::mark_self_write_for;


fn path_archive_document(state: &AppState, notebook_id: &str, relative_path: &str) -> Option<std::path::PathBuf> {
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let notebook = memo_file.get_notebook_config_by_id(notebook_id)?;
    let root = std::path::PathBuf::from(notebook.path).canonicalize().ok()?;
    let relative = std::path::Path::new(relative_path);
    if relative.is_absolute() || !relative.is_md()
        || relative.components().any(|part| !matches!(part, std::path::Component::Normal(_))) {
        return None;
    }
    let path = root.join(relative).canonicalize().ok()?;
    (path.starts_with(root) && path.is_file()).then_some(path)
}

#[tauri::command]
pub fn list_path_versions(notebook_id: String, relative_path: String, state: State<AppState>) -> Vec<PathVersionMeta> {
    read_lock(&state.memo_file, "memo_file").list_path_versions(&notebook_id, &relative_path)
}

#[tauri::command]
pub fn create_path_version(notebook_id: String, relative_path: String, source: Option<MemoVersionSource>, state: State<AppState>) -> Option<PathVersionMeta> {
    let path = path_archive_document(&state, &notebook_id, &relative_path)?;
    let memo_file = read_lock(&state.memo_file, "memo_file");
    memo_file.with_file_write(&notebook_id, &path, FileLockIntent::Existing,
        "create_path_version", |locked_path| {
            let content = fs::read_to_string(locked_path)?;
            memo_file.create_path_version(&notebook_id, &relative_path, &content,
                source.unwrap_or(MemoVersionSource::Manual))
        }).ok()?
}

/// 恢复写侧下沉到 core (`MemoFile::write_restored_content`), 供桌面命令 /
/// CLI / 内置 Agent 三端共用; 此处只补 watcher 免回环标记与索引刷新。
fn finish_restore(state: &State<AppState>, app: &AppHandle, path: &std::path::Path,
    memo_file: &flowix_core::memo_file::MemoFile, target: String) -> String {
    mark_self_write_for(app, path);
    crate::commands::helpers::refresh_notebook_note_index(memo_file, path);
    target
}

#[tauri::command]
pub fn restore_path_version(notebook_id: String, relative_path: String, version_id: String,
    expected_content: Option<String>, state: State<AppState>, app: AppHandle) -> Option<String> {
    let path = path_archive_document(&state, &notebook_id, &relative_path)?;
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let target = memo_file.read_path_version(&notebook_id, &relative_path, &version_id)?;
    let restored = memo_file.write_restored_content(&notebook_id, &relative_path, &path,
        &target, expected_content.as_deref()).ok()?;
    if !restored { return None; }
    Some(finish_restore(&state, &app, &path, &memo_file, target))
}

/// 云端版本恢复: 正文已由 `fns_note_history_content` 重建, 走同一条本地恢复
/// 管线落盘, 之后由同步上行传播到其他设备 (docs/VERSION-HISTORY-CLOUD.md §3 D2)。
#[tauri::command]
pub fn restore_path_content(notebook_id: String, relative_path: String, content: String,
    expected_content: Option<String>, state: State<AppState>, app: AppHandle) -> Option<String> {
    let path = path_archive_document(&state, &notebook_id, &relative_path)?;
    let memo_file = read_lock(&state.memo_file, "memo_file");
    let restored = memo_file.write_restored_content(&notebook_id, &relative_path, &path,
        &content, expected_content.as_deref()).ok()?;
    if !restored { return None; }
    Some(finish_restore(&state, &app, &path, &memo_file, content))
}
