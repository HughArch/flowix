//! Minimal OpenAI-compatible Chat Completions SSE client for the built-in
//! assistant.
//!
//! Deliberately small: text / reasoning deltas, parallel tool-call
//! accumulation and usage. No media, retries or provider-specific extensions.
//! Wire format is the de-facto `choices[0].delta` streaming shape served by
//! OpenAI, DeepSeek and every OpenAI-compatible gateway.

use std::collections::BTreeMap;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// Streaming responses may pause while the model thinks; the timeout applies
/// to individual reads, not the whole body.
const READ_TIMEOUT: Duration = Duration::from_secs(120);

/// One provider message in the request array.
#[derive(Debug, Clone)]
pub struct ProviderMessage {
    pub role: String,
    pub content: String,
    /// OpenAI vision `image_url` parts. When non-empty the wire `content`
    /// becomes a parts array with `content` as the leading text part.
    pub image_parts: Vec<Value>,
    /// OpenAI tool_calls array (assistant messages that invoke tools).
    pub tool_calls: Option<Value>,
    pub tool_call_id: Option<String>,
}

impl ProviderMessage {
    pub fn system(content: impl Into<String>) -> Self {
        Self { role: "system".into(), content: content.into(), image_parts: Vec::new(), tool_calls: None, tool_call_id: None }
    }

    pub fn user(content: impl Into<String>) -> Self {
        Self { role: "user".into(), content: content.into(), image_parts: Vec::new(), tool_calls: None, tool_call_id: None }
    }

    /// User message carrying vision images (`image_url` parts, already
    /// data URLs). Text stays the leading part so model sees the prompt first.
    pub fn user_with_images(content: impl Into<String>, image_parts: Vec<Value>) -> Self {
        Self { role: "user".into(), content: content.into(), image_parts, tool_calls: None, tool_call_id: None }
    }

    pub fn tool(call_id: &str, content: impl Into<String>) -> Self {
        Self {
            role: "tool".into(),
            content: content.into(),
            image_parts: Vec::new(),
            tool_calls: None,
            tool_call_id: Some(call_id.to_owned()),
        }
    }

    fn to_json(&self) -> Value {
        let content = if self.image_parts.is_empty() {
            json!(self.content)
        } else {
            let mut parts = vec![json!({ "type": "text", "text": self.content })];
            parts.extend(self.image_parts.iter().cloned());
            json!(parts)
        };
        let mut object = json!({ "role": self.role, "content": content });
        if let Some(calls) = &self.tool_calls {
            object["tool_calls"] = calls.clone();
        }
        if let Some(id) = &self.tool_call_id {
            object["tool_call_id"] = json!(id);
        }
        object
    }
}

/// A completed tool call assembled from streamed deltas.
#[derive(Debug, Clone)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

/// Events forwarded live while the stream runs.
pub enum StreamEvent {
    Text(String),
    Reasoning(String),
}

/// Final result of one streamed completion.
#[derive(Debug, Default)]
pub struct Completion {
    pub text: String,
    pub reasoning: String,
    pub tool_calls: Vec<ToolCall>,
    pub finish_reason: Option<String>,
    pub input_tokens: Option<u32>,
    pub output_tokens: Option<u32>,
}

#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    #[error("built-in AI is not configured")]
    NotConfigured,
    #[error("request failed: {0}")]
    Request(#[from] reqwest::Error),
    #[error("provider returned HTTP {status}: {body}")]
    Status { status: u16, body: String },
    #[error("stream interrupted: {0}")]
    Stream(String),
    #[error("invalid provider response: {0}")]
    Format(String),
    #[error("cancelled")]
    Cancelled,
}

#[derive(Deserialize)]
struct SseChunk {
    choices: Vec<SseChoice>,
    usage: Option<SseUsage>,
}

#[derive(Deserialize)]
struct SseChoice {
    #[serde(default)]
    delta: SseDelta,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Deserialize, Default)]
struct SseDelta {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    reasoning_content: Option<String>,
    #[serde(default)]
    tool_calls: Vec<SseToolDelta>,
}

#[derive(Deserialize)]
struct SseToolDelta {
    #[serde(default)]
    index: usize,
    #[serde(default)]
    id: Option<String>,
    function: Option<SseToolFunction>,
}

#[derive(Deserialize)]
struct SseToolFunction {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    arguments: Option<String>,
}

#[derive(Deserialize)]
struct SseUsage {
    #[serde(default)]
    prompt_tokens: Option<u32>,
    #[serde(default)]
    completion_tokens: Option<u32>,
}

/// Stream one chat completion. `on_event` receives deltas as they arrive; the
/// assembled [`Completion`] is returned once the stream ends. `cancel` is
/// polled between network reads — cancellation may cut the stream mid-flight
/// and yields [`ProviderError::Cancelled`].
///
/// `max_tokens` is deliberately omitted: providers cap the output budget at
/// very different values (DeepSeek rejects anything above 8k, GLM accepts up
/// to 131,072 and returns HTTP 400 outside `[1, 131072]`), so no single value
/// is portable. Leaving it out lets each provider apply its own default.
pub async fn stream_chat(
    endpoint: &str,
    api_key: &str,
    model: &str,
    messages: &[ProviderMessage],
    tools: &Value,
    cancel: Arc<std::sync::atomic::AtomicBool>,
    mut on_event: impl FnMut(StreamEvent),
) -> Result<Completion, ProviderError> {
    let body = json!({
        "model": model,
        "messages": messages.iter().map(ProviderMessage::to_json).collect::<Vec<_>>(),
        "tools": tools,
        "stream": true,
    });

    let client = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(READ_TIMEOUT)
        .build()?;
    let response = client
        .post(endpoint)
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|error| map_request_error(error, cancel.clone()))?;

    let status = response.status();
    if !status.is_success() {
        let code = status.as_u16();
        let body = response.text().await.unwrap_or_default();
        let body = if body.chars().count() > 600 {
            format!("{}…", body.chars().take(600).collect::<String>())
        } else {
            body
        };
        return Err(ProviderError::Status { status: code, body });
    }

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut completion = Completion::default();
    // tool index → (id, name, arguments); BTreeMap keeps emission order stable.
    let mut tools_acc: BTreeMap<usize, (String, String, String)> = BTreeMap::new();

    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(ProviderError::Cancelled);
        }
        let bytes = tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(250)) => {
                if cancel.load(Ordering::Relaxed) {
                    return Err(ProviderError::Cancelled);
                }
                continue;
            }
            chunk = futures::StreamExt::next(&mut stream) => chunk,
        };
        let bytes = match bytes {
            Some(chunk) => chunk.map_err(|error| ProviderError::Stream(error.to_string()))?,
            None => break,
        };
        buffer.push_str(&String::from_utf8_lossy(&bytes));

        while let Some(line_end) = buffer.find('\n') {
            let line = buffer[..line_end].trim_end_matches('\r').to_owned();
            buffer.drain(..=line_end);
            let Some(data) = line.strip_prefix("data:") else { continue };
            let data = data.trim();
            if data == "[DONE]" {
                finish_tools(&mut completion, tools_acc);
                return Ok(completion);
            }
            let chunk: SseChunk = serde_json::from_str(data)
                .map_err(|error| ProviderError::Format(format!("{error} in `{data}`")))?;

            if let Some(usage) = &chunk.usage {
                completion.input_tokens = usage.prompt_tokens;
                completion.output_tokens = usage.completion_tokens;
            }
            let Some(choice) = chunk.choices.first() else { continue };
            if let Some(reason) = &choice.finish_reason {
                completion.finish_reason = Some(reason.clone());
            }
            if let Some(reasoning) = &choice.delta.reasoning_content {
                if !reasoning.is_empty() {
                    completion.reasoning.push_str(reasoning);
                    on_event(StreamEvent::Reasoning(reasoning.clone()));
                }
            }
            if let Some(content) = &choice.delta.content {
                if !content.is_empty() {
                    completion.text.push_str(content);
                    on_event(StreamEvent::Text(content.clone()));
                }
            }
            for call in &choice.delta.tool_calls {
                let entry = tools_acc.entry(call.index).or_default();
                if let Some(id) = &call.id {
                    entry.0 = id.clone();
                }
                if let Some(function) = &call.function {
                    if let Some(name) = &function.name {
                        entry.1.push_str(name);
                    }
                    if let Some(arguments) = &function.arguments {
                        entry.2.push_str(arguments);
                    }
                }
            }
        }
    }

    finish_tools(&mut completion, tools_acc);
    Ok(completion)
}

fn finish_tools(completion: &mut Completion, tools_acc: BTreeMap<usize, (String, String, String)>) {
    completion.tool_calls = tools_acc
        .into_iter()
        .map(|(index, (id, name, arguments))| {
            let id = if id.is_empty() { format!("call_{index}") } else { id };
            ToolCall { id, name, arguments }
        })
        .collect();
}

fn map_request_error(error: reqwest::Error, cancel: Arc<std::sync::atomic::AtomicBool>) -> ProviderError {
    if cancel.load(Ordering::Relaxed) {
        return ProviderError::Cancelled;
    }
    ProviderError::Request(error)
}

/// Non-streaming single-shot completion, used by the connection test.
pub async fn complete_once(
    endpoint: &str,
    api_key: &str,
    model: &str,
    prompt: &str,
) -> Result<String, ProviderError> {
    let body = json!({
        "model": model,
        "messages": [{ "role": "user", "content": prompt }],
        "max_tokens": 16,
        "stream": false,
    });
    let client = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(Duration::from_secs(30))
        .build()?;
    let response = client
        .post(endpoint)
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(ProviderError::Status {
            status: status.as_u16(),
            body: text.chars().take(300).collect(),
        });
    }
    let value: Value = serde_json::from_str(&text)
        .map_err(|error| ProviderError::Format(error.to_string()))?;
    value["choices"][0]["message"]["content"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| ProviderError::Format("missing choices[0].message.content".into()))
}

/// Fetch the provider's model list (`GET /models`, OpenAI-compatible).
/// Accepts both the standard `{"data":[{"id":..}]}` shape and a bare array.
pub async fn list_models(
    models_endpoint: &str,
    api_key: &str,
) -> Result<Vec<String>, ProviderError> {
    let client = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(Duration::from_secs(30))
        .build()?;
    let response = client
        .get(models_endpoint)
        .bearer_auth(api_key)
        .send()
        .await?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(ProviderError::Status {
            status: status.as_u16(),
            body: text.chars().take(300).collect(),
        });
    }
    let value: Value =
        serde_json::from_str(&text).map_err(|error| ProviderError::Format(error.to_string()))?;
    let items = if let Some(data) = value.get("data").and_then(Value::as_array) {
        data.clone()
    } else if let Some(array) = value.as_array() {
        array.clone()
    } else {
        return Err(ProviderError::Format("models response has no data array".into()));
    };
    let mut ids: Vec<String> = items
        .iter()
        .filter_map(|item| item.get("id").and_then(Value::as_str))
        .map(str::to_owned)
        .collect();
    ids.sort();
    ids.dedup();
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_events(payload: &str) -> Completion {
        // Drive the SSE assembly by feeding the parser through the public
        // stream path would need a server; instead assert on the accumulation
        // helper behavior via finish_tools with a manual replay.
        let mut completion = Completion::default();
        let mut tools = BTreeMap::new();
        for line in payload.lines() {
            let Some(data) = line.strip_prefix("data: ") else { continue };
            if data == "[DONE]" {
                break;
            }
            let chunk: SseChunk = serde_json::from_str(data).unwrap();
            if let Some(choice) = chunk.choices.first() {
                if let Some(reason) = &choice.finish_reason {
                    completion.finish_reason = Some(reason.clone());
                }
                if let Some(content) = &choice.delta.content {
                    completion.text.push_str(content);
                }
                for call in &choice.delta.tool_calls {
                    let entry: &mut (String, String, String) =
                        tools.entry(call.index).or_default();
                    if let Some(id) = &call.id {
                        entry.0 = id.clone();
                    }
                    if let Some(function) = &call.function {
                        if let Some(name) = &function.name {
                            entry.1.push_str(name);
                        }
                        if let Some(arguments) = &function.arguments {
                            entry.2.push_str(arguments);
                        }
                    }
                }
            }
        }
        finish_tools(&mut completion, tools);
        completion
    }

    #[test]
    fn accumulates_parallel_tool_call_deltas() {
        let completion = parse_events(
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_a\",\"function\":{\"name\":\"note_\",\"arguments\":\"\"}}]}}]}\n\
             data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"path\\\"\"}}]}}]}\n\
             data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":1,\"id\":\"call_b\",\"function\":{\"name\":\"note_read\",\"arguments\":\"{}\"}}]}}]}\n\
             data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"tool_calls\"}]}\n\
             data: [DONE]\n",
        );
        assert_eq!(completion.text, "ok");
        assert_eq!(completion.finish_reason.as_deref(), Some("tool_calls"));
        assert_eq!(completion.tool_calls.len(), 2);
        assert_eq!(completion.tool_calls[0].id, "call_a");
        assert_eq!(completion.tool_calls[0].name, "note_");
        assert_eq!(completion.tool_calls[0].arguments, "{\"path\"");
        assert_eq!(completion.tool_calls[1].name, "note_read");
    }

    #[test]
    fn missing_tool_ids_get_stable_fallbacks() {
        let completion = parse_events(
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":3,\"function\":{\"name\":\"note_list\",\"arguments\":\"{}\"}}]}}]}\n\
             data: [DONE]\n",
        );
        assert_eq!(completion.tool_calls[0].id, "call_3");
    }

    #[test]
    fn provider_messages_serialize_tools_and_ids() {
        let assistant = ProviderMessage {
            role: "assistant".into(),
            content: String::new(),
            image_parts: Vec::new(),
            tool_calls: Some(json!([{ "id": "c1", "type": "function" }])),
            tool_call_id: None,
        };
        let tool = ProviderMessage::tool("c1", "{\"ok\":true}");
        assert_eq!(assistant.to_json()["tool_calls"][0]["id"], "c1");
        assert_eq!(tool.to_json()["tool_call_id"], "c1");
        assert_eq!(tool.to_json()["role"], "tool");
    }

    #[test]
    fn multimodal_user_message_serializes_content_parts() {
        let text_only = ProviderMessage::user("hello");
        assert_eq!(text_only.to_json()["content"], "hello");

        let multimodal = ProviderMessage::user_with_images(
            "看这张图",
            vec![json!({
                "type": "image_url",
                "image_url": { "url": "data:image/png;base64,AQID" },
            })],
        );
        let wire = multimodal.to_json();
        let parts = wire["content"].as_array().expect("content parts array");
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0]["type"], "text");
        assert_eq!(parts[0]["text"], "看这张图");
        assert_eq!(parts[1]["type"], "image_url");
        assert_eq!(parts[1]["image_url"]["url"], "data:image/png;base64,AQID");
    }
}
