//! Built-in assistant IPC: configuration management, connection test and
//! model discovery.
//!
//! Chat runs through the shared `chat_with_agent_stream` / `stop_agent_stream`
//! commands (agent type `"flowix"`), so the conversation UI needs no new send
//! or stop paths.
//!
//! Test/model-list commands take the **form values** as optional overrides so
//! the preferences UI can test exactly what the user typed, before anything
//! is saved. `api_key = None` falls back to the stored key.

use serde::Deserialize;
use tauri::State;

use crate::agent_wire::{AgentChatResponse, AgentUserMessage};
use crate::app::state::AppState;

use super::config::{
    BuiltinAiConfigInput, BuiltinAiConfigView, BuiltinAiProvider,
};
use super::provider;
use super::AGENT_ID;

/// Form overrides for test/model-list calls. `None` fields fall back to the
/// active provider; an empty-string api_key means "the form field is empty",
/// which also falls back to the stored key.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuiltinAiOverride {
    pub api_url: Option<String>,
    pub api_key: Option<String>,
    pub model: Option<String>,
}

/// Merge the active provider with form overrides into an ephemeral provider.
fn resolve_effective_provider(
    state: &AppState,
    over: Option<BuiltinAiOverride>,
) -> Option<BuiltinAiProvider> {
    let config = state.agent_builtin.load_config();
    let mut provider = config.active_provider().cloned().unwrap_or_default();
    if let Some(over) = over {
        if let Some(url) = over.api_url.map(|v| v.trim().trim_end_matches('/').to_owned()) {
            if !url.is_empty() {
                provider.api_url = url;
            }
        }
        if let Some(key) = over.api_key.map(|v| v.trim().to_owned()) {
            if !key.is_empty() {
                provider.api_key = key;
            }
        }
        if let Some(model) = over.model.map(|v| v.trim().to_owned()) {
            if !model.is_empty() {
                provider.model = model;
            }
        }
    }
    Some(provider)
}

fn validate_provider(provider: &BuiltinAiProvider, require_model: bool) -> Result<(), String> {
    if provider.api_url.trim().is_empty() {
        return Err("请先填写 API 地址".into());
    }
    if provider.api_key.trim().is_empty() {
        return Err("请先填写 API Key".into());
    }
    if require_model && provider.model.trim().is_empty() {
        return Err("请先填写模型".into());
    }
    Ok(())
}

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

/// Switch the active provider for subsequent runs. Each run re-reads the
/// config, so the next message uses the new vendor without a restart.
#[tauri::command]
pub fn agent_builtin_set_active_provider(
    provider_id: String,
    state: State<'_, AppState>,
) -> Result<BuiltinAiConfigView, String> {
    let mut config = state.agent_builtin.load_config();
    config.set_active_provider(&provider_id)?;
    state.agent_builtin.save_config(&config)?;
    Ok(config.view())
}

/// One-shot non-streaming request against the given (or active) provider.
#[tauri::command]
pub async fn agent_builtin_test_connection(
    over: Option<BuiltinAiOverride>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let provider = resolve_effective_provider(&state, over)
        .ok_or_else(|| "尚未配置 AI 厂商".to_owned())?;
    validate_provider(&provider, true)?;
    provider::complete_once(
        &provider.chat_endpoint(),
        &provider.api_key,
        &provider.model,
        "Reply with the single word: ok",
    )
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

/// Fetch a provider's model list for the model dropdown. Uses form values when
/// provided, otherwise the active provider.
#[tauri::command]
pub async fn agent_builtin_list_models(
    over: Option<BuiltinAiOverride>,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let provider = resolve_effective_provider(&state, over)
        .ok_or_else(|| "尚未配置 AI 厂商".to_owned())?;
    validate_provider(&provider, false)?;
    provider::list_models(&provider.models_endpoint(), &provider.api_key)
        .await
        .map_err(|error| error.to_string())
}

/// Hard-delete a built-in assistant thread together with its conversation
/// instances and messages. Used when the source document is deleted (the
/// document-scoped conversation dies with it) and by the conversation list's
/// delete action. External runtimes have their own lifecycle commands; this
/// one is builtin-only and touches no provider.
#[tauri::command]
pub async fn agent_builtin_delete_thread(
    thread_id: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    state.agent_builtin.stop(&thread_id);
    state
        .thread_manager
        .delete_thread_with_agent_conversations(&thread_id)
        .await
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
    state.agent_builtin.chat(app_handle, thread_id, message)?;
    Ok(AgentChatResponse { response: String::new() })
}

pub(crate) fn is_builtin(agent_type: Option<&str>) -> bool {
    agent_type.map(str::trim) == Some(AGENT_ID)
}
