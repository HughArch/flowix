//! FNS 云端笔记历史 REST 客户端 (`/api/note/history*`)。
//!
//! 服务端为每次同步修改自动落一条历史 (`note_history` 表): `content` 存修改前
//! 快照, `diffs` 存 go-diff 补丁; 「该版本修改后的正文」= 按序拼接 `Type != -1`
//! 的 `Text`。接口契约与实测样本见 docs/VERSION-HISTORY-CLOUD.md §2.3。
//!
//! 云端恢复不直推服务端 (`PUT /history/restore` v1 不用): 内容拉回本地后走
//! `restore_path_content` 的本地恢复管线, 文件仍是唯一事实源 (设计稿 §3 D2)。

use serde::{Deserialize, Serialize};

use flowix_core::memo_file::IsMd;

use super::config::FnsToken;
use super::service::FnsSyncService;
use tauri::AppHandle;

/// FNS 服务端「笔记不存在」错误码 (pkg/code/common.go), 即从未同步过。
const FNS_CODE_NOTE_NOT_FOUND: i64 = 430;

/// 一条云端版本的元数据 (不含正文)。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FnsCloudVersionMeta {
    pub history_id: i64,
    /// 服务端笔记内递增版本号。
    pub version: i64,
    pub created_at_ms: i64,
    pub client_name: String,
    pub client_type: String,
    pub client_version: String,
    pub path: String,
}

/// 云端版本列表页。`notSynced` 单独成态: 服务端查无此笔记 (从未同步过),
/// 前端据此区分「没同步过」与真正的错误。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum FnsCloudHistoryPage {
    Ok {
        items: Vec<FnsCloudVersionMeta>,
        total: u64,
        has_more: bool,
    },
    NotSynced,
}

/// 请求失败。`code = 0` 表示传输层/HTTP 层错误; 其余为 FNS 业务错误码。
#[derive(Debug)]
pub struct FnsApiError {
    pub code: i64,
    pub message: String,
}

impl std::fmt::Display for FnsApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.code == 0 {
            write!(f, "{}", self.message)
        } else {
            write!(f, "FNS error {}: {}", self.code, self.message)
        }
    }
}

/// 服务端响应包络: `{"code":1,"status":true,"message":"Success","data":...}`。
#[derive(Debug, Deserialize)]
struct FnsEnvelope<T> {
    code: i64,
    message: String,
    data: Option<T>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FnsHistoryListData {
    list: Option<Vec<FnsHistoryItem>>,
    pager: Option<FnsPager>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FnsPager {
    #[serde(default)]
    total_rows: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FnsHistoryItem {
    id: i64,
    #[serde(default)]
    version: i64,
    #[serde(default)]
    path: String,
    #[serde(default)]
    client_name: String,
    #[serde(default)]
    client_type: String,
    #[serde(default)]
    client_version: String,
    /// 服务器本地时区格式化字符串 `"2006-01-02 15:04:05"`, 不是时间戳。
    #[serde(default)]
    created_at: String,
}

#[derive(Debug, Deserialize)]
struct FnsHistoryDetail {
    #[serde(default)]
    content: String,
    #[serde(default)]
    diffs: Vec<FnsDiff>,
}

/// go-diff 默认序列化: 大写键 `Type`/`Text`; 0=EQUAL, 1=INSERT, -1=DELETE。
#[derive(Debug, Deserialize)]
struct FnsDiff {
    #[serde(rename = "Type")]
    typ: i64,
    #[serde(rename = "Text")]
    text: String,
}

/// 该版本修改后的完整正文 = 按序拼接 EQUAL/INSERT 文本 (丢弃 DELETE)。
fn reconstruct_after_content(detail: &FnsHistoryDetail) -> Result<String, String> {
    if detail.diffs.is_empty() {
        // ProcessDelay 对无内容变化不落库, 空补丁意味着数据不完整。
        return Err("cloud history has no diff patches".to_owned());
    }
    let mut content = String::new();
    for diff in &detail.diffs {
        if diff.typ != -1 {
            content.push_str(&diff.text);
        }
    }
    Ok(content)
}

/// `createdAt` 按服务器本地时区解析; 时区取不到时退回 UTC (显示误差可接受)。
fn parse_created_at_ms(value: &str) -> i64 {
    chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S")
        .map(|naive| {
            use chrono::TimeZone;
            chrono::Local
                .from_local_datetime(&naive)
                .single()
                .unwrap_or_else(|| naive.and_utc().with_timezone(&chrono::Local))
                .timestamp_millis()
        })
        .unwrap_or(0)
}

/// 校验 relative_path 形状 (相对、.md、无 `..` 分量), 与本地归档的
/// `path_archive_document` 同一口径; 云端查询不触碰文件系统, 只需形状。
fn validate_relative_path(relative_path: &str) -> Result<(), String> {
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

/// 解析 notebook → (服务器地址, token, vault)。未绑定/凭据不齐返回 Err。
fn resolve_binding(
    app: &AppHandle,
    service: &FnsSyncService,
    notebook_id: &str,
    relative_path: &str,
) -> Result<(String, FnsToken, String), String> {
    validate_relative_path(relative_path)?;
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

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|error| error.to_string())
}

fn get_request(
    api: &str,
    token: &FnsToken,
    path: &str,
    query: &[(&str, String)],
) -> Result<reqwest::RequestBuilder, String> {
    Ok(client()?
        .get(format!("{}/{}", api.trim_end_matches('/'), path))
        .query(query)
        .bearer_auth(token.token.trim())
        .header(
            "X-Client",
            if token.client_type.is_empty() { "flowix" } else { token.client_type.as_str() },
        )
        .header("X-Client-Name", "Flowix"))
}

async fn send<T: serde::de::DeserializeOwned>(
    request: reqwest::RequestBuilder,
) -> Result<T, FnsApiError> {
    let response = request
        .send()
        .await
        .map_err(|error| FnsApiError { code: 0, message: error.to_string() })?;
    if !response.status().is_success() {
        return Err(FnsApiError {
            code: 0,
            message: format!("FNS server returned {}", response.status()),
        });
    }
    let envelope: FnsEnvelope<T> = response
        .json()
        .await
        .map_err(|error| FnsApiError { code: 0, message: error.to_string() })?;
    if envelope.code != 1 {
        return Err(FnsApiError { code: envelope.code, message: envelope.message });
    }
    envelope.data.ok_or(FnsApiError {
        code: 0,
        message: "empty FNS response data".to_owned(),
    })
}

/// 拉取云端版本列表 (分页)。
pub async fn list_note_history(
    app: &AppHandle,
    service: &FnsSyncService,
    notebook_id: &str,
    relative_path: &str,
    page: u32,
    page_size: u32,
) -> Result<FnsCloudHistoryPage, FnsApiError> {
    let (api, token, vault) = resolve_binding(app, service, notebook_id, relative_path)
        .map_err(|message| FnsApiError { code: 0, message })?;
    let request = get_request(&api, &token, "api/note/histories", &[
        ("vault", vault.clone()),
        ("path", relative_path.replace('\\', "/")),
        ("page", page.to_string()),
        ("pageSize", page_size.to_string()),
    ])
    .map_err(|message| FnsApiError { code: 0, message })?;
    let data = match send::<FnsHistoryListData>(request).await {
        Ok(data) => data,
        // 服务端查无此笔记 = 从未同步过, 不是错误。
        Err(error) if error.code == FNS_CODE_NOTE_NOT_FOUND => {
            return Ok(FnsCloudHistoryPage::NotSynced);
        }
        Err(error) => return Err(error),
    };
    let items = data
        .list
        .unwrap_or_default()
        .into_iter()
        .map(|item| FnsCloudVersionMeta {
            history_id: item.id,
            version: item.version,
            created_at_ms: parse_created_at_ms(&item.created_at),
            client_name: item.client_name,
            client_type: item.client_type,
            client_version: item.client_version,
            path: item.path,
        })
        .collect();
    let total = data.pager.map(|pager| pager.total_rows).unwrap_or(0);
    let consumed = (page as u64).saturating_mul(page_size as u64);
    Ok(FnsCloudHistoryPage::Ok { items, total, has_more: consumed < total })
}

/// 拉取并重建某云端版本修改后的完整正文。
pub async fn note_history_content(
    app: &AppHandle,
    service: &FnsSyncService,
    notebook_id: &str,
    relative_path: &str,
    history_id: i64,
) -> Result<String, FnsApiError> {
    let (api, token, _vault) = resolve_binding(app, service, notebook_id, relative_path)
        .map_err(|message| FnsApiError { code: 0, message })?;
    let request = get_request(&api, &token, "api/note/history", &[
        ("id", history_id.to_string()),
    ])
    .map_err(|message| FnsApiError { code: 0, message })?;
    let detail = send::<FnsHistoryDetail>(request).await?;
    reconstruct_after_content(&detail)
        .map_err(|message| FnsApiError { code: 0, message })
}

/// 云端入口是否可用 (notebook 已绑定 FNS、凭据齐备)。供 `...` 菜单门控。
pub fn cloud_available(app: &AppHandle, service: &FnsSyncService, notebook_id: &str) -> bool {
    let Ok((_, root)) = super::service::notebook_root(app, notebook_id) else {
        return false;
    };
    let Ok(Some(state)) = flowix_fns::state::SyncState::load(&root) else {
        return false;
    };
    if state.vault.trim().is_empty() {
        return false;
    }
    let config = service.read_config();
    config.is_ready() && config.token(&state.token_id).is_some()
}
