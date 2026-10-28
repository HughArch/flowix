//! 云端笔记历史的桌面壳适配: 绑定解析见 [`super::binding`], REST 调用与内容
//! 重建在 [`flowix_core::fns_history`] (阻塞实现, 此处用 spawn_blocking 包装
//! 供 async IPC 命令使用)。

use std::sync::Arc;

use super::service::FnsSyncService;
use super::binding::{self, api_error};
use tauri::AppHandle;

pub use flowix_core::fns_history::{FnsApiError, FnsCloudHistoryPage, FnsCloudVersionMeta};

/// 云端入口是否可用 (notebook 已绑定 FNS、凭据齐备)。供 `...` 菜单门控。
pub fn cloud_available(app: &AppHandle, service: &FnsSyncService, notebook_id: &str) -> bool {
    binding::available(app, service, notebook_id)
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
        binding::validate_relative_path(&relative_path)?;
        let (api, token, vault) = binding::resolve_binding(&app, &service, &notebook_id)?;
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
        binding::validate_relative_path(&relative_path)?;
        let (api, token, _vault) = binding::resolve_binding(&app, &service, &notebook_id)?;
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
