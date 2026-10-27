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

use sha2::{Digest, Sha256};

use crate::agent_session::types::ChatMessage;
use crate::agent_session::ThreadManager;
use crate::agent_types::AgentId;
use crate::agent_wire::{AgentChunk, AgentUserMessage};
use crate::events::emit_to;
use crate::lock_utils::read_lock;
use flowix_core::memo_file::MemoFile;

use super::config::{BuiltinAiConfig, BuiltinAiProvider};
use super::provider::{self, ProviderMessage, ProviderError, StreamEvent};
use super::tools::{self, ToolScope};

/// Tool-call round trips allowed per run before the loop gives up.
const MAX_TOOL_CYCLES: usize = 20;
/// History messages fed to the model, newest first.
const HISTORY_MESSAGE_LIMIT: i64 = 60;
/// Provider-message cap (system + history + current turn + tool rounds).
const MAX_PROVIDER_MESSAGES: usize = 160;
/// Skill-catalog budget in the system prompt (name + description + path per
/// entry); a notebook with many skills must not crowd out the conversation.
const MAX_SKILL_CATALOG_CHARS: usize = 4_000;
/// Per-skill description cap in the catalog. Saves are capped too; this
/// covers hand-edited SKILL.md frontmatter.
const MAX_SKILL_DESCRIPTION_CHARS: usize = 500;

/// Per-run cancellation + lifecycle registry.
#[derive(Default)]
struct RunRegistry {
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

/// Emit one `agent-chunk` with the metadata every chunk must carry:
/// `run_id` + `agent_type`. The frontend event mapper rejects chunks without
/// `run_id` (`Agent chunk is missing run_id`), so every emit must go through
/// this helper — a bare `emit_to` silently drops the chunk and leaves the
/// conversation stuck in "running".
fn emit_builtin_chunk(app: &AppHandle, chunk: AgentChunk, run_id: &str) {
    let mut payload = serde_json::to_value(&chunk).unwrap_or(serde_json::Value::Null);
    if let serde_json::Value::Object(object) = &mut payload {
        object.insert(
            "run_id".to_owned(),
            serde_json::Value::String(run_id.to_owned()),
        );
        object.insert(
            "agent_type".to_owned(),
            serde_json::Value::String(super::AGENT_ID.to_owned()),
        );
    }
    let _ = emit_to(app, "agent-chunk", payload);
}

/// Frontend passes the run id it used for the optimistic user row; reuse it so
/// the live row and the persisted row share one identity. Fall back to a
/// generated id for direct/harness callers.
fn resolve_run_id(thread_id: &str, provided: Option<&str>) -> String {
    provided
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("run-{thread_id}-{}", uuid::Uuid::new_v4()))
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
        // Provider is per conversation; fall back to the global active
        // provider when the bound one was removed.
        let provider = message
            .builtin_provider_id
            .as_deref()
            .and_then(|id| config.providers.iter().find(|provider| provider.id == id))
            .cloned()
            .or_else(|| config.active_provider().cloned())
            .ok_or_else(|| "内置 AI 助手尚未配置任何厂商".to_owned())?;
        if !provider.is_configured() {
            return Err("当前 AI 厂商缺少 API 地址 / Key / 模型配置".into());
        }
        if self.is_running(&thread_id) {
            return Err("该会话已有正在运行的回复".into());
        }

        let scope = self
            .resolve_scope(&app, &message)
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
        let run_id = resolve_run_id(&thread_id, message.run_id.as_deref());
        let run_id_for_error = run_id.clone();
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
                emit_builtin_chunk(
                    &app,
                    AgentChunk::Error {
                        thread_id: run_thread_id,
                        message: error,
                        error_details: None,
                    },
                    &run_id_for_error,
                );
                return;
            }
            service
                .run(app, run_thread_id, message, config, provider, scope, cancel, run_id)
                .await;
        });
        Ok(())
    }

    fn resolve_scope(&self, app: &AppHandle, message: &AgentUserMessage) -> Option<ToolScope> {
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
            notebook_path: std::path::PathBuf::from(&notebook.path),
            config_dir: self.user_config_dir.clone(),
            mark_self_write: super::tools::self_write_marker(app.clone()),
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
        provider: BuiltinAiProvider,
        scope: ToolScope,
        cancel: Arc<AtomicBool>,
        run_id: String,
    ) {
        let started = std::time::Instant::now();
        emit_builtin_chunk(
            &app,
            AgentChunk::StreamStart {
                thread_id: thread_id.clone(),
                model: Some(provider.model.clone()),
                reasoning_effort: None,
            },
            &run_id,
        );

        let result = self
            .run_inner(
                &app,
                &thread_id,
                &run_id,
                &message,
                &config,
                &provider,
                &scope,
                &cancel,
            )
            .await;

        let reason = match &result {
            Ok(()) => None,
            Err(RunError::Cancelled) => Some("stopped".to_owned()),
            Err(RunError::Failed(error)) => {
                emit_builtin_chunk(
                    &app,
                    AgentChunk::Error {
                        thread_id: thread_id.clone(),
                        message: error.clone(),
                        error_details: None,
                    },
                    &run_id,
                );
                Some("error".to_owned())
            }
        };
        emit_builtin_chunk(
            &app,
            AgentChunk::StreamEnd {
                thread_id: thread_id.clone(),
                reason,
                duration_ms: Some(started.elapsed().as_millis() as u64),
            },
            &run_id,
        );
        self.finish(&thread_id);
    }

    async fn run_inner(
        self: &Arc<Self>,
        app: &AppHandle,
        thread_id: &str,
        run_id: &str,
        message: &AgentUserMessage,
        config: &BuiltinAiConfig,
        provider: &BuiltinAiProvider,
        scope: &ToolScope,
        cancel: &Arc<AtomicBool>,
    ) -> Result<(), RunError> {
        // 1. Persist + emit the user turn. Composer note references arrive as
        //    `flowix://open?...relativePath=...` markdown links; humanize them
        //    into llm_content so the model sees readable paths (display keeps
        //    the original). The id matches the frontend's optimistic row
        //    (`completedRunUserMessageId` = `user-<runId>`) so the live row is
        //    adopted in place instead of duplicated.
        let user_message_id = format!("user-{run_id}");
        // Keep the frontend-built LLM content (first-message context block:
        // current note excerpt + task tag) and only humanize note references
        // inside it. The display content stays untouched.
        let llm_content = humanize_note_references(
            message.llm_content.as_deref().unwrap_or(&message.content),
        );
        // Resolve attachments before persisting anything so a bad attachment
        // surfaces as a clean composer error instead of a phantom user row.
        let attachments = message.message_attachments();
        if attachments.iter().any(|attachment| attachment.r#type != "input_image") {
            return Err(RunError::Failed(
                "内置 AI 助手仅支持图片附件，暂不支持文档附件".into(),
            ));
        }
        let image_parts = build_vision_parts(&message.image_paths)
            .await
            .map_err(RunError::Failed)?;
        let user_message = ChatMessage {
            id: user_message_id.clone(),
            role: "user".into(),
            message_type: None,
            content: message.content.clone(),
            llm_content: Some(llm_content.clone()),
            attachments: (!attachments.is_empty()).then(|| attachments.clone()),
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
        emit_builtin_chunk(
            app,
            AgentChunk::UserMessage {
                thread_id: thread_id.to_owned(),
                id: user_message_id.clone(),
                text: message.content.clone(),
                timestamp: now_millis(),
                attachments: attachments.clone(),
            },
            run_id,
        );

        // 2. Assemble provider messages: system + history (already contains
        //    the just-persisted user turn; its llm_content carries the
        //    humanized references).
        let mut provider_messages =
            Vec::with_capacity(HISTORY_MESSAGE_LIMIT as usize + 8);
        // Optional notebook-level instructions. The file is user-authored and
        // treated as project guidance; the UI gets a visible notice.
        let agents_md = load_agents_md(&scope.notebook_path);
        // Skill bodies stay on disk; only the name+description catalog enters
        // the prompt and the model fetches a SKILL.md via file_read on demand.
        let skill_catalog = load_skill_catalog(&scope.notebook_path);
        provider_messages.push(ProviderMessage::system(system_prompt(
            scope,
            config.web_search_enabled,
            agents_md.as_deref(),
            &skill_catalog,
        )));
        if !skill_catalog.entries.is_empty() {
            emit_builtin_chunk(
                app,
                AgentChunk::Notice {
                    thread_id: thread_id.to_owned(),
                    // Id is derived from the loaded skill names: the UI shows
                    // the notice once, and a changed skill set produces a
                    // fresh notice instead of being swallowed by the old id.
                    id: format!(
                        "notice-builtin-skills-{thread_id}-{}",
                        skill_catalog_fingerprint(&skill_catalog),
                    ),
                    text: skill_notice_text(&skill_catalog),
                },
                run_id,
            );
        }
        if let Some(content) = &agents_md {
            emit_builtin_chunk(
                app,
                AgentChunk::Notice {
                    thread_id: thread_id.to_owned(),
                    // Stable per-thread id: the UI shows the notice once even
                    // though every run reloads AGENTS.md.
                    id: format!("notice-agents-md-{thread_id}"),
                    text: format!(
                        "已加载笔记本 AGENTS.md 作为项目指令（{} 字符）",
                        content.chars().count()
                    ),
                },
                run_id,
            );
        }
        for record in self.load_history(thread_id).await? {
            // The current turn's user row is replaced by the multimodal
            // message below (text + vision parts); replaying it here as well
            // would duplicate the turn.
            if record.id == user_message_id {
                continue;
            }
            if let Some(converted) = history_to_provider(&record) {
                provider_messages.push(converted);
                if provider_messages.len() >= MAX_PROVIDER_MESSAGES {
                    break;
                }
            }
        }
        provider_messages.push(ProviderMessage::user_with_images(llm_content, image_parts));

        // 3. Tool loop.
        for _cycle in 0..MAX_TOOL_CYCLES {
            if cancel.load(Ordering::Relaxed) {
                return Err(RunError::Cancelled);
            }

            let completion = provider::stream_chat(
                &provider.chat_endpoint(),
                &provider.api_key,
                &provider.model,
                &provider_messages,
                &tools::tool_definitions(config.web_search_enabled),
                Arc::clone(cancel),
                |event| match event {
                    StreamEvent::Text(text) => {
                        emit_builtin_chunk(
                            app,
                            AgentChunk::Text {
                                thread_id: thread_id.to_owned(),
                                text,
                            },
                            run_id,
                        );
                    }
                    StreamEvent::Reasoning(text) => {
                        emit_builtin_chunk(
                            app,
                            AgentChunk::Reasoning {
                                thread_id: thread_id.to_owned(),
                                text,
                            },
                            run_id,
                        );
                    }
                },
            )
            .await
            .map_err(map_provider_error)?;

            // Persist the reasoning transcript so reopening the conversation
            // shows what the model thought (the live row is collapsed by
            // default; see the render controller).
            if !completion.reasoning.is_empty() {
                self.persist_reasoning(thread_id, &completion.reasoning).await?;
            }

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
                image_parts: Vec::new(),
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
                // Provider call id doubles as the live tool row id so history
                // reconciliation (which matches on toolCallId) merges instead
                // of duplicating the tool row.
                let call_id = call.id.clone();
                emit_builtin_chunk(
                    app,
                    AgentChunk::ToolCall {
                        thread_id: thread_id.to_owned(),
                        id: call_id.clone(),
                        name: call.name.clone(),
                        input: serde_json::from_str(&call.arguments)
                            .unwrap_or(serde_json::json!({ "raw": call.arguments })),
                    },
                    run_id,
                );

                // Web search is async; note tools are blocking file/sqlite work
                // and stay off the async reactor.
                let result = if call.name == "web_search" {
                    if !config.web_search_enabled {
                        serde_json::json!({ "ok": false, "error": "联网搜索未启用，请在设置中开启" })
                    } else {
                        let args: serde_json::Value =
                            serde_json::from_str(&call.arguments).unwrap_or_default();
                        let query = args
                            .get("query")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or_default();
                        let limit = args.get("limit").and_then(serde_json::Value::as_u64);
                        match super::web_search::search(provider, query, limit).await {
                            Ok(response) => serde_json::to_value(response)
                                .unwrap_or_else(|error| serde_json::json!({
                                    "ok": false,
                                    "error": format!("搜索结果序列化失败: {error}")
                                })),
                            Err(error) => serde_json::json!({ "ok": false, "error": error }),
                        }
                    }
                } else {
                    let memo_file = Arc::clone(&self.memo_file);
                    let scope = scope.clone();
                    let name = call.name.clone();
                    let arguments = call.arguments.clone();
                    tauri::async_runtime::spawn_blocking(move || {
                        tools::execute(&memo_file, &scope, &name, &arguments)
                    })
                    .await
                    .unwrap_or_else(|error| {
                        serde_json::json!({ "ok": false, "error": format!("工具执行任务失败: {error}") })
                    })
                };

                emit_builtin_chunk(
                    app,
                    AgentChunk::ToolResult {
                        thread_id: thread_id.to_owned(),
                        id: call_id.clone(),
                        name: call.name.clone(),
                        result: result.clone(),
                    },
                    run_id,
                );

                let result_text = serde_json::to_string(&result)
                    .unwrap_or_else(|_| result.to_string());
                self.thread_manager
                    .add_message(
                        thread_id,
                        tool_message(&format!("tool-{call_id}"), &call.id, &call.name, &result_text),
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

    /// Persist one reasoning segment. The live row is produced by the reducer
    /// from `Reasoning` deltas; this row makes the transcript survive a
    /// reopen. `history_to_provider` ignores reasoning rows, so they never
    /// re-enter the model context.
    async fn persist_reasoning(&self, thread_id: &str, text: &str) -> Result<(), RunError> {
        let message = ChatMessage {
            id: new_message_id("reasoning"),
            role: "reasoning".into(),
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
            tool_calls: None,
            reasoning: None,
            is_completed: Some(true),
            error_details: None,
            is_collapsed: Some(true),
            codex_turn_id: None,
            turn_duration_ms: None,
        };
        self.thread_manager
            .add_message(thread_id, message)
            .await
            .map_err(|error| RunError::Failed(error.to_string()))
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

/// Resolve cached attachment paths into OpenAI vision `image_url` parts.
/// Count / size / type validation and the cache-root authorization live in
/// the shared image cache module.
async fn build_vision_parts(paths: &[String]) -> Result<Vec<serde_json::Value>, String> {
    let encoded =
        crate::commands::agent::image_cache::encode_cached_agent_images(paths).await?;
    Ok(encoded
        .into_iter()
        .map(|(media_type, data, _name)| {
            serde_json::json!({
                "type": "image_url",
                "image_url": { "url": format!("data:{media_type};base64,{data}") },
            })
        })
        .collect())
}

/// Map one persisted row into a provider message; returns `None` for rows
/// that carry no conversational content (loading placeholders, empty
/// assistant tool-turn carriers are kept only when they carry tool_calls).
/// History user rows replay as text only: images are sent in the turn they
/// arrive and are deliberately not re-uploaded for later turns (context and
/// payload budget); the visible transcript still shows them.
fn history_to_provider(record: &ChatMessage) -> Option<ProviderMessage> {
    match record.role.as_str() {
        "user" => Some(ProviderMessage::user(
            record.llm_content.clone().unwrap_or_else(|| record.content.clone()),
        )),
        "assistant" => {
            if let Some(calls) = &record.tool_calls {
                return Some(ProviderMessage {
                    image_parts: Vec::new(),
                    role: "assistant".into(),
                    content: record.content.clone(),
                    tool_calls: Some(calls.clone()),
                    tool_call_id: None,
                });
            }
            (!record.content.is_empty())
                .then(|| ProviderMessage {
                    image_parts: Vec::new(),
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

/// Read `<notebook>/AGENTS.md` if present. Notes are user data; cap the file
/// so a pathological file cannot blow the context budget.
fn load_agents_md(notebook_path: &std::path::Path) -> Option<String> {
    const MAX_AGENTS_MD_BYTES: u64 = 64 * 1024;
    let path = notebook_path.join("AGENTS.md");
    let metadata = std::fs::metadata(&path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_AGENTS_MD_BYTES {
        return None;
    }
    let content = std::fs::read_to_string(&path).ok()?;
    let trimmed = content.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

/// One enabled notebook skill in the system-prompt catalog. `path` is
/// notebook-relative so the model can fetch the body with `file_read`.
struct SkillCatalogEntry {
    name: String,
    description: String,
    path: String,
}

/// Enabled-skill catalog for the system prompt: name + description only,
/// bodies stay on disk. The `.agents/` tree is user data; any read failure
/// degrades to an empty catalog instead of failing the run.
struct SkillCatalog {
    entries: Vec<SkillCatalogEntry>,
    /// True when entries were dropped because the catalog exceeded its budget.
    truncated: bool,
}

fn load_skill_catalog(notebook_path: &std::path::Path) -> SkillCatalog {
    let skills = match crate::commands::agent::notebook_agents::read_markdown_collection(
        notebook_path,
        "skills",
    ) {
        Ok(skills) => skills,
        Err(_) => {
            return SkillCatalog {
                entries: Vec::new(),
                truncated: false,
            }
        }
    };
    let mut entries = Vec::new();
    let mut budget = MAX_SKILL_CATALOG_CHARS;
    for skill in skills {
        if !skill.enabled {
            continue;
        }
        // The catalog exists so the model can judge when a skill applies; a
        // skill without a description cannot be judged, so it stays out.
        let description = skill
            .description
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        if description.is_empty() {
            continue;
        }
        let name = skill.name.trim();
        let path = skill.path.trim();
        if name.is_empty() || path.is_empty() {
            continue;
        }
        let description = description
            .chars()
            .take(MAX_SKILL_DESCRIPTION_CHARS)
            .collect::<String>();
        // 24 covers the per-entry line scaffolding (bullet, dash, and the path label).
        let cost = name.chars().count() + description.chars().count() + path.chars().count() + 24;
        if cost > budget {
            let truncated = !entries.is_empty();
            return SkillCatalog { entries, truncated };
        }
        budget -= cost;
        entries.push(SkillCatalogEntry {
            name: name.to_owned(),
            description,
            path: path.to_owned(),
        });
    }
    SkillCatalog {
        entries,
        truncated: false,
    }
}

/// Stable fingerprint of the loaded skill set (names only) used in the
/// notice id, so the conversation UI dedups unchanged reruns but surfaces a
/// fresh notice when the user adds or removes skills.
fn skill_catalog_fingerprint(catalog: &SkillCatalog) -> String {
    let mut hasher = Sha256::new();
    for skill in &catalog.entries {
        hasher.update(skill.name.as_bytes());
        hasher.update(b"\n");
    }
    format!("{:x}", hasher.finalize())[..8].to_owned()
}

/// One-line notice listing the skills whose catalog entered the system
/// prompt. Worded to make clear only the listing is injected up front — the
/// model still fetches a SKILL.md body on demand.
fn skill_notice_text(catalog: &SkillCatalog) -> String {
    let mut text = format!(
        "笔记本技能清单已就绪（{} 个）：{}，正文由助手按需读取",
        catalog.entries.len(),
        catalog
            .entries
            .iter()
            .map(|skill| skill.name.as_str())
            .collect::<Vec<_>>()
            .join("、"),
    );
    if catalog.truncated {
        text.push_str("；其余技能因长度限制未列入");
    }
    text
}

/// Render the `## 笔记本技能` block appended after the AGENTS.md section.
fn skill_catalog_section(catalog: &SkillCatalog) -> String {
    if catalog.entries.is_empty() {
        return String::new();
    }
    let mut section = String::from(
        "\n\n## 笔记本技能\n以下是用户安装在当前笔记本的技能清单，每项对应一个 SKILL.md 操作指南。",
    );
    section.push_str(
        "当用户请求与某个技能的用途相关时，先用 file_read 读取对应 SKILL.md，再按其中的步骤执行；读取正文前不要臆测技能内容：",
    );
    for skill in &catalog.entries {
        section.push_str(&format!(
            "\n- {} — {}（SKILL.md 路径：{}）",
            skill.name, skill.description, skill.path
        ));
    }
    if catalog.truncated {
        section.push_str("\n（其余技能因长度限制未列出）");
    }
    section
}

fn system_prompt(
    scope: &ToolScope,
    web_search_enabled: bool,
    agents_md: Option<&str>,
    skill_catalog: &SkillCatalog,
) -> String {
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let web_search_rule = if web_search_enabled {
        "- 需要最新或外部信息时用 web_search；回答里引用返回结果的 URL，不要把搜索结果当成笔记内容。"
    } else {
        "- 当前没有联网搜索工具；用户要求联网搜索时，明确说明需要在设置中开启「联网搜索」。"
    };
    let agents_section = agents_md
        .map(|content| {
            format!(
                "\n\n## 笔记本 AGENTS.md 指令\n以下内容来自当前笔记本根目录的 AGENTS.md，作为本会话的项目指令：\n\n{content}"
            )
        })
        .unwrap_or_default();
    format!(
        "你是 Flowix 内置笔记助手，运行在用户设备上的 Flowix 应用内，\
只能通过提供的笔记工具访问用户的笔记。

当前笔记本：{name}（id: {notebook_id}）。所有工具只能访问这个笔记本。
今天的日期：{today}。

工具使用规范：
- 修改任何笔记前必须先 note_read 拿到最新正文。除非用户明确说“当前文档/这篇笔记/指定路径”，否则先询问用户要修改哪篇笔记，不要自行猜测。
- 常规修改优先用 note_edit：old 片段必须在正文中恰好出现一次，不要凭记忆编写 old。
- note_write 会整篇覆盖正文，仅在重写整篇时使用。
- note_delete 是硬删除且不可恢复：**必须先向用户说明要删除哪篇，并得到用户明确同意后才能调用**；用户未确认时绝不删除。
- 新建笔记前先确认位置（哪个文件夹/相对路径）。用户没说位置时先询问，不要默认建在根目录。
- 新建笔记用 note_create。默认只补充 created 日期（工具会自动写入）；**不要默认添加颜色或标签**：
  · tags / colors 只在用户明确要求，或内容主题明显需要分类时添加
  · icon 可选，用户未要求时可省略
  · 其他属性通过 properties 传入
  这些通过 note_create 的 tags/icon/colors/properties 参数传入，不要手写 YAML frontmatter。
- 新建文档要排版精美：合理使用标题层级、列表、表格；在合适位置用 callout/toggle/columns/background 工具突出重点、分组信息、对比内容，避免堆砌。
- 用户需要 HTML / CSS / JSON / 源代码等非 Markdown 文件时，用 file_create 生成，path 必须带扩展名（如 输出/index.html）；不要把这类内容塞进 .md 笔记，也不要在文件末尾强加 .md 后缀。file 工具操作原始文件：不进笔记列表、不支持 frontmatter/标签；更新前先 file_read，再 file_write 整篇覆盖。
- Flowix 支持富内容：callout（提示块）、toggle（折叠块）、columns（多列布局）、background（行背景）。用户要求这些效果时调用同名工具，不要手写 ::: 语法。
  · 多列/分栏 → columns action=add contents=[左栏 Markdown, 右栏 Markdown] titleColor=yellow（分栏标题即每栏第一行会自动加行背景；titleColor 可选 yellow/blue/green 等）
  · 提示块/警告框 → callout action=add
  · 折叠详情 → toggle action=add
  · 文字行背景 → background action=set
  · 序号（block/column/line）都从 1 开始；修改前先 list 确认序号。
- 用户消息中 @标题 形式的提及通常对应 relativePath 为「标题.md」的笔记。
{web_search_rule}
- 用用户的语言回答；提到笔记时给出其相对路径；不要虚构笔记内容。{agents_section}{skills_section}",
        name = scope.notebook_name,
        notebook_id = scope.notebook_id,
        today = today,
        web_search_rule = web_search_rule,
        agents_section = agents_section,
        skills_section = skill_catalog_section(skill_catalog),
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
        let pairs: Vec<(String, String)> = url::form_urlencoded::parse(query.as_bytes())
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect();
        // `buildNoteOpenLink` emits `b=<notebook>&f=<relative>`; older links
        // may use `relativePath` / `file` / `path`.
        let relative = pairs.iter().find_map(|(key, value)| match key.as_str() {
            "relativePath" | "f" | "file" => Some(value.as_str()),
            "path" if !value.starts_with('/') => Some(value.as_str()),
            _ => None,
        });
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

/// Remove note/folder references from a first message before deriving the
/// conversation title. The mobile composer seeds the input with
/// `[Title](flowix://open?b=..&f=..)`, which would otherwise become the title.
fn strip_note_references(content: &str) -> String {
    use std::sync::OnceLock;
    static LINK_RE: OnceLock<regex::Regex> = OnceLock::new();
    static URL_RE: OnceLock<regex::Regex> = OnceLock::new();
    let link_re = LINK_RE.get_or_init(|| {
        regex::Regex::new(r"\[[^\]\n]*\]\(flowix://[^)\n]*\)").expect("note link regex")
    });
    let url_re = URL_RE
        .get_or_init(|| regex::Regex::new(r"flowix://\S+").expect("note url regex"));
    let without_links = link_re.replace_all(content, " ");
    url_re.replace_all(&without_links, " ").into_owned()
}

pub(crate) fn derive_title(content: &str) -> String {
    let cleaned = strip_note_references(content);
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
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

    fn skill_fixture(root: &std::path::Path, id: &str, frontmatter: &str) {
        let directory = root.join(".agents").join("skills").join(id);
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            directory.join("SKILL.md"),
            format!("---\n{frontmatter}\n---\n\n正文步骤"),
        )
        .unwrap();
    }

    #[test]
    fn skill_catalog_lists_enabled_described_skills_only() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        skill_fixture(
            root,
            "demo",
            "id: demo\nname: 日报\ndescription: 生成每日工作日报\nenabled: true",
        );
        skill_fixture(
            root,
            "off",
            "id: off\nname: 关闭\ndescription: 不应出现\nenabled: false",
        );
        skill_fixture(root, "blank", "id: blank\nname: 无描述");

        let catalog = load_skill_catalog(root);
        assert_eq!(catalog.entries.len(), 1, "仅 enabled 且有描述的技能进入清单");
        let entry = &catalog.entries[0];
        assert_eq!(entry.name, "日报");
        assert_eq!(entry.description, "生成每日工作日报");
        assert_eq!(entry.path, ".agents/skills/demo/SKILL.md");
        assert!(!catalog.truncated);
    }

    #[test]
    fn skill_notice_lists_loaded_skill_names() {
        let catalog = SkillCatalog {
            entries: vec![
                SkillCatalogEntry {
                    name: "日报".into(),
                    description: "a".into(),
                    path: "p1".into(),
                },
                SkillCatalogEntry {
                    name: "周报".into(),
                    description: "b".into(),
                    path: "p2".into(),
                },
            ],
            truncated: false,
        };
        assert_eq!(
            skill_notice_text(&catalog),
            "笔记本技能清单已就绪（2 个）：日报、周报，正文由助手按需读取"
        );

        let truncated = SkillCatalog {
            entries: catalog.entries,
            truncated: true,
        };
        assert!(
            skill_notice_text(&truncated).ends_with("；其余技能因长度限制未列入"),
            "{}",
            skill_notice_text(&truncated)
        );
    }

    #[test]
    fn skill_notice_fingerprint_tracks_the_loaded_skill_set() {
        let make = |names: &[&str]| SkillCatalog {
            entries: names
                .iter()
                .map(|name| SkillCatalogEntry {
                    name: (*name).into(),
                    description: "d".into(),
                    path: "p".into(),
                })
                .collect(),
            truncated: false,
        };
        assert_eq!(
            skill_catalog_fingerprint(&make(&["日报", "周报"])),
            skill_catalog_fingerprint(&make(&["日报", "周报"]))
        );
        assert_ne!(
            skill_catalog_fingerprint(&make(&["日报", "周报"])),
            skill_catalog_fingerprint(&make(&["日报"]))
        );
    }

    #[test]
    fn skill_catalog_missing_agents_dir_degrades_to_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let catalog = load_skill_catalog(tmp.path());
        assert!(catalog.entries.is_empty());
        assert!(!catalog.truncated);
    }

    #[test]
    fn system_prompt_embeds_skill_catalog_with_read_instruction() {
        let tmp = tempfile::tempdir().unwrap();
        let scope = ToolScope {
            notebook_id: "work".into(),
            notebook_name: "Work".into(),
            notebook_path: tmp.path().to_path_buf(),
            config_dir: tmp.path().join("config"),
            mark_self_write: Arc::new(|_| {}),
        };
        let catalog = SkillCatalog {
            entries: vec![SkillCatalogEntry {
                name: "日报".into(),
                description: "生成每日工作日报".into(),
                path: ".agents/skills/demo/SKILL.md".into(),
            }],
            truncated: false,
        };
        let prompt = system_prompt(&scope, false, None, &catalog);
        assert!(prompt.contains("## 笔记本技能"), "{prompt}");
        assert!(
            prompt.contains("- 日报 — 生成每日工作日报（SKILL.md 路径：.agents/skills/demo/SKILL.md）"),
            "{prompt}"
        );
        assert!(prompt.contains("先用 file_read 读取对应 SKILL.md"), "{prompt}");

        let empty = SkillCatalog {
            entries: Vec::new(),
            truncated: false,
        };
        let without = system_prompt(&scope, false, None, &empty);
        assert!(!without.contains("笔记本技能"), "{without}");
    }
}
