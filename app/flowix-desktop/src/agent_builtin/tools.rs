//! Note tools for the built-in assistant.
//!
//! Every tool is scoped to one notebook (the conversation's notebook) and
//! goes through `flowix_core::NoteService`, which owns path validation, the
//! note index and compare-and-save protection. Tool results are plain JSON
//! values the model reads back on the next turn.

use std::sync::{Arc, RwLock};

use flowix_core::memo_file::MemoFile;
use flowix_core::{NoteSaveOutcome, NoteService};
use serde_json::{json, Value};

/// Result size sent back to the model. Full data still reaches the UI via the
/// ToolResult chunk when smaller; oversized bodies are truncated here.
const MAX_TOOL_RESULT_CHARS: usize = 24_000;
const LIST_PAGE_SIZE: usize = 100;
const SEARCH_LIMIT: usize = 20;

/// The notebook all tool calls operate on.
#[derive(Debug, Clone)]
pub struct ToolScope {
    pub notebook_id: String,
    pub notebook_name: String,
}

pub fn tool_definitions(web_search_enabled: bool) -> Value {
    let mut tools = json!([
        {
            "type": "function",
            "function": {
                "name": "note_list",
                "description": "列出当前笔记本中的笔记（按更新时间排序）。用于浏览或定位笔记路径。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "offset": { "type": "integer", "description": "分页偏移，默认 0" }
                    }
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "note_search",
                "description": "在当前笔记本中全文搜索笔记，支持可选标签过滤。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "搜索关键词" },
                        "tag": { "type": "string", "description": "可选标签路径过滤，如 项目/Flowix" },
                        "limit": { "type": "integer", "description": "最多返回条数，默认 10，上限 20" }
                    },
                    "required": ["query"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "note_read",
                "description": "读取一篇笔记的完整 Markdown 正文。修改前必须先读取。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "笔记本内相对路径，如 会议/2026-10-25.md" }
                    },
                    "required": ["path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "note_create",
                "description": "在当前笔记本新建一篇笔记，返回实际落盘路径。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "title": { "type": "string", "description": "笔记标题（决定文件名）" },
                        "content": { "type": "string", "description": "Markdown 正文" },
                        "parent": { "type": "string", "description": "可选目标文件夹相对路径" }
                    },
                    "required": ["title", "content"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "note_edit",
                "description": "精确替换笔记中的一段文本。old 必须在正文中恰好出现一次；修改前先 note_read。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "笔记本内相对路径" },
                        "old": { "type": "string", "description": "要被替换的原文片段" },
                        "new": { "type": "string", "description": "替换后的文本" }
                    },
                    "required": ["path", "old", "new"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "note_write",
                "description": "整篇覆盖一篇笔记的正文。仅在需要全量重写时使用；常规修改用 note_edit。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "笔记本内相对路径" },
                        "content": { "type": "string", "description": "完整的新正文" }
                    },
                    "required": ["path", "content"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "note_delete",
                "description": "删除一篇笔记。破坏性操作：本地为硬删除，仅在用户明确要求删除时调用。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "笔记本内相对路径" }
                    },
                    "required": ["path"]
                }
            }
        },
    ]);
    if web_search_enabled {
        tools
            .as_array_mut()
            .expect("tool list is an array")
            .push(json!({
                "type": "function",
                "function": {
                    "name": "web_search",
                    "description": "联网搜索公开网页，返回标题、URL 和摘要。用于需要最新或外部信息的问题；回答时引用返回的 URL。",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "query": { "type": "string", "description": "搜索关键词" },
                            "limit": { "type": "integer", "description": "返回条数，默认 5，最多 10" }
                        },
                        "required": ["query"]
                    }
                }
            }));
    }
    tools
}

/// Validate and normalize a notebook-relative note path from model input.
fn normalize_path(raw: &str) -> Result<String, String> {
    let normalized = raw.trim().replace('\\', "/");
    if normalized.is_empty() {
        return Err("path 不能为空".into());
    }
    if normalized.starts_with('/') {
        return Err(format!("path 必须是笔记本内相对路径: {raw}"));
    }
    for component in normalized.split('/') {
        match component {
            "" | "." => return Err(format!("path 含有空段或 `.`: {raw}")),
            ".." => return Err(format!("path 不允许包含 `..`: {raw}")),
            hidden if hidden.starts_with('.') => {
                return Err(format!("path 不允许访问隐藏路径: {raw}"))
            }
            _ => {}
        }
    }
    Ok(normalized)
}

fn truncate(value: Value) -> Value {
    let serialized = value.to_string();
    if serialized.chars().count() <= MAX_TOOL_RESULT_CHARS {
        return value;
    }
    let cut: String = serialized.chars().take(MAX_TOOL_RESULT_CHARS).collect();
    json!({ "truncated": true, "preview": cut })
}

fn document_json(document: &flowix_core::service::NoteDocument) -> Value {
    json!({
        "notebookId": document.notebook.id,
        "relativePath": document.entry.relative_path,
        "title": document.entry.title,
        "updatedAt": document.entry.updated_at,
    })
}

/// Execute one tool call. Blocking (file + sqlite IO), ms-scale; callers run
/// it outside the async hot path.
pub fn execute(
    memo_file: &Arc<RwLock<MemoFile>>,
    scope: &ToolScope,
    name: &str,
    arguments: &str,
) -> Value {
    let result = execute_inner(memo_file, scope, name, arguments);
    match result {
        Ok(value) => truncate(value),
        Err(error) => json!({ "ok": false, "error": error }),
    }
}

fn execute_inner(
    memo_file: &Arc<RwLock<MemoFile>>,
    scope: &ToolScope,
    name: &str,
    arguments: &str,
) -> Result<Value, String> {
    let args: Value = if arguments.trim().is_empty() {
        json!({})
    } else {
        serde_json::from_str(arguments).map_err(|error| format!("参数不是合法 JSON: {error}"))?
    };

    let memo_file = Arc::clone(memo_file);
    // NoteService 借用读锁守卫；守卫必须与 service 活得一样久，
    // 但各 NoteService 调用结束后立刻释放，避免长时间压住写方。
    // NoteService 方法是 &mut self 的本地绑定；MemoFile 只以共享引用持有。
    let result = {
        let guard = memo_file
            .read()
            .map_err(|_| "note storage lock poisoned".to_owned())?;
        let mut service = NoteService::new(&guard);
        execute_with_service(&mut service, scope, name, &args)
    };
    result
}

fn execute_with_service(
    mut service: &mut NoteService<'_>,
    scope: &ToolScope,
    name: &str,
    args: &Value,
) -> Result<Value, String> {
    let notebook = &scope.notebook_id;

    match name {
        "note_list" => {
            let offset = args.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
            let entries = service
                .list(notebook)
                .map_err(|error| error.to_string())?;
            let total = entries.len();
            let notes: Vec<Value> = entries
                .into_iter()
                .skip(offset)
                .take(LIST_PAGE_SIZE)
                .map(|entry| {
                    json!({ "relativePath": entry.relative_path, "title": entry.title,
                    "updatedAt": entry.updated_at })
                })
                .collect();
            let next = offset + notes.len();
            Ok(json!({ "ok": true, "total": total, "notes": notes,
            "nextOffset": (next < total).then_some(next) }))
        }
        "note_search" => {
            let query = string_arg(&args, "query").ok_or("缺少 query")?;
            let tag = args.get("tag").and_then(Value::as_str).filter(|s| !s.trim().is_empty());
            let limit = args
                .get("limit")
                .and_then(Value::as_u64)
                .unwrap_or(10)
                .clamp(1, SEARCH_LIMIT as u64) as usize;
            let hits = service
                .search_with_tag_filter(notebook, &query, tag, limit)
                .map_err(|error| error.to_string())?;
            let matches: Vec<Value> = hits
                .into_iter()
                .map(|hit| {
                    json!({ "relativePath": hit.relative_path, "title": hit.title,
                    "snippet": hit.snippet })
                })
                .collect();
            Ok(json!({ "ok": true, "matches": matches }))
        }
        "note_read" => {
            let path = normalize_path(&string_arg(&args, "path").ok_or("缺少 path")?)?;
            let document = service.get(notebook, &path).map_err(|error| error.to_string())?;
            Ok(json!({ "ok": true, "note": {
            "relativePath": document.entry.relative_path,
            "title": document.entry.title,
            "body": document.body } }))
        }
        "note_create" => {
            let title = string_arg(&args, "title").ok_or("缺少 title")?;
            let content = string_arg(&args, "content").ok_or("缺少 content")?;
            let parent = args
                .get("parent")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(normalize_path)
                .transpose()?;
            let document = service
                .create(notebook, parent.as_deref(), &title, &content)
                .map_err(|error| error.to_string())?;
            Ok(json!({ "ok": true, "action": "created", "note": document_json(&document) }))
        }
        "note_edit" => {
            let path = normalize_path(&string_arg(&args, "path").ok_or("缺少 path")?)?;
            let old = string_arg(&args, "old").ok_or("缺少 old")?;
            let new = string_arg(&args, "new").ok_or("缺少 new")?;
            if old.is_empty() {
                return Err("old 不能为空".into());
            }
            let document = service.get(notebook, &path).map_err(|error| error.to_string())?;
            let matches = document.body.match_indices(&old).count();
            if matches != 1 {
                return Err(format!(
                    "old 在正文中出现了 {matches} 次（要求恰好 1 次）；请先 note_read 并调整 old 片段"
                ));
            }
            let next = document.body.replacen(&old, &new, 1);
            save_cas(&mut service, notebook, &path, &next, Some(&document.body))?;
            Ok(json!({ "ok": true, "action": "edited", "path": path,
            "note": { "relativePath": document.entry.relative_path, "title": document.entry.title } }))
        }
        "note_write" => {
            let path = normalize_path(&string_arg(&args, "path").ok_or("缺少 path")?)?;
            let content = string_arg(&args, "content").ok_or("缺少 content")?;
            let document = service
                .get(notebook, &path)
                .map_err(|error| format!("读取失败（笔记可能不存在）: {error}"))?;
            if document.body == content {
                return Ok(json!({ "ok": true, "action": "unchanged", "path": path }));
            }
            save_cas(&mut service, notebook, &path, &content, Some(&document.body))?;
            Ok(json!({ "ok": true, "action": "written", "path": path }))
        }
        "note_delete" => {
            let path = normalize_path(&string_arg(&args, "path").ok_or("缺少 path")?)?;
            let document = service.get(notebook, &path).map_err(|error| error.to_string())?;
            let removed = service
                .delete_checked(notebook, &path, &document.body)
                .map_err(|error| error.to_string())?;
            Ok(json!({ "ok": removed, "action": "deleted", "path": path }))
        }
        other => Err(format!("未知工具: {other}")),
    }
}

fn save_cas(
    service: &mut NoteService<'_>,
    notebook: &str,
    path: &str,
    content: &str,
    expected: Option<&str>,
) -> Result<(), String> {
    match service.save(notebook, path, content, expected) {
        Ok(NoteSaveOutcome::Saved(_)) => Ok(()),
        Ok(NoteSaveOutcome::Conflict { .. }) => Err(
            "保存冲突：笔记在读取后被修改过（可能正在被编辑）。请重新 note_read 后再试".into(),
        ),
        Err(error) => Err(error.to_string()),
    }
}

fn string_arg(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use flowix_core::memo_file::NotebookConfig;

    fn fixture() -> (tempfile::TempDir, Arc<RwLock<MemoFile>>, ToolScope) {
        let tmp = tempfile::tempdir().unwrap();
        let notebook_path = tmp.path().join("notes");
        std::fs::create_dir_all(&notebook_path).unwrap();
        let memo = MemoFile::new(tmp.path().to_path_buf());
        memo
            .write_notebook_configs(&[NotebookConfig {
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
        let scope = ToolScope { notebook_id: "work".into(), notebook_name: "Work".into() };
        (tmp, Arc::new(RwLock::new(memo)), scope)
    }

    #[test]
    fn create_read_edit_delete_round_trip() {
        let (_tmp, memo, scope) = fixture();
        let created = execute(&memo, &scope, "note_create",
            r##"{"title":"Meeting","content":"# Meeting\nhello world\n"}"##);
        assert_eq!(created["ok"], true, "{created}");
        let path = created["note"]["relativePath"].as_str().unwrap();

        let read = execute(&memo, &scope, "note_read", &json!({ "path": path }).to_string());
        assert!(read["note"]["body"].as_str().unwrap().contains("hello world"));

        let edit = execute(&memo, &scope, "note_edit",
            &json!({ "path": path, "old": "hello", "new": "再见" }).to_string());
        assert_eq!(edit["ok"], true, "{edit}");

        let ambiguous = execute(&memo, &scope, "note_edit",
            &json!({ "path": path, "old": "不存在的片段", "new": "x" }).to_string());
        assert!(ambiguous["error"].as_str().unwrap().contains("0 次"));

        let deleted = execute(&memo, &scope, "note_delete", &json!({ "path": path }).to_string());
        assert_eq!(deleted["ok"], true, "{deleted}");
    }

    #[test]
    fn rejects_path_escape_and_hidden_dirs() {
        assert!(normalize_path("../etc.md").is_err());
        assert!(normalize_path("/abs.md").is_err());
        assert!(normalize_path("notes/.flowix/x.md").is_err());
        assert!(normalize_path("a/./b.md").is_err());
        assert_eq!(normalize_path("notes\\2026-10-25.md").unwrap(), "notes/2026-10-25.md");
    }

    #[test]
    fn search_and_list_surface_entries() {
        let (_tmp, memo, scope) = fixture();
        execute(&memo, &scope, "note_create",
            r##"{"title":"Rust 笔记","content":"# Rust 笔记\n所有权与生命周期\n"}"##);
        let hits = execute(&memo, &scope, "note_search",
            r#"{"query":"所有权"}"#);
        assert_eq!(hits["ok"], true, "{hits}");
        assert_eq!(hits["matches"].as_array().unwrap().len(), 1);

        let list = execute(&memo, &scope, "note_list", "{}");
        assert_eq!(list["total"], 1, "{list}");
    }

    #[test]
    fn unknown_tool_is_reported_not_panicked() {
        let (_tmp, memo, scope) = fixture();
        let out = execute(&memo, &scope, "note_shell", "{}");
        assert!(out["error"].as_str().unwrap().contains("未知工具"));
    }
}
