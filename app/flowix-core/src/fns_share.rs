//! FNS 分享 REST 客户端 (`/api/share*`, `/api/notes/share-paths`)。
//!
//! 分享以 `path_hash` 为主键在服务端定位笔记 (JS 兼容 32 位字符串哈希, 与同步
//! 引擎 `flowix-fns::hash` 同一算法; `flowix-core` 不依赖 `flowix-fns`, 此处
//! 镜像实现并以相同测试向量锁定)。token 由服务端每次现签 (SID 方案, 不入库),
//! 客户端只在响应内消费、不持久化。接口契约见 docs/NOTE-SHARE-CLOUD.md §3。
//!
//! 阻塞式实现 (reqwest::blocking): 桌面 async 命令用 spawn_blocking 包装。
//! 凭据不在此解析 —— 调用方传入服务器地址与 token, 各端自行从 `boot/fns-sync.json`
//! + 笔记本 `.flowix/sync-state.json` 解析。

use serde::{Deserialize, Serialize};

/// FNS 业务错误码 (pkg/code/common.go): 从未同步过的笔记。
pub const FNS_CODE_NOTE_NOT_FOUND: i64 = 430;
/// FNS 业务错误码: 该路径当前没有 active 分享 (服务端以「文件不存在」复用)。
pub const FNS_CODE_SHARE_ABSENT: i64 = 455;

/// 一条分享的当前状态。`share_url` 由本 crate 拼好, 调用方直接展示。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FnsShareView {
    /// 笔记 (或文件) 表 ID, 分享页 URL 的 `/{id}` 段。
    pub id: i64,
    /// `note` | `file`。
    #[serde(rename = "shareType")]
    pub share_type: String,
    pub token: String,
    pub is_password: bool,
    /// Go time.Time RFC3339 字符串; 零值 (`0001-01-01T00:00:00Z`) = 永久。
    pub expires_at: String,
    #[serde(default)]
    pub short_link: String,
    pub base_url: String,
    /// `{base}/share/{id}/{token}`, 已规范好斜杠。
    pub share_url: String,
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
struct FnsShareData {
    id: i64,
    #[serde(rename = "type", default)]
    share_type: String,
    #[serde(default)]
    token: String,
    #[serde(default)]
    is_password: bool,
    #[serde(default)]
    expires_at: String,
    #[serde(default)]
    short_link: String,
    #[serde(default)]
    base_url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SharePathBody<'a> {
    vault: &'a str,
    path: &'a str,
    path_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    password: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    expire_at: Option<i64>,
}

/// JavaScript 兼容 32 位字符串哈希 (UTF-16 code unit 迭代)。
///
/// 镜像 `flowix-fns::hash::encode_hash32` / 服务端 `util.EncodeHash32`:
/// `hash = (hash << 5) - hash + char`, i32 回绕。
pub fn encode_hash32(content: &str) -> String {
    let mut hash: i32 = 0;
    for unit in content.encode_utf16() {
        hash = hash
            .wrapping_shl(5)
            .wrapping_sub(hash)
            .wrapping_add(i32::from(unit));
    }
    hash.to_string()
}

/// notebook 相对路径 (正斜杠) 的服务端主键哈希。
pub fn path_hash(path: &str) -> String {
    encode_hash32(path)
}

fn client() -> Result<reqwest::blocking::Client, FnsApiError> {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|error| FnsApiError { code: 0, message: error.to_string() })
}

fn base(api: &str) -> String {
    api.trim_end_matches('/').to_owned()
}

fn auth(
    builder: reqwest::blocking::RequestBuilder,
    token: &str,
    client_type: &str,
) -> reqwest::blocking::RequestBuilder {
    builder
        .bearer_auth(token.trim())
        .header(
            "X-Client",
            if client_type.is_empty() { "flowix" } else { client_type },
        )
        .header("X-Client-Name", "Flowix")
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

/// 只校验包络码、不取 data —— cancel / password 等端点成功时 `data` 为 null。
fn send_ok(request: reqwest::blocking::RequestBuilder) -> Result<(), FnsApiError> {
    let response = request
        .send()
        .map_err(|error| FnsApiError { code: 0, message: error.to_string() })?;
    if !response.status().is_success() {
        return Err(FnsApiError {
            code: 0,
            message: format!("FNS server returned {}", response.status()),
        });
    }
    let envelope: FnsEnvelope<serde::de::IgnoredAny> = response
        .json()
        .map_err(|error| FnsApiError { code: 0, message: error.to_string() })?;
    if envelope.code != 1 {
        return Err(FnsApiError { code: envelope.code, message: envelope.message });
    }
    Ok(())
}

fn to_view(data: FnsShareData) -> FnsShareView {
    let share_url = format!(
        "{}/share/{}/{}",
        data.base_url.trim_end_matches('/'),
        data.id,
        data.token
    );
    FnsShareView {
        id: data.id,
        share_type: data.share_type,
        token: data.token,
        is_password: data.is_password,
        expires_at: data.expires_at,
        short_link: data.short_link,
        base_url: data.base_url,
        share_url,
    }
}

/// 创建分享 (服务端幂等: 同资源已有 active 分享会先撤销再建)。
pub fn share_create(
    api: &str,
    token: &str,
    client_type: &str,
    vault: &str,
    path: &str,
    password: Option<&str>,
    expire_at_sec: Option<i64>,
) -> Result<FnsShareView, FnsApiError> {
    let path = path.replace('\\', "/");
    let body = SharePathBody {
        vault,
        path: &path,
        path_hash: path_hash(&path),
        password,
        expire_at: expire_at_sec,
    };
    let request = auth(
        client()?.post(format!("{}/api/share", base(api))),
        token,
        client_type,
    )
    .json(&body);
    send::<FnsShareData>(request).map(to_view)
}

/// 查询当前分享 (服务端每次现签新 token)。
pub fn share_query(
    api: &str,
    token: &str,
    client_type: &str,
    vault: &str,
    path: &str,
) -> Result<FnsShareView, FnsApiError> {
    let path = path.replace('\\', "/");
    let request = auth(
        client()?.get(format!("{}/api/share", base(api))),
        token,
        client_type,
    )
    .query(&[
        ("vault", vault),
        ("path", path.as_str()),
        ("pathHash", path_hash(&path).as_str()),
    ]);
    send::<FnsShareData>(request).map(to_view)
}

/// 查询便捷封装: 无 active 分享 (455) 返回 `Ok(None)` 而非错误。
pub fn share_query_or_none(
    api: &str,
    token: &str,
    client_type: &str,
    vault: &str,
    path: &str,
) -> Result<Option<FnsShareView>, FnsApiError> {
    match share_query(api, token, client_type, vault, path) {
        Ok(view) => Ok(Some(view)),
        Err(error) if error.code == FNS_CODE_SHARE_ABSENT => Ok(None),
        Err(error) => Err(error),
    }
}

/// 取消 (撤销) 分享。
pub fn share_cancel(
    api: &str,
    token: &str,
    client_type: &str,
    vault: &str,
    path: &str,
) -> Result<(), FnsApiError> {
    let path = path.replace('\\', "/");
    let body = SharePathBody {
        vault,
        path: &path,
        path_hash: path_hash(&path),
        password: None,
        expire_at: None,
    };
    let request = auth(
        client()?.delete(format!("{}/api/share", base(api))),
        token,
        client_type,
    )
    .json(&body);
    send_ok(request)
}

/// 更新分享密码与过期时间 (`password = ""` 表示去掉密码)。
pub fn share_update_password(
    api: &str,
    token: &str,
    client_type: &str,
    vault: &str,
    path: &str,
    password: Option<&str>,
    expire_at_sec: Option<i64>,
) -> Result<(), FnsApiError> {
    let path = path.replace('\\', "/");
    let body = SharePathBody {
        vault,
        path: &path,
        path_hash: path_hash(&path),
        password,
        expire_at: expire_at_sec,
    };
    let request = auth(
        client()?.post(format!("{}/api/share/password", base(api))),
        token,
        client_type,
    )
    .json(&body);
    send_ok(request)
}

/// vault 内所有 active 分享的笔记路径 (预留: 列表角标 / 分享管理)。
pub fn active_note_share_paths(
    api: &str,
    token: &str,
    client_type: &str,
    vault: &str,
) -> Result<Vec<String>, FnsApiError> {
    let request = auth(
        client()?.get(format!("{}/api/notes/share-paths", base(api))),
        token,
        client_type,
    )
    .query(&[("vault", vault)]);
    send::<Vec<String>>(request)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 与 `flowix-fns::hash` 共用的测试向量, 锁定镜像实现不漂移。
    #[test]
    fn path_hash_matches_engine_vectors() {
        assert_eq!(encode_hash32("abc"), "96354");
        assert_eq!(encode_hash32(""), "0");
        // 非 BMP 字符走 UTF-16 代理对, 与 JS/Go 一致。
        let mut expected: i32 = 0;
        for unit in [0xD83Du16, 0xDE00u16] {
            expected = expected
                .wrapping_shl(5)
                .wrapping_sub(expected)
                .wrapping_add(i32::from(unit));
        }
        assert_eq!(encode_hash32("😀"), expected.to_string());
        // path_hash 只做拼接转发, 行为同 encode_hash32。
        assert_eq!(path_hash("Notes/计划.md"), encode_hash32("Notes/计划.md"));
    }

    /// 实测响应形态 (docs/NOTE-SHARE-CLOUD.md §3) 的反序列化 + URL 拼接。
    #[test]
    fn parses_share_data_and_builds_url() {
        let data: FnsShareData = serde_json::from_str(
            r#"{"id":129,"type":"note","token":"CNmkmQlq0s-4elT3NuZG2w",
                "isPassword":false,"expiresAt":"0001-01-01T00:00:00Z",
                "shortLink":"","baseUrl":"https://fns.example.com/"}"#,
        )
        .unwrap();
        let view = to_view(data);
        assert_eq!(view.share_type, "note");
        assert_eq!(view.share_url, "https://fns.example.com/share/129/CNmkmQlq0s-4elT3NuZG2w");
    }

    #[test]
    fn create_body_uses_camel_case_and_optional_fields() {
        let body = SharePathBody {
            vault: "测试",
            path: "Notes/计划.md",
            path_hash: path_hash("Notes/计划.md"),
            password: Some("123"),
            expire_at: Some(1_900_000_000),
        };
        let json = serde_json::to_value(&body).unwrap();
        assert_eq!(json["vault"], "测试");
        assert_eq!(json["pathHash"], path_hash("Notes/计划.md"));
        assert_eq!(json["expireAt"], 1_900_000_000);
        let bare = serde_json::to_value(SharePathBody {
            vault: "v",
            path: "a.md",
            path_hash: "0".into(),
            password: None,
            expire_at: None,
        })
        .unwrap();
        assert!(bare.get("password").is_none());
        assert!(bare.get("expireAt").is_none());
    }
}
