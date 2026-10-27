//! Minimal MCP (Model Context Protocol) client for the built-in assistant.
//!
//! Streamable HTTP only — the transport used by remote servers in the
//! notebook's `.agents/mcp.json` (the same file the desktop notebook-agent
//! settings UI edits, synced to mobile through FNS like `skills/**`).
//! JSON-RPC 2.0 over POST: `initialize` handshake, `tools/list` discovery and
//! `tools/call` execution. Responses may arrive as `application/json` or an
//! SSE `text/event-stream` body; both are handled. Server-initiated requests
//! (sampling, roots) are not supported: this client never opens the upstream
//! GET stream, which plain tool servers do not require.
//!
//! Connection failures are per-server and non-fatal: one broken entry in
//! `mcp.json` must not take down the whole assistant run.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};

/// Spec revision advertised during `initialize`. `2025-03-26` introduced
/// Streamable HTTP and is the version most remote servers speak.
const PROTOCOL_VERSION: &str = "2025-03-26";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const CALL_TIMEOUT: Duration = Duration::from_secs(30);
/// Safety caps so a pathological `mcp.json` cannot stall the run loop.
const MAX_SERVERS: usize = 8;
const MAX_TOOLS_PER_SERVER: usize = 32;
/// OpenAI-compatible providers reject function names outside this length.
const MAX_EXPOSED_NAME_LEN: usize = 64;

/// One remote MCP server entry from `.agents/mcp.json`.
#[derive(Debug, Clone)]
pub struct McpServerConfig {
    pub id: String,
    pub url: String,
    pub headers: BTreeMap<String, String>,
}

/// A discovered tool bound to the server it lives on.
#[derive(Debug, Clone)]
struct McpToolEntry {
    exposed_name: String,
    server_index: usize,
    /// The tool's real name on the server, passed to `tools/call` as-is.
    remote_name: String,
    description: String,
    input_schema: Value,
}

/// Connected servers + their discovered tools for one run.
#[derive(Default)]
pub struct McpRuntime {
    clients: Vec<(McpServerConfig, McpClient)>,
    tools: Vec<McpToolEntry>,
    /// `(server id, reason)` for entries that failed to connect or enumerate.
    failures: Vec<(String, String)>,
}

impl McpRuntime {
    /// Read `.agents/mcp.json` from the notebook and connect to every usable
    /// remote server concurrently. Never fails: unreachable servers land in
    /// [`Self::failure_summary`] so the UI can surface them as a notice.
    pub async fn connect_notebook_servers(notebook_path: &Path) -> Self {
        let mut runtime = Self::default();
        let servers = read_notebook_servers(notebook_path);
        if servers.is_empty() {
            return runtime;
        }
        let attempts = servers.into_iter().map(|server| async move {
            let result = connect_and_list(&server).await;
            (server, result)
        });
        for (server, result) in futures::future::join_all(attempts).await {
            match result {
                Ok(tools) => runtime.register(server, tools),
                Err(error) => runtime.failures.push((server.id.clone(), error)),
            }
        }
        runtime
    }

    fn register(&mut self, server: McpServerConfig, tools: Vec<DiscoveredTool>) {
        let server_index = self.clients.len();
        self.clients.push((server.clone(), McpClient::new(&server)));
        for tool in tools.into_iter().take(MAX_TOOLS_PER_SERVER) {
            let exposed_name = exposed_tool_name(&server.id, &tool.name, &mut self.tools);
            self.tools.push(McpToolEntry {
                exposed_name,
                server_index,
                remote_name: tool.name,
                description: tool.description,
                input_schema: tool.input_schema,
            });
        }
    }

    /// True when at least one tool was discovered.
    pub fn has_tools(&self) -> bool {
        !self.tools.is_empty()
    }

    /// True when at least one configured server failed to come up.
    pub fn has_failures(&self) -> bool {
        !self.failures.is_empty()
    }

    /// Human-readable load summary for the run notice: `exa（3 个工具）、…`.
    pub fn summary(&self) -> String {
        self.clients
            .iter()
            .enumerate()
            .map(|(index, (server, _))| {
                let count = self
                    .tools
                    .iter()
                    .filter(|tool| tool.server_index == index)
                    .count();
                format!("{}（{} 个工具）", server.id, count)
            })
            .collect::<Vec<_>>()
            .join("、")
    }

    /// Failure lines for the run notice: `id：原因；…`.
    pub fn failure_summary(&self) -> String {
        self.failures
            .iter()
            .map(|(id, error)| format!("{id}：{error}"))
            .collect::<Vec<_>>()
            .join("；")
    }

    /// OpenAI function-tool definitions for the discovered tools.
    pub fn tool_definitions(&self) -> Vec<Value> {
        self.tools
            .iter()
            .map(|entry| {
                let server = &self.clients[entry.server_index].0;
                json!({
                    "type": "function",
                    "function": {
                        "name": entry.exposed_name,
                        "description": mcp_tool_description(server, &entry.description),
                        "parameters": entry.input_schema,
                    },
                })
            })
            .collect()
    }

    /// Execute one tool call. The result JSON mirrors the built-in tool
    /// convention: `{ok, content}` on success, `{ok: false, error}` otherwise.
    /// MCP-level tool errors (`isError: true`) still count as `ok: true` for
    /// transport purposes — the text is the model's to interpret — but are
    /// flagged so the model can tell them apart.
    pub async fn call(&self, exposed_name: &str, arguments: Value) -> Value {
        let Some(entry) = self
            .tools
            .iter()
            .find(|tool| tool.exposed_name == exposed_name)
        else {
            return json!({ "ok": false, "error": format!("未知的 MCP 工具: {exposed_name}") });
        };
        let server = &self.clients[entry.server_index].0;
        match self.clients[entry.server_index]
            .1
            .call_tool(&entry.remote_name, arguments)
            .await
        {
            Ok(result) => json!({ "ok": !result.is_error, "content": result.text }),
            Err(error) => json!({ "ok": false, "error": error }),
        }
    }
}

/// Tool metadata returned by `tools/list`.
struct DiscoveredTool {
    name: String,
    description: String,
    input_schema: Value,
}

fn mcp_tool_description(server: &McpServerConfig, description: &str) -> String {
    let base = if description.trim().is_empty() {
        "MCP 工具（无描述）".to_owned()
    } else {
        description.trim().to_owned()
    };
    format!("{base}（来自笔记本 MCP 服务 {}）", server.id)
}

/// Read the remote-server entries from `<notebook>/.agents/mcp.json`.
/// `stdio` entries are skipped: they need a process runtime the mobile side
/// does not have. Malformed files degrade to "no servers", never an error.
pub fn read_notebook_servers(notebook_path: &Path) -> Vec<McpServerConfig> {
    let path = notebook_path.join(".agents").join("mcp.json");
    let Ok(content) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<Value>(&content) else {
        tracing::warn!(path = %path.display(), "invalid .agents/mcp.json: not valid JSON");
        return Vec::new();
    };
    let Some(servers) = value.get("mcpServers").and_then(Value::as_object) else {
        tracing::warn!(path = %path.display(), "invalid .agents/mcp.json: missing mcpServers object");
        return Vec::new();
    };
    servers
        .iter()
        .filter(|(id, definition)| {
            if definition.get("enabled").is_some_and(|enabled| enabled == &json!(false)) {
                tracing::debug!(server = %id, "MCP server disabled in mcp.json");
                return false;
            }
            let remote = definition.get("url").is_some_and(Value::is_string)
                && definition
                    .get("transport")
                    .and_then(Value::as_str)
                    .map_or(true, |transport| transport != "stdio");
            if !remote {
                tracing::debug!(server = %id, "skipping non-remote MCP server in mcp.json");
            }
            remote
        })
        .take(MAX_SERVERS)
        .filter_map(|(id, definition)| {
            let url = definition
                .get("url")
                .and_then(Value::as_str)?
                .trim()
                .to_owned();
            if url.is_empty() {
                return None;
            }
            let headers = definition
                .get("headers")
                .and_then(Value::as_object)
                .map(|headers| {
                    headers
                        .iter()
                        .filter_map(|(key, value)| {
                            value.as_str().map(|value| (key.clone(), value.to_owned()))
                        })
                        .collect::<BTreeMap<_, _>>()
                })
                .unwrap_or_default();
            Some(McpServerConfig {
                id: id.clone(),
                url,
                headers,
            })
        })
        .collect()
}

async fn connect_and_list(server: &McpServerConfig) -> Result<Vec<DiscoveredTool>, String> {
    let client = McpClient::new(server);
    client.initialize().await?;
    client.list_tools().await
}

/// Provider-safe tool name: `mcp__<server>__<tool>`, sanitized to
/// `[A-Za-z0-9_-]` and capped at 64 chars (OpenAI function-name rules).
/// Collisions after sanitization get a numeric suffix. `existing` holds the
/// already-taken exposed names.
fn exposed_tool_name(server_id: &str, tool_name: &str, existing: &[McpToolEntry]) -> String {
    let sanitize = |value: &str| {
        let mut out = String::with_capacity(value.len());
        for character in value.chars() {
            out.push(if character.is_ascii_alphanumeric()
                || character == '_'
                || character == '-'
            {
                character
            } else {
                '_'
            });
        }
        if out.is_empty() {
            "tool".to_owned()
        } else {
            out
        }
    };
    let base = truncate_chars(
        &format!("mcp__{}__{}", sanitize(server_id), sanitize(tool_name)),
        MAX_EXPOSED_NAME_LEN,
    );
    let mut candidate = base.clone();
    let mut suffix = 2;
    while existing.iter().any(|entry| entry.exposed_name == candidate) {
        let stem = truncate_chars(&base, MAX_EXPOSED_NAME_LEN - 4);
        candidate = format!("{stem}_{suffix}");
        suffix += 1;
    }
    candidate
}

fn truncate_chars(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

/// Text payload of a `tools/call` result.
struct ToolCallResult {
    text: String,
    is_error: bool,
}

/// One Streamable-HTTP MCP session: `initialize` handshake, then
/// `tools/list` / `tools/call` POSTs carrying the `Mcp-Session-Id` header.
/// Interior mutability because the runtime shares one client per server
/// across the whole tool loop.
struct McpClient {
    server: McpServerConfig,
    http: reqwest::Client,
    session_id: Mutex<Option<String>>,
    next_id: AtomicU64,
}

impl McpClient {
    fn new(server: &McpServerConfig) -> Self {
        let http = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(CALL_TIMEOUT)
            .build()
            .unwrap_or_default();
        Self {
            server: server.clone(),
            http,
            session_id: Mutex::new(None),
            next_id: AtomicU64::new(0),
        }
    }

    fn take_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed) + 1
    }

    fn auth_headers(&self) -> reqwest::header::HeaderMap {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            "Accept",
            "application/json, text/event-stream"
                .parse()
                .expect("static accept header"),
        );
        headers.insert(
            "MCP-Protocol-Version",
            reqwest::header::HeaderValue::from_static(PROTOCOL_VERSION),
        );
        for (key, value) in &self.server.headers {
            if let (Ok(key), Ok(value)) = (
                reqwest::header::HeaderName::from_bytes(key.as_bytes()),
                reqwest::header::HeaderValue::from_str(value),
            ) {
                headers.insert(key, value);
            }
        }
        if let Some(session) = self.session_id.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone() {
            if let Ok(value) = reqwest::header::HeaderValue::from_str(&session) {
                headers.insert("Mcp-Session-Id", value);
            }
        }
        headers
    }

    /// POST one JSON-RPC message. Returns `None` for empty (202) responses,
    /// which is how servers acknowledge notifications. Captures the
    /// `Mcp-Session-Id` response header into the session.
    async fn post(&self, body: Value) -> Result<Option<Value>, String> {
        let response = self
            .http
            .post(&self.server.url)
            .headers(self.auth_headers())
            .json(&body)
            .send()
            .await
            .map_err(|error| format!("MCP {} 请求失败: {error}", self.server.id))?;
        if let Some(session) = response
            .headers()
            .get("Mcp-Session-Id")
            .and_then(|value| value.to_str().ok())
        {
            *self
                .session_id
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(session.to_owned());
        }
        let status = response.status();
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let body = response.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(format!(
                "MCP {} 返回 HTTP {}: {}",
                self.server.id,
                status.as_u16(),
                truncate_chars(body.trim(), 200)
            ));
        }
        if body.trim().is_empty() {
            return Ok(None);
        }
        if content_type.contains("text/event-stream") {
            return parse_sse_response(&body, &self.server.id);
        }
        let value: Value = serde_json::from_str(&body)
            .map_err(|error| format!("MCP {} 响应不是 JSON: {error}", self.server.id))?;
        Ok(Some(value))
    }

    /// `initialize` + `notifications/initialized`. A server answering with a
    /// different protocol version than requested is allowed by spec; the
    /// handshake counts as long as it accepted ours.
    async fn initialize(&self) -> Result<(), String> {
        let id = self.take_id();
        let response = self
            .post(json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": "initialize",
                "params": {
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": {
                        "name": format!("{}-agent", super::AGENT_ID),
                        "version": env!("CARGO_PKG_VERSION"),
                    },
                },
            }))
            .await?
            .ok_or_else(|| format!("MCP {} initialize 未返回结果", self.server.id))?;
        if let Some(error) = response.get("error") {
            return Err(format!(
                "MCP {} initialize 被拒绝: {}",
                self.server.id,
                error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("未知错误")
            ));
        }
        if response.get("id").and_then(Value::as_u64) != Some(id) {
            return Err(format!("MCP {} initialize 响应 id 不匹配", self.server.id));
        }
        self.post(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))
            .await?;
        Ok(())
    }

    async fn list_tools(&self) -> Result<Vec<DiscoveredTool>, String> {
        let id = self.take_id();
        let response = self
            .post(json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": "tools/list",
                "params": {},
            }))
            .await?
            .ok_or_else(|| format!("MCP {} tools/list 未返回结果", self.server.id))?;
        let result = jsonrpc_result(&response, id, &self.server.id)?;
        let mut tools = Vec::new();
        if let Some(items) = result.get("tools").and_then(Value::as_array) {
            for item in items {
                let Some(name) = item.get("name").and_then(Value::as_str) else {
                    continue;
                };
                tools.push(DiscoveredTool {
                    name: name.to_owned(),
                    description: item
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                    input_schema: item
                        .get("inputSchema")
                        .cloned()
                        .unwrap_or(json!({ "type": "object" })),
                });
            }
        }
        Ok(tools)
    }

    /// `tools/call` with a one-shot retry: a stale/expired session surfaces
    /// as an HTTP or JSON-RPC error, so on failure the client re-handshakes
    /// once and tries again before giving up.
    async fn call_tool(&self, name: &str, arguments: Value) -> Result<ToolCallResult, String> {
        match self.call_tool_once(name, arguments.clone()).await {
            Ok(result) => Ok(result),
            Err(error) => {
                tracing::warn!(server = %self.server.id, %error, "MCP tools/call failed; retrying with a fresh session");
                self.initialize().await?;
                self.call_tool_once(name, arguments).await
            }
        }
    }

    async fn call_tool_once(&self, name: &str, arguments: Value) -> Result<ToolCallResult, String> {
        let id = self.take_id();
        let response = self
            .post(json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": "tools/call",
                "params": { "name": name, "arguments": arguments },
            }))
            .await?
            .ok_or_else(|| format!("MCP {} tools/call 未返回结果", self.server.id))?;
        let result = jsonrpc_result(&response, id, &self.server.id)?;
        let mut text = String::new();
        if let Some(parts) = result.get("content").and_then(Value::as_array) {
            for part in parts {
                if part.get("type").and_then(Value::as_str) == Some("text") {
                    if !text.is_empty() {
                        text.push('\n');
                    }
                    text.push_str(part.get("text").and_then(Value::as_str).unwrap_or_default());
                }
            }
        }
        if text.is_empty() {
            text = "（工具无文本输出）".to_owned();
        }
        Ok(ToolCallResult {
            text,
            is_error: result
                .get("isError")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        })
    }
}

fn jsonrpc_result<'a>(
    response: &'a Value,
    expected_id: u64,
    server_id: &str,
) -> Result<&'a Value, String> {
    if let Some(error) = response.get("error") {
        return Err(format!(
            "MCP {server_id} 请求被拒绝: {}",
            error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("未知错误")
        ));
    }
    if response.get("id").and_then(Value::as_u64) != Some(expected_id) {
        return Err(format!("MCP {server_id} 响应 id 不匹配"));
    }
    response
        .get("result")
        .ok_or_else(|| format!("MCP {server_id} 响应缺少 result"))
}

/// Extract the JSON-RPC response for our request out of an SSE body: scan
/// `data:` lines and take the first event carrying a numeric `id`. Events
/// without one are notifications or server-initiated requests, which this
/// client does not answer.
fn parse_sse_response(body: &str, server_id: &str) -> Result<Option<Value>, String> {
    for line in body.lines() {
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        if data.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(data) else {
            continue;
        };
        if value.get("id").and_then(Value::as_u64).is_some() {
            return Ok(Some(value));
        }
    }
    Err(format!(
        "MCP {server_id} SSE 响应中没有匹配的 JSON-RPC 结果"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_mcp_json(dir: &Path, content: &str) {
        let agents = dir.join(".agents");
        std::fs::create_dir_all(&agents).unwrap();
        std::fs::write(agents.join("mcp.json"), content).unwrap();
    }

    #[test]
    fn reads_remote_entries_and_skips_others() {
        let dir = tempfile::tempdir().unwrap();
        write_mcp_json(
            dir.path(),
            r#"{
                "mcpServers": {
                    "exa": { "url": "https://mcp.exa.ai/mcp", "headers": { "x-api-key": "k1" }, "transport": "streamable-http" },
                    "local": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem"], "transport": "stdio" },
                    "off": { "url": "https://example.com/mcp", "enabled": false },
                    "empty-url": { "url": "" }
                }
            }"#,
        );
        let servers = read_notebook_servers(dir.path());
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].id, "exa");
        assert_eq!(servers[0].url, "https://mcp.exa.ai/mcp");
        assert_eq!(
            servers[0].headers.get("x-api-key").map(String::as_str),
            Some("k1")
        );
    }

    #[test]
    fn missing_or_invalid_file_yields_no_servers() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_notebook_servers(dir.path()).is_empty());
        write_mcp_json(dir.path(), "not json");
        assert!(read_notebook_servers(dir.path()).is_empty());
        write_mcp_json(dir.path(), r#"{}"#);
        assert!(read_notebook_servers(dir.path()).is_empty());
    }

    #[test]
    fn exposed_names_are_sanitized_and_unique() {
        let existing: Vec<McpToolEntry> = Vec::new();
        let name = exposed_tool_name("exa", "web_search", &existing);
        assert_eq!(name, "mcp__exa__web_search");
        // Dots and slashes from arbitrary MCP tool names become underscores.
        let taken = vec![McpToolEntry {
            exposed_name: "mcp__exa__web_search".to_owned(),
            server_index: 0,
            remote_name: String::new(),
            description: String::new(),
            input_schema: Value::Null,
        }];
        assert_eq!(
            exposed_tool_name("exa", "web_search", &taken),
            "mcp__exa__web_search_2"
        );
        assert_eq!(
            exposed_tool_name("exa", "crawling/v1.crawl", &existing),
            "mcp__exa__crawling_v1_crawl"
        );
    }

    #[test]
    fn parses_sse_data_lines() {
        let body = "event: message\n\
                    data: {\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{}}\n\n\
                    data: {\"jsonrpc\":\"2.0\",\"method\":\"ping\"}\n";
        let response = parse_sse_response(body, "exa").unwrap().unwrap();
        assert_eq!(response.get("id").and_then(Value::as_u64), Some(7));
        assert!(parse_sse_response("data: not json\n", "exa").is_err());
    }
}
