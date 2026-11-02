//! Tool item parsing shared by live notifications and persisted history.
use serde_json::Value;

pub(super) const CODEX_CUSTOM_TOOL_MESSAGE_TYPE: &str = "codex-custom-tool";

const CUSTOM_TOOL_CALL_TYPES: &[&str] = &["custom_tool_call", "customToolCall"];
const CUSTOM_TOOL_OUTPUT_TYPES: &[&str] = &["custom_tool_call_output", "customToolCallOutput"];

fn item_kind(item: &Value) -> Option<&str> {
    item.get("type").and_then(Value::as_str)
}

fn nonempty_item_string<'a>(item: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|key| item.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

pub(super) fn custom_tool_call_id(item: &Value) -> Option<&str> {
    nonempty_item_string(item, &["call_id", "callId", "tool_call_id", "toolCallId"])
        .or_else(|| nonempty_item_string(item, &["id"]))
}

pub(super) fn custom_tool_output_call_id(item: &Value) -> Option<&str> {
    nonempty_item_string(item, &["call_id", "callId", "tool_call_id", "toolCallId"])
}

pub(super) fn custom_tool_name(item: &Value) -> Option<&str> {
    nonempty_item_string(item, &["name", "tool_name", "toolName"])
}

fn custom_tool_input(item: &Value) -> Option<&Value> {
    ["input", "arguments", "args"]
        .iter()
        .find_map(|key| item.get(*key))
}

fn has_custom_tool_call_shape(item: &Value) -> bool {
    custom_tool_call_id(item).is_some()
        && custom_tool_name(item).is_some()
        && custom_tool_input(item).is_some()
}

/// Known custom-tool aliases are accepted directly; unknown item types need a
/// call id, name, and input payload before they are treated as custom tools.
pub(super) fn is_custom_tool_call_item(item: &Value) -> bool {
    let Some(kind) = item_kind(item) else {
        return false;
    };
    let supports_custom_shape =
        CUSTOM_TOOL_CALL_TYPES.contains(&kind) || canonical_codex_tool_name(kind).is_none();
    supports_custom_shape
        && !CUSTOM_TOOL_OUTPUT_TYPES.contains(&kind)
        && has_custom_tool_call_shape(item)
}

pub(super) fn is_custom_tool_output_item(item: &Value) -> bool {
    let Some(kind) = item_kind(item) else {
        return false;
    };
    let recognized_type = CUSTOM_TOOL_OUTPUT_TYPES.contains(&kind);
    let future_type = canonical_codex_tool_name(kind).is_none();
    custom_tool_output_call_id(item).is_some()
        && codex_custom_tool_output(item).is_some()
        && (recognized_type || future_type)
}

pub(super) fn codex_tool_call_identity(item: &Value) -> Option<(String, String)> {
    let kind = item_kind(item)?;
    if let Some(name) = canonical_codex_tool_name(kind) {
        let id = item.get("id")?.as_str()?.trim();
        return (!id.is_empty()).then(|| (id.to_string(), name.to_string()));
    }
    if !is_custom_tool_call_item(item) {
        return None;
    }
    Some((
        custom_tool_call_id(item)?.to_string(),
        custom_tool_name(item)?.to_string(),
    ))
}

pub(super) fn codex_tool_result_identity(item: &Value) -> Option<(String, String)> {
    if is_custom_tool_output_item(item) {
        return Some((
            custom_tool_output_call_id(item)?.to_string(),
            custom_tool_name(item).unwrap_or("unknown_tool").to_string(),
        ));
    }
    codex_tool_call_identity(item)
}

pub(super) fn codex_tool_result_value(item: &Value) -> Option<Value> {
    if is_custom_tool_output_item(item) || is_custom_tool_call_item(item) {
        if let Some(output) = codex_custom_tool_output(item) {
            return Some(output.clone());
        }
        if is_custom_tool_call_item(item)
            && item
                .get("status")
                .and_then(Value::as_str)
                .is_some_and(is_terminal_native_status)
        {
            return Some(Value::Null);
        }
        return None;
    }
    codex_tool_call_identity(item).map(|_| item.clone())
}

pub(super) fn codex_custom_tool_message_type(item: &Value) -> Option<&'static str> {
    (is_custom_tool_call_item(item) || is_custom_tool_output_item(item))
        .then_some(CODEX_CUSTOM_TOOL_MESSAGE_TYPE)
}

pub(super) fn codex_tool_call_input(item: &Value) -> Value {
    if codex_custom_tool_message_type(item).is_some() {
        serde_json::json!({
            "input": custom_tool_input(item).cloned().unwrap_or_else(|| item.clone())
        })
    } else {
        item.clone()
    }
}

pub(super) fn codex_custom_tool_output(item: &Value) -> Option<&Value> {
    ["output", "result", "error"]
        .iter()
        .find_map(|key| item.get(*key))
}

pub(super) fn codex_tool_payload_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        _ => serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string()),
    }
}

fn canonical_codex_tool_name(kind: &str) -> Option<&'static str> {
    match kind {
        "commandExecution" => Some("command_execution"),
        "fileChange" => Some("file_change"),
        "mcpToolCall" => Some("mcp_tool_call"),
        "dynamicToolCall" => Some("dynamic_tool_call"),
        // `collabToolCall` is current; retain the older spelling as an alias.
        "collabToolCall" | "collabAgentToolCall" => Some("collab_agent_tool_call"),
        "webSearch" => Some("web_search"),
        "imageView" => Some("view_image"),
        "imageGeneration" => Some("image_generation"),
        _ => None,
    }
}

pub(super) fn is_terminal_native_status(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "interrupted" | "cancelled")
}
