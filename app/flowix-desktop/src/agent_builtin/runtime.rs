//! Agent loop for the built-in assistant.
//!
//! One detached tokio task per run: build provider messages from the
//! persisted thread history, stream the completion, execute tool calls
//! against the shared `MemoFile`, and persist every turn into `thread.db`
//! so the conversation UI (history, titles, per-notebook lists) works
//! unchanged. Progress reaches the frontend through `agent-chunk` events
//! carrying the shared [`AgentChunk`] wire shape.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::AppHandle;

use crate::agent_session::types::ChatMessage;
use crate::agent_session::ThreadManager;
use crate::agent_types::AgentId;
use crate::agent_wire::{AgentChunk, AgentUserMessage};
use crate::events::emit_to;
use crate::lock_utils::read_lock;
use flowix_core::memo_file::MemoFile;

use super::config::BuiltinAiConfig;
use super::provider::{self, ProviderMessage, ProviderError, StreamEvent};
use super::tools::{self, ToolScope};

/// Tool-call round trips allowed per run before the loop gives up.
const MAX_TOOL_CYCLES: usize = 8;
/// History messages fed to the model, newest first.
const HISTORY_MESSAGE_LIMIT: i64 = 60;
/// Provider-message cap (system + history + current turn + tool rounds).
const MAX_PROVIDER_MESSAGES: usize = 160;

/// Per-run cancellation + lifecycle registry.
#[derive(Default)]
struct RunRegistry {
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

pub struct BuiltinAiService {
    runs: RunRegistry,
    user_config_dir: std::path::PathBuf,
    memo_file: Arc<std::sync::RwLock<MemoFile>>,
    thread_manager: Arc<ThreadManager>,
}

impl BuiltinAiService {
    pub fn new(
        user_config_dir: std::path::PathBuf,
        memo_file: Arc<std::sync::RwLock<MemoFile>>,
        thread_manager: Arc<ThreadManager>,
    ) -> Self {
        Self {
            runs: RunRegistry::default(),
            user_config_dir,
            memo_file,
            thread_manager,
        }
    }

    pub fn load_config(&self) -> BuiltinAiConfig {
        BuiltinAiConfig::load(&self.user_config_dir)
    }

    pub fn save_config(&self, config: &BuiltinAiConfig) -> Result<(), String> {
        config
            .save(&self.user_config_dir)
            .map_err(|error| error.to_string())
    }

    /// True when a run is active for the thread.
    pub fn is_running(&self, thread_id: &str) -> bool {
        self.runs
            .cancels
            .lock()
            .map(|runs| runs.contains_key(thread_id))
            .unwrap_or(false)
    }

    /// Signal cancellation. Returns true when a run was actually cancelled.
    pub fn stop(&self, thread_id: &str) -> bool {
        let token = {
            let mut runs = self
                .runs
                .cancels
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            runs.remove(thread_id)
        };
        match token {
            Some(token) => {
                token.store(true, Ordering::Relaxed);
                true
            }
            None => false,
        }
    }

    /// Validate and launch a run. Mirrors the external-runtime chat contract:
    /// returns immediately; progress flows through `agent-chunk` events.
    pub fn chat(
        self: &Arc<Self>,
        app: AppHandle,
        thread_id: String,
        message: AgentUserMessage,
    ) -> Result<(), String> {
        let config = self.load_config();
        if !config.enabled {
            return Err("内置 AI 助手未启用：请在设置中开启并配置模型".into());
        }
        if !config.is_configured() {
            return Err("内置 AI 助手缺少 API 地址 / Key / 模型配置".into());
        }
        if !message.image_paths.is_empty() {
            return Err("内置 AI 助手暂不支持图片或文件附件".into());
        }
        if self.is_running(&thread_id) {
            return Err("该会话已有正在运行的回复".into());
        }

        let scope = self
            .resolve_scope(&message)
            .ok_or_else(|| "无法确定目标笔记本：请先选择一个笔记本".to_owned())?;


        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut runs = self
                .runs
                .cancels
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            runs.insert(thread_id.clone(), Arc::clone(&cancel));
        }

        let service = Arc::clone(self);
        let run_thread_id = thread_id.clone();
        let title = super::runtime::derive_title(&message.content);
        tauri::async_runtime::spawn(async move {
            // Ensure the thread row exists so history / conversation lists see
            // the run even if it fails immediately afterwards.
            let ensured = service
                .thread_manager
                .ensure_thread(
                    &run_thread_id,
                    AgentId::new(super::AGENT_ID),
                    title,
                )
                .await
                .map_err(|error| error.to_string());
            if let Err(error) = ensured {
                service.finish(&run_thread_id);
                let _ = emit_to(
                    &app,
                    "agent-chunk",
                    AgentChunk::Error { thread_id: run_thread_id, message: error, error_details: None },
                );
                return;
            }
            service.run(app, run_thread_id, message, config, scope, cancel).await;
        });
        Ok(())
    }

    fn resolve_scope(&self, message: &AgentUserMessage) -> Option<ToolScope> {
        let guard = read_lock(&self.memo_file, "memo_file");
        // Scope priority: explicit conversation notebook > selected notebook
        // > default notebook > first registered notebook.
        let configs = guard.read_notebook_configs().unwrap_or_default();
        let explicit = message
            .runtime_config
            .as_ref()
            .and_then(|config| config.notebook_id.as_deref())
            .filter(|id| !id.trim().is_empty())
            .and_then(|id| configs.iter().find(|config| config.id == id));
        let selected = guard
            .read_selected_notebook_id()
            .ok()
            .flatten()
            .and_then(|id| configs.iter().find(|config| config.id == id));
        let notebook = explicit
            .or(selected)
            .or_else(|| configs.iter().find(|config| config.is_default))
            .or_else(|| configs.first())?;
        Some(ToolScope {
            notebook_id: notebook.id.clone(),
            notebook_name: notebook.name.clone(),
        })
    }

    fn finish(&self, thread_id: &str) {
        self.runs
            .cancels
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(thread_id);
    }

    fn cancelled(&self, thread_id: &str) -> bool {
        self.runs
            .cancels
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(thread_id)
            .is_some_and(|token| token.load(Ordering::Relaxed))
    }

    async fn run(
        self: Arc<Self>,
        app: AppHandle,
        thread_id: String,
        message: AgentUserMessage,
        config: BuiltinAiConfig,
        scope: ToolScope,
        cancel: Arc<AtomicBool>,
    ) {
        let started = std::time::Instant::now();
        let _ = emit_to(&app, "agent-chunk", AgentChunk::StreamStart {
            thread_id: thread_id.clone(),
            model: Some(config.model.clone()),
            reasoning_effort: None,
        });

        let result = self
            .run_inner(&app, &thread_id, &message, &config, &scope, &cancel)
            .await;

        let reason = match &result {
            Ok(()) => None,
            Err(RunError::Cancelled) => Some("stopped".to_owned()),
            Err(RunError::Failed(error)) => {
                let _ = emit_to(&app, "agent-chunk", AgentChunk::Error {
                    thread_id: thread_id.clone(),
                    message: error.clone(),
                    error_details: None,
                });
                Some("error".to_owned())
            }
        };
        let _ = emit_to(&app, "agent-chunk", AgentChunk::StreamEnd {
            thread_id: thread_id.clone(),
            reason,
            duration_ms: Some(started.elapsed().as_millis() as u64),
        });
        self.finish(&thread_id);
    }

    async fn run_inner(
        self: &Arc<Self>,
        app: &AppHandle,
        thread_id: &str,
        message: &AgentUserMessage,
        config: &BuiltinAiConfig,
        scope: &ToolScope,
        cancel: &Arc<AtomicBool>,
    ) -> Result<(), RunError> {
        // 1. Persist + emit the user turn. Composer note references arrive as
        //    `flowix://open?...relativePath=...` markdown links; humanize them
        //    into llm_content so the model sees readable paths (display keeps
        //    the original).
        let llm_content = humanize_note_references(&message.content);
        let user_message = ChatMessage {
            id: new_message_id("user"),
            role: "user".into(),
            message_type: None,
            content: message.content.clone(),
            llm_content: Some(llm_content),
            attachments: None,
            system_reminder_directory: None,
            timestamp: now_rfc3339(),
            source_sequence: None,
            is_loading: None,
            tool_call_id: None,
            tool_name: None,
            tool_data: None,
            tool_input: None,
            tool_call: None,
            tool_result: None,
            tool_calls: None,
            reasoning: None,
            is_completed: Some(true),
            error_details: None,
            is_collapsed: None,
            codex_turn_id: None,
            turn_duration_ms: None,
        };
        self.thread_manager
            .add_message(thread_id, user_message.clone())
            .await
            .map_err(|error| RunError::Failed(error.to_string()))?;
        let _ = emit_to(app, "agent-chunk", AgentChunk::UserMessage {
            thread_id: thread_id.to_owned(),
            id: user_message.id.clone(),
            text: message.content.clone(),
            timestamp: now_millis(),
            attachments: Vec::new(),
        });

        // 2. Assemble provider messages: system + history (already contains
        //    the just-persisted user turn; its llm_content carries the
        //    humanized references).
        let mut provider_messages =
            Vec::with_capacity(HISTORY_MESSAGE_LIMIT as usize + 8);
        provider_messages.push(ProviderMessage::system(system_prompt(scope)));
        for record in self.load_history(thread_id).await? {
            if let Some(converted) = history_to_provider(&record) {
                provider_messages.push(converted);
                if provider_messages.len() >= MAX_PROVIDER_MESSAGES {
                    break;
                }
            }
        }

        // 3. Tool loop.
        for _cycle in 0..MAX_TOOL_CYCLES {
            if cancel.load(Ordering::Relaxed) {
                return Err(RunError::Cancelled);
            }

            let completion = provider::stream_chat(
                &config.chat_endpoint(),
                &config.api_key,
                &config.model,
                &provider_messages,
                &tools::tool_definitions(),
                config.max_total_tokens,
                Arc::clone(cancel),
                |event| match event {
                    StreamEvent::Text(text) => {
                        let _ = emit_to(app, "agent-chunk", AgentChunk::Text {
                            thread_id: thread_id.to_owned(),
                            text,
                        });
                    }
                    StreamEvent::Reasoning(text) => {
                        let _ = emit_to(app, "agent-chunk", AgentChunk::Reasoning {
                            thread_id: thread_id.to_owned(),
                            text,
                        });
                    }
                },
            )
            .await
            .map_err(map_provider_error)?;

            if completion.tool_calls.is_empty() {
                // Final answer for this turn.
                if completion.text.is_empty() {
                    return Err(RunError::Failed(
                        "模型返回了空回复（未产生文本或工具调用）".into(),
                    ));
                }
                self.persist_assistant(thread_id, &completion.text, None).await?;
                return Ok(());
            }

            // Assistant turn that requests tools.
            let calls_json = serde_json::to_value(completion.tool_calls.iter().map(|call| {
                serde_json::json!({
                    "id": call.id,
                    "type": "function",
                    "function": { "name": call.name, "arguments": call.arguments },
                })
            }).collect::<Vec<_>>())
            .ok();
            self.persist_assistant(thread_id, &completion.text, calls_json)
                .await?;
            provider_messages.push(ProviderMessage {
                role: "assistant".into(),
                content: completion.text.clone(),
                tool_calls: Some(serde_json::to_value(completion.tool_calls.iter().map(|call| {
                    serde_json::json!({
                        "id": call.id,
                        "type": "function",
                        "function": { "name": call.name, "arguments": call.arguments },
                    })
                }).collect::<Vec<_>>()).unwrap_or_default()),
                tool_call_id: None,
            });

            for call in &completion.tool_calls {
                if cancel.load(Ordering::Relaxed) {
                    return Err(RunError::Cancelled);
                }
                let call_id = new_message_id("tool");
                let _ = emit_to(app, "agent-chunk", AgentChunk::ToolCall {
                    thread_id: thread_id.to_owned(),
                    id: call_id.clone(),
                    name: call.name.clone(),
                    input: serde_json::from_str(&call.arguments)
                        .unwrap_or(serde_json::json!({ "raw": call.arguments })),
                });

                let memo_file = Arc::clone(&self.memo_file);
                let scope = scope.clone();
                let name = call.name.clone();
                let arguments = call.arguments.clone();
                // Blocking file/sqlite work stays off the async reactor.
                let result = tauri::async_runtime::spawn_blocking(move || {
                    tools::execute(&memo_file, &scope, &name, &arguments)
                })
                .await
                .unwrap_or_else(|error| {
                    serde_json::json!({ "ok": false, "error": format!("工具执行任务失败: {error}") })
                });

                let _ = emit_to(app, "agent-chunk", AgentChunk::ToolResult {
                    thread_id: thread_id.to_owned(),
                    id: call_id.clone(),
                    name: call.name.clone(),
                    result: result.clone(),
                });

                let result_text = serde_json::to_string(&result)
                    .unwrap_or_else(|_| result.to_string());
                self.thread_manager
                    .add_message(
                        thread_id,
                        tool_message(&call_id, &call.id, &call.name, &result_text),
                    )
                    .await
                    .map_err(|error| RunError::Failed(error.to_string()))?;
                provider_messages.push(ProviderMessage::tool(&call.id, result_text));
                if provider_messages.len() >= MAX_PROVIDER_MESSAGES {
                    return Err(RunError::Failed(
                        "对话上下文超出上限，请开新会话继续".into(),
                    ));
                }
            }
        }

        Err(RunError::Failed(format!(
            "工具调用超过 {MAX_TOOL_CYCLES} 轮仍未给出最终回复，已停止"
        )))
    }

    async fn load_history(
        &self,
        thread_id: &str,
    ) -> Result<Vec<ChatMessage>, RunError> {
        let page = self
            .thread_manager
            .get_thread_messages_page(thread_id, None, HISTORY_MESSAGE_LIMIT)
            .await
            .map_err(|error| RunError::Failed(error.to_string()))?;
        Ok(page.messages)
    }

    async fn persist_assistant(
        &self,
        thread_id: &str,
        text: &str,
        tool_calls: Option<serde_json::Value>,
    ) -> Result<(), RunError> {
        let message = ChatMessage {
            id: new_message_id("assistant"),
            role: "assistant".into(),
            message_type: None,
            content: text.to_owned(),
            attachments: None,
            llm_content: None,
            system_reminder_directory: None,
            timestamp: now_rfc3339(),
            source_sequence: None,
            is_loading: None,
            tool_call_id: None,
            tool_name: None,
            tool_data: None,
            tool_input: None,
            tool_call: None,
            tool_result: None,
            tool_calls,
            reasoning: None,
            is_completed: Some(true),
            error_details: None,
            is_collapsed: None,
            codex_turn_id: None,
            turn_duration_ms: None,
        };
        self.thread_manager
            .add_message(thread_id, message)
            .await
            .map_err(|error| RunError::Failed(error.to_string()))
    }
}

enum RunError {
    Cancelled,
    Failed(String),
}

fn map_provider_error(error: ProviderError) -> RunError {
    match error {
        ProviderError::Cancelled => RunError::Cancelled,
        other => RunError::Failed(other.to_string()),
    }
}

/// Map one persisted row into a provider message; returns `None` for rows
/// that carry no conversational content (loading placeholders, empty
/// assistant tool-turn carriers are kept only when they carry tool_calls).
fn history_to_provider(record: &ChatMessage) -> Option<ProviderMessage> {
    match record.role.as_str() {
        "user" => Some(ProviderMessage::user(
            record.llm_content.clone().unwrap_or_else(|| record.content.clone()),
        )),
        "assistant" => {
            if let Some(calls) = &record.tool_calls {
                return Some(ProviderMessage {
                    role: "assistant".into(),
                    content: record.content.clone(),
                    tool_calls: Some(calls.clone()),
                    tool_call_id: None,
                });
            }
            (!record.content.is_empty())
                .then(|| ProviderMessage {
                    role: "assistant".into(),
                    content: record.content.clone(),
                    tool_calls: None,
                    tool_call_id: None,
                })
        }
        "tool" => record.tool_call_id.as_ref().map(|id| {
            ProviderMessage::tool(id, record.content.clone())
        }),
        _ => None,
    }
}

fn tool_message(message_id: &str, provider_call_id: &str, name: &str, result_text: &str) -> ChatMessage {
    ChatMessage {
        id: message_id.to_owned(),
        role: "tool".into(),
        message_type: None,
        content: result_text.to_owned(),
        attachments: None,
        llm_content: None,
        system_reminder_directory: None,
        timestamp: now_rfc3339(),
        source_sequence: None,
        is_loading: None,
        // Provider call id, not the local message id: history replay feeds it
        // back as the `tool` role's tool_call_id.
        tool_call_id: Some(provider_call_id.to_owned()),
        tool_name: Some(name.to_owned()),
        tool_data: Some(result_text.to_owned()),
        tool_input: None,
        tool_call: None,
        tool_result: None,
        tool_calls: None,
        reasoning: None,
        is_completed: Some(true),
        error_details: None,
        is_collapsed: None,
        codex_turn_id: None,
        turn_duration_ms: None,
    }
}

fn system_prompt(scope: &ToolScope) -> String {
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    format!(
        "你是 Flowix 内置笔记助手，运行在用户设备上的 Flowix 应用内，\
只能通过提供的笔记工具访问用户的笔记。

当前笔记本：{name}（id: {notebook_id}）。所有工具只能访问这个笔记本。
今天的日期：{today}。

工具使用规范：
- 修改任何笔记前必须先 note_read 拿到最新正文。
- 常规修改优先用 note_edit：old 片段必须在正文中恰好出现一次，不要凭记忆编写 old。
- note_write 会整篇覆盖正文，仅在重写整篇时使用。
- note_delete 是硬删除且不可恢复，只在用户明确要求删除时使用。
- 新建笔记用 note_create，把用户要求的标签（如 #项目/Flowix）写进正文。
- 用户消息中 @标题 形式的提及通常对应 relativePath 为「标题.md」的笔记。
- 用用户的语言回答；提到笔记时给出其相对路径；不要虚构笔记内容。",
        name = scope.notebook_name,
        notebook_id = scope.notebook_id,
        today = today,
    )
}

/// Rewrite composer note references into readable `@path` mentions for the
/// model. Handles both the markdown-link form
/// `[标题](flowix://open?notebookId=..&relativePath=Path.md)` and the bare
/// `flowix://open?path=/abs/Path.md` fallback. Percent-encoding is decoded so
/// 中文路径 stay readable.
fn humanize_note_references(content: &str) -> String {
    const MARKER: &str = "flowix://open?";
    if !content.contains(MARKER) {
        return content.to_owned();
    }
    let mut out = String::with_capacity(content.len());
    let mut rest = content;
    while let Some(start) = rest.find(MARKER) {
        out.push_str(&rest[..start]);
        let tail = &rest[start + MARKER.len()..];
        // The query runs until a character that cannot appear in a URL query.
        let end = tail
            .find(|c: char| c == ')' || c == '"' || c == '\'' || c.is_whitespace())
            .unwrap_or(tail.len());
        let query = &tail[..end];
        let decoded_query = url::form_urlencoded::parse(query.as_bytes())
            .map(|(key, value)| format!("{key}={value}"))
            .collect::<Vec<_>>()
            .join("&");
        let relative = decoded_query
            .split('&')
            .find_map(|pair| pair.strip_prefix("relativePath="));
        match relative {
            Some(path) if !path.is_empty() => {
                out.push('@');
                out.push_str(path);
            }
            _ => {
                // Not a relative-path reference (e.g. absolute path fallback):
                // keep the original text untouched.
                out.push_str(&rest[start..start + MARKER.len() + end]);
            }
        }
        rest = &tail[end..];
    }
    out.push_str(rest);
    out
}

pub(crate) fn derive_title(content: &str) -> String {
    let collapsed = content.split_whitespace().collect::<Vec<_>>().join(" ");
    let truncated: String = collapsed.chars().take(40).collect();
    if truncated.is_empty() {
        "新对话".to_owned()
    } else {
        truncated
    }
}

fn new_message_id(prefix: &str) -> String {
    format!("{}_{}", prefix, uuid::Uuid::new_v4())
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_rows_map_to_provider_messages() {
        let mut record = ChatMessage {
            id: "m1".into(),
            role: "user".into(),
            message_type: None,
            content: "显示内容".into(),
            attachments: None,
            llm_content: Some("llm 内容".into()),
            system_reminder_directory: None,
            timestamp: "2026-01-01".into(),
            source_sequence: None,
            is_loading: None,
            tool_call_id: None,
            tool_name: None,
            tool_data: None,
            tool_input: None,
            tool_call: None,
            tool_result: None,
            tool_calls: None,
            reasoning: None,
            is_completed: Some(true),
            error_details: None,
            is_collapsed: None,
            codex_turn_id: None,
            turn_duration_ms: None,
        };
        let user = history_to_provider(&record).unwrap();
        assert_eq!(user.role, "user");
        assert_eq!(user.content, "llm 内容");

        record.role = "assistant".into();
        record.content = String::new();
        record.llm_content = None;
        assert!(history_to_provider(&record).is_none(), "空 assistant 行不应进入 provider 消息");

        record.tool_calls = Some(serde_json::json!([{ "id": "c1" }]));
        let with_tools = history_to_provider(&record).unwrap();
        assert_eq!(with_tools.tool_calls.as_ref().unwrap()[0]["id"], "c1");

        record.role = "tool".into();
        record.tool_calls = None;
        record.tool_call_id = Some("c1".into());
        let tool = history_to_provider(&record).unwrap();
        assert_eq!(tool.tool_call_id.as_deref(), Some("c1"));
    }

    #[test]
    fn titles_collapse_whitespace_and_truncate() {
        assert_eq!(derive_title("  hello   world  "), "hello world");
        assert_eq!(derive_title("").len() > 0, true);
        let long = derive_title(&"字".repeat(100));
        assert_eq!(long.chars().count(), 40);
    }

    #[test]
    fn humanizes_note_reference_links() {
        let input = "先看 [会议记录](flowix://open?notebookId=work&relativePath=%E4%BC%9A%E8%AE%AE.md) 再总结";
        let out = humanize_note_references(input);
        assert!(out.contains("@会议.md"), "{out}");
        assert!(out.starts_with("先看 ") && out.ends_with(" 再总结"), "{out}");
    }

    #[test]
    fn keeps_non_relative_open_links_untouched() {
        let input = "[外部](flowix://open?path=%2Fabs%2Fx.md) 保留";
        assert_eq!(humanize_note_references(input), input);
    }

    #[test]
    fn plain_content_passes_through() {
        assert_eq!(humanize_note_references("普通文本 @笔记.md"), "普通文本 @笔记.md");
    }
}
