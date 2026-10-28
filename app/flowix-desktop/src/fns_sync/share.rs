//! 笔记分享的桌面壳适配: 绑定解析见 [`super::binding`], REST 调用在
//! [`flowix_core::fns_share`] (阻塞实现, 此处用 spawn_blocking 包装供 async
//! IPC 命令使用)。接口契约见 docs/NOTE-SHARE-CLOUD.md。

use std::sync::Arc;

use super::binding::{self, api_error, task_error};
use super::service::FnsSyncService;
use tauri::AppHandle;

pub use flowix_core::fns_share::FnsShareView;

/// 分享入口是否可用 (notebook 已绑定 FNS、凭据齐备)。供 `...` 菜单门控。
pub fn share_available(app: &AppHandle, service: &FnsSyncService, notebook_id: &str) -> bool {
    binding::available(app, service, notebook_id)
}

/// 创建分享 (服务端幂等: 同资源已有 active 分享先撤销再建)。
pub async fn share_create(
    app: AppHandle,
    service: Arc<FnsSyncService>,
    notebook_id: String,
    relative_path: String,
    password: Option<String>,
    expire_at_sec: Option<i64>,
) -> Result<FnsShareView, String> {
    tauri::async_runtime::spawn_blocking(move || {
        binding::validate_relative_path(&relative_path)?;
        let (api, token, vault) = binding::resolve_binding(&app, &service, &notebook_id)?;
        flowix_core::fns_share::share_create(
            &api,
            &token.token,
            &token.client_type,
            &vault,
            &relative_path,
            password.as_deref(),
            expire_at_sec,
        )
        .map_err(|error| binding::api_error_message(error.code, error.message))
    })
    .await
    .map_err(|error| task_error("share create", error.to_string()))?
}

/// 查询当前分享。无 active 分享返回 `None` 而非错误。
pub async fn share_query(
    app: AppHandle,
    service: Arc<FnsSyncService>,
    notebook_id: String,
    relative_path: String,
) -> Result<Option<FnsShareView>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        binding::validate_relative_path(&relative_path)?;
        let (api, token, vault) = binding::resolve_binding(&app, &service, &notebook_id)?;
        flowix_core::fns_share::share_query_or_none(
            &api,
            &token.token,
            &token.client_type,
            &vault,
            &relative_path,
        )
        .map_err(|error| binding::api_error_message(error.code, error.message))
    })
    .await
    .map_err(|error| task_error("share query", error.to_string()))?
}

/// 取消 (撤销) 分享。外部分享链接随即失效, 不可恢复。
pub async fn share_cancel(
    app: AppHandle,
    service: Arc<FnsSyncService>,
    notebook_id: String,
    relative_path: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        binding::validate_relative_path(&relative_path)?;
        let (api, token, vault) = binding::resolve_binding(&app, &service, &notebook_id)?;
        flowix_core::fns_share::share_cancel(
            &api,
            &token.token,
            &token.client_type,
            &vault,
            &relative_path,
        )
        .map_err(|error| binding::api_error_message(error.code, error.message))
    })
    .await
    .map_err(|error| task_error("share cancel", error.to_string()))?
}

/// 更新分享密码与过期时间。
pub async fn share_update_password(
    app: AppHandle,
    service: Arc<FnsSyncService>,
    notebook_id: String,
    relative_path: String,
    password: Option<String>,
    expire_at_sec: Option<i64>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        binding::validate_relative_path(&relative_path)?;
        let (api, token, vault) = binding::resolve_binding(&app, &service, &notebook_id)?;
        flowix_core::fns_share::share_update_password(
            &api,
            &token.token,
            &token.client_type,
            &vault,
            &relative_path,
            password.as_deref(),
            expire_at_sec,
        )
        .map_err(|error| binding::api_error_message(error.code, error.message))
    })
    .await
    .map_err(|error| task_error("share password", error.to_string()))?
}

/// vault 内所有 active 分享的笔记路径 (预留: 列表角标 / 分享管理)。
pub async fn active_note_share_paths(
    app: AppHandle,
    service: Arc<FnsSyncService>,
    notebook_id: String,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (api, token, vault) = binding::resolve_binding(&app, &service, &notebook_id)?;
        flowix_core::fns_share::active_note_share_paths(
            &api,
            &token.token,
            &token.client_type,
            &vault,
        )
        .map_err(|error| binding::api_error_message(error.code, error.message))
    })
    .await
    .map_err(|error| task_error("share paths", error.to_string()))?
}
