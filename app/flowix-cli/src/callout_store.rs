//! Callout operations shared by the CLI and MCP adapters.

use crate::{errors::CliError, path_store};
use flowix_core::memo_file::callout;
use serde_json::{json, Value};

fn read(raw: &str) -> Result<(Value, String), CliError> {
    let document = path_store::show(raw)?;
    let body = document
        .get("body")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    Ok((document, body))
}

fn blocks(body: &str) -> Value {
    serde_json::to_value(callout::parse(body)).unwrap_or_else(|_| json!([]))
}

fn address(document: &Value) -> Value {
    document.get("address").cloned().unwrap_or(Value::Null)
}

pub(crate) fn list(raw: &str) -> Result<Value, CliError> {
    let (document, body) = read(raw)?;
    Ok(json!({
        "ok": true,
        "action": "callout.list",
        "address": address(&document),
        "blocks": blocks(&body),
    }))
}

pub(crate) fn add(
    raw: &str,
    at: Option<usize>,
    icon: Option<&str>,
    color: Option<&str>,
    content: &str,
) -> Result<Value, CliError> {
    let (document, body) = read(raw)?;
    let next = callout::insert(&body, at, icon, color, content).map_err(CliError::Usage)?;
    path_store::write(raw, &next)?;
    Ok(json!({
        "ok": true,
        "action": "callout.add",
        "address": address(&document),
        "blocks": blocks(&next),
    }))
}

pub(crate) fn set(
    raw: &str,
    block: usize,
    icon: Option<&str>,
    color: Option<&str>,
) -> Result<Value, CliError> {
    let (document, body) = read(raw)?;
    let next =
        callout::set(&body, block.saturating_sub(1), icon, color).map_err(CliError::Usage)?;
    path_store::write(raw, &next)?;
    Ok(json!({
        "ok": true,
        "action": "callout.set",
        "address": address(&document),
        "blocks": blocks(&next),
    }))
}

pub(crate) fn remove(raw: &str, block: usize, keep_content: bool) -> Result<Value, CliError> {
    let (document, body) = read(raw)?;
    let next =
        callout::remove(&body, block.saturating_sub(1), keep_content).map_err(CliError::Usage)?;
    path_store::write(raw, &next)?;
    Ok(json!({
        "ok": true,
        "action": "callout.remove",
        "address": address(&document),
        "keepContent": keep_content,
        "blocks": blocks(&next),
    }))
}
