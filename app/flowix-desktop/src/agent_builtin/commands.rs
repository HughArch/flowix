//! Built-in assistant IPC: configuration management and connection test.
//!
//! Chat runs through the shared `chat_with_agent_stream` / `stop_agent_stream`
//! commands (agent type `"flowix"`), so the conversation UI needs no new send
//! or stop paths.

use tauri::State;

use crate::agent_wire::{AgentChatResponse, AgentUserMessage};
use crate::app::state::AppState;

use super::config::{BuiltinAiConfig, BuiltinAiConfigInput, BuiltinAiConfigView};
use super::provider;
use super::AGENT_ID;

/// Current built-in assistant configuration. The API key is never echoed.
#[tauri::command]
pub fn agent_builtin_get_config(state: State<'_, AppState>) -> BuiltinAiConfigView {
    state.agent_builtin.load_config().view()
}

/// Replace the built-in assistant configuration. `api_key = null` keeps the
/// stored key; an explicit string (including empty) replaces it.
#[tauri::command]
pub fn agent_builtin_set_config(
    input: BuiltinAiConfigInput,
    state: State<'_, AppState>,
) -> Result<BuiltinAiConfigView, String> {
    let mut config = state.agent_builtin.load_config();
    config.apply(input);
    state.agent_builtin.save_config(&config)?;
    Ok(config.view())
}

/// One-shot non-streaming request to verify the provider settings.
#[tauri::command]
pub async fn agent_builtin_test_connection(state: State<'_, AppState>) -> Result<String, String> {
    let config: BuiltinAiConfig = state.agent_builtin.load_config();
    if !config.is_configured() {
        return Err("请先填写 API 地址、Key 和模型".into());
    }
    provider::complete_once(&config.chat_endpoint(), &config.api_key, &config.model,
        "Reply with the single word: ok")
        .await
        .map(|reply| {
            let trimmed = reply.trim();
            if trimmed.is_empty() {
                "连接成功，但模型返回了空回复".to_owned()
            } else {
                format!("连接成功：{}", trimmed.chars().take(40).collect::<String>())
            }
        })
        .map_err(|error| error.to_string())
}

/// Entry used by `chat_with_agent_stream` when `agentType == "flowix"`.
/// Fire-and-forget like every runtime: progress flows via `agent-chunk`.
pub(crate) async fn chat_with_builtin(
    thread_id: String,
    message: AgentUserMessage,
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<AgentChatResponse, String> {
    state
        .agent_builtin
        .chat(app_handle, thread_id, message)?;
    Ok(AgentChatResponse { response: String::new() })
}

pub(crate) fn is_builtin(agent_type: Option<&str>) -> bool {
    agent_type.map(str::trim) == Some(AGENT_ID)
}
