//! Canvas tool for the built-in assistant.
//!
//! One `canvas` tool with an `action` enum, mirroring the rich-content tools
//! (`callout` / `toggle` / ...). Actions operate on `.flowix-canvas` board
//! documents through `flowix_core::canvas`; files are read and written under
//! the shared `MemoFile` file locks and marked as self-writes so the watcher
//! does not mistake agent edits for external ones. Note-card titles are
//! snapshotted the same way the board renders card faces.

use flowix_core::canvas::{self, CanvasDocument, GridPlan, NoteCardInput};
use flowix_core::NoteService;
use serde_json::{json, Value};

use super::tools::{mark_file_self_write, normalize_path, string_arg, ToolScope};
use flowix_core::memo_file::MemoFile;

pub(crate) fn execute(
    memo_file: &MemoFile,
    service: &mut NoteService<'_>,
    scope: &ToolScope,
    args: &Value,
) -> Result<Value, String> {
    let action = string_arg(args, "action").ok_or("缺少 action")?;
    match action.as_str() {
        "create" => create(memo_file, scope, args),
        "list" => list(scope),
        "read" => {
            let (relative, document) = load(scope, args)?;
            let mut summary = document.summary();
            let object = summary.as_object_mut().expect("summary is an object");
            object.insert("ok".into(), json!(true));
            object.insert("action".into(), json!("canvas.read"));
            object.insert("path".into(), json!(relative));
            Ok(summary)
        }
        "addCard" => {
            let (relative, mut document) = load(scope, args)?;
            let id = add_card(service, scope, args, &mut document)?;
            save(memo_file, scope, &relative, &document)?;
            Ok(json!({ "ok": true, "action": "canvas.addCard", "path": relative,
                "id": id, "counts": counts(&document) }))
        }
        "addShape" => {
            let (relative, mut document) = load(scope, args)?;
            let id = document
                .add_shape(
                    &canvas::ShapeInput {
                        shape: string_arg(args, "shape").ok_or("缺少 shape")?,
                        x: number_arg(args, "x"),
                        y: number_arg(args, "y"),
                        w: number_arg(args, "w"),
                        h: number_arg(args, "h"),
                        x2: number_arg(args, "x2"),
                        y2: number_arg(args, "y2"),
                        text: string_arg(args, "text"),
                        fill: string_arg(args, "fill"),
                        stroke: string_arg(args, "stroke"),
                        font_size: number_arg(args, "fontSize"),
                        text_align: string_arg(args, "textAlign"),
                    },
                    &canvas::now_iso(),
                )
                .map_err(|error| error.0)?;
            save(memo_file, scope, &relative, &document)?;
            Ok(json!({ "ok": true, "action": "canvas.addShape", "path": relative,
                "id": id, "counts": counts(&document) }))
        }
        "addEdge" => {
            let (relative, mut document) = load(scope, args)?;
            let id = document
                .add_edge(
                    &string_arg(args, "from").ok_or("缺少 from")?,
                    &string_arg(args, "to").ok_or("缺少 to")?,
                    string_arg(args, "label").as_deref(),
                    &canvas::now_iso(),
                )
                .map_err(|error| error.0)?;
            save(memo_file, scope, &relative, &document)?;
            Ok(json!({ "ok": true, "action": "canvas.addEdge", "path": relative,
                "id": id, "counts": counts(&document) }))
        }
        "addFrame" => {
            let (relative, mut document) = load(scope, args)?;
            let id = document
                .add_frame(
                    &canvas::FrameInput {
                        title: string_arg(args, "title"),
                        x: number_arg(args, "x"),
                        y: number_arg(args, "y"),
                        w: number_arg(args, "w"),
                        h: number_arg(args, "h"),
                    },
                    &canvas::now_iso(),
                )
                .map_err(|error| error.0)?;
            save(memo_file, scope, &relative, &document)?;
            Ok(json!({ "ok": true, "action": "canvas.addFrame", "path": relative,
                "id": id, "counts": counts(&document) }))
        }
        "addNotes" => {
            let (relative, mut document) = load(scope, args)?;
            let note_paths = args
                .get("notePaths")
                .and_then(Value::as_array)
                .ok_or("缺少 notePaths（笔记相对路径数组）")?
                .iter()
                .map(|value| {
                    value
                        .as_str()
                        .map(str::trim)
                        .filter(|path| !path.is_empty())
                        .map(str::to_owned)
                        .ok_or("notePaths 必须是非空字符串数组")
                })
                .collect::<Result<Vec<_>, _>>()?;
            let inputs = note_paths
                .iter()
                .map(|note_path| note_card_input(service, scope, note_path, None))
                .collect::<Result<Vec<_>, _>>()?;
            let ids = document
                .add_note_cards(
                    &inputs,
                    &GridPlan {
                        columns: args
                            .get("columns")
                            .and_then(Value::as_u64)
                            .unwrap_or(3) as usize,
                        gap_x: number_arg(args, "gapX").unwrap_or(canvas::AUTO_PLACE_GAP),
                        gap_y: number_arg(args, "gapY").unwrap_or(canvas::AUTO_PLACE_GAP),
                        w: number_arg(args, "w"),
                        h: number_arg(args, "h"),
                        start: number_arg(args, "x").zip(number_arg(args, "y")),
                    },
                    &canvas::now_iso(),
                )
                .map_err(|error| error.0)?;
            save(memo_file, scope, &relative, &document)?;
            Ok(json!({ "ok": true, "action": "canvas.addNotes", "path": relative,
                "ids": ids, "counts": counts(&document) }))
        }
        "update" => {
            let (relative, mut document) = load(scope, args)?;
            let id = string_arg(args, "id").ok_or("缺少 id（要更新的元素 id，来自 read）")?;
            let patch = canvas::ElementPatch {
                x: number_arg(args, "x"),
                y: number_arg(args, "y"),
                w: number_arg(args, "w"),
                h: number_arg(args, "h"),
                x2: number_arg(args, "x2"),
                y2: number_arg(args, "y2"),
                text: string_arg(args, "text"),
                color: string_arg(args, "color"),
                fill: string_arg(args, "fill"),
                stroke: string_arg(args, "stroke"),
                label: string_arg(args, "label"),
                from: string_arg(args, "from"),
                to: string_arg(args, "to"),
                title: string_arg(args, "title"),
            };
            let kind = document
                .update_element(&id, &patch, &canvas::now_iso())
                .map_err(|error| error.0)?;
            save(memo_file, scope, &relative, &document)?;
            Ok(json!({ "ok": true, "action": "canvas.update", "path": relative,
                "id": id, "kind": kind, "counts": counts(&document) }))
        }
        "remove" => {
            let (relative, mut document) = load(scope, args)?;
            let ids = args
                .get("ids")
                .and_then(Value::as_array)
                .ok_or("缺少 ids（元素 id 数组）")?
                .iter()
                .map(|value| {
                    value
                        .as_str()
                        .map(str::to_owned)
                        .filter(|id| !id.is_empty())
                        .ok_or("ids 必须是非空字符串数组")
                })
                .collect::<Result<Vec<_>, _>>()?;
            let borrowed: Vec<&str> = ids.iter().map(String::as_str).collect();
            let report = document.remove(&borrowed, &canvas::now_iso());
            if report.removed.is_empty() {
                return Err("没有匹配到任何元素 id".into());
            }
            save(memo_file, scope, &relative, &document)?;
            Ok(json!({ "ok": true, "action": "canvas.remove", "path": relative,
                "removed": report.removed, "removedEdges": report.removed_edges,
                "counts": counts(&document) }))
        }
        other => Err(format!(
            "未知 canvas action: {other}（可用 create/list/read/addCard/addShape/addEdge/addFrame/addNotes/update/remove）"
        )),
    }
}

fn counts(document: &CanvasDocument) -> Value {
    document.summary()["counts"].clone()
}

/// Load the canvas named by `args.path`.
fn load(scope: &ToolScope, args: &Value) -> Result<(String, CanvasDocument), String> {
    let relative = normalize_path(&string_arg(args, "path").ok_or("缺少 path")?)?;
    let absolute =
        canvas::resolve_canvas_path(&scope.notebook_path, &relative).map_err(|error| error.0)?;
    let text = std::fs::read_to_string(&absolute).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => format!("画布不存在: {relative}"),
        _ => format!("读取画布失败: {error}"),
    })?;
    let document = CanvasDocument::parse(&text, &canvas::now_iso()).map_err(|error| error.0)?;
    Ok((relative, document))
}

fn save(
    memo_file: &MemoFile,
    scope: &ToolScope,
    relative: &str,
    document: &CanvasDocument,
) -> Result<(), String> {
    let absolute =
        canvas::resolve_canvas_path(&scope.notebook_path, relative).map_err(|error| error.0)?;
    memo_file
        .write_file_for_notebook(
            &scope.notebook_id,
            &absolute,
            document.serialize().as_bytes(),
        )
        .map_err(|error| format!("写入画布失败: {error}"))?;
    mark_file_self_write(scope, &absolute);
    Ok(())
}

fn create(memo_file: &MemoFile, scope: &ToolScope, args: &Value) -> Result<Value, String> {
    let name = string_arg(args, "name")
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "Untitled".into());
    let parent = args
        .get("parent")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|parent| !parent.is_empty())
        .map(normalize_path)
        .transpose()?;
    let parent_dir = match &parent {
        Some(parent) => {
            canvas::resolve_canvas_path(&scope.notebook_path, &format!("{parent}/x.flowix-canvas"))
                .map_err(|error| error.0)?
                .parent()
                .expect("canvas path has a parent")
                .to_path_buf()
        }
        None => scope.notebook_path.clone(),
    };
    let filename = canvas::unique_canvas_filename(&parent_dir, &name);
    let relative = match &parent {
        Some(parent) => format!("{parent}/{filename}"),
        None => filename,
    };
    let absolute =
        canvas::resolve_canvas_path(&scope.notebook_path, &relative).map_err(|error| error.0)?;
    if let Some(parent_dir) = absolute.parent() {
        std::fs::create_dir_all(parent_dir).map_err(|error| format!("创建目录失败: {error}"))?;
    }
    memo_file
        .create_file_for_notebook(
            &scope.notebook_id,
            &absolute,
            CanvasDocument::create_text(&canvas::now_iso()).as_bytes(),
        )
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::AlreadyExists => format!("画布已存在: {relative}"),
            _ => format!("创建画布失败: {error}"),
        })?;
    mark_file_self_write(scope, &absolute);
    Ok(json!({ "ok": true, "action": "created", "path": relative }))
}

fn list(scope: &ToolScope) -> Result<Value, String> {
    let paths = canvas::list_canvas_files(&scope.notebook_path);
    Ok(json!({ "ok": true, "action": "canvas.list", "total": paths.len(), "canvases": paths }))
}

/// One note card input resolved against the current notebook: title snapshot
/// derived from the note body (the same face the board renders), falling back
/// to the note index entry title.
fn note_card_input(
    service: &mut NoteService<'_>,
    scope: &ToolScope,
    raw_note_path: &str,
    title_override: Option<String>,
) -> Result<NoteCardInput, String> {
    let note_path = normalize_path(raw_note_path)?;
    let document = service
        .get(&scope.notebook_id, &note_path)
        .map_err(|error| format!("读取笔记失败（可能不存在）: {error}"))?;
    let (derived, _) = flowix_core::memo_file::extract_title_and_preview(&document.body);
    let title = title_override
        .or_else(|| (!derived.trim().is_empty()).then_some(derived))
        .or_else(|| {
            let entry_title = document.entry.title.clone();
            (!entry_title.trim().is_empty()).then_some(entry_title)
        });
    Ok(NoteCardInput {
        notebook_id: scope.notebook_id.clone(),
        notebook_name: Some(scope.notebook_name.clone()),
        path: note_path,
        title,
        x: None,
        y: None,
        w: None,
        h: None,
        render_scope: None,
        heading: None,
    })
}

fn add_card(
    service: &mut NoteService<'_>,
    scope: &ToolScope,
    args: &Value,
    document: &mut CanvasDocument,
) -> Result<String, String> {
    let note_path = string_arg(args, "notePath");
    let text = string_arg(args, "text");
    let position = (
        number_arg(args, "x"),
        number_arg(args, "y"),
        number_arg(args, "w"),
        number_arg(args, "h"),
    );
    match (note_path, text) {
        (Some(note_path), _) => {
            let input = note_card_input(service, scope, &note_path, string_arg(args, "title"))?;
            let mut positioned = input;
            positioned.x = position.0;
            positioned.y = position.1;
            positioned.w = position.2;
            positioned.h = position.3;
            document
                .add_note_card(&positioned, &canvas::now_iso())
                .map_err(|error| error.0)
        }
        (None, Some(text)) => document
            .add_text_card(
                &canvas::TextCardInput {
                    x: position.0,
                    y: position.1,
                    w: position.2,
                    h: position.3,
                    text: Some(text),
                    color: string_arg(args, "color"),
                },
                &canvas::now_iso(),
            )
            .map_err(|error| error.0),
        (None, None) => Err("addCard 需要 notePath（笔记卡片）或 text（便签）之一".into()),
    }
}

fn number_arg(args: &Value, key: &str) -> Option<f64> {
    args.get(key)
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_builtin::tools::{execute as tools_execute, ToolScope};
    use flowix_core::memo_file::{MemoFile, NotebookConfig};
    use std::sync::{Arc, RwLock};

    fn fixture() -> (tempfile::TempDir, Arc<RwLock<MemoFile>>, ToolScope) {
        let tmp = tempfile::tempdir().unwrap();
        let notebook_path = tmp.path().join("notes");
        std::fs::create_dir_all(&notebook_path).unwrap();
        let memo = MemoFile::new(tmp.path().to_path_buf());
        memo.write_notebook_configs(&[NotebookConfig {
            id: "work".into(),
            name: "Work".into(),
            icon: None,
            path: notebook_path.to_string_lossy().to_string(),
            is_default: true,
            sort: 0,
            created_at: 0,
            updated_at: 0,
        }])
        .unwrap();
        let scope = ToolScope {
            notebook_id: "work".into(),
            notebook_name: "Work".into(),
            notebook_path: notebook_path,
            config_dir: tmp.path().join("config"),
            mark_self_write: Arc::new(|_| {}),
        };
        (tmp, Arc::new(RwLock::new(memo)), scope)
    }

    #[test]
    fn canvas_tool_builds_a_board_end_to_end() {
        let (tmp, memo, scope) = fixture();
        // Seed two notes through the note tools.
        let created = tools_execute(
            &memo,
            &scope,
            "note_create",
            r##"{"title":"A 篇","content":"# A 篇\n正文\n"}"##,
        );
        assert_eq!(created["ok"], true, "{created}");
        tools_execute(
            &memo,
            &scope,
            "note_create",
            r##"{"title":"B 篇","content":"# B 篇\n正文\n"}"##,
        );

        let call = |arguments: Value| {
            let guard = memo.read().unwrap();
            let mut service = NoteService::new(&guard);
            execute(&guard, &mut service, &scope, &arguments)
        };

        // Create + list.
        let created = call(json!({"action":"create", "name":"计划", "parent":"画布"})).unwrap();
        let path = created["path"].as_str().unwrap().to_owned();
        assert_eq!(path, "画布/计划.flowix-canvas");
        let on_disk = std::fs::read_to_string(
            tmp.path()
                .join("notes")
                .join("画布")
                .join("计划.flowix-canvas"),
        )
        .unwrap();
        assert!(
            on_disk.starts_with("{\n  \"type\": \"flowix/canvas\""),
            "{on_disk}"
        );
        let listed = call(json!({"action":"list"})).unwrap();
        assert_eq!(listed["canvases"].as_array().unwrap().len(), 1);

        // Sticky + note card + shape + edge.
        let sticky =
            call(json!({"action":"addCard", "path":path, "text":"便签", "color":"blue"})).unwrap();
        let sticky_id = sticky["id"].as_str().unwrap().to_owned();
        let note_card =
            call(json!({"action":"addCard", "path":path, "notePath":"A 篇.md"})).unwrap();
        let note_card_id = note_card["id"].as_str().unwrap().to_owned();
        let shape =
            call(json!({"action":"addShape", "path":path, "shape":"rect", "text":"节点"})).unwrap();
        let shape_id = shape["id"].as_str().unwrap().to_owned();
        let edge = call(json!({"action":"addEdge", "path":path, "from":note_card_id, "to":shape_id, "label":"依赖"})).unwrap();
        let edge_id = edge["id"].as_str().unwrap().to_owned();
        assert!(edge_id.starts_with("e_"));

        // Note card got the derived title.
        let read = call(json!({"action":"read", "path":path})).unwrap();
        let note_entry = read["cards"]
            .as_array()
            .unwrap()
            .iter()
            .find(|card| card["id"] == note_card_id.as_str())
            .unwrap();
        assert_eq!(note_entry["kind"], "note");
        assert_eq!(note_entry["title"], "A 篇");
        assert_eq!(note_entry["notebookName"], "Work");

        // Batch grid.
        let batch = call(json!({"action":"addNotes", "path":path,
            "notePaths":["A 篇.md", "B 篇.md"], "columns":2}))
        .unwrap();
        assert_eq!(batch["ids"].as_array().unwrap().len(), 2);
        assert_eq!(batch["counts"]["cards"], 4, "{batch}");

        // Update: move the sticky, relabel the edge.
        let moved = call(
            json!({"action":"update", "path":path, "id":sticky_id, "x":200, "y":80, "text":"移动过"}),
        )
        .unwrap();
        assert_eq!(moved["kind"], "card", "{moved}");
        let relabeled =
            call(json!({"action":"update", "path":path, "id":edge_id, "label":"改标注"})).unwrap();
        assert_eq!(relabeled["kind"], "edge", "{relabeled}");
        let read_after_update = call(json!({"action":"read", "path":path})).unwrap();
        let moved_card = read_after_update["cards"]
            .as_array()
            .unwrap()
            .iter()
            .find(|card| card["id"] == sticky_id.as_str())
            .unwrap();
        assert_eq!(moved_card["x"].as_f64(), Some(200.0));
        assert_eq!(moved_card["text"], "移动过");

        // Remove cascades the edge.
        let removed =
            call(json!({"action":"remove", "path":path, "ids":[note_card_id, sticky_id]})).unwrap();
        assert_eq!(removed["removedEdges"].as_array().unwrap().len(), 1);
        assert_eq!(removed["counts"]["cards"], 2, "{removed}");

        // Unknown action / bad color are reported as strings.
        assert!(call(json!({"action":"layout", "path":path})).is_err());
        assert!(
            call(json!({"action":"addCard", "path":path, "text":"x", "color":"pink"})).is_err()
        );
        assert!(call(json!({"action":"read", "path":"notes/a.md"})).is_err());
    }
}
