//! Note-card (block-level note reference) operations shared by the CLI and
//! MCP adapters.

use crate::{errors::CliError, path_store};
use flownote_core::memo_file::notecard::{self, FieldUpdate, NoteCardInput, NoteCardUpdate};
use serde_json::{json, Value};
use std::path::Path;

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
    serde_json::to_value(notecard::parse(body)).unwrap_or_else(|_| json!([]))
}

fn address(document: &Value) -> Value {
    document.get("address").cloned().unwrap_or(Value::Null)
}

pub(crate) fn list(raw: &str) -> Result<Value, CliError> {
    let (document, body) = read(raw)?;
    Ok(json!({
        "ok": true,
        "action": "notecard.list",
        "address": address(&document),
        "blocks": blocks(&body),
    }))
}

/// Resolved target of a new card: the locator the editor stores plus a title
/// snapshot so the card face renders before the note index is consulted.
struct Target {
    notebook_id: String,
    notebook_name: String,
    relative_path: String,
    title: String,
}

/// `note` is a note or canvas address. Notes are titled the same way canvas
/// note cards are; canvases are not note-indexed, so they are only checked
/// for existence and titled by file stem.
fn resolve_target(note: &str, title: Option<&str>) -> Result<Target, CliError> {
    let (_, notebook, relative) = path_store::address(note)?;
    let snapshot = if flownote_core::canvas::is_canvas_path(&relative) {
        let path = flownote_core::memo_file::notebook_path_from_relative(
            Path::new(&notebook.path),
            &relative,
        )
        .map_err(CliError::Usage)?;
        if !path.is_file() {
            return Err(CliError::NotFound(format!("canvas not found: {note}")));
        }
        Path::new(&relative)
            .file_stem()
            .and_then(|stem| stem.to_str())
            .map(str::to_owned)
    } else {
        path_store::note_title_snapshot(&path_store::show(note)?)
    };
    Ok(Target {
        notebook_id: notebook.id,
        notebook_name: notebook.name,
        relative_path: relative,
        title: title
            .map(str::trim)
            .filter(|title| !title.is_empty())
            .map(str::to_owned)
            .or(snapshot)
            .unwrap_or_default(),
    })
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn add(
    raw: &str,
    note: &str,
    at: Option<usize>,
    layout: Option<&str>,
    color: Option<&str>,
    text: Option<&str>,
    title: Option<&str>,
) -> Result<Value, CliError> {
    let (document, body) = read(raw)?;
    let target = resolve_target(note, title)?;
    let next = notecard::insert(
        &body,
        at,
        &NoteCardInput {
            notebook_id: &target.notebook_id,
            relative_path: &target.relative_path,
            notebook_name: &target.notebook_name,
            title: &target.title,
            layout,
            color,
            custom_text: text,
        },
    )
    .map_err(CliError::Usage)?;
    path_store::write(raw, &next)?;
    Ok(json!({
        "ok": true,
        "action": "notecard.add",
        "address": address(&document),
        "blocks": blocks(&next),
    }))
}

fn field_update(value: Option<&str>, clear: bool) -> FieldUpdate<'_> {
    match (value, clear) {
        (Some(value), _) => FieldUpdate::Set(value),
        (None, true) => FieldUpdate::Clear,
        (None, false) => FieldUpdate::Keep,
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn set(
    raw: &str,
    block: usize,
    layout: Option<&str>,
    title: Option<&str>,
    color: Option<&str>,
    clear_color: bool,
    text: Option<&str>,
    clear_text: bool,
) -> Result<Value, CliError> {
    if color.is_some() && clear_color {
        return Err(CliError::Usage(
            "notecard set: provide at most one of color or clear-color".into(),
        ));
    }
    if text.is_some() && clear_text {
        return Err(CliError::Usage(
            "notecard set: provide at most one of text or clear-text".into(),
        ));
    }
    let (document, body) = read(raw)?;
    let next = notecard::set(
        &body,
        block.saturating_sub(1),
        &NoteCardUpdate {
            layout,
            title,
            color: field_update(color, clear_color),
            custom_text: field_update(text, clear_text),
        },
    )
    .map_err(CliError::Usage)?;
    path_store::write(raw, &next)?;
    Ok(json!({
        "ok": true,
        "action": "notecard.set",
        "address": address(&document),
        "blocks": blocks(&next),
    }))
}

pub(crate) fn remove(raw: &str, block: usize) -> Result<Value, CliError> {
    let (document, body) = read(raw)?;
    let next = notecard::remove(&body, block.saturating_sub(1)).map_err(CliError::Usage)?;
    path_store::write(raw, &next)?;
    Ok(json!({
        "ok": true,
        "action": "notecard.remove",
        "address": address(&document),
        "blocks": blocks(&next),
    }))
}
