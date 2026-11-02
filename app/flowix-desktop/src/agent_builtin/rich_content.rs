//! Flowix rich-content tools for the built-in assistant.
//!
//! Callouts, collapsible toggles, multi-column layouts, line backgrounds and
//! note cards are stored as Flowix-specific Markdown fences / directives. The
//! assistant must never hand-write those; these tools apply the same core
//! transforms as the editor/CLI so the result stays structurally valid.
//!
//! Every mutating action reads the current body and saves with expected-content
//! CAS, mirroring `note_edit`.

use flowix_core::memo_file::{
    callout, columns,
    line_background,
    notecard::{self, FieldUpdate, NoteCardInput, NoteCardUpdate},
    toggle::{self, BackgroundUpdate},
};
use flowix_core::{NoteSaveOutcome, NoteService};
use serde_json::{json, Value};
use std::path::Path;

use super::tools::{normalize_path, ToolScope};

fn action(args: &Value) -> Result<&str, String> {
    args.get("action")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "缺少 action".to_owned())
}

fn path_arg(args: &Value) -> Result<String, String> {
    let raw = args
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| "缺少 path".to_owned())?;
    normalize_path(raw)
}

fn string_arg(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn usize_arg(args: &Value, key: &str) -> Option<usize> {
    args.get(key)
        .and_then(Value::as_u64)
        .map(|value| value as usize)
}

fn bool_arg(args: &Value, key: &str) -> bool {
    args.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn read_body(
    service: &mut NoteService<'_>,
    notebook: &str,
    path: &str,
) -> Result<String, String> {
    service
        .get(notebook, path)
        .map(|document| document.body)
        .map_err(|error| format!("读取笔记失败: {error}"))
}

fn save_body(
    service: &mut NoteService<'_>,
    notebook: &str,
    path: &str,
    body: &str,
    expected: &str,
) -> Result<(), String> {
    match service.save(notebook, path, body, Some(expected)) {
        Ok(NoteSaveOutcome::Saved(_)) => Ok(()),
        Ok(NoteSaveOutcome::Conflict { .. }) => Err(
            "保存冲突：笔记在读取后被修改过。请重新读取笔记后再试".to_owned(),
        ),
        Err(error) => Err(error.to_string()),
    }
}

pub fn execute(
    service: &mut NoteService<'_>,
    notebook: &str,
    name: &str,
    args: &Value,
) -> Result<Value, String> {
    match name {
        "callout" => callout_op(service, notebook, args),
        "toggle" => toggle_op(service, notebook, args),
        "columns" => columns_op(service, notebook, args),
        "background" => background_op(service, notebook, args),
        other => Err(format!("未知富内容工具: {other}")),
    }
}

fn callout_op(
    service: &mut NoteService<'_>,
    notebook: &str,
    args: &Value,
) -> Result<Value, String> {
    let action = action(args)?;
    let path = path_arg(args)?;
    let body = read_body(service, notebook, &path)?;
    match action {
        "list" => Ok(json!({
            "ok": true, "action": "callout.list", "path": path,
            "blocks": callout::parse(&body),
        })),
        "add" => {
            let content = string_arg(args, "content").ok_or("callout add 需要 content")?;
            let next = callout::insert(
                &body,
                usize_arg(args, "at"),
                string_arg(args, "icon").as_deref(),
                string_arg(args, "color").as_deref(),
                &content,
            )?;
            save_body(service, notebook, &path, &next, &body)?;
            Ok(json!({
                "ok": true, "action": "callout.add", "path": path,
                "blocks": callout::parse(&next),
            }))
        }
        "set" => {
            let block = usize_arg(args, "block").ok_or("callout set 需要 block（从 1 开始）")?;
            let next = callout::set(
                &body,
                block.saturating_sub(1),
                string_arg(args, "icon").as_deref(),
                string_arg(args, "color").as_deref(),
            )?;
            save_body(service, notebook, &path, &next, &body)?;
            Ok(json!({
                "ok": true, "action": "callout.set", "path": path,
                "blocks": callout::parse(&next),
            }))
        }
        "remove" => {
            let block = usize_arg(args, "block").ok_or("callout remove 需要 block（从 1 开始）")?;
            let next = callout::remove(&body, block.saturating_sub(1), bool_arg(args, "keepContent"))?;
            save_body(service, notebook, &path, &next, &body)?;
            Ok(json!({
                "ok": true, "action": "callout.remove", "path": path,
                "blocks": callout::parse(&next),
            }))
        }
        other => Err(format!("callout 不支持 action: {other}")),
    }
}

fn toggle_op(
    service: &mut NoteService<'_>,
    notebook: &str,
    args: &Value,
) -> Result<Value, String> {
    let action = action(args)?;
    let path = path_arg(args)?;
    let body = read_body(service, notebook, &path)?;
    match action {
        "list" => Ok(json!({
            "ok": true, "action": "toggle.list", "path": path,
            "blocks": toggle::parse(&body),
        })),
        "add" => {
            let title = string_arg(args, "title").ok_or("toggle add 需要 title")?;
            let content = string_arg(args, "content").unwrap_or_default();
            let next = toggle::insert(
                &body,
                usize_arg(args, "at"),
                &title,
                &content,
                args.get("open").and_then(Value::as_bool).unwrap_or(true),
                string_arg(args, "bg").as_deref(),
            )?;
            save_body(service, notebook, &path, &next, &body)?;
            Ok(json!({
                "ok": true, "action": "toggle.add", "path": path,
                "blocks": toggle::parse(&next),
            }))
        }
        "set" => {
            let block = usize_arg(args, "block").ok_or("toggle set 需要 block（从 1 开始）")?;
            let bg = string_arg(args, "bg");
            let clear_bg = bool_arg(args, "clearBg");
            if bg.is_some() && clear_bg {
                return Err("toggle set: bg 与 clearBg 只能提供一个".into());
            }
            let background = match (bg.as_deref(), clear_bg) {
                (Some(color), false) => BackgroundUpdate::Set(color),
                (None, true) => BackgroundUpdate::Clear,
                _ => BackgroundUpdate::Keep,
            };
            let open = args.get("open").and_then(Value::as_bool);
            let next = toggle::set(
                &body,
                block.saturating_sub(1),
                string_arg(args, "title").as_deref(),
                string_arg(args, "content").as_deref(),
                open,
                background,
            )?;
            save_body(service, notebook, &path, &next, &body)?;
            Ok(json!({
                "ok": true, "action": "toggle.set", "path": path,
                "blocks": toggle::parse(&next),
            }))
        }
        "remove" => {
            let block = usize_arg(args, "block").ok_or("toggle remove 需要 block（从 1 开始）")?;
            let next = toggle::remove(&body, block.saturating_sub(1), bool_arg(args, "keepContent"))?;
            save_body(service, notebook, &path, &next, &body)?;
            Ok(json!({
                "ok": true, "action": "toggle.remove", "path": path,
                "blocks": toggle::parse(&next),
            }))
        }
        other => Err(format!("toggle 不支持 action: {other}")),
    }
}

/// Give the first non-empty line of a column (its title) a line background.
/// Invalid colors or non-text first blocks leave the content untouched.
fn apply_column_title_background(content: &str, color: &str) -> String {
    if content.trim().is_empty() {
        return content.to_owned();
    }
    let Some(line) = content
        .lines()
        .position(|line| !line.trim().is_empty())
        .map(|index| index + 1)
    else {
        return content.to_owned();
    };
    line_background::set(content, line, color).unwrap_or_else(|_| content.to_owned())
}

fn columns_op(
    service: &mut NoteService<'_>,
    notebook: &str,
    args: &Value,
) -> Result<Value, String> {
    let action = action(args)?;
    let path = path_arg(args)?;
    let body = read_body(service, notebook, &path)?;
    match action {
        "list" => Ok(json!({
            "ok": true, "action": "columns.list", "path": path,
            "blocks": columns::parse(&body),
        })),
        "add" => {
            // `contents` lets the model generate a filled layout in one call;
            // otherwise fall back to an empty block with `count` columns.
            let contents = args.get("contents").and_then(Value::as_array).map(|values| {
                values
                    .iter()
                    .map(|value| value.as_str().unwrap_or_default().to_owned())
                    .collect::<Vec<_>>()
            });
            let next = if let Some(contents) = contents {
                let title_color = string_arg(args, "titleColor").unwrap_or_else(|| "yellow".to_owned());
                let specs: Vec<columns::ColumnSpec> = contents
                    .into_iter()
                    .map(|content| columns::ColumnSpec {
                        width: columns::DEFAULT_WIDTH,
                        content: apply_column_title_background(&content, &title_color),
                    })
                    .collect();
                columns::insert_specs(&body, usize_arg(args, "at"), &specs)?
            } else {
                let count = usize_arg(args, "count").ok_or("columns add 需要 count（2-4）或 contents")?;
                columns::insert(&body, usize_arg(args, "at"), count)?
            };
            save_body(service, notebook, &path, &next, &body)?;
            Ok(json!({
                "ok": true, "action": "columns.add", "path": path,
                "blocks": columns::parse(&next),
            }))
        }
        "remove" => {
            let block = usize_arg(args, "block").ok_or("columns remove 需要 block（从 1 开始）")?;
            let column = usize_arg(args, "column").ok_or("columns remove 需要 column（从 1 开始）")?;
            let next = columns::remove_column(
                &body,
                block.saturating_sub(1),
                column.saturating_sub(1),
            )?;
            save_body(service, notebook, &path, &next, &body)?;
            Ok(json!({
                "ok": true, "action": "columns.remove", "path": path,
                "blocks": columns::parse(&next),
            }))
        }
        "width" | "widths" => {
            let block = usize_arg(args, "block").ok_or("columns width 需要 block（从 1 开始）")?;
            let widths: Vec<u32> = args
                .get("widths")
                .and_then(Value::as_array)
                .ok_or("columns width 需要 widths 数组")?
                .iter()
                .map(|value| {
                    value
                        .as_u64()
                        .map(|value| value as u32)
                        .ok_or_else(|| "widths 必须是整数数组".to_owned())
                })
                .collect::<Result<_, _>>()?;
            let next = columns::set_widths(&body, block.saturating_sub(1), &widths)?;
            save_body(service, notebook, &path, &next, &body)?;
            Ok(json!({
                "ok": true, "action": "columns.width", "path": path,
                "blocks": columns::parse(&next),
            }))
        }
        other => Err(format!("columns 不支持 action: {other}")),
    }
}

fn background_op(
    service: &mut NoteService<'_>,
    notebook: &str,
    args: &Value,
) -> Result<Value, String> {
    let action = action(args)?;
    let path = path_arg(args)?;
    let body = read_body(service, notebook, &path)?;
    match action {
        "list" => Ok(json!({
            "ok": true, "action": "background.list", "path": path,
            "blocks": line_background::parse(&body),
        })),
        "set" => {
            let line = usize_arg(args, "line").ok_or("background set 需要 line（从 1 开始）")?;
            let color = string_arg(args, "color").ok_or("background set 需要 color")?;
            let next = line_background::set(&body, line, &color)?;
            save_body(service, notebook, &path, &next, &body)?;
            Ok(json!({
                "ok": true, "action": "background.set", "path": path, "line": line, "color": color,
                "blocks": line_background::parse(&next),
            }))
        }
        "clear" => {
            let line = usize_arg(args, "line").ok_or("background clear 需要 line（从 1 开始）")?;
            let next = line_background::clear(&body, line)?;
            save_body(service, notebook, &path, &next, &body)?;
            Ok(json!({
                "ok": true, "action": "background.clear", "path": path, "line": line,
                "blocks": line_background::parse(&next),
            }))
        }
        other => Err(format!("background 不支持 action: {other}")),
    }
}

/// Note cards (`::notecard`) embed a reference to another note or canvas of
/// the current notebook. Unlike the fenced containers above, `add` has to
/// resolve its target first, which is why this entry point takes the whole
/// [`ToolScope`]: canvases are not note-indexed, so they are checked on disk.
pub fn notecard(
    service: &mut NoteService<'_>,
    scope: &ToolScope,
    args: &Value,
) -> Result<Value, String> {
    let notebook = scope.notebook_id.as_str();
    let action = action(args)?;
    let path = path_arg(args)?;
    let body = read_body(service, notebook, &path)?;
    match action {
        "list" => Ok(json!({
            "ok": true, "action": "notecard.list", "path": path,
            "blocks": notecard::parse(&body),
        })),
        "add" => {
            let target = string_arg(args, "notePath")
                .ok_or("notecard add 需要 notePath（被引用笔记或画布的笔记本内相对路径）")?;
            let target = normalize_path(&target)?;
            let title = notecard_title(service, scope, &target, string_arg(args, "title").as_deref())?;
            let next = notecard::insert(
                &body,
                usize_arg(args, "at"),
                &NoteCardInput {
                    notebook_id: notebook,
                    relative_path: &target,
                    notebook_name: &scope.notebook_name,
                    title: &title,
                    layout: string_arg(args, "layout").as_deref(),
                    color: string_arg(args, "color").as_deref(),
                    custom_text: string_arg(args, "text").as_deref(),
                },
            )?;
            save_body(service, notebook, &path, &next, &body)?;
            Ok(json!({
                "ok": true, "action": "notecard.add", "path": path,
                "blocks": notecard::parse(&next),
            }))
        }
        "set" => {
            let block = usize_arg(args, "block").ok_or("notecard set 需要 block（从 1 开始）")?;
            let color = string_arg(args, "color");
            let clear_color = bool_arg(args, "clearColor");
            if color.is_some() && clear_color {
                return Err("notecard set: color 与 clearColor 只能提供一个".into());
            }
            let text = string_arg(args, "text");
            let clear_text = bool_arg(args, "clearText");
            if text.is_some() && clear_text {
                return Err("notecard set: text 与 clearText 只能提供一个".into());
            }
            let next = notecard::set(
                &body,
                block.saturating_sub(1),
                &NoteCardUpdate {
                    layout: string_arg(args, "layout").as_deref(),
                    title: string_arg(args, "title").as_deref(),
                    color: field_update(color.as_deref(), clear_color),
                    custom_text: field_update(text.as_deref(), clear_text),
                },
            )?;
            save_body(service, notebook, &path, &next, &body)?;
            Ok(json!({
                "ok": true, "action": "notecard.set", "path": path,
                "blocks": notecard::parse(&next),
            }))
        }
        "remove" => {
            let block = usize_arg(args, "block").ok_or("notecard remove 需要 block（从 1 开始）")?;
            let next = notecard::remove(&body, block.saturating_sub(1))?;
            save_body(service, notebook, &path, &next, &body)?;
            Ok(json!({
                "ok": true, "action": "notecard.remove", "path": path,
                "blocks": notecard::parse(&next),
            }))
        }
        other => Err(format!("notecard 不支持 action: {other}")),
    }
}

fn field_update(value: Option<&str>, clear: bool) -> FieldUpdate<'_> {
    match (value, clear) {
        (Some(value), _) => FieldUpdate::Set(value),
        (None, true) => FieldUpdate::Clear,
        (None, false) => FieldUpdate::Keep,
    }
}

/// Title snapshot stored on the card. Notes derive it the same way the note
/// index does; canvases are titled by file stem after an existence check.
fn notecard_title(
    service: &mut NoteService<'_>,
    scope: &ToolScope,
    target: &str,
    title: Option<&str>,
) -> Result<String, String> {
    if let Some(title) = title.map(str::trim).filter(|title| !title.is_empty()) {
        return Ok(title.to_owned());
    }
    if flowix_core::canvas::is_canvas_path(target) {
        let path = flowix_core::canvas::resolve_canvas_path(&scope.notebook_path, target)
            .map_err(|error| error.0)?;
        if !path.is_file() {
            return Err(format!("画布不存在: {target}"));
        }
        return Ok(Path::new(target)
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or_default()
            .to_owned());
    }
    let document = service
        .get(&scope.notebook_id, target)
        .map_err(|error| format!("读取目标笔记失败: {error}"))?;
    let (derived, _) = flowix_core::memo_file::extract_title_and_preview(&document.body);
    Ok(if derived.trim().is_empty() {
        document.entry.title
    } else {
        derived
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use flowix_core::memo_file::{MemoFile, NotebookConfig};
    use std::sync::{Arc, RwLock};

    fn fixture() -> (tempfile::TempDir, Arc<RwLock<MemoFile>>, String, String) {
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
        let mut service = NoteService::new(&memo);
        let document = service
            .create("work", None, "Rich", "# Rich\n正文\n")
            .unwrap();
        let path = document.entry.relative_path.clone();
        (tmp, Arc::new(RwLock::new(memo)), "work".into(), path)
    }

    #[test]
    fn callout_toggle_columns_round_trip() {
        let (_tmp, memo, notebook, path) = fixture();
        let guard = memo.read().unwrap();
        let mut service = NoteService::new(&guard);

        let added = execute(
            &mut service,
            &notebook,
            "callout",
            &json!({ "action": "add", "path": path, "content": "提示内容" }),
        )
        .unwrap();
        assert_eq!(added["blocks"].as_array().unwrap().len(), 1, "{added}");

        let toggled = execute(
            &mut service,
            &notebook,
            "toggle",
            &json!({ "action": "add", "path": path, "title": "详情", "content": "隐藏内容" }),
        )
        .unwrap();
        assert_eq!(toggled["blocks"].as_array().unwrap().len(), 1, "{toggled}");

        let columns = execute(
            &mut service,
            &notebook,
            "columns",
            &json!({ "action": "add", "path": path, "contents": ["左栏内容", "右栏内容"] }),
        )
        .unwrap();
        assert_eq!(columns["blocks"].as_array().unwrap().len(), 1, "{columns}");
        let block = &columns["blocks"][0];
        let left = block["columns"][0]["content"].as_str().unwrap();
        let right = block["columns"][1]["content"].as_str().unwrap();
        assert!(left.contains("左栏内容"), "{left}");
        assert!(right.contains("右栏内容"), "{right}");
        // Column titles get a default line background marker.
        assert!(left.contains("flowix:block-bg"), "{left}");
        assert!(right.contains("flowix:block-bg"), "{right}");

        let body = service.get(&notebook, &path).unwrap().body;
        assert!(body.contains("::: callout"));
        assert!(body.contains("::: toggle"));
        assert!(body.contains("::: columns"));
        assert!(body.contains("左栏内容"));
    }

    #[test]
    fn rejects_unknown_action() {
        let (_tmp, memo, notebook, path) = fixture();
        let guard = memo.read().unwrap();
        let mut service = NoteService::new(&guard);
        let error = execute(
            &mut service,
            &notebook,
            "callout",
            &json!({ "action": "explode", "path": path }),
        )
        .unwrap_err();
        assert!(error.contains("不支持 action"));
    }

    fn scope_for(tmp: &tempfile::TempDir, notebook: &str) -> ToolScope {
        ToolScope {
            notebook_id: notebook.to_owned(),
            notebook_name: "Work".into(),
            notebook_path: tmp.path().join("notes"),
            config_dir: tmp.path().join("config"),
            mark_self_write: Arc::new(|_| {}),
        }
    }

    #[test]
    fn notecard_round_trip() {
        let (tmp, memo, notebook, path) = fixture();
        let guard = memo.read().unwrap();
        let mut service = NoteService::new(&guard);
        let target = service
            .create(&notebook, None, "Target", "# Target note\n\nbody\n")
            .unwrap()
            .entry
            .relative_path;
        let scope = scope_for(&tmp, &notebook);

        let added = notecard(
            &mut service,
            &scope,
            &json!({
                "action": "add", "path": path, "notePath": target,
                "layout": "cardLarge", "color": "blue", "text": "hint",
            }),
        )
        .unwrap();
        let block = &added["blocks"][0];
        assert_eq!(block["address"], format!("work::{target}"));
        assert_eq!(block["title"], "Target note");
        assert_eq!(block["notebookName"], "Work");
        assert_eq!(block["layout"], "cardLarge");
        assert_eq!(block["color"], "blue");
        assert_eq!(block["customText"], "hint");
        assert!(service.get(&notebook, &path).unwrap().body.contains("::notecard{"));

        let updated = notecard(
            &mut service,
            &scope,
            &json!({ "action": "set", "path": path, "block": 1, "layout": "line", "clearColor": true }),
        )
        .unwrap();
        assert_eq!(updated["blocks"][0]["layout"], "line");
        assert_eq!(updated["blocks"][0]["color"], "");
        assert_eq!(updated["blocks"][0]["customText"], "hint");

        let removed = notecard(
            &mut service,
            &scope,
            &json!({ "action": "remove", "path": path, "block": 1 }),
        )
        .unwrap();
        assert!(removed["blocks"].as_array().unwrap().is_empty());
        assert!(!service.get(&notebook, &path).unwrap().body.contains("::notecard"));
    }

    #[test]
    fn notecard_rejects_missing_targets_and_conflicting_updates() {
        let (tmp, memo, notebook, path) = fixture();
        let guard = memo.read().unwrap();
        let mut service = NoteService::new(&guard);
        let scope = scope_for(&tmp, &notebook);

        let no_target = notecard(&mut service, &scope, &json!({ "action": "add", "path": path }))
            .unwrap_err();
        assert!(no_target.contains("notePath"), "{no_target}");

        let missing_note = notecard(
            &mut service,
            &scope,
            &json!({ "action": "add", "path": path, "notePath": "Nope.md" }),
        )
        .unwrap_err();
        assert!(missing_note.contains("读取目标笔记失败"), "{missing_note}");

        let missing_canvas = notecard(
            &mut service,
            &scope,
            &json!({ "action": "add", "path": path, "notePath": "Nope.flowix-canvas" }),
        )
        .unwrap_err();
        assert!(missing_canvas.contains("画布不存在"), "{missing_canvas}");

        let conflict = notecard(
            &mut service,
            &scope,
            &json!({ "action": "set", "path": path, "block": 1, "color": "red", "clearColor": true }),
        )
        .unwrap_err();
        assert!(conflict.contains("只能提供一个"), "{conflict}");
        assert!(!service.get(&notebook, &path).unwrap().body.contains("::notecard"));
    }
}
