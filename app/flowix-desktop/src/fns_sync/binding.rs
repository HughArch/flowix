//! FNS 绑定解析与路径校验: history / share 等 REST 适配共用的前置步骤。
//!
//! 从 `boot/fns-sync.json` (全局 api + token) 与笔记本 `.flowix/sync-state.json`
//! (vault 绑定) 解析出一次 REST 调用所需的 (服务器地址, token, vault)。

use tauri::AppHandle;

use super::config::FnsToken;
use super::service::FnsSyncService;
use flowix_core::fns_history::FnsApiError;

/// 解析 notebook → (服务器地址, token, vault)。未绑定/凭据不齐返回 Err。
/// `path` 形状校验 (相对/.md/无 `..`) 由各入口自行做 —— 本函数只关心绑定。
pub(super) fn resolve_binding(
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

/// 云端入口 (历史/分享等) 是否可用 (notebook 已绑定 FNS、凭据齐备)。供 `...` 菜单门控。
pub(super) fn available(app: &AppHandle, service: &FnsSyncService, notebook_id: &str) -> bool {
    resolve_binding(app, service, notebook_id).is_ok()
}

pub(super) fn validate_relative_path(relative_path: &str) -> Result<(), String> {
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

/// 统一把 FNS 业务错误摊平成前端可读的字符串; 业务码原样携带。
/// `fns_history` / `fns_share` 各自有同形的 `FnsApiError`, 按 code/message 处理。
pub(super) fn api_error_message(code: i64, message: String) -> String {
    if code == 0 {
        message
    } else {
        format!("[{code}] {message}")
    }
}

pub(super) fn api_error(error: FnsApiError) -> String {
    api_error_message(error.code, error.message)
}

/// spawn_blocking 包装里统一的任务层错误文案。
pub(super) fn task_error(context: &str, error: String) -> String {
    format!("{context} task failed: {error}")
}
