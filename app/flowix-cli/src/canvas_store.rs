//! Canvas (`.flowix-canvas`) operations shared by the CLI and MCP adapters.
//!
//! Canvas files are plain JSON outside the Markdown note index: they are read
//! and written at the file layer through the shared `MemoFile` locks (so a
//! concurrent desktop edit and an agent edit serialize safely), never through
//! `NoteService`. Parsing and mutations live in `flowix_core::canvas`.

use crate::{errors::CliError, path_store, store};
use flowix_core::canvas::{self, CanvasDocument, CanvasError, GridPlan, NoteCardInput};
use flowix_core::memo_file::NotebookConfig;
use serde_json::{json, Value};
use std::path::Path;

fn usage(error: CanvasError) -> CliError {
    CliError::Usage(error.0)
}

fn canvas_file(notebook: &NotebookConfig, relative: &str) -> Result<std::path::PathBuf, CliError> {
    canvas::resolve_canvas_path(Path::new(&notebook.path), relative).map_err(usage)
}

/// Load and parse the canvas at `raw` (`<notebook>::<path>` / absolute path).
fn load(
    raw: &str,
) -> Result<
    (
        flowix_core::memo_file::MemoFile,
        NotebookConfig,
        String,
        CanvasDocument,
    ),
    CliError,
> {
    let (mf, notebook, relative) = path_store::address(raw)?;
    let absolute = canvas_file(&notebook, &relative)?;
    let text = std::fs::read_to_string(&absolute).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => {
            CliError::NotFound(format!("canvas not found: {}::{}", notebook.id, relative))
        }
        _ => CliError::Io(std::io::Error::new(
            error.kind(),
            format!("read canvas: {error}"),
        )),
    })?;
    let document = CanvasDocument::parse(&text, &canvas::now_iso())
        .map_err(|error| CliError::Usage(error.0))?;
    Ok((mf, notebook, relative, document))
}

/// Serialize and write the canvas back under the shared file lock.
fn save(
    mf: &flowix_core::memo_file::MemoFile,
    notebook: &NotebookConfig,
    relative: &str,
    document: &CanvasDocument,
) -> Result<(), CliError> {
    let absolute = canvas_file(notebook, relative)?;
    mf.write_file_for_notebook(&notebook.id, &absolute, document.serialize().as_bytes())
        .map_err(|error| {
            CliError::Io(std::io::Error::new(
                error.kind(),
                format!("write canvas: {error}"),
            ))
        })
}

fn canvas_payload(
    action: &str,
    notebook: &NotebookConfig,
    relative: &str,
    document: &CanvasDocument,
) -> Value {
    let mut payload = document.summary();
    let object = payload.as_object_mut().expect("summary is an object");
    object.insert("ok".into(), json!(true));
    object.insert("action".into(), json!(action));
    object.insert("notebookId".into(), json!(notebook.id));
    object.insert("relativePath".into(), json!(relative));
    object.insert(
        "address".into(),
        json!(format!("{}::{}", notebook.id, relative)),
    );
    payload
}

fn counts(document: &CanvasDocument) -> Value {
    document.summary()["counts"].clone()
}

/// `flowix canvas create` / `canvas.create` — new empty canvas with a unique
/// name, mirroring the frontend's create dialog (` (N)` suffixes).
pub(crate) fn create(
    notebook_key: Option<&str>,
    name: &str,
    folder: Option<&str>,
) -> Result<Value, CliError> {
    let mf = store::open()?;
    let notebook =
        store::resolve_notebook_config(&mf, store::resolve_notebook_key(notebook_key)?.as_str())?;
    let folder = folder
        .map(str::trim)
        .filter(|folder| !folder.is_empty())
        .map(normalize_folder)
        .transpose()?;
    let parent = match &folder {
        Some(relative) => {
            flowix_core::memo_file::notebook_path_from_relative(Path::new(&notebook.path), relative)
                .map_err(|error| CliError::Usage(format!("invalid folder: {error}")))?
        }
        None => Path::new(&notebook.path).to_path_buf(),
    };
    let filename = canvas::unique_canvas_filename(&parent, name);
    let relative = match &folder {
        Some(relative) => format!("{relative}/{filename}"),
        None => filename,
    };
    let absolute = canvas_file(&notebook, &relative)?;
    if let Some(parent_dir) = absolute.parent() {
        std::fs::create_dir_all(parent_dir).map_err(|error| {
            CliError::Io(std::io::Error::new(
                error.kind(),
                format!("create folder: {error}"),
            ))
        })?;
    }
    mf.create_file_for_notebook(
        &notebook.id,
        &absolute,
        CanvasDocument::create_text(&canvas::now_iso()).as_bytes(),
    )
    .map_err(|error| match error.kind() {
        std::io::ErrorKind::AlreadyExists => {
            CliError::Conflict(format!("canvas already exists: {relative}"))
        }
        _ => CliError::Io(std::io::Error::new(
            error.kind(),
            format!("create canvas: {error}"),
        )),
    })?;
    Ok(json!({
        "ok": true, "action": "created", "notebookId": notebook.id,
        "relativePath": relative, "address": format!("{}::{}", notebook.id, relative),
        "path": absolute,
    }))
}

fn normalize_folder(raw: &str) -> Result<String, CliError> {
    let normalized = raw.replace('\\', "/");
    if normalized.is_empty()
        || normalized.starts_with('/')
        || normalized
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == ".." || part.starts_with('.'))
    {
        return Err(CliError::Usage(format!("invalid folder: {raw}")));
    }
    Ok(normalized)
}

/// Card title snapshot for a note, derived the same way the board renders
/// card faces (`extract_title_and_preview`), falling back to the note index
/// entry title.
fn note_title_snapshot(document_note: &Value) -> Option<String> {
    let body = document_note
        .get("body")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let (derived, _) = flowix_core::memo_file::extract_title_and_preview(body);
    (!derived.trim().is_empty()).then_some(derived).or_else(|| {
        document_note
            .get("note")
            .and_then(|note| note.get("title"))
            .and_then(Value::as_str)
            .filter(|title| !title.trim().is_empty())
            .map(str::to_owned)
    })
}

/// `flowix canvas show` / `canvas.show` — normalized board summary.
pub(crate) fn show(raw: &str) -> Result<Value, CliError> {
    let (_, notebook, relative, document) = load(raw)?;
    Ok(canvas_payload(
        "canvas.show",
        &notebook,
        &relative,
        &document,
    ))
}

/// Optional position/size shared by the add commands.
pub(crate) struct Placement {
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub w: Option<f64>,
    pub h: Option<f64>,
}

/// `flowix canvas add-card` / `canvas.addCard` — one note or sticky card.
/// `note` is a note address (`<notebook>::<path>`); its id and title snapshot
/// come from the note index, so the card face renders on every device.
pub(crate) fn add_card(
    raw: &str,
    note: Option<&str>,
    text: Option<&str>,
    color: Option<&str>,
    title: Option<&str>,
    placement: Placement,
) -> Result<Value, CliError> {
    let (mf, notebook, relative, mut document) = load(raw)?;
    let id = match (note, text) {
        (Some(note_address), _) => {
            let document_note = path_store::show(note_address)?;
            let note_notebook = document_note
                .get("notebookId")
                .and_then(Value::as_str)
                .ok_or_else(|| CliError::NotFound(format!("note not found: {note_address}")))?;
            let note_path = document_note
                .get("relativePath")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let note_title = title
                .map(str::to_owned)
                .or_else(|| note_title_snapshot(&document_note));
            let notebook_name = mf
                .read_notebook_configs()?
                .into_iter()
                .find(|config| config.id == note_notebook)
                .map(|config| config.name);
            document
                .add_note_card(
                    &NoteCardInput {
                        notebook_id: note_notebook.to_owned(),
                        notebook_name,
                        path: note_path,
                        title: note_title,
                        x: placement.x,
                        y: placement.y,
                        w: placement.w,
                        h: placement.h,
                        render_scope: None,
                        heading: None,
                    },
                    &canvas::now_iso(),
                )
                .map_err(usage)?
        }
        (None, Some(text)) => document
            .add_text_card(
                &canvas::TextCardInput {
                    x: placement.x,
                    y: placement.y,
                    w: placement.w,
                    h: placement.h,
                    text: Some(text.to_owned()),
                    color: color.map(str::to_owned),
                },
                &canvas::now_iso(),
            )
            .map_err(usage)?,
        (None, None) => {
            return Err(CliError::Usage(
                "canvas add-card requires --note <note-address> or --text <text>".into(),
            ))
        }
    };
    save(&mf, &notebook, &relative, &document)?;
    Ok(json!({
        "ok": true, "action": "canvas.addCard", "address": format!("{}::{}", notebook.id, relative),
        "id": id, "counts": counts(&document),
    }))
}

/// `flowix canvas update` / `canvas.updateElement` — move / resize / retext /
/// relink one existing element. Blank text-ish values clear the attribute.
pub(crate) fn update(
    raw: &str,
    element_id: &str,
    args: &UpdateArgs<'_>,
) -> Result<Value, CliError> {
    let (mf, notebook, relative, mut document) = load(raw)?;
    let patch = canvas::ElementPatch {
        x: args.x,
        y: args.y,
        w: args.w,
        h: args.h,
        x2: args.x2,
        y2: args.y2,
        text: args.text.map(str::to_owned),
        color: args.color.map(str::to_owned),
        fill: args.fill.map(str::to_owned),
        stroke: args.stroke.map(str::to_owned),
        label: args.label.map(str::to_owned),
        from: args.from.map(str::to_owned),
        to: args.to.map(str::to_owned),
        title: args.title.map(str::to_owned),
    };
    let kind = document
        .update_element(element_id, &patch, &canvas::now_iso())
        .map_err(usage)?;
    save(&mf, &notebook, &relative, &document)?;
    Ok(json!({
        "ok": true, "action": "canvas.updateElement", "address": format!("{}::{}", notebook.id, relative),
        "id": element_id, "kind": kind, "counts": counts(&document),
    }))
}

/// Update patch for [`update`], grouped to keep the call sites flat.
#[derive(Default)]
pub(crate) struct UpdateArgs<'a> {
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub w: Option<f64>,
    pub h: Option<f64>,
    pub x2: Option<f64>,
    pub y2: Option<f64>,
    pub text: Option<&'a str>,
    pub color: Option<&'a str>,
    pub fill: Option<&'a str>,
    pub stroke: Option<&'a str>,
    pub label: Option<&'a str>,
    pub from: Option<&'a str>,
    pub to: Option<&'a str>,
    pub title: Option<&'a str>,
}

/// Shape attributes for [`add_shape`], grouped to keep the call sites flat.
pub(crate) struct ShapeArgs<'a> {
    pub shape: &'a str,
    pub text: Option<&'a str>,
    pub fill: Option<&'a str>,
    pub stroke: Option<&'a str>,
    pub placement: Placement,
    pub x2: Option<f64>,
    pub y2: Option<f64>,
}

/// `flowix canvas add-shape` / `canvas.addShape`.
pub(crate) fn add_shape(raw: &str, args: ShapeArgs<'_>) -> Result<Value, CliError> {
    let (mf, notebook, relative, mut document) = load(raw)?;
    let id = document
        .add_shape(
            &canvas::ShapeInput {
                shape: args.shape.to_owned(),
                x: args.placement.x,
                y: args.placement.y,
                w: args.placement.w,
                h: args.placement.h,
                x2: args.x2,
                y2: args.y2,
                text: args.text.map(str::to_owned),
                fill: args.fill.map(str::to_owned),
                stroke: args.stroke.map(str::to_owned),
                font_size: None,
                text_align: None,
            },
            &canvas::now_iso(),
        )
        .map_err(usage)?;
    save(&mf, &notebook, &relative, &document)?;
    Ok(json!({
        "ok": true, "action": "canvas.addShape", "address": format!("{}::{}", notebook.id, relative),
        "id": id, "counts": counts(&document),
    }))
}

/// `flowix canvas add-edge` / `canvas.addEdge`.
pub(crate) fn add_edge(
    raw: &str,
    from: &str,
    to: &str,
    label: Option<&str>,
) -> Result<Value, CliError> {
    let (mf, notebook, relative, mut document) = load(raw)?;
    let id = document
        .add_edge(from, to, label, &canvas::now_iso())
        .map_err(usage)?;
    save(&mf, &notebook, &relative, &document)?;
    Ok(json!({
        "ok": true, "action": "canvas.addEdge", "address": format!("{}::{}", notebook.id, relative),
        "id": id, "counts": counts(&document),
    }))
}

/// `flowix canvas add-frame` / `canvas.addFrame`.
pub(crate) fn add_frame(
    raw: &str,
    title: Option<&str>,
    placement: Placement,
) -> Result<Value, CliError> {
    let (mf, notebook, relative, mut document) = load(raw)?;
    let id = document
        .add_frame(
            &canvas::FrameInput {
                title: title.map(str::to_owned),
                x: placement.x,
                y: placement.y,
                w: placement.w,
                h: placement.h,
            },
            &canvas::now_iso(),
        )
        .map_err(usage)?;
    save(&mf, &notebook, &relative, &document)?;
    Ok(json!({
        "ok": true, "action": "canvas.addFrame", "address": format!("{}::{}", notebook.id, relative),
        "id": id, "counts": counts(&document),
    }))
}

/// `flowix canvas add-notes` / `canvas.addNotes` — place several notes as a
/// grid of note cards ("把 10 篇笔记摆上画布").
pub(crate) fn add_notes(
    raw: &str,
    note_addresses: &[String],
    grid: GridPlan,
) -> Result<Value, CliError> {
    if note_addresses.is_empty() {
        return Err(CliError::Usage("canvas add-notes requires --notes".into()));
    }
    let (mf, notebook, relative, mut document) = load(raw)?;
    let inputs = note_addresses
        .iter()
        .map(|note_address| {
            let document_note = path_store::show(note_address)?;
            let note_notebook = document_note
                .get("notebookId")
                .and_then(Value::as_str)
                .ok_or_else(|| CliError::NotFound(format!("note not found: {note_address}")))?;
            let notebook_name = mf
                .read_notebook_configs()?
                .into_iter()
                .find(|config| config.id == note_notebook)
                .map(|config| config.name);
            Ok(NoteCardInput {
                notebook_id: note_notebook.to_owned(),
                notebook_name,
                path: document_note
                    .get("relativePath")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                title: note_title_snapshot(&document_note),
                x: None,
                y: None,
                w: grid.w,
                h: grid.h,
                render_scope: None,
                heading: None,
            })
        })
        .collect::<Result<Vec<_>, CliError>>()?;
    let ids = document
        .add_note_cards(&inputs, &grid, &canvas::now_iso())
        .map_err(usage)?;
    save(&mf, &notebook, &relative, &document)?;
    Ok(json!({
        "ok": true, "action": "canvas.addNotes", "address": format!("{}::{}", notebook.id, relative),
        "ids": ids, "counts": counts(&document),
    }))
}

/// `flowix canvas remove` / `canvas.remove` — delete elements by id
/// (edges referencing them go with them).
pub(crate) fn remove(raw: &str, ids: &[String]) -> Result<Value, CliError> {
    if ids.is_empty() {
        return Err(CliError::Usage("canvas remove requires --ids".into()));
    }
    let borrowed: Vec<&str> = ids.iter().map(String::as_str).collect();
    let (mf, notebook, relative, mut document) = load(raw)?;
    let report = document.remove(&borrowed, &canvas::now_iso());
    if report.removed.is_empty() {
        return Err(CliError::NotFound(
            "no elements matched the given ids".into(),
        ));
    }
    save(&mf, &notebook, &relative, &document)?;
    Ok(json!({
        "ok": true, "action": "canvas.remove", "address": format!("{}::{}", notebook.id, relative),
        "removed": report.removed, "removedEdges": report.removed_edges,
        "counts": counts(&document),
    }))
}

#[cfg(test)]
mod tests;
