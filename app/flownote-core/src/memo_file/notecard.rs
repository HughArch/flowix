//! Block-level note reference cards (`/笔记卡片`) encoded as a single-line
//! directive carrying a JSON payload:
//!
//! ```markdown
//! ::notecard{"notebookId":"work","relativePath":"Notes/A.md","notebookName":"work","title":"A","originalPath":null,"linkStyle":"flownote","linkTarget":null,"heading":null,"stale":false,"layout":"card","color":"","customText":""}
//! ```
//!
//! The editor writes this format (see
//! `features/editor/extensions/note-block/note-reference-block-markdown.ts`);
//! the CLI, MCP and the built-in assistant share this parser so agents can
//! insert, restyle and remove cards without hand-writing the payload.
//!
//! Three layouts mirror the editor's hover toolbar: `line` (icon + title +
//! snippet on one row), `card` (small bordered card) and `cardLarge` (cover
//! banner + title + snippet). `color` fills the card with a note colour and
//! `customText` replaces the note snippet.
//!
//! Payload keys this module does not model are preserved verbatim across
//! [`set`], so attributes added by a newer editor survive an older CLI.

use serde::Serialize;
use serde_json::{Map, Value};

pub const MARKER: &str = "::notecard";
pub const LAYOUTS: [&str; 3] = ["line", "card", "cardLarge"];
pub const DEFAULT_LAYOUT: &str = "card";
/// Card fill palette; mirrors `NOTE_COLORS` in the web app.
pub const COLORS: [&str; 7] = ["red", "orange", "yellow", "green", "cyan", "blue", "gray"];

/// Payload keys in the editor's serialisation order.
const KEYS: [&str; 12] = [
    "notebookId",
    "relativePath",
    "notebookName",
    "title",
    "originalPath",
    "linkStyle",
    "linkTarget",
    "heading",
    "stale",
    "layout",
    "color",
    "customText",
];

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteCardBlock {
    /// 1-based line of the `::notecard` directive.
    pub start_line: usize,
    /// 1-based line where the payload closes (equals `start_line` for the
    /// editor's single-line form).
    pub end_line: usize,
    /// `<notebookId>::<relativePath>` when both locator fields are present.
    pub address: Option<String>,
    pub notebook_id: Option<String>,
    pub relative_path: Option<String>,
    pub notebook_name: String,
    pub title: String,
    pub layout: String,
    /// Card fill colour; empty means no fill.
    pub color: String,
    /// Display text replacing the note snippet; empty means use the snippet.
    pub custom_text: String,
    pub stale: bool,
    pub link_style: String,
    pub link_target: Option<String>,
    pub heading: Option<String>,
    /// Raw payload for lossless rewrites.
    #[serde(skip)]
    attrs: Map<String, Value>,
}

/// Locator and presentation of a newly inserted card.
#[derive(Debug, Clone, Default)]
pub struct NoteCardInput<'a> {
    pub notebook_id: &'a str,
    pub relative_path: &'a str,
    pub notebook_name: &'a str,
    pub title: &'a str,
    pub layout: Option<&'a str>,
    pub color: Option<&'a str>,
    pub custom_text: Option<&'a str>,
}

/// Three-state update shared by the optional presentation fields.
#[derive(Debug, Clone, Copy, Default)]
pub enum FieldUpdate<'a> {
    #[default]
    Keep,
    Set(&'a str),
    Clear,
}

#[derive(Debug, Clone, Default)]
pub struct NoteCardUpdate<'a> {
    pub layout: Option<&'a str>,
    pub title: Option<&'a str>,
    pub color: FieldUpdate<'a>,
    pub custom_text: FieldUpdate<'a>,
}

/// Parse every note card. A directive whose payload never closes (or closes
/// with trailing text on the same line) is left alone as ordinary Markdown.
pub fn parse(markdown: &str) -> Vec<NoteCardBlock> {
    let lines: Vec<&str> = markdown.lines().collect();
    let mut blocks = Vec::new();
    let mut code_fence: Option<(char, usize)> = None;
    let mut index = 0;

    while index < lines.len() {
        let trimmed = lines[index].trim_end_matches('\r').trim();

        if let Some((marker, length)) = code_fence {
            if is_fence_close(trimmed, marker, length) {
                code_fence = None;
            }
            index += 1;
            continue;
        }
        if let Some(open) = fence_open(trimmed) {
            code_fence = Some(open);
            index += 1;
            continue;
        }

        let Some(payload_start) = payload_start(trimmed) else {
            index += 1;
            continue;
        };
        let Some((payload, end)) = collect_payload(&lines, index, &trimmed[payload_start..]) else {
            index += 1;
            continue;
        };
        // The editor keeps a card even when its payload is unreadable, so the
        // block index stays aligned with what the user sees.
        let attrs = match serde_json::from_str::<Value>(&payload) {
            Ok(Value::Object(map)) => map,
            _ => Map::new(),
        };
        blocks.push(block_from_attrs(index + 1, end + 1, attrs));
        index = end + 1;
    }

    blocks
}

/// Render a card directive from a full payload.
pub fn render(attrs: &Map<String, Value>) -> String {
    let payload = serde_json::to_string(attrs).unwrap_or_else(|_| "{}".to_string());
    format!("{MARKER}{payload}")
}

/// Insert a card before `at_line` (1-based), or append it.
pub fn insert(
    markdown: &str,
    at_line: Option<usize>,
    input: &NoteCardInput<'_>,
) -> Result<String, String> {
    let block = render(&input_attrs(input)?);
    let lines: Vec<&str> = markdown.lines().collect();
    let insert_at = at_line
        .map(|line| line.saturating_sub(1).min(lines.len()))
        .unwrap_or(lines.len());
    let mut result: Vec<String> = Vec::with_capacity(lines.len() + 3);

    for (index, line) in lines.iter().enumerate() {
        if index == insert_at {
            push_separator(&mut result);
            result.push(block.clone());
            result.push(String::new());
        }
        result.push((*line).to_string());
    }
    if insert_at >= lines.len() {
        push_separator(&mut result);
        result.push(block);
    }

    Ok(finish(markdown, result))
}

/// Update the layout, title, fill colour and/or custom text of one card.
pub fn set(
    markdown: &str,
    block_index: usize,
    update: &NoteCardUpdate<'_>,
) -> Result<String, String> {
    if update.layout.is_none()
        && update.title.is_none()
        && matches!(update.color, FieldUpdate::Keep)
        && matches!(update.custom_text, FieldUpdate::Keep)
    {
        return Err("provide at least one of layout, title, color or text".into());
    }
    let blocks = parse(markdown);
    let block = blocks
        .get(block_index)
        .ok_or_else(|| format!("note card {} not found", block_index + 1))?;

    let mut attrs = block.attrs.clone();
    if let Some(layout) = update.layout {
        attrs.insert("layout".into(), Value::String(validate_layout(layout)?));
    }
    if let Some(title) = update.title {
        attrs.insert("title".into(), Value::String(title.trim().to_owned()));
    }
    match update.color {
        FieldUpdate::Set(color) => {
            attrs.insert("color".into(), Value::String(validate_color(color)?));
        }
        FieldUpdate::Clear => {
            attrs.insert("color".into(), Value::String(String::new()));
        }
        FieldUpdate::Keep => {}
    }
    match update.custom_text {
        FieldUpdate::Set(text) => {
            attrs.insert("customText".into(), Value::String(text.trim().to_owned()));
        }
        FieldUpdate::Clear => {
            attrs.insert("customText".into(), Value::String(String::new()));
        }
        FieldUpdate::Keep => {}
    }

    Ok(replace_lines(
        markdown,
        block.start_line,
        block.end_line,
        &render(&canonicalize(&attrs)),
    ))
}

/// Remove a card. Cards have no body, so nothing is hoisted.
pub fn remove(markdown: &str, block_index: usize) -> Result<String, String> {
    let blocks = parse(markdown);
    let block = blocks
        .get(block_index)
        .ok_or_else(|| format!("note card {} not found", block_index + 1))?;
    Ok(replace_lines(
        markdown,
        block.start_line,
        block.end_line,
        "",
    ))
}

/// Validate a layout name, returning its canonical spelling.
pub fn validate_layout(value: &str) -> Result<String, String> {
    let value = value.trim();
    LAYOUTS
        .iter()
        .find(|layout| layout.eq_ignore_ascii_case(value))
        .map(|layout| (*layout).to_string())
        .ok_or_else(|| {
            format!(
                "unknown note card layout `{value}`; expected one of: {}",
                LAYOUTS.join(", ")
            )
        })
}

/// Validate a fill colour, returning its canonical lowercase form.
pub fn validate_color(value: &str) -> Result<String, String> {
    let value = value.trim();
    COLORS
        .iter()
        .find(|color| color.eq_ignore_ascii_case(value))
        .map(|color| (*color).to_string())
        .ok_or_else(|| {
            format!(
                "unknown note card color `{value}`; expected one of: {}",
                COLORS.join(", ")
            )
        })
}

fn input_attrs(input: &NoteCardInput<'_>) -> Result<Map<String, Value>, String> {
    let notebook_id = input.notebook_id.trim();
    let relative_path = input.relative_path.trim();
    if notebook_id.is_empty() || relative_path.is_empty() {
        return Err("note card needs a target note (notebook id and relative path)".into());
    }
    let mut attrs = Map::new();
    attrs.insert("notebookId".into(), Value::String(notebook_id.to_owned()));
    attrs.insert(
        "relativePath".into(),
        Value::String(relative_path.to_owned()),
    );
    attrs.insert(
        "notebookName".into(),
        Value::String(input.notebook_name.trim().to_owned()),
    );
    attrs.insert("title".into(), Value::String(input.title.trim().to_owned()));
    attrs.insert(
        "layout".into(),
        Value::String(match input.layout {
            Some(layout) => validate_layout(layout)?,
            None => DEFAULT_LAYOUT.to_string(),
        }),
    );
    attrs.insert(
        "color".into(),
        Value::String(match input.color {
            Some(color) => validate_color(color)?,
            None => String::new(),
        }),
    );
    attrs.insert(
        "customText".into(),
        Value::String(
            input
                .custom_text
                .map(str::trim)
                .unwrap_or_default()
                .to_owned(),
        ),
    );
    Ok(canonicalize(&attrs))
}

/// Full payload in the editor's key order: known fields normalised the same
/// way `normalizeNoteBlockAttrs` does, unknown keys appended untouched.
fn canonicalize(attrs: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    out.insert("notebookId".into(), nullable_value(attrs.get("notebookId")));
    out.insert(
        "relativePath".into(),
        nullable_value(attrs.get("relativePath")),
    );
    out.insert("notebookName".into(), text_value(attrs.get("notebookName")));
    out.insert("title".into(), text_value(attrs.get("title")));
    out.insert(
        "originalPath".into(),
        nullable_value(attrs.get("originalPath")),
    );
    out.insert(
        "linkStyle".into(),
        Value::String(normalize_link_style(attrs.get("linkStyle"))),
    );
    out.insert("linkTarget".into(), nullable_value(attrs.get("linkTarget")));
    out.insert("heading".into(), nullable_value(attrs.get("heading")));
    out.insert("stale".into(), Value::Bool(bool_of(attrs.get("stale"))));
    out.insert(
        "layout".into(),
        Value::String(normalize_layout(attrs.get("layout"))),
    );
    out.insert("color".into(), text_value(attrs.get("color")));
    out.insert("customText".into(), text_value(attrs.get("customText")));
    for (key, value) in attrs {
        if !KEYS.contains(&key.as_str()) {
            out.insert(key.clone(), value.clone());
        }
    }
    out
}

fn block_from_attrs(
    start_line: usize,
    end_line: usize,
    attrs: Map<String, Value>,
) -> NoteCardBlock {
    let notebook_id = nullable_text(attrs.get("notebookId"));
    let relative_path = nullable_text(attrs.get("relativePath"));
    let address = match (&notebook_id, &relative_path) {
        (Some(notebook), Some(path)) => Some(format!("{notebook}::{path}")),
        _ => None,
    };
    NoteCardBlock {
        start_line,
        end_line,
        address,
        notebook_id,
        relative_path,
        notebook_name: text(attrs.get("notebookName")),
        title: text(attrs.get("title")),
        layout: normalize_layout(attrs.get("layout")),
        color: text(attrs.get("color")),
        custom_text: text(attrs.get("customText")),
        stale: bool_of(attrs.get("stale")),
        link_style: normalize_link_style(attrs.get("linkStyle")),
        link_target: nullable_text(attrs.get("linkTarget")),
        heading: nullable_text(attrs.get("heading")),
        attrs,
    }
}

fn text(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_default()
}

fn nullable_text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

fn text_value(value: Option<&Value>) -> Value {
    Value::String(text(value))
}

fn nullable_value(value: Option<&Value>) -> Value {
    nullable_text(value)
        .map(Value::String)
        .unwrap_or(Value::Null)
}

fn bool_of(value: Option<&Value>) -> bool {
    value.and_then(Value::as_bool).unwrap_or(false)
}

fn normalize_layout(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .filter(|layout| LAYOUTS.contains(layout))
        .unwrap_or(DEFAULT_LAYOUT)
        .to_string()
}

fn normalize_link_style(value: Option<&Value>) -> String {
    match value.and_then(Value::as_str) {
        Some(style @ ("wiki" | "markdown")) => style.to_string(),
        _ => "flownote".to_string(),
    }
}

/// Byte offset of the payload's opening brace within a trimmed directive line.
fn payload_start(trimmed: &str) -> Option<usize> {
    let rest = trimmed.strip_prefix(MARKER)?;
    let skipped = rest.len() - rest.trim_start().len();
    rest[skipped..]
        .starts_with('{')
        .then_some(MARKER.len() + skipped)
}

/// Walk the JSON payload from its opening brace, continuing onto following
/// lines until the braces balance. Returns the payload text and the 0-based
/// index of the line it closes on. A string left open at a line end is
/// malformed JSON, so the directive is rejected instead of swallowing the rest
/// of the note.
fn collect_payload(lines: &[&str], start: usize, first: &str) -> Option<(String, usize)> {
    let mut scanner = BraceScanner::default();
    let mut payload = String::new();
    let mut index = start;
    let mut segment = first;
    loop {
        match scanner.feed(segment) {
            Some(close) => {
                if !segment[close..].trim().is_empty() {
                    return None;
                }
                payload.push_str(&segment[..close]);
                return Some((payload, index));
            }
            None if scanner.in_string => return None,
            None => {
                payload.push_str(segment);
                payload.push('\n');
            }
        }
        index += 1;
        segment = lines.get(index)?.trim_end_matches('\r');
    }
}

#[derive(Default)]
struct BraceScanner {
    depth: usize,
    in_string: bool,
    escaped: bool,
}

impl BraceScanner {
    /// Feed one line; returns the byte offset just past the closing brace when
    /// the payload balances on this line.
    fn feed(&mut self, segment: &str) -> Option<usize> {
        for (offset, ch) in segment.char_indices() {
            if self.in_string {
                if self.escaped {
                    self.escaped = false;
                } else if ch == '\\' {
                    self.escaped = true;
                } else if ch == '"' {
                    self.in_string = false;
                }
                continue;
            }
            match ch {
                '"' => self.in_string = true,
                '{' => self.depth += 1,
                '}' => {
                    self.depth = self.depth.saturating_sub(1);
                    if self.depth == 0 {
                        return Some(offset + ch.len_utf8());
                    }
                }
                _ => {}
            }
        }
        None
    }
}

fn fence_open(line: &str) -> Option<(char, usize)> {
    let first = line.chars().next()?;
    if first != '`' && first != '~' {
        return None;
    }
    let length = line.chars().take_while(|ch| *ch == first).count();
    (length >= 3).then_some((first, length))
}

fn is_fence_close(line: &str, marker: char, open_length: usize) -> bool {
    let length = line.chars().take_while(|ch| *ch == marker).count();
    length >= open_length && line.chars().nth(length).is_none_or(|ch| ch.is_whitespace())
}

fn push_separator(lines: &mut Vec<String>) {
    if lines.last().map(|line| !line.is_empty()).unwrap_or(false) {
        lines.push(String::new());
    }
}

fn finish(original: &str, lines: Vec<String>) -> String {
    let mut output = lines.join("\n");
    if original.ends_with('\n') {
        output.push('\n');
    }
    output
}

fn replace_lines(markdown: &str, start_line: usize, end_line: usize, replacement: &str) -> String {
    let lines: Vec<&str> = markdown.lines().collect();
    let start = start_line.saturating_sub(1).min(lines.len());
    let end = end_line.min(lines.len());
    let mut result: Vec<String> = Vec::new();
    result.extend(lines[..start].iter().map(|line| (*line).to_string()));
    if !replacement.is_empty() {
        result.extend(replacement.lines().map(str::to_string));
    }
    result.extend(lines[end..].iter().map(|line| (*line).to_string()));
    finish(markdown, result)
}

#[cfg(test)]
mod tests {
    use super::*;

    const EDITOR_LINE: &str = r#"::notecard{"notebookId":"work","relativePath":"Notes/A.md","notebookName":"Work","title":"A","originalPath":null,"linkStyle":"flownote","linkTarget":null,"heading":null,"stale":false,"layout":"cardLarge","color":"blue","customText":"read me"}"#;

    fn input<'a>() -> NoteCardInput<'a> {
        NoteCardInput {
            notebook_id: "work",
            relative_path: "Notes/A.md",
            notebook_name: "Work",
            title: "A",
            ..NoteCardInput::default()
        }
    }

    #[test]
    fn parses_the_editor_form() {
        let blocks = parse(&format!("# Title\n\n{EDITOR_LINE}\n\nafter\n"));
        assert_eq!(blocks.len(), 1);
        let block = &blocks[0];
        assert_eq!(block.start_line, 3);
        assert_eq!(block.end_line, 3);
        assert_eq!(block.address.as_deref(), Some("work::Notes/A.md"));
        assert_eq!(block.notebook_name, "Work");
        assert_eq!(block.title, "A");
        assert_eq!(block.layout, "cardLarge");
        assert_eq!(block.color, "blue");
        assert_eq!(block.custom_text, "read me");
        assert!(!block.stale);
        assert_eq!(block.link_style, "flownote");
    }

    #[test]
    fn normalises_missing_and_invalid_fields_like_the_editor() {
        let blocks =
            parse(r#"::notecard{"notebookId":"","layout":"huge","linkStyle":"odd","stale":"yes"}"#);
        let block = &blocks[0];
        assert_eq!(block.notebook_id, None);
        assert_eq!(block.address, None);
        assert_eq!(block.layout, DEFAULT_LAYOUT);
        assert_eq!(block.link_style, "flownote");
        assert!(!block.stale);
        assert_eq!(block.color, "");
    }

    #[test]
    fn keeps_a_card_with_an_unreadable_payload() {
        let blocks = parse("::notecard{\"title\":}\n");
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].title, "");
    }

    #[test]
    fn brace_in_title_does_not_end_the_payload() {
        let blocks =
            parse(r#"::notecard{"notebookId":"w","relativePath":"x.md","title":"a } b {"}"#);
        assert_eq!(blocks[0].title, "a } b {");
    }

    #[test]
    fn allows_whitespace_and_indentation_around_the_payload() {
        let blocks = parse("  ::notecard  {\"notebookId\":\"w\",\"relativePath\":\"x.md\"}  \n");
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].address.as_deref(), Some("w::x.md"));
    }

    #[test]
    fn accepts_a_wrapped_payload() {
        let md = "::notecard{\n  \"notebookId\": \"w\",\n  \"relativePath\": \"x.md\"\n}\nafter\n";
        let blocks = parse(md);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].start_line, 1);
        assert_eq!(blocks[0].end_line, 4);
        assert_eq!(blocks[0].address.as_deref(), Some("w::x.md"));
    }

    #[test]
    fn rejects_trailing_text_unclosed_and_fenced_directives() {
        assert!(parse("::notecard{\"a\":1} trailing\n").is_empty());
        assert!(parse("::notecard{\"a\":1\nnever closes\n").is_empty());
        assert!(parse("::notecard{\"a\":\"open string\n}\n").is_empty());
        assert!(parse("::notecard\n").is_empty());
        assert!(parse(&format!("```\n{EDITOR_LINE}\n```\n")).is_empty());
    }

    #[test]
    fn insert_appends_with_a_separator_and_canonical_keys() {
        let next = insert("# Title\nbody\n", None, &input()).unwrap();
        assert_eq!(
            next,
            format!(
                "# Title\nbody\n\n{MARKER}{}\n",
                r#"{"notebookId":"work","relativePath":"Notes/A.md","notebookName":"Work","title":"A","originalPath":null,"linkStyle":"flownote","linkTarget":null,"heading":null,"stale":false,"layout":"card","color":"","customText":""}"#
            )
        );
        let blocks = parse(&next);
        assert_eq!(blocks[0].start_line, 4);
        assert_eq!(blocks[0].layout, "card");
    }

    #[test]
    fn insert_before_a_line_and_with_presentation() {
        let next = insert(
            "one\ntwo\n",
            Some(2),
            &NoteCardInput {
                layout: Some("CARDLARGE"),
                color: Some("Blue"),
                custom_text: Some("  hint  "),
                ..input()
            },
        )
        .unwrap();
        let blocks = parse(&next);
        assert_eq!(blocks[0].start_line, 3);
        assert_eq!(blocks[0].layout, "cardLarge");
        assert_eq!(blocks[0].color, "blue");
        assert_eq!(blocks[0].custom_text, "hint");
        assert!(next.starts_with("one\n\n::notecard"));
        assert!(next.ends_with("\n\ntwo\n"));
    }

    #[test]
    fn insert_rejects_missing_target_and_bad_values() {
        let missing = insert("", None, &NoteCardInput::default()).unwrap_err();
        assert!(missing.contains("target note"));
        let layout = insert(
            "",
            None,
            &NoteCardInput {
                layout: Some("huge"),
                ..input()
            },
        )
        .unwrap_err();
        assert!(layout.contains("unknown note card layout"));
        let color = insert(
            "",
            None,
            &NoteCardInput {
                color: Some("teal"),
                ..input()
            },
        )
        .unwrap_err();
        assert!(color.contains("unknown note card color"));
    }

    #[test]
    fn set_updates_fields_and_preserves_unknown_keys() {
        let md = format!(
            "intro\n{}\noutro\n",
            r#"::notecard{"notebookId":"w","relativePath":"x.md","title":"old","layout":"line","color":"red","customText":"c","future":{"k":[1]}}"#
        );
        let next = set(
            &md,
            0,
            &NoteCardUpdate {
                layout: Some("card"),
                title: Some("new"),
                color: FieldUpdate::Clear,
                custom_text: FieldUpdate::Set("fresh"),
            },
        )
        .unwrap();
        let blocks = parse(&next);
        assert_eq!(blocks[0].layout, "card");
        assert_eq!(blocks[0].title, "new");
        assert_eq!(blocks[0].color, "");
        assert_eq!(blocks[0].custom_text, "fresh");
        assert_eq!(blocks[0].address.as_deref(), Some("w::x.md"));
        assert!(next.contains(r#""future":{"k":[1]}"#));
        assert!(next.starts_with("intro\n::notecard{\"notebookId\":\"w\""));
        assert!(next.ends_with("}\noutro\n"));
    }

    #[test]
    fn set_requires_a_change_and_an_existing_block() {
        let md = format!("{EDITOR_LINE}\n");
        assert!(set(&md, 0, &NoteCardUpdate::default())
            .unwrap_err()
            .contains("at least one"));
        assert!(set(
            &md,
            3,
            &NoteCardUpdate {
                layout: Some("line"),
                ..NoteCardUpdate::default()
            }
        )
        .unwrap_err()
        .contains("not found"));
    }

    #[test]
    fn set_rewrites_a_wrapped_payload_onto_one_line() {
        let md = "::notecard{\n  \"notebookId\": \"w\",\n  \"relativePath\": \"x.md\"\n}\nafter\n";
        let next = set(
            md,
            0,
            &NoteCardUpdate {
                layout: Some("line"),
                ..NoteCardUpdate::default()
            },
        )
        .unwrap();
        assert_eq!(next.lines().count(), 2);
        assert_eq!(parse(&next)[0].layout, "line");
        assert!(next.ends_with("after\n"));
    }

    #[test]
    fn remove_drops_the_directive_line() {
        let md = format!("before\n\n{EDITOR_LINE}\n\nafter\n");
        let next = remove(&md, 0).unwrap();
        assert!(!next.contains(MARKER));
        assert!(next.contains("before"));
        assert!(next.contains("after"));
        assert!(remove(&md, 1).unwrap_err().contains("not found"));
    }

    #[test]
    fn round_trips_through_render() {
        let blocks = parse(EDITOR_LINE);
        assert_eq!(render(&canonicalize(&blocks[0].attrs)), EDITOR_LINE);
    }
}
