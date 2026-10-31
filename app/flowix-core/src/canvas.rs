//! `.flowix-canvas` document model and board-layer operations.
//!
//! Mirrors the TypeScript model in `app/flowix-web/features/canvas/model.ts`:
//! a canvas file is plain JSON (`type: "flowix/canvas"`, `version: 1`) so the
//! FNS file channel syncs it without special casing. Board arrays pass
//! through as raw JSON values (with `serde_json`'s `preserve_order` feature)
//! so a parse -> serialize round-trip stays byte-stable for content this
//! layer never edited — the same invariant the frontend relies on.
//!
//! Consumers:
//! - `flowix-cli`: `flowix canvas ...` subcommands and the memo MCP tool's
//!   `canvas.*` actions
//! - `flowix-desktop` `agent_builtin`: the mobile assistant's `canvas` tool
//!
//! Every mutation refreshes `meta.updatedAt`; every add assigns the same id
//! prefixes (`c_`/`s_`/`e_`/`f_`) and default sizes the board view uses.
//!
//! 同步约定：前端是本模型的编辑侧实现，前端新增/修改画布字段、守卫常量、
//! 解析宽容度或默认尺寸时，必须在同一次变更里同步更新本文件。对齐点：
//! parse 规则（type/version 闸门、条目透传与上限）、serialize 布局（字段
//! 顺序、缩进、尾换行）、读取归一化默认值、以及新建元素写入的字段集合。
//! 顶层字段两边都是固定集合，顶层演进必须两边同改；条目内的未知字段靠
//! 透传自动存活。

use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

pub const CANVAS_FILE_EXTENSION: &str = "flowix-canvas";
pub const CANVAS_DOCUMENT_TYPE: &str = "flowix/canvas";
pub const CANVAS_DOCUMENT_VERSION: i64 = 1;

/// Mirrors the frontend guards (`model.ts`); the board arrays are capped by
/// the same constant the frontend uses on parse.
pub const MAX_CANVAS_ELEMENTS: usize = 5000;
pub const MAX_CANVAS_BOARD_ENTRIES: usize = 2000;

/// Sticky-note tints, mirroring the board view's `STICKY_COLORS` row.
pub const STICKY_COLORS: &[&str] = &["yellow", "red", "green", "blue", "purple"];
pub const SHAPE_KINDS: &[&str] = &["rect", "ellipse", "diamond", "text", "arrow", "line"];

/// Element sizes used by the board view when creating without a drag.
pub const NOTE_CARD_SIZE: (f64, f64) = (420.0, 400.0);
pub const STICKY_CARD_SIZE: (f64, f64) = (220.0, 180.0);
pub const FRAME_SIZE: (f64, f64) = (480.0, 360.0);
pub const BOX_SHAPE_SIZE: (f64, f64) = (160.0, 100.0);
pub const TEXT_LABEL_SIZE: (f64, f64) = (240.0, 40.0);
/// Arrow/line length when the head point is omitted.
pub const TWO_POINT_DEFAULT_LENGTH: f64 = 160.0;
/// Auto-placement gap between existing content and new elements.
pub const AUTO_PLACE_GAP: f64 = 40.0;

const MIN_ELEMENT_SIZE: f64 = 16.0;
const DEFAULT_STROKE: &str = "#1e1e1e";
const DEFAULT_FILL: &str = "#ffffff";
const ID_ALPHABET: &[char] = &[
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i',
    'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
];

/// Error raised by canvas document parsing and mutations.
#[derive(Debug, Clone)]
pub struct CanvasError(pub String);

impl std::fmt::Display for CanvasError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for CanvasError {}

/// Current UTC time in the frontend's `toISOString` form (`…THH:MM:SS.mmmZ`).
pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// True for notebook-relative paths ending in `.flowix-canvas` (case-insensitive).
pub fn is_canvas_path(relative: &str) -> bool {
    relative
        .trim()
        .to_ascii_lowercase()
        .ends_with(&format!(".{CANVAS_FILE_EXTENSION}"))
}

/// A parsed `.flowix-canvas` document. Board arrays stay raw so untouched
/// content survives a load -> save cycle byte-for-byte.
#[derive(Debug, Clone)]
pub struct CanvasDocument {
    pub created_at: String,
    pub updated_at: String,
    elements: Vec<Value>,
    cards: Vec<Value>,
    shapes: Vec<Value>,
    ink: Vec<Value>,
    edges: Vec<Value>,
    frames: Vec<Value>,
    files: Map<String, Value>,
    app_state: Option<Value>,
}

fn plain_object(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

fn passthrough_array(value: &Value, cap: usize) -> Vec<Value> {
    value
        .as_array()
        .map(|entries| {
            entries
                .iter()
                .filter(|entry| entry.is_object())
                .take(cap)
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

fn finite_number(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
}

fn string_field(entry: &Map<String, Value>, key: &str) -> Option<String> {
    entry.get(key).and_then(Value::as_str).and_then(|text| {
        let trimmed = text.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_owned())
    })
}

fn number_field(entry: &Map<String, Value>, key: &str) -> Option<f64> {
    finite_number(entry.get(key))
}

impl CanvasDocument {
    /// Empty document, matching the frontend's `createCanvasDocument()`.
    pub fn create(now: &str) -> Self {
        Self {
            created_at: now.to_owned(),
            updated_at: now.to_owned(),
            elements: Vec::new(),
            cards: Vec::new(),
            shapes: Vec::new(),
            ink: Vec::new(),
            edges: Vec::new(),
            frames: Vec::new(),
            files: Map::new(),
            app_state: None,
        }
    }

    /// Serialized empty canvas, matching the frontend's `createCanvasDocumentText()`.
    pub fn create_text(now: &str) -> String {
        Self::create(now).serialize()
    }

    /// Parse stored text. Throws for content the editor cannot open (same
    /// contract as the frontend's `parseCanvasDocument`): invalid JSON, wrong
    /// `type`, or an unsupported `version`.
    pub fn parse(text: &str, now: &str) -> Result<Self, CanvasError> {
        let raw: Value = serde_json::from_str(text)
            .map_err(|error| CanvasError(format!("画布文件不是有效的 JSON: {error}")))?;
        let object = plain_object(&raw)
            .filter(|object| {
                object.get("type").and_then(Value::as_str) == Some(CANVAS_DOCUMENT_TYPE)
            })
            .ok_or_else(|| CanvasError("画布文件类型不正确".into()))?;
        let version = object.get("version");
        if version.and_then(Value::as_i64) != Some(CANVAS_DOCUMENT_VERSION) {
            return Err(CanvasError(format!(
                "不支持的画布版本: {}",
                version
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "missing".into())
            )));
        }
        let meta = plain_object(object.get("meta").unwrap_or(&Value::Null));
        let meta_value = |key: &str| {
            meta.and_then(|meta| meta.get(key))
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| now.to_owned())
        };
        let files = object
            .get("files")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let app_state = object
            .get("appState")
            .and_then(Value::as_object)
            .map(|state| Value::Object(state.clone()));
        Ok(Self {
            created_at: meta_value("createdAt"),
            updated_at: meta_value("updatedAt"),
            elements: passthrough_array(
                object.get("elements").unwrap_or(&Value::Null),
                MAX_CANVAS_ELEMENTS,
            ),
            cards: passthrough_array(
                object.get("cards").unwrap_or(&Value::Null),
                MAX_CANVAS_BOARD_ENTRIES,
            ),
            shapes: passthrough_array(
                object.get("shapes").unwrap_or(&Value::Null),
                MAX_CANVAS_BOARD_ENTRIES,
            ),
            ink: passthrough_array(
                object.get("ink").unwrap_or(&Value::Null),
                MAX_CANVAS_BOARD_ENTRIES,
            ),
            edges: passthrough_array(
                object.get("edges").unwrap_or(&Value::Null),
                MAX_CANVAS_BOARD_ENTRIES,
            ),
            frames: passthrough_array(
                object.get("frames").unwrap_or(&Value::Null),
                MAX_CANVAS_BOARD_ENTRIES,
            ),
            files,
            app_state,
        })
    }

    /// Serialize with the frontend's exact layout: 2-space indent, fixed field
    /// order, trailing newline, and `appState` omitted when absent (a fresh
    /// document has none; the board view writes `{}` on its first save).
    pub fn serialize(&self) -> String {
        let mut document = Map::new();
        document.insert("type".into(), json!(CANVAS_DOCUMENT_TYPE));
        document.insert("version".into(), json!(CANVAS_DOCUMENT_VERSION));
        document.insert(
            "meta".into(),
            json!({"createdAt": self.created_at, "updatedAt": self.updated_at}),
        );
        document.insert("elements".into(), Value::Array(self.elements.clone()));
        document.insert("cards".into(), Value::Array(self.cards.clone()));
        document.insert("shapes".into(), Value::Array(self.shapes.clone()));
        document.insert("ink".into(), Value::Array(self.ink.clone()));
        document.insert("edges".into(), Value::Array(self.edges.clone()));
        document.insert("frames".into(), Value::Array(self.frames.clone()));
        document.insert("files".into(), Value::Object(self.files.clone()));
        if let Some(state) = &self.app_state {
            document.insert("appState".into(), state.clone());
        }
        let mut text =
            serde_json::to_string_pretty(&Value::Object(document)).unwrap_or_else(|_| "{}".into());
        text.push('\n');
        text
    }

    pub fn card_count(&self) -> usize {
        self.cards.len()
    }

    pub fn shape_count(&self) -> usize {
        self.shapes.len()
    }

    pub fn edge_count(&self) -> usize {
        self.edges.len()
    }

    pub fn frame_count(&self) -> usize {
        self.frames.len()
    }

    pub fn element_count(&self) -> usize {
        self.elements.len()
    }

    pub fn ink_count(&self) -> usize {
        self.ink.len()
    }

    /// Persisted board viewport (`appState.viewport`) when present and sane.
    pub fn viewport(&self) -> Option<(f64, f64, f64)> {
        let state = self.app_state.as_ref()?;
        let viewport = state.get("viewport")?;
        let x = finite_number(viewport.get("x"))?;
        let y = finite_number(viewport.get("y"))?;
        let zoom = finite_number(viewport.get("zoom")).filter(|zoom| *zoom > 0.0)?;
        Some((x, y, zoom))
    }

    /// Normalized board cards, mirroring the frontend's `readBoardCards`
    /// coercion: malformed entries are skipped, sizes clamp to >= 16.
    pub fn board_cards(&self) -> Vec<BoardCard> {
        self.cards
            .iter()
            .filter_map(|entry| entry.as_object())
            .filter_map(|entry| {
                let id = string_field(entry, "id")?;
                let x = number_field(entry, "x")?;
                let y = number_field(entry, "y")?;
                let w = number_field(entry, "w")?;
                let h = number_field(entry, "h")?;
                let kind = match entry.get("kind").and_then(Value::as_str) {
                    Some("text") | Some("image") | Some("canvas") => entry
                        .get("kind")
                        .and_then(Value::as_str)
                        .unwrap()
                        .to_owned(),
                    _ => "note".to_owned(),
                };
                Some(BoardCard {
                    id,
                    kind,
                    x,
                    y,
                    w: w.max(MIN_ELEMENT_SIZE),
                    h: h.max(MIN_ELEMENT_SIZE),
                    notebook_id: string_field(entry, "notebookId"),
                    notebook_name: string_field(entry, "notebookName"),
                    path: string_field(entry, "path"),
                    title: string_field(entry, "title"),
                    text: string_field(entry, "text"),
                    color: string_field(entry, "color"),
                    render_scope: entry
                        .get("renderScope")
                        .and_then(Value::as_str)
                        .filter(|scope| matches!(*scope, "excerpt" | "full" | "section"))
                        .map(str::to_owned),
                    heading: string_field(entry, "heading"),
                })
            })
            .collect()
    }

    /// Normalized board shapes (rect/ellipse/diamond/text/arrow/line).
    pub fn board_shapes(&self) -> Vec<BoardShape> {
        self.shapes
            .iter()
            .filter_map(|entry| entry.as_object())
            .filter_map(|entry| {
                let id = string_field(entry, "id")?;
                let x = number_field(entry, "x")?;
                let y = number_field(entry, "y")?;
                let w = number_field(entry, "w")?;
                let h = number_field(entry, "h")?;
                let shape = match entry.get("shape").and_then(Value::as_str) {
                    Some(kind) if SHAPE_KINDS.contains(&kind) => kind.to_owned(),
                    _ => "rect".to_owned(),
                };
                Some(BoardShape {
                    id,
                    shape,
                    x,
                    y,
                    w: w.max(MIN_ELEMENT_SIZE),
                    h: h.max(MIN_ELEMENT_SIZE),
                    x2: number_field(entry, "x2"),
                    y2: number_field(entry, "y2"),
                    text: string_field(entry, "text"),
                    fill: string_field(entry, "fill"),
                    stroke: string_field(entry, "stroke"),
                })
            })
            .collect()
    }

    /// Normalized board edges; entries missing an endpoint id are skipped.
    pub fn board_edges(&self) -> Vec<BoardEdge> {
        self.edges
            .iter()
            .filter_map(|entry| entry.as_object())
            .filter_map(|entry| {
                Some(BoardEdge {
                    id: string_field(entry, "id")?,
                    from: string_field(entry, "from")?,
                    to: string_field(entry, "to")?,
                    label: string_field(entry, "label"),
                })
            })
            .collect()
    }

    /// Normalized grouping frames.
    pub fn board_frames(&self) -> Vec<BoardFrame> {
        self.frames
            .iter()
            .filter_map(|entry| entry.as_object())
            .filter_map(|entry| {
                Some(BoardFrame {
                    id: string_field(entry, "id")?,
                    title: string_field(entry, "title"),
                    x: number_field(entry, "x")?,
                    y: number_field(entry, "y")?,
                    w: number_field(entry, "w")?.max(MIN_ELEMENT_SIZE),
                    h: number_field(entry, "h")?.max(MIN_ELEMENT_SIZE),
                    color: string_field(entry, "color"),
                })
            })
            .collect()
    }

    /// Ids of connectable nodes (cards + shapes), the endpoint set the board
    /// view's arrow tool draws between.
    fn connectable_ids(&self) -> std::collections::HashSet<String> {
        self.cards
            .iter()
            .chain(self.shapes.iter())
            .filter_map(|entry| entry.get("id").and_then(Value::as_str))
            .filter(|id| !id.is_empty())
            .map(str::to_owned)
            .collect()
    }

    /// Next free stacking slot, mirroring the board view's `nextZ()`
    /// (shape default 5, card 10, ink 20).
    fn next_z(&self) -> i64 {
        let mut max = 0i64;
        let mut scan = |entries: &[Value], default: i64| {
            for entry in entries {
                max = max.max(entry.get("z").and_then(Value::as_i64).unwrap_or(default));
            }
        };
        scan(&self.shapes, 5);
        scan(&self.cards, 10);
        scan(&self.ink, 20);
        max + 1
    }

    /// Collision-free element id with the board view's
    /// `<prefix>_<timestamp36>_<random>` shape.
    fn next_id(&self, prefix: &str) -> String {
        let millis = chrono::Utc::now().timestamp_millis();
        let existing = |candidate: &str| {
            self.cards
                .iter()
                .chain(self.shapes.iter())
                .chain(self.edges.iter())
                .chain(self.frames.iter())
                .any(|entry| entry.get("id").and_then(Value::as_str) == Some(candidate))
        };
        loop {
            let id = format!(
                "{prefix}_{}_{}",
                millis_to_base36(millis),
                nanoid::nanoid!(6, ID_ALPHABET)
            );
            if !existing(&id) {
                return id;
            }
        }
    }

    /// Bounding box over cards, shapes and frames — the extent new content
    /// auto-places next to.
    pub fn bounding_box(&self) -> Option<(f64, f64, f64, f64)> {
        let mut min_x = f64::INFINITY;
        let mut min_y = f64::INFINITY;
        let mut max_x = f64::NEG_INFINITY;
        let mut max_y = f64::NEG_INFINITY;
        let mut any = false;
        let mut expand = |x: f64, y: f64, w: f64, h: f64| {
            any = true;
            min_x = min_x.min(x);
            min_y = min_y.min(y);
            max_x = max_x.max(x + w);
            max_y = max_y.max(y + h);
        };
        for card in self.board_cards() {
            expand(card.x, card.y, card.w, card.h);
        }
        for shape in self.board_shapes() {
            let width = shape
                .x2
                .map(|x2| (x2 - shape.x).abs().max(shape.w))
                .unwrap_or(shape.w);
            let height = shape
                .y2
                .map(|y2| (y2 - shape.y).abs().max(shape.h))
                .unwrap_or(shape.h);
            expand(shape.x, shape.y, width, height);
        }
        for frame in self.board_frames() {
            expand(frame.x, frame.y, frame.w, frame.h);
        }
        any.then_some((min_x, min_y, max_x - min_x, max_y - min_y))
    }

    /// Top-left for a new element when the caller gives no position: to the
    /// right of current content, or the origin on an empty board.
    pub fn auto_position(&self, _w: f64, _h: f64) -> (f64, f64) {
        match self.bounding_box() {
            Some((x, y, width, _)) => (x + width + AUTO_PLACE_GAP, y),
            None => (0.0, 0.0),
        }
    }

    fn touch(&mut self, now: &str) {
        self.updated_at = now.to_owned();
    }

    fn check_board_cap(&self, current: usize, what: &str) -> Result<(), CanvasError> {
        if current >= MAX_CANVAS_BOARD_ENTRIES {
            return Err(CanvasError(format!(
                "画布 {what} 数量已达上限 {MAX_CANVAS_BOARD_ENTRIES}"
            )));
        }
        Ok(())
    }

    /// Add a note card referencing an existing note. Returns the new card id.
    pub fn add_note_card(
        &mut self,
        input: &NoteCardInput,
        now: &str,
    ) -> Result<String, CanvasError> {
        self.check_board_cap(self.cards.len(), "卡片")?;
        let (w, h) = size_or(input.w, input.h, NOTE_CARD_SIZE);
        let (x, y) = position_or(input.x, input.y, self.auto_position(w, h));
        let mut card = Map::new();
        let id = self.next_id("c");
        card.insert("id".into(), json!(id));
        card.insert("kind".into(), json!("note"));
        card.insert("x".into(), json!(round_coord(x)));
        card.insert("y".into(), json!(round_coord(y)));
        card.insert("w".into(), json!(round_coord(w)));
        card.insert("h".into(), json!(round_coord(h)));
        card.insert("z".into(), json!(self.next_z()));
        card.insert("notebookId".into(), json!(input.notebook_id));
        if let Some(name) = input
            .notebook_name
            .as_deref()
            .filter(|name| !name.is_empty())
        {
            card.insert("notebookName".into(), json!(name));
        }
        card.insert("path".into(), json!(input.path));
        if let Some(title) = input.title.as_deref().filter(|title| !title.is_empty()) {
            card.insert("title".into(), json!(title));
        }
        if let Some(scope) = input
            .render_scope
            .as_deref()
            .filter(|scope| !scope.is_empty())
        {
            if !matches!(scope, "excerpt" | "full" | "section") {
                return Err(CanvasError(format!(
                    "renderScope 只支持 excerpt/full/section: {scope}"
                )));
            }
            card.insert("renderScope".into(), json!(scope));
            if scope == "section" {
                if let Some(heading) = input
                    .heading
                    .as_deref()
                    .filter(|heading| !heading.is_empty())
                {
                    card.insert("heading".into(), json!(heading));
                }
            }
        }
        self.cards.push(Value::Object(card));
        self.touch(now);
        Ok(id)
    }

    /// Add a sticky-text card. Returns the new card id.
    pub fn add_text_card(
        &mut self,
        input: &TextCardInput,
        now: &str,
    ) -> Result<String, CanvasError> {
        self.check_board_cap(self.cards.len(), "卡片")?;
        let color = match input.color.as_deref().filter(|color| !color.is_empty()) {
            Some(color) => {
                if !STICKY_COLORS.contains(&color) {
                    return Err(CanvasError(format!(
                        "便签颜色只支持 {}",
                        STICKY_COLORS.join("/")
                    )));
                }
                color.to_owned()
            }
            None => STICKY_COLORS[0].to_owned(),
        };
        let (w, h) = size_or(input.w, input.h, STICKY_CARD_SIZE);
        let (x, y) = position_or(input.x, input.y, self.auto_position(w, h));
        let mut card = Map::new();
        let id = self.next_id("c");
        card.insert("id".into(), json!(id));
        card.insert("kind".into(), json!("text"));
        card.insert("x".into(), json!(round_coord(x)));
        card.insert("y".into(), json!(round_coord(y)));
        card.insert("w".into(), json!(round_coord(w)));
        card.insert("h".into(), json!(round_coord(h)));
        card.insert("z".into(), json!(self.next_z()));
        if let Some(text) = input.text.as_deref() {
            if !text.is_empty() {
                card.insert("text".into(), json!(text));
            }
        }
        card.insert("color".into(), json!(color));
        self.cards.push(Value::Object(card));
        self.touch(now);
        Ok(id)
    }

    /// Add a diagram shape. Returns the new shape id.
    pub fn add_shape(&mut self, input: &ShapeInput, now: &str) -> Result<String, CanvasError> {
        self.check_board_cap(self.shapes.len(), "形状")?;
        let shape = input.shape.trim();
        if !SHAPE_KINDS.contains(&shape) {
            return Err(CanvasError(format!("形状只支持 {}", SHAPE_KINDS.join("/"))));
        }
        let two_point = matches!(shape, "arrow" | "line");
        let (x, y, w, h, x2, y2) = if two_point {
            let x = input
                .x
                .unwrap_or_else(|| self.auto_position(TWO_POINT_DEFAULT_LENGTH, 0.0).0);
            let y = input
                .y
                .unwrap_or_else(|| self.auto_position(TWO_POINT_DEFAULT_LENGTH, 0.0).1);
            let x2 = input.x2.unwrap_or(x + TWO_POINT_DEFAULT_LENGTH);
            let y2 = input.y2.unwrap_or(y);
            (x, y, (x2 - x).abs(), (y2 - y).abs(), Some(x2), Some(y2))
        } else {
            let is_label = shape == "text";
            let (default_w, default_h) = if is_label {
                TEXT_LABEL_SIZE
            } else {
                BOX_SHAPE_SIZE
            };
            let (w, h) = size_or(input.w, input.h, (default_w, default_h));
            let (x, y) = position_or(input.x, input.y, self.auto_position(w, h));
            (x, y, w, h, None, None)
        };
        let mut shape_value = Map::new();
        let id = self.next_id("s");
        shape_value.insert("id".into(), json!(id));
        shape_value.insert("shape".into(), json!(shape));
        shape_value.insert("x".into(), json!(round_coord(x)));
        shape_value.insert("y".into(), json!(round_coord(y)));
        shape_value.insert("w".into(), json!(round_coord(w)));
        shape_value.insert("h".into(), json!(round_coord(h)));
        if let Some(x2) = x2 {
            shape_value.insert("x2".into(), json!(round_coord(x2)));
        }
        if let Some(y2) = y2 {
            shape_value.insert("y2".into(), json!(round_coord(y2)));
        }
        match shape {
            "text" => {
                shape_value.insert(
                    "stroke".into(),
                    json!(input
                        .stroke
                        .as_deref()
                        .filter(|stroke| !stroke.is_empty())
                        .unwrap_or(DEFAULT_STROKE)),
                );
                if let Some(size) = input.font_size.filter(|size| *size >= 8.0 && *size <= 72.0) {
                    shape_value.insert("fontSize".into(), json!(size.round() as i64));
                }
                if let Some(align) = input
                    .text_align
                    .as_deref()
                    .filter(|align| !align.is_empty())
                {
                    shape_value.insert("textAlign".into(), json!(align));
                }
                if let Some(text) = input.text.as_deref().filter(|text| !text.is_empty()) {
                    shape_value.insert("text".into(), json!(text));
                }
            }
            "arrow" | "line" => {
                shape_value.insert(
                    "stroke".into(),
                    json!(input
                        .stroke
                        .as_deref()
                        .filter(|stroke| !stroke.is_empty())
                        .unwrap_or(DEFAULT_STROKE)),
                );
                if let Some(text) = input.text.as_deref().filter(|text| !text.is_empty()) {
                    shape_value.insert("text".into(), json!(text));
                }
            }
            _ => {
                shape_value.insert(
                    "fill".into(),
                    json!(input
                        .fill
                        .as_deref()
                        .filter(|fill| !fill.is_empty())
                        .unwrap_or(DEFAULT_FILL)),
                );
                shape_value.insert(
                    "stroke".into(),
                    json!(input
                        .stroke
                        .as_deref()
                        .filter(|stroke| !stroke.is_empty())
                        .unwrap_or(DEFAULT_STROKE)),
                );
                if let Some(text) = input.text.as_deref().filter(|text| !text.is_empty()) {
                    shape_value.insert("text".into(), json!(text));
                }
            }
        }
        shape_value.insert("z".into(), json!(self.next_z()));
        self.shapes.push(Value::Object(shape_value));
        self.touch(now);
        Ok(id)
    }

    /// Add an edge between two existing cards/shapes. Duplicate from/to pairs
    /// are rejected (the board view skips them silently; an agent should know).
    pub fn add_edge(
        &mut self,
        from: &str,
        to: &str,
        label: Option<&str>,
        now: &str,
    ) -> Result<String, CanvasError> {
        self.check_board_cap(self.edges.len(), "连线")?;
        let connectable = self.connectable_ids();
        for endpoint in [from, to] {
            if !connectable.contains(endpoint) {
                return Err(CanvasError(format!(
                    "连线端点不存在（需要已存在的卡片或形状 id）: {endpoint}"
                )));
            }
        }
        if self
            .board_edges()
            .iter()
            .any(|edge| edge.from == from && edge.to == to)
        {
            return Err(CanvasError(format!("连线已存在: {from} -> {to}")));
        }
        let mut edge = Map::new();
        let id = self.next_id("e");
        edge.insert("id".into(), json!(id));
        edge.insert("from".into(), json!(from));
        edge.insert("to".into(), json!(to));
        if let Some(label) = label.map(str::trim).filter(|label| !label.is_empty()) {
            edge.insert("label".into(), json!(label));
        }
        self.edges.push(Value::Object(edge));
        self.touch(now);
        Ok(id)
    }

    /// Add a grouping frame. Returns the new frame id.
    pub fn add_frame(&mut self, input: &FrameInput, now: &str) -> Result<String, CanvasError> {
        self.check_board_cap(self.frames.len(), "分组框")?;
        let (w, h) = size_or(input.w, input.h, FRAME_SIZE);
        let (x, y) = position_or(input.x, input.y, self.auto_position(w, h));
        let mut frame = Map::new();
        let id = self.next_id("f");
        frame.insert("id".into(), json!(id));
        if let Some(title) = input.title.as_deref().filter(|title| !title.is_empty()) {
            frame.insert("title".into(), json!(title));
        }
        frame.insert("x".into(), json!(round_coord(x)));
        frame.insert("y".into(), json!(round_coord(y)));
        frame.insert("w".into(), json!(round_coord(w)));
        frame.insert("h".into(), json!(round_coord(h)));
        self.frames.push(Value::Object(frame));
        self.touch(now);
        Ok(id)
    }

    /// Remove cards/shapes/ink/frames/edges by id; edges with a removed
    /// endpoint are removed with them (the graph would drop them anyway).
    /// Returns the ids actually removed.
    pub fn remove(&mut self, ids: &[&str], now: &str) -> RemoveReport {
        if ids.is_empty() {
            return RemoveReport {
                removed: Vec::new(),
                removed_edges: Vec::new(),
            };
        }
        let wanted: std::collections::HashSet<&str> = ids.iter().copied().collect();
        let keep = |entries: &[Value]| -> (Vec<Value>, Vec<String>) {
            let mut kept = Vec::with_capacity(entries.len());
            let mut removed = Vec::new();
            for entry in entries {
                let id = entry.get("id").and_then(Value::as_str).unwrap_or_default();
                if wanted.contains(id) {
                    removed.push(id.to_owned());
                } else {
                    kept.push(entry.clone());
                }
            }
            (kept, removed)
        };
        let (cards, cards_removed) = keep(&self.cards);
        let (shapes, shapes_removed) = keep(&self.shapes);
        let (ink, ink_removed) = keep(&self.ink);
        let (frames, frames_removed) = keep(&self.frames);
        let (mut kept_edges, edges_removed_direct) = keep(&self.edges);
        let mut removed: Vec<String> = Vec::new();
        removed.extend(cards_removed);
        removed.extend(shapes_removed);
        removed.extend(ink_removed);
        removed.extend(frames_removed);
        removed.extend(edges_removed_direct.clone());
        if removed.is_empty() {
            return RemoveReport {
                removed,
                removed_edges: Vec::new(),
            };
        }
        let gone: std::collections::HashSet<&str> = removed.iter().map(String::as_str).collect();
        let mut removed_edges = edges_removed_direct;
        kept_edges.retain(|edge| {
            let from = edge.get("from").and_then(Value::as_str).unwrap_or_default();
            let to = edge.get("to").and_then(Value::as_str).unwrap_or_default();
            if gone.contains(from) || gone.contains(to) {
                removed_edges.push(
                    edge.get("id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                );
                false
            } else {
                true
            }
        });
        self.cards = cards;
        self.shapes = shapes;
        self.ink = ink;
        self.frames = frames;
        self.edges = kept_edges;
        self.touch(now);
        RemoveReport {
            removed,
            removed_edges,
        }
    }

    /// Update one existing element in place (move / resize / retext / relink).
    /// Fields not applicable to the element's kind are rejected so a wrong
    /// patch fails loudly instead of silently writing dead keys. Text-ish
    /// fields set to an empty/blank string clear the attribute. Returns the
    /// element kind that was updated.
    pub fn update_element(
        &mut self,
        id: &str,
        patch: &ElementPatch,
        now: &str,
    ) -> Result<&'static str, CanvasError> {
        let has_geometry = patch.x.is_some()
            || patch.y.is_some()
            || patch.w.is_some()
            || patch.h.is_some()
            || patch.x2.is_some()
            || patch.y2.is_some();
        let has_textish = patch.text.is_some()
            || patch.color.is_some()
            || patch.fill.is_some()
            || patch.stroke.is_some()
            || patch.label.is_some()
            || patch.title.is_some();
        let has_relink = patch.from.is_some() || patch.to.is_some();
        if !has_geometry && !has_textish && !has_relink {
            return Err(CanvasError(
                "update 缺少可应用的字段（x/y/w/h/x2/y2/text/color/fill/stroke/label/from/to/title）"
                    .into(),
            ));
        }

        let locate = |entries: &[Value]| {
            entries
                .iter()
                .position(|entry| entry.get("id").and_then(Value::as_str) == Some(id))
        };

        if let Some(index) = locate(&self.cards) {
            if has_relink || patch.fill.is_some() || patch.stroke.is_some() || patch.label.is_some()
            {
                return Err(CanvasError(
                    "卡片不支持 from/to/fill/stroke/label 字段".into(),
                ));
            }
            let entry = self.cards[index]
                .as_object_mut()
                .expect("card is an object");
            Self::write_point_fields(entry, patch);
            Self::write_textish_field(entry, "title", patch.title.as_deref());
            Self::write_textish_field(entry, "text", patch.text.as_deref());
            Self::write_textish_field(entry, "color", patch.color.as_deref());
            self.touch(now);
            return Ok("card");
        }
        if let Some(index) = locate(&self.shapes) {
            if has_relink || patch.label.is_some() {
                return Err(CanvasError("形状不支持 from/to/label 字段".into()));
            }
            let shape_kind = self.shapes[index]
                .get("shape")
                .and_then(Value::as_str)
                .unwrap_or("rect")
                .to_owned();
            let two_point = matches!(shape_kind.as_str(), "arrow" | "line");
            if two_point
                && (patch.w.is_some() || patch.h.is_some())
                && !has_geometry_endpoints(patch)
            {
                return Err(CanvasError(
                    "箭头/线段的范围由两端点决定，请用 x2/y2 调整而不是 w/h".into(),
                ));
            }
            if !two_point && (patch.x2.is_some() || patch.y2.is_some()) {
                return Err(CanvasError(format!(
                    "{shape_kind} 形状不支持 x2/y2（仅箭头/线段有两端点）"
                )));
            }
            let entry = self.shapes[index]
                .as_object_mut()
                .expect("shape is an object");
            Self::write_point_fields(entry, patch);
            if two_point {
                // Keep the stored box consistent with the endpoints, exactly
                // like `add_shape` writes it (w = |x2-x|, h = |y2-y|).
                let x = entry.get("x").and_then(Value::as_f64).unwrap_or_default();
                let y = entry.get("y").and_then(Value::as_f64).unwrap_or_default();
                let x2 = entry.get("x2").and_then(Value::as_f64).unwrap_or(x);
                let y2 = entry.get("y2").and_then(Value::as_f64).unwrap_or(y);
                entry.insert("w".into(), json!(round_coord((x2 - x).abs())));
                entry.insert("h".into(), json!(round_coord((y2 - y).abs())));
            }
            Self::write_textish_field(entry, "text", patch.text.as_deref());
            Self::write_textish_field(entry, "fill", patch.fill.as_deref());
            Self::write_textish_field(entry, "stroke", patch.stroke.as_deref());
            self.touch(now);
            return Ok("shape");
        }
        if let Some(index) = locate(&self.frames) {
            if has_relink
                || patch.text.is_some()
                || patch.color.is_some()
                || patch.fill.is_some()
                || patch.stroke.is_some()
                || patch.label.is_some()
                || patch.x2.is_some()
                || patch.y2.is_some()
            {
                return Err(CanvasError("分组框只支持 x/y/w/h/title".into()));
            }
            let entry = self.frames[index]
                .as_object_mut()
                .expect("frame is an object");
            Self::write_point_fields(entry, patch);
            Self::write_textish_field(entry, "title", patch.title.as_deref());
            self.touch(now);
            return Ok("frame");
        }
        if let Some(index) = locate(&self.edges) {
            if has_geometry
                || patch.text.is_some()
                || patch.color.is_some()
                || patch.fill.is_some()
                || patch.stroke.is_some()
                || patch.title.is_some()
            {
                return Err(CanvasError("连线只支持 from/to/label".into()));
            }
            let from = patch
                .from
                .clone()
                .or_else(|| {
                    self.edges[index]
                        .get("from")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .expect("edge always has from");
            let to = patch
                .to
                .clone()
                .or_else(|| {
                    self.edges[index]
                        .get("to")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .expect("edge always has to");
            let connectable = self.connectable_ids();
            for endpoint in [&from, &to] {
                if !connectable.contains(endpoint) {
                    return Err(CanvasError(format!(
                        "连线端点不存在（需要已存在的卡片或形状 id）: {endpoint}"
                    )));
                }
            }
            let duplicates = self
                .board_edges()
                .iter()
                .any(|edge| edge.id != id && edge.from == from && edge.to == to);
            if duplicates {
                return Err(CanvasError(format!("连线已存在: {from} -> {to}")));
            }
            let entry = self.edges[index]
                .as_object_mut()
                .expect("edge is an object");
            entry.insert("from".into(), json!(from));
            entry.insert("to".into(), json!(to));
            Self::write_textish_field(entry, "label", patch.label.as_deref());
            self.touch(now);
            return Ok("edge");
        }
        if locate(&self.ink).is_some() {
            return Err(CanvasError(
                "手绘笔迹不支持 update（不支持整体改写），请 remove 后重画".into(),
            ));
        }
        Err(CanvasError(format!(
            "元素 id 不存在: {id}（先 show 查看现有元素 id）"
        )))
    }

    /// Write x/y/w/h (+x2/y2 when present in the patch) with the same
    /// rounding and minimum sizes the add paths use.
    fn write_point_fields(entry: &mut Map<String, Value>, patch: &ElementPatch) {
        if let Some(x) = patch.x {
            entry.insert("x".into(), json!(round_coord(x)));
        }
        if let Some(y) = patch.y {
            entry.insert("y".into(), json!(round_coord(y)));
        }
        if let Some(w) = patch.w {
            entry.insert("w".into(), json!(round_coord(w.max(MIN_ELEMENT_SIZE))));
        }
        if let Some(h) = patch.h {
            entry.insert("h".into(), json!(round_coord(h.max(MIN_ELEMENT_SIZE))));
        }
        if let Some(x2) = patch.x2 {
            entry.insert("x2".into(), json!(round_coord(x2)));
        }
        if let Some(y2) = patch.y2 {
            entry.insert("y2".into(), json!(round_coord(y2)));
        }
    }

    /// Set or clear an optional string field (blank clears the attribute,
    /// matching how the board view drops empty labels).
    fn write_textish_field(entry: &mut Map<String, Value>, key: &str, value: Option<&str>) {
        let Some(value) = value else { return };
        let trimmed = value.trim();
        if trimmed.is_empty() {
            entry.remove(key);
        } else {
            entry.insert(key.into(), json!(trimmed));
        }
    }

    /// Add note cards in a grid, mirroring the "spread notes on a canvas"
    /// flow the board view drives by hand. Positions start at `plan.start`
    /// (or auto-placed beside existing content) and advance column-first.
    /// Returns the new card ids in input order.
    pub fn add_note_cards(
        &mut self,
        notes: &[NoteCardInput],
        plan: &GridPlan,
        now: &str,
    ) -> Result<Vec<String>, CanvasError> {
        if notes.is_empty() {
            return Ok(Vec::new());
        }
        if plan.columns == 0 {
            return Err(CanvasError("grid columns 必须为正整数".into()));
        }
        let (w, h) = size_or(plan.w, plan.h, NOTE_CARD_SIZE);
        let (start_x, start_y) = match plan.start {
            Some((x, y)) => (x, y),
            None => self.auto_position(w, h),
        };
        let column_pitch = w + plan.gap_x.max(0.0);
        let row_pitch = h + plan.gap_y.max(0.0);
        let mut ids = Vec::with_capacity(notes.len());
        for (index, note) in notes.iter().enumerate() {
            let column = index % plan.columns;
            let row = index / plan.columns;
            let mut positioned = note.clone();
            positioned.x = Some(start_x + column as f64 * column_pitch);
            positioned.y = Some(start_y + row as f64 * row_pitch);
            positioned.w = Some(w);
            positioned.h = Some(h);
            ids.push(self.add_note_card(&positioned, now)?);
        }
        Ok(ids)
    }
}

// Inputs and reports

#[derive(Debug, Clone)]
pub struct NoteCardInput {
    pub notebook_id: String,
    pub notebook_name: Option<String>,
    /// Notebook-relative note path (`BoardCard.path`).
    pub path: String,
    pub title: Option<String>,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub w: Option<f64>,
    pub h: Option<f64>,
    pub render_scope: Option<String>,
    pub heading: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct TextCardInput {
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub w: Option<f64>,
    pub h: Option<f64>,
    pub text: Option<String>,
    pub color: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ShapeInput {
    pub shape: String,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub w: Option<f64>,
    pub h: Option<f64>,
    pub x2: Option<f64>,
    pub y2: Option<f64>,
    pub text: Option<String>,
    pub fill: Option<String>,
    pub stroke: Option<String>,
    pub font_size: Option<f64>,
    pub text_align: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct FrameInput {
    pub title: Option<String>,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub w: Option<f64>,
    pub h: Option<f64>,
}

/// Field patch for [`CanvasDocument::update_element`]. `None` leaves the
/// attribute unchanged; text-ish fields set to a blank string clear it.
#[derive(Debug, Clone, Default)]
pub struct ElementPatch {
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub w: Option<f64>,
    pub h: Option<f64>,
    pub x2: Option<f64>,
    pub y2: Option<f64>,
    pub text: Option<String>,
    pub color: Option<String>,
    pub fill: Option<String>,
    pub stroke: Option<String>,
    /// Edge label.
    pub label: Option<String>,
    /// Edge endpoint re-targeting.
    pub from: Option<String>,
    pub to: Option<String>,
    /// Frame title / note-card title snapshot.
    pub title: Option<String>,
}

#[derive(Debug, Clone, Copy)]
pub struct GridPlan {
    pub columns: usize,
    pub gap_x: f64,
    pub gap_y: f64,
    pub w: Option<f64>,
    pub h: Option<f64>,
    /// Explicit top-left; `None` auto-places beside existing content.
    pub start: Option<(f64, f64)>,
}

impl Default for GridPlan {
    fn default() -> Self {
        Self {
            columns: 3,
            gap_x: AUTO_PLACE_GAP,
            gap_y: AUTO_PLACE_GAP,
            w: None,
            h: None,
            start: None,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct RemoveReport {
    pub removed: Vec<String>,
    pub removed_edges: Vec<String>,
}

// Normalized reads

#[derive(Debug, Clone)]
pub struct BoardCard {
    pub id: String,
    pub kind: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub notebook_id: Option<String>,
    pub notebook_name: Option<String>,
    pub path: Option<String>,
    pub title: Option<String>,
    pub text: Option<String>,
    pub color: Option<String>,
    pub render_scope: Option<String>,
    pub heading: Option<String>,
}

#[derive(Debug, Clone)]
pub struct BoardShape {
    pub id: String,
    pub shape: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub x2: Option<f64>,
    pub y2: Option<f64>,
    pub text: Option<String>,
    pub fill: Option<String>,
    pub stroke: Option<String>,
}

#[derive(Debug, Clone)]
pub struct BoardEdge {
    pub id: String,
    pub from: String,
    pub to: String,
    pub label: Option<String>,
}

#[derive(Debug, Clone)]
pub struct BoardFrame {
    pub id: String,
    pub title: Option<String>,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub color: Option<String>,
}

impl BoardCard {
    pub fn to_summary(&self) -> Value {
        let mut value = json!({
            "id": self.id, "kind": self.kind, "x": self.x, "y": self.y, "w": self.w, "h": self.h,
        });
        let object = value.as_object_mut().expect("summary is an object");
        for (key, field) in [
            ("notebookId", &self.notebook_id),
            ("notebookName", &self.notebook_name),
            ("path", &self.path),
            ("title", &self.title),
            ("text", &self.text),
            ("color", &self.color),
            ("renderScope", &self.render_scope),
            ("heading", &self.heading),
        ] {
            if let Some(text) = field {
                object.insert(key.into(), json!(text));
            }
        }
        value
    }
}

impl BoardShape {
    pub fn to_summary(&self) -> Value {
        let mut value = json!({
            "id": self.id, "shape": self.shape, "x": self.x, "y": self.y, "w": self.w, "h": self.h,
        });
        let object = value.as_object_mut().expect("summary is an object");
        if let Some(x2) = self.x2 {
            object.insert("x2".into(), json!(x2));
        }
        if let Some(y2) = self.y2 {
            object.insert("y2".into(), json!(y2));
        }
        for (key, field) in [
            ("text", &self.text),
            ("fill", &self.fill),
            ("stroke", &self.stroke),
        ] {
            if let Some(text) = field {
                object.insert(key.into(), json!(text));
            }
        }
        value
    }
}

impl BoardEdge {
    pub fn to_summary(&self) -> Value {
        let mut value = json!({"id": self.id, "from": self.from, "to": self.to});
        if let Some(label) = &self.label {
            value
                .as_object_mut()
                .expect("summary is an object")
                .insert("label".into(), json!(label));
        }
        value
    }
}

impl BoardFrame {
    pub fn to_summary(&self) -> Value {
        let mut value = json!({"id": self.id, "x": self.x, "y": self.y, "w": self.w, "h": self.h});
        let object = value.as_object_mut().expect("summary is an object");
        if let Some(title) = &self.title {
            object.insert("title".into(), json!(title));
        }
        if let Some(color) = &self.color {
            object.insert("color".into(), json!(color));
        }
        value
    }
}

impl CanvasDocument {
    /// Compact agent-facing view: normalized board content plus counts.
    pub fn summary(&self) -> Value {
        json!({
            "type": CANVAS_DOCUMENT_TYPE,
            "version": CANVAS_DOCUMENT_VERSION,
            "meta": {"createdAt": self.created_at, "updatedAt": self.updated_at},
            "counts": {
                "cards": self.card_count(), "shapes": self.shape_count(),
                "edges": self.edge_count(), "frames": self.frame_count(),
                "ink": self.ink_count(), "elements": self.element_count(),
            },
            "cards": self.board_cards().iter().map(BoardCard::to_summary).collect::<Vec<_>>(),
            "shapes": self.board_shapes().iter().map(BoardShape::to_summary).collect::<Vec<_>>(),
            "edges": self.board_edges().iter().map(BoardEdge::to_summary).collect::<Vec<_>>(),
            "frames": self.board_frames().iter().map(BoardFrame::to_summary).collect::<Vec<_>>(),
            "viewport": self.viewport().map(|(x, y, zoom)| json!({"x": x, "y": y, "zoom": zoom})),
        })
    }
}

// Filesystem helpers

/// List notebook-relative paths of all canvas files below a notebook root.
/// Hidden / policy-ignored trees are skipped (mirrors the note index walk).
pub fn list_canvas_files(notebook_root: &Path) -> Vec<String> {
    let mut found = Vec::new();
    for entry in walkdir::WalkDir::new(notebook_root)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
    {
        let Ok(relative) = entry.path().strip_prefix(notebook_root) else {
            continue;
        };
        let relative = relative.to_string_lossy().replace('\\', "/");
        if relative.is_empty() || relative.split('/').any(|part| part.starts_with('.')) {
            continue;
        }
        if !is_canvas_path(&relative) {
            continue;
        }
        found.push(relative);
    }
    found.sort();
    found
}

/// Choose a free `<stem>.flowix-canvas` filename in `dir`, appending ` (N)`
/// like the frontend's create dialog. A trailing extension on `stem` is
/// stripped first, then the stem is sanitized.
pub fn unique_canvas_filename(dir: &Path, stem: &str) -> String {
    let trimmed = stem.trim().trim_end_matches(['.', ' ']);
    let stripped = trimmed
        .strip_suffix(&format!(".{CANVAS_FILE_EXTENSION}"))
        .unwrap_or_else(|| trimmed.strip_suffix(".canvas").unwrap_or(trimmed))
        .trim();
    let mut stem = super::memo_file::sanitize_filename_component(stripped);
    if stem.is_empty() {
        stem = "Untitled".into();
    }
    let occupied = |name: &str| dir.join(name).exists();
    let primary = format!("{stem}.{CANVAS_FILE_EXTENSION}");
    if !occupied(primary.to_ascii_lowercase().as_str()) && !occupied(&primary) {
        return primary;
    }
    let mut suffix = 2u32;
    loop {
        let candidate = format!("{stem} ({suffix}).{CANVAS_FILE_EXTENSION}");
        if !occupied(&candidate) && !occupied(candidate.to_ascii_lowercase().as_str()) {
            return candidate;
        }
        suffix += 1;
    }
}

/// Resolve a notebook-relative canvas path to an absolute path, rejecting
/// non-canvas paths and ignored trees.
pub fn resolve_canvas_path(notebook_root: &Path, relative: &str) -> Result<PathBuf, CanvasError> {
    if !is_canvas_path(relative) {
        return Err(CanvasError(format!(
            "画布地址必须是 .{CANVAS_FILE_EXTENSION} 文件: {relative}"
        )));
    }
    let path = super::memo_file::notebook_path_from_relative(notebook_root, relative)
        .map_err(|error| CanvasError(format!("画布路径非法: {error}")))?;
    if super::memo_file::is_ignored_notebook_relative_path(Path::new(relative)) {
        return Err(CanvasError(format!(
            "画布路径位于被忽略的目录内: {relative}"
        )));
    }
    Ok(path)
}

// Internals

fn round_coord(value: f64) -> i64 {
    value.round() as i64
}

/// True when the patch touches endpoint geometry (used to allow endpoint +
/// box together on two-point shapes, where endpoints win).
fn has_geometry_endpoints(patch: &ElementPatch) -> bool {
    patch.x.is_some() || patch.y.is_some() || patch.x2.is_some() || patch.y2.is_some()
}

fn size_or(w: Option<f64>, h: Option<f64>, default: (f64, f64)) -> (f64, f64) {
    (
        w.filter(|size| *size >= MIN_ELEMENT_SIZE)
            .unwrap_or(default.0),
        h.filter(|size| *size >= MIN_ELEMENT_SIZE)
            .unwrap_or(default.1),
    )
}

fn position_or(x: Option<f64>, y: Option<f64>, fallback: (f64, f64)) -> (f64, f64) {
    match (x, y) {
        (Some(x), Some(y)) => (x, y),
        (Some(x), None) => (x, fallback.1),
        (None, Some(y)) => (fallback.0, y),
        (None, None) => fallback,
    }
}

fn millis_to_base36(millis: i64) -> String {
    let mut value = millis.max(0) as u64;
    if value == 0 {
        return "0".into();
    }
    let mut digits = Vec::new();
    while value > 0 {
        digits.push(ID_ALPHABET[(value % 36) as usize]);
        value /= 36;
    }
    digits.into_iter().rev().collect()
}

#[cfg(test)]
mod tests;
