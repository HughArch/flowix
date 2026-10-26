//! FNS 云端笔记历史 REST 客户端 (`/api/note/history*`)。
//!
//! 服务端为每次同步修改自动落一条历史 (`note_history` 表): `content` 存修改前
//! 快照, `diffs` 存 go-diff 补丁; 「该版本修改后的正文」= 按序拼接 `Type != -1`
//! 的 `Text`。接口契约与实测样本见 flowix 仓库 docs/VERSION-HISTORY-CLOUD.md §2.3。
//!
//! 阻塞式实现 (reqwest::blocking): 桌面 async 命令用 spawn_blocking 包装,
//! CLI / 内置 Agent 工具天然在阻塞上下文。凭据不在此解析 —— 调用方传入
//! 服务器地址与 token, 各端自行从 `boot/fns-sync.json` + 笔记本
//! `.flowix/sync-state.json` 解析。

use serde::{Deserialize, Serialize};

/// FNS 服务端「笔记不存在」错误码 (pkg/code/common.go), 即从未同步过。
pub const FNS_CODE_NOTE_NOT_FOUND: i64 = 430;

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

/// 云端版本列表页。`notSynced` 单独成态: 服务端查无此笔记 (从未同步过)。
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
    /// 修改前快照。重建只用 `diffs` (拼接 Type != -1), 此字段仅用于确认
    /// 响应形状与排查, 故不读取。
    #[serde(default)]
    #[allow(dead_code)]
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

fn client() -> Result<reqwest::blocking::Client, FnsApiError> {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|error| FnsApiError { code: 0, message: error.to_string() })
}

fn get_request(
    api: &str,
    token: &str,
    client_type: &str,
    path: &str,
    query: &[(&str, String)],
) -> Result<reqwest::blocking::RequestBuilder, FnsApiError> {
    Ok(client()?
        .get(format!("{}/{}", api.trim_end_matches('/'), path))
        .query(query)
        .bearer_auth(token.trim())
        .header(
            "X-Client",
            if client_type.is_empty() { "flowix" } else { client_type },
        )
        .header("X-Client-Name", "Flowix"))
}

fn send<T: serde::de::DeserializeOwned>(
    request: reqwest::blocking::RequestBuilder,
) -> Result<T, FnsApiError> {
    let response = request
        .send()
        .map_err(|error| FnsApiError { code: 0, message: error.to_string() })?;
    if !response.status().is_success() {
        return Err(FnsApiError {
            code: 0,
            message: format!("FNS server returned {}", response.status()),
        });
    }
    let envelope: FnsEnvelope<T> = response
        .json()
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
pub fn list_note_history(
    api: &str,
    token: &str,
    client_type: &str,
    vault: &str,
    path: &str,
    page: u32,
    page_size: u32,
) -> Result<FnsCloudHistoryPage, FnsApiError> {
    let request = get_request(api, token, client_type, "api/note/histories", &[
        ("vault", vault.to_owned()),
        ("path", path.replace('\\', "/")),
        ("page", page.to_string()),
        ("pageSize", page_size.to_string()),
    ])?;
    let data = send::<FnsHistoryListData>(request)?;
    let Some(list) = data.list else {
        // 防御: code=1 却无 list 视作空页。
        return Ok(FnsCloudHistoryPage::Ok { items: Vec::new(), total: 0, has_more: false });
    };
    let items = list
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

/// 查无此笔记 (从未同步过) 的列表查询便捷封装。
pub fn list_note_history_or_not_synced(
    api: &str,
    token: &str,
    client_type: &str,
    vault: &str,
    path: &str,
    page: u32,
    page_size: u32,
) -> Result<FnsCloudHistoryPage, FnsApiError> {
    match list_note_history(api, token, client_type, vault, path, page, page_size) {
        Ok(page) => Ok(page),
        Err(error) if error.code == FNS_CODE_NOTE_NOT_FOUND => Ok(FnsCloudHistoryPage::NotSynced),
        Err(error) => Err(error),
    }
}

/// 拉取并重建某云端版本修改后的完整正文。
pub fn note_history_content(
    api: &str,
    token: &str,
    client_type: &str,
    history_id: i64,
) -> Result<String, FnsApiError> {
    let request = get_request(api, token, client_type, "api/note/history", &[
        ("id", history_id.to_string()),
    ])?;
    let detail = send::<FnsHistoryDetail>(request)?;
    reconstruct_after_content(&detail)
        .map_err(|message| FnsApiError { code: 0, message })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 实测响应样本 (docs/VERSION-HISTORY-CLOUD.md §2.3) 的关键形态。
    #[test]
    fn reconstructs_after_content_from_go_diff_patches() {
        let detail: FnsHistoryDetail = serde_json::from_str(
            r#"{"content":"before","diffs":[
                {"Type":0,"Text":"keep "},{"Type":1,"Text":"added"},
                {"Type":-1,"Text":"deleted"},{"Type":0,"Text":" tail"}]}"#,
        )
        .unwrap();
        assert_eq!(reconstruct_after_content(&detail).unwrap(), "keep added tail");
    }

    #[test]
    fn rejects_empty_diff_patches() {
        let detail: FnsHistoryDetail = serde_json::from_str(r#"{"content":"x","diffs":[]}"#).unwrap();
        assert!(reconstruct_after_content(&detail).is_err());
    }

    #[test]
    fn parses_list_envelope_with_camel_case_and_pager() {
        let data: FnsHistoryListData = serde_json::from_str(
            r#"{"list":[{"id":98,"noteId":18,"vaultId":1,"path":"a.md",
                "clientName":"Flowix","clientType":"flowix","clientVersion":"1.5.11",
                "version":4,"createdAt":"2026-10-25 23:20:06"}],
                "pager":{"page":1,"pageSize":10,"totalRows":4}}"#,
        )
        .unwrap();
        let item = &data.list.unwrap()[0];
        assert_eq!(item.id, 98);
        assert_eq!(item.version, 4);
        assert_ne!(parse_created_at_ms(&item.created_at), 0, "时区内的合法时间不应解析为 0");
        assert_eq!(data.pager.unwrap().total_rows, 4);
    }

    #[test]
    fn parse_created_at_handles_garbage() {
        assert_eq!(parse_created_at_ms("not a date"), 0);
    }
}
