//! 云端笔记历史的桌面壳适配: 从 app 状态解析 FNS 绑定 (服务器地址 + token +
//! vault), REST 调用与内容重建在 [`flowix_core::fns_history`] (阻塞实现,
//! 此处用 spawn_blocking 包装供 async IPC 命令使用)。

use std::sync::Arc;

use super::config::FnsToken;
use super::service::FnsSyncService;
use tauri::AppHandle;

pub use flowix_core::fns_history::{FnsApiError, FnsCloudHistoryPage, FnsCloudVersionMeta};

/// 解析 notebook → (服务器地址, token, vault)。未绑定/凭据不齐返回 Err。
/// `path` 形状校验 (相对/.md/无 `..`) 由各入口自行做 —— 本函数只关心绑定。
fn resolve_binding(
    app: &AppHandle,
    service: &FnsSyncService,
    notebook_id: &str,
) -> Result<(String, FnsToken, String), String> {
    let (_, root) = super::service::notebook_root(app, notebook_id)?;
    let state = flowix_fns::state::SyncState::load(&root).map_err(|error| error.to_string())?;
    let Some(state) = state else {
        return Err("notebook is not bound to FNS".to_owned());
    };
    if state.vault.trim().is_empty() {
        return Err("notebook has no vault binding".to_owned());
    }
    let config = service.read_config();
    if !config.is_ready() {
        return Err("FNS sync is not configured".to_owned());
    }
    let token = config
        .token(&state.token_id)
        .cloned()
        .ok_or_else(|| "bound FNS token is missing".to_owned())?;
    Ok((config.api.trim().to_owned(), token, state.vault))
}

/// 云端入口是否可用 (notebook 已绑定 FNS、凭据齐备)。供 `...` 菜单门控。
pub fn cloud_available(app: &AppHandle, service: &FnsSyncService, notebook_id: &str) -> bool {
    resolve_binding(app, service, notebook_id).is_ok()
}

fn validate_relative_path(relative_path: &str) -> Result<(), String> {
    use flowix_core::memo_file::IsMd;
    let path = std::path::Path::new(relative_path);
    if path.is_absolute()
        || !path.is_md()
        || path
            .components()
            .any(|part| !matches!(part, std::path::Component::Normal(_)))
    {
        return Err(format!("unsafe relative path: {relative_path}"));
    }
    Ok(())
}

fn api_error(error: FnsApiError) -> String {
    if error.code == 0 {
        error.message
    } else {
        format!("[{code}] {message}", code = error.code, message = error.message)
    }
}

/// 拉取云端版本列表 (分页)。查无笔记返回 `NotSynced` 形态而非错误。
pub async fn list_note_history(
    app: AppHandle,
    service: Arc<FnsSyncService>,
    notebook_id: String,
    relative_path: String,
    page: u32,
    page_size: u32,
) -> Result<FnsCloudHistoryPage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_relative_path(&relative_path)?;
        let (api, token, vault) = resolve_binding(&app, &service, &notebook_id)?;
        flowix_core::fns_history::list_note_history_or_not_synced(
            &api,
            &token.token,
            &token.client_type,
            &vault,
            &relative_path,
            page,
            page_size,
        )
        .map_err(api_error)
    })
    .await
    .map_err(|error| format!("cloud history task failed: {error}"))?
}

/// 拉取并重建某云端版本修改后的完整正文。
pub async fn note_history_content(
    app: AppHandle,
    service: Arc<FnsSyncService>,
    notebook_id: String,
    relative_path: String,
    history_id: i64,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_relative_path(&relative_path)?;
        let (api, token, _vault) = resolve_binding(&app, &service, &notebook_id)?;
        flowix_core::fns_history::note_history_content(
            &api,
            &token.token,
            &token.client_type,
            history_id,
        )
        .map_err(api_error)
    })
    .await
    .map_err(|error| format!("cloud history task failed: {error}"))?
}
