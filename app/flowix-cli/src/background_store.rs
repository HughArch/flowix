//! Line-background operations shared by the CLI and MCP adapters.

use crate::{errors::CliError, path_store};
use flowix_core::memo_file::line_background;
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
    serde_json::to_value(line_background::parse(body)).unwrap_or_else(|_| json!([]))
}

fn address(document: &Value) -> Value {
    document.get("address").cloned().unwrap_or(Value::Null)
}

pub(crate) fn list(raw: &str) -> Result<Value, CliError> {
    let (document, body) = read(raw)?;
    Ok(json!({
        "ok": true,
        "action": "background.list",
        "address": address(&document),
        "blocks": blocks(&body),
    }))
}

pub(crate) fn set(raw: &str, line: usize, color: &str) -> Result<Value, CliError> {
    let (document, body) = read(raw)?;
    let next = line_background::set(&body, line, color).map_err(CliError::Usage)?;
    path_store::write(raw, &next)?;
    Ok(json!({
        "ok": true,
        "action": "background.set",
        "address": address(&document),
        "line": line,
        "color": color,
        "blocks": blocks(&next),
    }))
}

pub(crate) fn clear(raw: &str, line: usize) -> Result<Value, CliError> {
    let (document, body) = read(raw)?;
    let next = line_background::clear(&body, line).map_err(CliError::Usage)?;
    path_store::write(raw, &next)?;
    Ok(json!({
        "ok": true,
        "action": "background.clear",
        "address": address(&document),
        "line": line,
        "blocks": blocks(&next),
    }))
}
