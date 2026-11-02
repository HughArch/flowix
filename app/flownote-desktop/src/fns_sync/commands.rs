//! IPC commands for FNS sync.

use tauri::{AppHandle, Manager, State};

use crate::app::state::AppState;
use crate::fns_sync::config::{FnsConfigPatch, FnsConfigView, FnsTokenInput};
use crate::fns_sync::history::{FnsApiError, FnsCloudHistoryPage};
use crate::fns_sync::share::FnsShareView;
use crate::fns_sync::service::{
    ConflictResolutionChoice, FnsConflictDetail, FnsConflictView, FnsNotebookState,
    FnsNotebookSyncOutcome, FnsSyncRecord, FnsSyncStatus,
};

/// 统一把 `FnsApiError` 摊平成前端可读的字符串; 业务码原样携带。
/// (错误文案已在 history.rs 内摊平, 此处保留类型引用防误删。)
#[allow(unused_imports)]
use crate::fns_sync::history::FnsApiError as _FnsApiErrorKeep;

/// `...` 菜单云端历史入口的门控: notebook 是否已绑定 FNS 且凭据齐备。
#[tauri::command]
pub fn fns_cloud_history_available(app: AppHandle, notebook_id: String) -> bool {
    let service = app.state::<AppState>().fns_sync.clone();
    super::history::cloud_available(&app, &service, &notebook_id)
}

/// 云端版本列表 (分页)。查无笔记返回 `NotSynced` 形态而非错误。
#[tauri::command]
pub async fn fns_note_history_list(
    app: AppHandle,
    notebook_id: String,
    relative_path: String,
    page: Option<u32>,
    page_size: Option<u32>,
) -> Result<FnsCloudHistoryPage, String> {
    let service = app.state::<AppState>().fns_sync.clone();
    super::history::list_note_history(
        app, service, notebook_id, relative_path,
        page.unwrap_or(1).max(1), page_size.unwrap_or(20).clamp(1, 100),
    )
    .await
}

/// 拉取并重建某云端版本修改后的完整正文。
#[tauri::command]
pub async fn fns_note_history_content(
    app: AppHandle,
    notebook_id: String,
    relative_path: String,
    history_id: i64,
) -> Result<String, String> {
    let service = app.state::<AppState>().fns_sync.clone();
    super::history::note_history_content(
        app, service, notebook_id, relative_path, history_id,
    )
    .await
}

/// `...` 菜单分享入口的门控: notebook 是否已绑定 FNS 且凭据齐备。
#[tauri::command]
pub fn fns_share_available(app: AppHandle, notebook_id: String) -> bool {
    let service = app.state::<AppState>().fns_sync.clone();
    super::share::share_available(&app, &service, &notebook_id)
}

/// 创建分享 (服务端幂等)。`expire_at_sec` 缺省/0 = 永久。
#[tauri::command]
pub async fn fns_share_create(
    app: AppHandle,
    notebook_id: String,
    relative_path: String,
    password: Option<String>,
    expire_at_sec: Option<i64>,
) -> Result<FnsShareView, String> {
    let service = app.state::<AppState>().fns_sync.clone();
    super::share::share_create(
        app, service, notebook_id, relative_path, password, expire_at_sec,
    )
    .await
}

/// 查询当前分享。无 active 分享返回 `null` 而非错误。
#[tauri::command]
pub async fn fns_share_query(
    app: AppHandle,
    notebook_id: String,
    relative_path: String,
) -> Result<Option<FnsShareView>, String> {
    let service = app.state::<AppState>().fns_sync.clone();
    super::share::share_query(app, service, notebook_id, relative_path).await
}

/// 取消 (撤销) 分享。外部分享链接随即失效, 不可恢复。
#[tauri::command]
pub async fn fns_share_cancel(
    app: AppHandle,
    notebook_id: String,
    relative_path: String,
) -> Result<(), String> {
    let service = app.state::<AppState>().fns_sync.clone();
    super::share::share_cancel(app, service, notebook_id, relative_path).await
}

/// 更新分享密码与过期时间。
#[tauri::command]
pub async fn fns_share_password(
    app: AppHandle,
    notebook_id: String,
    relative_path: String,
    password: Option<String>,
    expire_at_sec: Option<i64>,
) -> Result<(), String> {
    let service = app.state::<AppState>().fns_sync.clone();
    super::share::share_update_password(
        app, service, notebook_id, relative_path, password, expire_at_sec,
    )
    .await
}

/// vault 内所有 active 分享的笔记路径 (预留: 列表角标 / 分享管理)。
#[tauri::command]
pub async fn fns_share_paths(
    app: AppHandle,
    notebook_id: String,
) -> Result<Vec<String>, String> {
    let service = app.state::<AppState>().fns_sync.clone();
    super::share::active_note_share_paths(app, service, notebook_id).await
}

#[tauri::command]
pub fn fns_get_config(state: State<AppState>) -> FnsConfigView {
    state.fns_sync.config_view()
}

#[tauri::command]
pub fn fns_patch_config(
    patch: FnsConfigPatch,
    state: State<AppState>,
) -> Result<FnsConfigView, String> {
    state.fns_sync.patch_config(patch)
}

#[tauri::command]
pub fn fns_upsert_token(
    input: FnsTokenInput,
    state: State<AppState>,
) -> Result<FnsConfigView, String> {
    state.fns_sync.upsert_token(input)
}

#[tauri::command]
pub fn fns_delete_token(id: String, state: State<AppState>) -> Result<FnsConfigView, String> {
    state.fns_sync.delete_token(&id)
}

#[tauri::command]
pub fn fns_get_status(state: State<AppState>) -> FnsSyncStatus {
    state.fns_sync.status()
}

#[tauri::command]
pub fn fns_get_history(
    notebook_id: Option<String>,
    state: State<AppState>,
) -> Vec<FnsSyncRecord> {
    state.fns_sync.history(notebook_id.as_deref())
}

#[tauri::command]
pub fn fns_get_notebook_state(
    app: AppHandle,
    notebook_id: String,
) -> Result<FnsNotebookState, String> {
    let service = app.state::<AppState>().fns_sync.clone();
    service.notebook_state(&app, &notebook_id)
}

#[tauri::command]
pub fn fns_bind_notebook(
    app: AppHandle,
    notebook_id: String,
    token_id: String,
    vault: String,
) -> Result<FnsNotebookState, String> {
    let service = app.state::<AppState>().fns_sync.clone();
    service.bind_notebook(&app, &notebook_id, &token_id, &vault)
}

#[tauri::command]
pub fn fns_unbind_notebook(app: AppHandle, notebook_id: String) -> Result<(), String> {
    let service = app.state::<AppState>().fns_sync.clone();
    service.unbind_notebook(&app, &notebook_id)
}

#[tauri::command]
pub async fn fns_sync_notebook(
    app: AppHandle,
    notebook_id: String,
) -> Result<Option<FnsNotebookSyncOutcome>, String> {
    let service = app.state::<AppState>().fns_sync.clone();
    if let Some(reason) = service.sync_blocker(&app, &notebook_id) {
        return Err(reason);
    }
    service.sync_notebook(&app, &notebook_id).await
}

#[tauri::command]
pub async fn fns_sync_all(app: AppHandle) -> Result<Vec<FnsNotebookSyncOutcome>, String> {
    let service = app.state::<AppState>().fns_sync.clone();
    service.sync_bound_notebooks(&app).await
}

/// App returned to the foreground: pull once in case the background freeze
/// dropped listener events or the connection itself.
#[tauri::command]
pub fn fns_schedule_focus_sync(app: AppHandle) {
    app.state::<AppState>()
        .fns_sync
        .schedule_bound_notebook_syncs(&app);
}

/// Pending sync conflicts for one notebook, oldest first.
#[tauri::command]
pub fn fns_conflict_list(
    app: AppHandle,
    notebook_id: String,
) -> Result<Vec<FnsConflictView>, String> {
    app.state::<AppState>().fns_sync.conflicts(&app, &notebook_id)
}

/// The three versions behind one pending conflict, for the diff dialog.
#[tauri::command]
pub fn fns_conflict_detail(
    app: AppHandle,
    notebook_id: String,
    path: String,
) -> Result<FnsConflictDetail, String> {
    app.state::<AppState>()
        .fns_sync
        .conflict_detail(&app, &notebook_id, &path)
}

/// Resolve one pending conflict with an explicit user choice
/// (`keepLocal` / `keepRemote` / `merge`).
#[tauri::command]
pub async fn fns_conflict_resolve(
    app: AppHandle,
    notebook_id: String,
    path: String,
    action: String,
) -> Result<(), String> {
    let choice = match action.as_str() {
        "keepLocal" => ConflictResolutionChoice::KeepLocal,
        "keepRemote" => ConflictResolutionChoice::KeepRemote,
        "merge" => ConflictResolutionChoice::Merge,
        other => return Err(format!("unknown conflict action: {other}")),
    };
    let service = app.state::<AppState>().fns_sync.clone();
    service
        .resolve_conflict(&app, &notebook_id, &path, choice)
        .await
}

/// Drop a pending conflict marker without touching any content; the next
/// sync may re-detect it.
#[tauri::command]
pub async fn fns_conflict_dismiss(
    app: AppHandle,
    notebook_id: String,
    path: String,
) -> Result<(), String> {
    let service = app.state::<AppState>().fns_sync.clone();
    service.dismiss_conflict(&app, &notebook_id, &path).await
}

/// Server-written conflict copies from the old force-merge behavior.
#[tauri::command]
pub fn fns_legacy_conflict_copies(
    app: AppHandle,
    notebook_id: String,
) -> Result<Vec<String>, String> {
    app.state::<AppState>()
        .fns_sync
        .legacy_conflict_copies(&app, &notebook_id)
}

/// Delete all legacy conflict copies locally and schedule a sync so the
/// deletions propagate server-side. Returns the number removed.
#[tauri::command]
pub async fn fns_cleanup_legacy_conflict_copies(
    app: AppHandle,
    notebook_id: String,
) -> Result<usize, String> {
    let service = app.state::<AppState>().fns_sync.clone();
    service
        .cleanup_legacy_conflict_copies(&app, &notebook_id)
        .await
}
