//! FNS 云端笔记历史 (`note_history`) 的 CLI 入口。
//!
//! 凭据解析与桌面壳同源: `<config_dir>/boot/fns-sync.json` 存全局 token,
//! 各笔记本 `.flowix/sync-state.json` 绑定 vault 与 tokenId。REST 调用与
//! diff 重建在 [`flowix_core::fns_history`]; 恢复走 [`MemoFile::write_restored_content`]
//! 共享写侧 (restore_backup 自保 + 原子覆写), 同步引擎随后上行传播。

use std::path::PathBuf;

use serde_json::{json, Value};

use crate::errors::CliError;
use crate::paths::Resolved;
use crate::store;
use flowix_core::fns_config::FnsConfig;
use flowix_core::fns_history::{self, FnsApiError, FnsCloudHistoryPage};
use flowix_core::memo_file::MemoFile;

struct CloudBinding {
    api: String,
    token: String,
    client_type: String,
    vault: String,
}

/// notebook key → (服务器地址, token, vault)。凭据或绑定缺失即报错。
fn resolve_binding(
    paths: &Resolved,
    mf: &MemoFile,
    notebook_key: &str,
    relative_path: &str,
) -> Result<CloudBinding, CliError> {
    let relative = std::path::Path::new(relative_path);
    if relative.is_absolute()
        || !flowix_core::memo_file::IsMd::is_md(relative)
        || relative
            .components()
            .any(|part| !matches!(part, std::path::Component::Normal(_)))
    {
        return Err(CliError::Usage(format!("unsafe relative path: {relative_path}")));
    }

    let config = store::resolve_notebook_config(mf, notebook_key)?;
    let root = PathBuf::from(&config.path);
    let Some(state) = flowix_fns::state::SyncState::load(&root)
        .map_err(|error| CliError::Usage(format!("cannot read sync state: {error}")))?
    else {
        return Err(CliError::NotFound(format!(
            "notebook `{notebook_key}` is not bound to FNS (no .flowix/sync-state.json)"
        )));
    };
    if state.vault.trim().is_empty() {
        return Err(CliError::Usage(format!(
            "notebook `{notebook_key}` has no vault binding"
        )));
    }

    let fns_config = FnsConfig::load(&paths.config_dir);
    if !fns_config.is_ready() {
        return Err(CliError::Usage(
            "FNS sync is not configured (`boot/fns-sync.json` missing or incomplete)".into(),
        ));
    }
    let token = fns_config
        .token(&state.token_id)
        .ok_or_else(|| CliError::NotFound("bound FNS token is missing".into()))?;
    Ok(CloudBinding {
        api: fns_config.api.trim().to_owned(),
        token: token.token.clone(),
        client_type: token.client_type.clone(),
        vault: state.vault.clone(),
    })
}

fn api_error(error: FnsApiError) -> CliError {
    CliError::Usage(error.to_string())
}

/// `cloud-versions` / MCP `cloud.versions`: 云端版本列表 (分页)。
pub(crate) fn list(
    paths: &Resolved,
    notebook_key: &str,
    relative_path: &str,
    page: u32,
) -> Result<Value, CliError> {
    let mf = store::open()?;
    let binding = resolve_binding(paths, &mf, notebook_key, relative_path)?;
    match fns_history::list_note_history_or_not_synced(
        &binding.api,
        &binding.token,
        &binding.client_type,
        &binding.vault,
        relative_path,
        page,
        20,
    )
    .map_err(api_error)?
    {
        FnsCloudHistoryPage::NotSynced => Ok(json!({
            "ok": true, "status": "notSynced",
            "message": "note has never been synced to the cloud"
        })),
        FnsCloudHistoryPage::Ok { items, total, has_more } => Ok(json!({
            "ok": true, "status": "ok",
            "total": total, "hasMore": has_more, "page": page,
            "versions": items,
        })),
    }
}

/// `cloud-restore` / MCP `cloud.restore`: 拉取云端版本正文并走本地恢复管线
/// (当前内容自保为 restore_backup + 原子覆写), 同步引擎随后上行传播。
/// CLI 无前端 buffer 概念, 不做 expectedContent 校验。
pub(crate) fn restore(
    paths: &Resolved,
    notebook_key: &str,
    relative_path: &str,
    history_id: i64,
) -> Result<Value, CliError> {
    let mf = store::open()?;
    let binding = resolve_binding(paths, &mf, notebook_key, relative_path)?;
    let content = fns_history::note_history_content(
        &binding.api,
        &binding.token,
        &binding.client_type,
        history_id,
    )
    .map_err(api_error)?;

    let config = store::resolve_notebook_config(&mf, notebook_key)?;
    let path = mf
        .resolve_notebook_md_path(&config.id, relative_path)
        .map_err(|error| CliError::NotFound(format!("note file unavailable: {error}")))?;
    let restored = mf
        .write_restored_content(&config.id, relative_path, &path, &content, None)
        .map_err(|error| CliError::Usage(format!("restore write failed: {error}")))?;
    if !restored {
        return Err(CliError::Usage(
            "restore refused: note content changed concurrently".into(),
        ));
    }
    Ok(json!({
        "ok": true, "action": "restored",
        "historyId": history_id,
        "path": relative_path,
        "note": "current content was archived locally as restore_backup; it will sync upstream on the next sync run",
    }))
}
