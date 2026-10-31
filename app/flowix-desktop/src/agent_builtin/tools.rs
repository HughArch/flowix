//! Note and file tools for the built-in assistant.
//!
//! Note tools go through `flowix_core::NoteService`, which owns path
//! validation, the note index and compare-and-save protection. The `file_*`
//! tools operate on raw non-Markdown text files (HTML, CSS, JSON, source
//! code, ...) below the same notebook root: they skip the note index and
//! frontmatter machinery entirely. Tool results are plain JSON values the
//! model reads back on the next turn.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use flowix_core::memo_file::{notebook_path_from_relative, MemoFile};
use flowix_core::{NoteSaveOutcome, NoteService};
use serde_json::{json, Value};
use tauri::AppHandle;

/// Result size sent back to the model. Full data still reaches the UI via the
/// ToolResult chunk when smaller; oversized bodies are truncated here.
const MAX_TOOL_RESULT_CHARS: usize = 24_000;
const LIST_PAGE_SIZE: usize = 100;
const SEARCH_LIMIT: usize = 20;
/// Files above this are refused by `file_read`: the result could never fit a
/// model context anyway (results truncate at `MAX_TOOL_RESULT_CHARS`).
const MAX_FILE_READ_BYTES: u64 = 1024 * 1024;

/// The notebook all tool calls operate on.
#[derive(Clone)]
pub struct ToolScope {
    pub notebook_id: String,
    pub notebook_name: String,
    /// Notebook root on disk; used to load the optional `AGENTS.md` and to
    /// resolve `file_*` tool paths.
    pub notebook_path: std::path::PathBuf,
    /// 用户配置目录 (`~/.flowix`): 云端历史工具从这里读 `boot/fns-sync.json`。
    pub config_dir: std::path::PathBuf,
    /// Marks a just-written path as backend-owned so the watcher does not
    /// treat it as an external edit. Boxed instead of carrying the
    /// `AppHandle` so tests can pass a no-op without a Tauri runtime.
    pub mark_self_write: Arc<dyn Fn(&Path) + Send + Sync>,
}

impl std::fmt::Debug for ToolScope {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ToolScope")
            .field("notebook_id", &self.notebook_id)
            .field("notebook_name", &self.notebook_name)
            .field("notebook_path", &self.notebook_path)
            .field("config_dir", &self.config_dir)
            .finish_non_exhaustive()
    }
}

/// Watcher self-write marker bound to the real app handle (see
/// [`ToolScope::mark_self_write`]). Degrades to a no-op when the watcher is
/// not running.
pub fn self_write_marker(app: AppHandle) -> Arc<dyn Fn(&Path) + Send + Sync> {
    Arc::new(move |path| crate::watcher::runtime::mark_self_write_for(&app, path))
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
                        "parent": { "type": "string", "description": "目标文件夹相对路径；用户未说明位置时先询问" },
                        "tags": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "默认标签，例如 [\"项目/Flowix\"]"
                        },
                        "icon": {
                            "type": "string",
                            "description": "笔记图标（单个 emoji），写入 flowix_icon"
                        },
                        "colors": {
                            "type": "array",
                            "items": { "type": "string", "enum": ["red", "orange", "yellow", "green", "cyan", "blue", "gray"] },
                            "description": "笔记颜色，写入 flowix_colors"
                        },
                        "properties": {
                            "type": "object",
                            "description": "额外 frontmatter 属性，例如 { \"created\": \"2026-10-25\" }",
                            "additionalProperties": true
                        }
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
                "description": "删除一篇笔记。破坏性操作：调用前必须在对话中得到用户明确同意；本地为硬删除，不可恢复。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "笔记本内相对路径" }
                    },
                    "required": ["path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "file_create",
                "description": "在当前笔记本新建一个非 Markdown 的文本文件（HTML / CSS / JSON / 源代码等），内容原样写入，不追加 frontmatter。路径必须带扩展名；文件已存在时报错。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "笔记本内相对路径，必须带扩展名，如 输出/index.html" },
                        "content": { "type": "string", "description": "完整文件内容（UTF-8 文本）" }
                    },
                    "required": ["path", "content"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "file_read",
                "description": "读取笔记本内一个文本文件的原始内容（任意扩展名，含 .md；上限约 1MB）。技能库 .agents/skills/ 下的 SKILL.md 也用本工具读取。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "笔记本内相对路径" }
                    },
                    "required": ["path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "file_write",
                "description": "整篇覆盖一个已存在的非 Markdown 文本文件。修改前先 file_read；新建文件用 file_create；.md 笔记请用 note_write。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "笔记本内相对路径，必须带扩展名" },
                        "content": { "type": "string", "description": "完整文件内容（UTF-8 文本）" }
                    },
                    "required": ["path", "content"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "cloud_versions",
                "description": "列出一篇笔记的云端历史版本（FNS 同步服务记录，跨设备共享）。笔记本未绑定同步或笔记从未同步过时会说明原因。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "笔记本内相对路径" },
                        "page": { "type": "integer", "description": "页码（1 开始），每页 20 条" }
                    },
                    "required": ["path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "cloud_restore",
                "description": "把一篇笔记恢复到指定云端历史版本。当前内容会先本地归档为 restore_backup，随后同步到其他设备。破坏性操作：调用前必须先向用户确认目标版本。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "笔记本内相对路径" },
                        "historyId": { "type": "integer", "description": "云端历史 id，来自 cloud_versions 的结果" }
                    },
                    "required": ["path", "historyId"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "canvas",
                "description": "管理当前笔记本内的画布（.flowix-canvas 白板文档）。用户要求创建画布/白板、把笔记摆上画布、加形状连线时用它，不要手写画布 JSON。action: create/list/read/addCard/addShape/addEdge/addFrame/addNotes/remove。典型流程：先 read 拿到元素 id 再 addEdge/remove；多篇笔记用 addNotes 排成网格，单个笔记卡用 addCard(notePath)，便签用 addCard(text)；坐标省略时自动放在现有内容旁边；笔记卡片引用笔记本体，不要把正文复制进画布。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": { "type": "string", "enum": ["create", "list", "read", "addCard", "addShape", "addEdge", "addFrame", "addNotes", "remove"] },
                        "path": { "type": "string", "description": "画布文件相对路径（.flowix-canvas，来自 create/list）" },
                        "name": { "type": "string", "description": "create：画布名称（决定文件名，默认 Untitled）" },
                        "parent": { "type": "string", "description": "create：目标文件夹相对路径；用户未说明位置时先询问" },
                        "notePath": { "type": "string", "description": "addCard：作为笔记卡片的笔记相对路径（与 text 二选一）" },
                        "text": { "type": "string", "description": "addCard：便签文字；addShape：形状标签" },
                        "color": { "type": "string", "enum": ["yellow", "red", "green", "blue", "purple"], "description": "addCard：便签底色，默认 yellow" },
                        "title": { "type": "string", "description": "addCard：卡片标题快照（默认取笔记标题）" },
                        "shape": { "type": "string", "enum": ["rect", "ellipse", "diamond", "text", "arrow", "line"], "description": "addShape：形状类型" },
                        "fill": { "type": "string", "description": "addShape：填充色，如 #ffffff" },
                        "stroke": { "type": "string", "description": "addShape：描边色，如 #1e1e1e" },
                        "from": { "type": "string", "description": "addEdge：起点元素 id（卡片/形状）" },
                        "to": { "type": "string", "description": "addEdge：终点元素 id" },
                        "label": { "type": "string", "description": "addEdge：连线标签" },
                        "notePaths": { "type": "array", "items": { "type": "string" }, "description": "addNotes：批量上画布的笔记相对路径" },
                        "columns": { "type": "integer", "description": "addNotes：网格列数，默认 3" },
                        "ids": { "type": "array", "items": { "type": "string" }, "description": "remove：要删除的元素 id（相连的连线一并删除）" },
                        "x": { "type": "number", "description": "元素左上角 X（省略则自动摆放）" },
                        "y": { "type": "number", "description": "元素左上角 Y" },
                        "w": { "type": "number", "description": "宽度（默认按元素类型：笔记卡 420、便签 220、形状 160、文字 240、分组框 480）" },
                        "h": { "type": "number", "description": "高度（默认按元素类型）" },
                        "x2": { "type": "number", "description": "addShape：箭头/线段终点 X（默认 x+160）" },
                        "y2": { "type": "number", "description": "addShape：箭头/线段终点 Y（默认 y）" },
                        "gapX": { "type": "number", "description": "addNotes：横向间距，默认 40" },
                        "gapY": { "type": "number", "description": "addNotes：纵向间距，默认 40" }
                    },
                    "required": ["action"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "callout",
                "description": "管理笔记里的提示块（callout）。用户要求 callout/提示块/警告框时用它，不要手写 ::: callout 语法。action: list/add/set/remove；block 从 1 开始。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": { "type": "string", "enum": ["list", "add", "set", "remove"] },
                        "path": { "type": "string", "description": "笔记本内相对路径" },
                        "at": { "type": "integer", "description": "插入位置行号（1 开始），默认末尾" },
                        "block": { "type": "integer", "description": "目标 callout 序号（1 开始）" },
                        "icon": { "type": "string", "description": "emoji 图标" },
                        "color": { "type": "string", "description": "颜色，如 yellow/red/blue" },
                        "content": { "type": "string", "description": "提示内容（Markdown）" },
                        "keepContent": { "type": "boolean", "description": "remove 时是否保留正文" }
                    },
                    "required": ["action", "path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "toggle",
                "description": "管理笔记里的折叠块（toggle）。用户要求折叠/展开详情时用它，不要手写 ::: toggle 语法。action: list/add/set/remove；block 从 1 开始。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": { "type": "string", "enum": ["list", "add", "set", "remove"] },
                        "path": { "type": "string", "description": "笔记本内相对路径" },
                        "at": { "type": "integer", "description": "插入位置行号（1 开始），默认末尾" },
                        "block": { "type": "integer", "description": "目标 toggle 序号（1 开始）" },
                        "title": { "type": "string", "description": "折叠块标题" },
                        "content": { "type": "string", "description": "折叠块正文（Markdown）" },
                        "open": { "type": "boolean", "description": "是否默认展开" },
                        "bg": { "type": "string", "description": "整块背景色" },
                        "clearBg": { "type": "boolean", "description": "清除背景色" },
                        "keepContent": { "type": "boolean", "description": "remove 时是否保留正文" }
                    },
                    "required": ["action", "path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "columns",
                "description": "管理笔记里的多列布局。用户要求多列/分栏时用它，不要手写 ::: columns 语法。action: list/add/remove/width；add 可用 contents 一次写入各栏 Markdown；block 从 1 开始。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": { "type": "string", "enum": ["list", "add", "remove", "width"] },
                        "path": { "type": "string", "description": "笔记本内相对路径" },
                        "at": { "type": "integer", "description": "插入位置行号（1 开始），默认末尾" },
                        "count": { "type": "integer", "description": "列数（2-4）；提供 contents 时可省略" },
                        "contents": { "type": "array", "items": { "type": "string" }, "description": "各栏内容（Markdown）；列数由数组长度决定，建议 2-4 栏" },
                        "titleColor": { "type": "string", "description": "分栏标题（每栏第一行）的行背景色，默认 yellow" },
                        "block": { "type": "integer", "description": "目标 columns 块序号（1 开始）" },
                        "column": { "type": "integer", "description": "要删除的列序号（1 开始）" },
                        "widths": { "type": "array", "items": { "type": "integer" }, "description": "各列相对宽度，例如 [100,100]" }
                    },
                    "required": ["action", "path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "background",
                "description": "管理笔记的文字行背景色。action: list/set/clear；line 从 1 开始。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": { "type": "string", "enum": ["list", "set", "clear"] },
                        "path": { "type": "string", "description": "笔记本内相对路径" },
                        "line": { "type": "integer", "description": "目标行号（1 开始）" },
                        "color": { "type": "string", "description": "背景色，如 yellow/red/blue" }
                    },
                    "required": ["action", "path"]
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

/// Apply `tags` / `icon` / `colors` / `properties` from `note_create` into the
/// leading YAML frontmatter. Explicit fields win over `properties`.
fn apply_create_metadata(args: &Value, content: &str) -> Result<String, String> {
    use flowix_core::memo_file::frontmatter::{merge_frontmatter, MergeOverrides};

    let mut overrides: MergeOverrides = MergeOverrides::new();
    if let Some(properties) = args.get("properties").and_then(Value::as_object) {
        for (key, value) in properties {
            let key = key.trim();
            if key.is_empty() {
                continue;
            }
            overrides.insert(
                key.to_owned(),
                serde_json::to_string(value)
                    .map_err(|error| format!("properties.{key} 序列化失败: {error}"))?,
            );
        }
    }

    if let Some(tags) = args.get("tags").and_then(Value::as_array) {
        let tags: Vec<String> = tags
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|tag| !tag.is_empty())
            .map(str::to_owned)
            .collect();
        if !tags.is_empty() {
            overrides.insert(
                "tags".to_owned(),
                serde_json::to_string(&tags).map_err(|error| error.to_string())?,
            );
        }
    }

    if let Some(icon) = string_arg(args, "icon") {
        overrides.insert(
            "flowix_icon".to_owned(),
            serde_json::to_string(icon.trim()).map_err(|error| error.to_string())?,
        );
    }

    if let Some(colors) = args.get("colors").and_then(Value::as_array) {
        const ALLOWED: &[&str] = &["red", "orange", "yellow", "green", "cyan", "blue", "gray"];
        let colors: Vec<String> = colors
            .iter()
            .filter_map(Value::as_str)
            .map(|color| color.trim().to_ascii_lowercase())
            .filter(|color| !color.is_empty())
            .collect();
        if let Some(invalid) = colors.iter().find(|color| !ALLOWED.contains(&color.as_str())) {
            return Err(format!(
                "不支持的笔记颜色 `{invalid}`，可用：{}",
                ALLOWED.join(", ")
            ));
        }
        if !colors.is_empty() {
            overrides.insert(
                "flowix_colors".to_owned(),
                serde_json::to_string(&colors).map_err(|error| error.to_string())?,
            );
        }
    }

    // Deterministic date default: the model may choose the rest, but a new
    // note always carries its creation date unless explicitly provided.
    if !overrides.contains_key("created") {
        let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
        overrides.insert(
            "created".to_owned(),
            serde_json::to_string(&today).map_err(|error| error.to_string())?,
        );
    }

    Ok(merge_frontmatter(content, &overrides))
}

/// Validate and normalize a notebook-relative note path from model input.
pub(crate) fn normalize_path(raw: &str) -> Result<String, String> {
    let normalized = raw.trim().replace('\\', "/");
    validate_common_path(&normalized, raw)?;
    reject_hidden_component(&normalized, raw)?;
    Ok(normalized)
}

/// `file_read` counterpart of [`normalize_path`]: identical rules, except the
/// notebook skill library `.agents/skills/**` is readable — the system-prompt
/// skill catalog hands the model these exact paths so it can load a SKILL.md
/// body on demand. Writes (`file_create` / `file_write`) and note tools keep
/// the strict hidden-path rule: skill files are config managed by the
/// settings dialog, not agent-writable content.
pub(crate) fn normalize_read_path(raw: &str) -> Result<String, String> {
    let normalized = raw.trim().replace('\\', "/");
    validate_common_path(&normalized, raw)?;
    let parts: Vec<&str> = normalized.split('/').collect();
    if parts.first() == Some(&".agents") && parts.get(1) == Some(&"skills") {
        if normalized.split('/').skip(2).any(|part| part.starts_with('.')) {
            return Err(format!("path 不允许访问隐藏路径: {raw}"));
        }
        return Ok(normalized);
    }
    reject_hidden_component(&normalized, raw)?;
    Ok(normalized)
}

/// Reject any dot-prefixed path component: hidden trees (`.flowix`,
/// `.agents`, `.index.yaml` …) are notebook internals, not agent content.
fn reject_hidden_component(normalized: &str, raw: &str) -> Result<(), String> {
    if normalized.split('/').any(|part| part.starts_with('.')) {
        return Err(format!("path 不允许访问隐藏路径: {raw}"));
    }
    Ok(())
}

/// Relative-only, no empty / `.` / `..` segments.
fn validate_common_path(normalized: &str, raw: &str) -> Result<(), String> {
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
            _ => {}
        }
    }
    Ok(())
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

/// 云端历史 (FNS note_history): 凭据解析与桌面命令同源 —— 全局
/// `boot/fns-sync.json` + 笔记本 `.flowix/sync-state.json`; REST 与 diff 重建
/// 在 [`flowix_core::fns_history`]。恢复复用 `write_restored_content` 共享写侧。
fn execute_cloud_tool(
    memo_file: &MemoFile,
    scope: &ToolScope,
    name: &str,
    args: &Value,
) -> Result<Value, String> {
    let notebook = &scope.notebook_id;
    let path = normalize_path(&string_arg(args, "path").ok_or("缺少 path")?)?;

    let config = flowix_core::fns_config::FnsConfig::load(&scope.config_dir);
    if !config.is_ready() {
        return Err("当前设备未配置云端同步（FNS），无法读取云端历史".into());
    }
    let sync_state = flowix_fns::state::SyncState::load(&scope.notebook_path)
        .map_err(|error| format!("读取同步绑定失败: {error}"))?
        .ok_or("当前笔记本未绑定云端同步，无法读取云端历史")?;
    if sync_state.vault.trim().is_empty() {
        return Err("当前笔记本没有绑定 vault".into());
    }
    let token = config
        .token(&sync_state.token_id)
        .ok_or("绑定的同步令牌已不存在，请重新绑定")?;

    match name {
        "cloud_versions" => {
            let page = args.get("page").and_then(Value::as_u64).unwrap_or(1).max(1) as u32;
            match flowix_core::fns_history::list_note_history_or_not_synced(
                config.api.trim(),
                &token.token,
                &token.client_type,
                &sync_state.vault,
                &path,
                page,
                20,
            )
            .map_err(|error| error.to_string())?
            {
                flowix_core::fns_history::FnsCloudHistoryPage::NotSynced => {
                    Ok(json!({ "ok": true, "status": "notSynced",
                        "message": "该笔记尚未同步到云端，暂无云端历史" }))
                }
                flowix_core::fns_history::FnsCloudHistoryPage::Ok { items, total, has_more } => {
                    Ok(json!({ "ok": true, "status": "ok", "total": total,
                        "hasMore": has_more, "page": page, "versions": items }))
                }
            }
        }
        "cloud_restore" => {
            let history_id = args
                .get("historyId")
                .and_then(Value::as_i64)
                .ok_or("缺少 historyId")?;
            let content = flowix_core::fns_history::note_history_content(
                config.api.trim(),
                &token.token,
                &token.client_type,
                history_id,
            )
            .map_err(|error| error.to_string())?;
            let absolute = memo_file
                .resolve_notebook_md_path(notebook, &path)
                .map_err(|error| format!("笔记文件不可用: {error}"))?;
            let restored = memo_file
                .write_restored_content(notebook, &path, &absolute, &content, None)
                .map_err(|error| format!("恢复写入失败: {error}"))?;
            if !restored {
                return Err("恢复被拒绝：笔记内容在恢复期间发生变化".into());
            }
            Ok(json!({ "ok": true, "action": "restored", "path": path,
                "historyId": history_id,
                "note": "当前内容已本地归档为 restore_backup，下次同步会上行到其他设备" }))
        }
        _ => unreachable!(),
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
        // 云端历史工具只读 MemoFile + 用户配置; file 工具只做原始文件 IO，
        // 两者都不走 NoteService 的笔记索引管线。
        if matches!(name, "cloud_versions" | "cloud_restore") {
            execute_cloud_tool(&guard, scope, name, &args)
        } else if matches!(name, "file_create" | "file_read" | "file_write") {
            execute_file_tool(&guard, scope, name, &args)
        } else if matches!(name, "canvas") {
            // 画布文件不在笔记索引里：写侧走 MemoFile 文件锁，标题快照查
            // NoteService，所以两者都要。
            let mut service = NoteService::new(&guard);
            super::canvas_tools::execute(&guard, &mut service, scope, &args)
        } else {
            let mut service = NoteService::new(&guard);
            execute_with_service(&mut service, scope, name, &args)
        }
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

    // Flowix rich content (callouts / toggles / columns / line backgrounds)
    // lives in dedicated modules; dispatch before the plain note tools.
    if matches!(name, "callout" | "toggle" | "columns" | "background") {
        return super::rich_content::execute(service, notebook, name, &args);
    }

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
            let content = apply_create_metadata(&args, &content)?;
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

/// Raw non-Markdown text files: create / read / overwrite below the notebook
/// root. Writes go through the shared `MemoFile` file locks and mark
/// self-writes, so the watcher and FNS sync treat them like any other
/// backend-owned write. There is deliberately no `file_delete` / `file_edit`:
/// the model rewrites the whole file via `file_write` instead.
fn execute_file_tool(
    memo_file: &MemoFile,
    scope: &ToolScope,
    name: &str,
    args: &Value,
) -> Result<Value, String> {
    match name {
        "file_create" => {
            let raw = string_arg(args, "path").ok_or("缺少 path")?;
            let content = string_arg(args, "content").ok_or("缺少 content")?;
            let (relative, absolute) = resolve_writable_file_path(scope, memo_file, &raw)?;
            // The file lock canonicalizes the parent, so intermediate
            // directories must exist before the create intent is taken (same
            // ordering as the FNS sync writer).
            if let Some(parent) = absolute.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|error| format!("创建目录失败: {error}"))?;
            }
            memo_file
                .create_file_for_notebook(&scope.notebook_id, &absolute, content.as_bytes())
                .map_err(|error| match error.kind() {
                    io::ErrorKind::AlreadyExists => format!(
                        "文件已存在: {relative}。先 file_read 查看内容，需要覆盖时用 file_write，或换一个文件名。"
                    ),
                    _ => format!("创建文件失败: {error}"),
                })?;
            mark_file_self_write(scope, &absolute);
            Ok(json!({ "ok": true, "action": "created", "path": relative }))
        }
        "file_read" => {
            let raw = string_arg(args, "path").ok_or("缺少 path")?;
            let relative = normalize_read_path(&raw)?;
            let absolute =
                notebook_path_from_relative(&scope.notebook_path, &relative)
                    .map_err(|error| format!("path 非法: {error}"))?;
            let metadata = std::fs::metadata(&absolute).map_err(|error| match error.kind() {
                io::ErrorKind::NotFound => format!("文件不存在: {relative}"),
                _ => format!("读取文件失败: {error}"),
            })?;
            if !metadata.is_file() {
                return Err(format!("path 不是文件: {relative}"));
            }
            if metadata.len() > MAX_FILE_READ_BYTES {
                return Err(format!(
                    "文件过大（{} 字节，上限 {MAX_FILE_READ_BYTES}）: {relative}",
                    metadata.len()
                ));
            }
            let content = std::fs::read_to_string(&absolute).map_err(|error| match error.kind() {
                io::ErrorKind::NotFound => format!("文件不存在: {relative}"),
                _ if error.kind() == io::ErrorKind::InvalidData => {
                    format!("不是 UTF-8 文本文件，无法读取: {relative}")
                }
                _ => format!("读取文件失败: {error}"),
            })?;
            Ok(json!({ "ok": true, "path": relative, "content": content }))
        }
        "file_write" => {
            let raw = string_arg(args, "path").ok_or("缺少 path")?;
            let content = string_arg(args, "content").ok_or("缺少 content")?;
            let (relative, absolute) = resolve_writable_file_path(scope, memo_file, &raw)?;
            memo_file
                .write_file_for_notebook(&scope.notebook_id, &absolute, content.as_bytes())
                .map_err(|error| match error.kind() {
                    io::ErrorKind::NotFound => {
                        format!("文件不存在: {relative}。新建文件用 file_create。")
                    }
                    _ => format!("写入文件失败: {error}"),
                })?;
            mark_file_self_write(scope, &absolute);
            Ok(json!({ "ok": true, "action": "written", "path": relative }))
        }
        _ => unreachable!(),
    }
}

/// Validate a model-supplied path for `file_create` / `file_write` and return
/// `(notebook-relative, absolute)`. Markdown is rejected: `.md` files must go
/// through the note tools or they would bypass the note index and its
/// frontmatter / CAS invariants.
fn resolve_writable_file_path(
    scope: &ToolScope,
    memo_file: &MemoFile,
    raw: &str,
) -> Result<(String, PathBuf), String> {
    let relative = normalize_path(raw)?;
    let relative_path = Path::new(&relative);
    let extension = relative_path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default();
    if extension.is_empty() || extension.len() > 16 || !extension.chars().all(|c| c.is_ascii_alphanumeric())
    {
        return Err(format!(
            "path 必须带 1-16 位字母数字扩展名（如 .html / .css / .json）: {raw}"
        ));
    }
    if matches!(extension.to_ascii_lowercase().as_str(), "md" | "markdown") {
        return Err("Markdown 笔记请改用 note_create / note_write，file 工具不处理 .md".into());
    }
    if memo_file
        .file_management_policy(&scope.notebook_id)
        .is_index_ignored_at(&scope.notebook_path, relative_path)
    {
        return Err(format!("path 位于被忽略的目录内: {raw}"));
    }
    let absolute = notebook_path_from_relative(&scope.notebook_path, &relative)
        .map_err(|error| format!("path 非法: {error}"))?;
    Ok((relative, absolute))
}

pub(crate) fn mark_file_self_write(scope: &ToolScope, absolute: &Path) {
    (scope.mark_self_write)(absolute);
}

pub(crate) fn string_arg(args: &Value, key: &str) -> Option<String> {
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
    fn read_path_allows_only_the_skill_library() {
        assert_eq!(
            normalize_read_path(".agents/skills/demo/SKILL.md").unwrap(),
            ".agents/skills/demo/SKILL.md"
        );
        // Legacy lowercase skill filenames ride the same subtree rule.
        assert_eq!(
            normalize_read_path(".agents/skills/demo/skill.md").unwrap(),
            ".agents/skills/demo/skill.md"
        );
        // Other hidden trees stay off-limits, and the strict rule is
        // unchanged for writes / note tools.
        assert!(normalize_read_path(".agents/mcp.json").is_err());
        assert!(normalize_read_path(".agents/skills/.stash/x.md").is_err());
        assert!(normalize_read_path(".flowix/x.md").is_err());
        assert!(normalize_read_path("notes/../.agents/mcp.json").is_err());
        assert!(normalize_read_path(".agents/skills//SKILL.md").is_err());
        assert!(normalize_path(".agents/skills/demo/SKILL.md").is_err());
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
    fn create_applies_default_metadata() {
        let (tmp, memo, scope) = fixture();
        let created = execute(
            &memo,
            &scope,
            "note_create",
            &json!({
                "title": "Styled",
                "content": "# Styled\n正文\n",
                "tags": ["项目/Flowix"],
                "icon": "📝",
                "colors": ["yellow"],
                "properties": { "created": "2026-10-25" }
            })
            .to_string(),
        );
        assert_eq!(created["ok"], true, "{created}");
        let path = created["note"]["relativePath"].as_str().unwrap();
        let file = tmp.path().join("notes").join(path);
        let body = std::fs::read_to_string(file).unwrap();
        assert!(body.contains("tags:"), "{body}");
        assert!(body.contains("flowix_icon:"), "{body}");
        assert!(body.contains("flowix_colors:"), "{body}");
        assert!(body.contains("created: \"2026-10-25\""), "{body}");
        assert!(body.contains("项目/Flowix"), "{body}");
        assert!(body.contains("# Styled"), "{body}");
    }

    #[test]
    fn unknown_tool_is_reported_not_panicked() {
        let (_tmp, memo, scope) = fixture();
        let out = execute(&memo, &scope, "note_shell", "{}");
        assert!(out["error"].as_str().unwrap().contains("未知工具"));
    }

    #[test]
    fn file_create_read_write_round_trip() {
        let (tmp, memo, scope) = fixture();
        let created = execute(
            &memo,
            &scope,
            "file_create",
            r##"{"path":"输出/index.html","content":"<!doctype html>\n<html><body>hello</body></html>\n"}"##,
        );
        assert_eq!(created["ok"], true, "{created}");
        assert_eq!(created["path"], "输出/index.html", "{created}");

        // Content lands verbatim on disk — no frontmatter injection.
        let on_disk =
            std::fs::read_to_string(tmp.path().join("notes").join("输出").join("index.html"))
                .unwrap();
        assert!(on_disk.starts_with("<!doctype html>"), "{on_disk}");

        let read = execute(
            &memo,
            &scope,
            "file_read",
            &json!({ "path": "输出/index.html" }).to_string(),
        );
        assert_eq!(read["content"], on_disk, "{read}");

        let written = execute(
            &memo,
            &scope,
            "file_write",
            r##"{"path":"输出/index.html","content":"<html>updated</html>"}"##,
        );
        assert_eq!(written["ok"], true, "{written}");
        let updated =
            std::fs::read_to_string(tmp.path().join("notes").join("输出").join("index.html"))
                .unwrap();
        assert_eq!(updated, "<html>updated</html>");
    }

    #[test]
    fn file_create_rejects_existing_md_and_bad_paths() {
        let (_tmp, memo, scope) = fixture();
        let duplicate = execute(
            &memo,
            &scope,
            "file_create",
            r##"{"path":"dup.txt","content":"a"}"##,
        );
        assert_eq!(duplicate["ok"], true, "{duplicate}");
        let again = execute(
            &memo,
            &scope,
            "file_create",
            r##"{"path":"dup.txt","content":"b"}"##,
        );
        assert!(again["error"].as_str().unwrap().contains("已存在"), "{again}");

        let markdown = execute(
            &memo,
            &scope,
            "file_create",
            r##"{"path":"note.md","content":"# x"}"##,
        );
        assert!(
            markdown["error"].as_str().unwrap().contains("note_create"),
            "{markdown}"
        );

        let no_extension = execute(
            &memo,
            &scope,
            "file_create",
            r##"{"path":"Makefile","content":"all:"}"##,
        );
        assert!(
            no_extension["error"].as_str().unwrap().contains("扩展名"),
            "{no_extension}"
        );

        let missing = execute(
            &memo,
            &scope,
            "file_write",
            r##"{"path":"ghost.html","content":"x"}"##,
        );
        assert!(
            missing["error"].as_str().unwrap().contains("不存在"),
            "{missing}"
        );

        let escaped = execute(
            &memo,
            &scope,
            "file_create",
            r##"{"path":"../evil.html","content":"x"}"##,
        );
        assert!(escaped["error"].is_string(), "{escaped}");
    }
}
