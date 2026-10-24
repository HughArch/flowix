//! IPC commands for FNS sync.

use tauri::{AppHandle, Manager, State};

use crate::app::state::AppState;
use crate::fns_sync::config::{FnsConfigPatch, FnsConfigView};
use crate::fns_sync::service::{FnsNotebookSyncOutcome, FnsSyncStatus};

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
pub fn fns_get_status(state: State<AppState>) -> FnsSyncStatus {
    state.fns_sync.status()
}

#[tauri::command]
pub async fn fns_sync_notebook(
    app: AppHandle,
    notebook_id: String,
) -> Result<Option<FnsNotebookSyncOutcome>, String> {
    let service = app.state::<AppState>().fns_sync.clone();
    service.sync_notebook(&app, &notebook_id).await
}

#[tauri::command]
pub async fn fns_sync_all(app: AppHandle) -> Result<Vec<FnsNotebookSyncOutcome>, String> {
    let service = app.state::<AppState>().fns_sync.clone();
    service.sync_bound_notebooks(&app).await
}
