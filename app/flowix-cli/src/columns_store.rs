//! Column-layout operations shared by the CLI and MCP adapters.

use crate::{errors::CliError, path_store};
use flowix_core::memo_file::columns;
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
    serde_json::to_value(columns::parse(body)).unwrap_or_else(|_| json!([]))
}

fn address(document: &Value) -> Value {
    document.get("address").cloned().unwrap_or(Value::Null)
}

pub(crate) fn list(raw: &str) -> Result<Value, CliError> {
    let (document, body) = read(raw)?;
    Ok(json!({
        "ok": true,
        "action": "columns.list",
        "address": address(&document),
        "blocks": blocks(&body),
    }))
}

pub(crate) fn add(raw: &str, count: usize, at: Option<usize>) -> Result<Value, CliError> {
    let (document, body) = read(raw)?;
    let next = columns::insert(&body, at, count).map_err(CliError::Usage)?;
    path_store::write(raw, &next)?;
    Ok(json!({
        "ok": true,
        "action": "columns.add",
        "address": address(&document),
        "blocks": blocks(&next),
    }))
}

pub(crate) fn remove(raw: &str, block: usize, column: usize) -> Result<Value, CliError> {
    let (document, body) = read(raw)?;
    let next = columns::remove_column(
        &body,
        block.saturating_sub(1),
        column.saturating_sub(1),
    )
    .map_err(CliError::Usage)?;
    path_store::write(raw, &next)?;
    Ok(json!({
        "ok": true,
        "action": "columns.remove",
        "address": address(&document),
        "blocks": blocks(&next),
    }))
}

pub(crate) fn set_widths(
    raw: &str,
    block: usize,
    widths: &[u32],
) -> Result<Value, CliError> {
    let (document, body) = read(raw)?;
    let next =
        columns::set_widths(&body, block.saturating_sub(1), widths).map_err(CliError::Usage)?;
    path_store::write(raw, &next)?;
    Ok(json!({
        "ok": true,
        "action": "columns.width",
        "address": address(&document),
        "blocks": blocks(&next),
    }))
}
