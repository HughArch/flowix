//! IPC commands for FNS sync.

use tauri::{AppHandle, Manager, State};

use crate::app::state::AppState;
use crate::fns_sync::config::{FnsConfigPatch, FnsConfigView, FnsTokenInput};
use crate::fns_sync::service::{
    ConflictResolutionChoice, FnsConflictView, FnsNotebookState, FnsNotebookSyncOutcome,
    FnsSyncRecord, FnsSyncStatus,
};

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
