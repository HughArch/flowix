//! Toggle operations shared by the CLI and MCP adapters.

use crate::{errors::CliError, path_store};
use flowix_core::memo_file::toggle::{self, BackgroundUpdate};
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
    serde_json::to_value(toggle::parse(body)).unwrap_or_else(|_| json!([]))
}

fn address(document: &Value) -> Value {
    document.get("address").cloned().unwrap_or(Value::Null)
}

pub(crate) fn list(raw: &str) -> Result<Value, CliError> {
    let (document, body) = read(raw)?;
    Ok(json!({
        "ok": true,
        "action": "toggle.list",
        "address": address(&document),
        "blocks": blocks(&body),
    }))
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn add(
    raw: &str,
    at: Option<usize>,
    title: &str,
    body: &str,
    open: bool,
    bg: Option<&str>,
) -> Result<Value, CliError> {
    let (document, current) = read(raw)?;
    let next = toggle::insert(&current, at, title, body, open, bg).map_err(CliError::Usage)?;
    path_store::write(raw, &next)?;
    Ok(json!({
        "ok": true,
        "action": "toggle.add",
        "address": address(&document),
        "blocks": blocks(&next),
    }))
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn set(
    raw: &str,
    block: usize,
    title: Option<&str>,
    body: Option<&str>,
    open: Option<bool>,
    bg: Option<&str>,
    clear_bg: bool,
) -> Result<Value, CliError> {
    if bg.is_some() && clear_bg {
        return Err(CliError::Usage(
            "toggle set: provide at most one of bg or clear-bg".into(),
        ));
    }
    let background = match (bg, clear_bg) {
        (Some(color), false) => BackgroundUpdate::Set(color),
        (None, true) => BackgroundUpdate::Clear,
        _ => BackgroundUpdate::Keep,
    };
    let (document, current) = read(raw)?;
    let next = toggle::set(
        &current,
        block.saturating_sub(1),
        title,
        body,
        open,
        background,
    )
    .map_err(CliError::Usage)?;
    path_store::write(raw, &next)?;
    Ok(json!({
        "ok": true,
        "action": "toggle.set",
        "address": address(&document),
        "blocks": blocks(&next),
    }))
}

pub(crate) fn remove(raw: &str, block: usize, keep_content: bool) -> Result<Value, CliError> {
    let (document, body) = read(raw)?;
    let next =
        toggle::remove(&body, block.saturating_sub(1), keep_content).map_err(CliError::Usage)?;
    path_store::write(raw, &next)?;
    Ok(json!({
        "ok": true,
        "action": "toggle.remove",
        "address": address(&document),
        "keepContent": keep_content,
        "blocks": blocks(&next),
    }))
}
