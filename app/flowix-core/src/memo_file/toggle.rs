//! Flowus-style toggle blocks encoded as fenced divs.
//!
//! ```markdown
//! ::: toggle collapsed bg="yellow"
//!
//! title
//!
//! body
//!
//! :::
//! ```
//!
//! The editor writes this format; the CLI and MCP use the same parser so agents
//! can inspect and rewrite toggles without understanding the layout.
//!
//! The first block inside the fence is the title line and the remaining blocks
//! form the collapsible body. An empty title with a body is serialized as
//! `&nbsp;` so the body never gets promoted into the title slot on re-parse.

use serde::Serialize;

pub const COLORS: [&str; 9] = [
    "red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink", "gray",
];

/// Title placeholder used by the editor for an empty title with a body.
const EMPTY_TITLE: &str = "&nbsp;";
const NON_BREAKING_SPACE: char = '\u{a0}';

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ToggleBlock {
    /// 1-based line number of the `::: toggle` opener.
    pub start_line: usize,
    /// 1-based line number of the closing `:::`.
    pub end_line: usize,
    /// `false` when the fence carries the `collapsed` flag.
    pub open: bool,
    /// Optional whole-container background color.
    pub bg: Option<String>,
    /// Title line (first block inside the fence), without the `&nbsp;` marker.
    pub title: String,
    /// Remaining Markdown after the title.
    pub body: String,
    /// Complete inner Markdown (title + blank line + body).
    pub content: String,
}

/// How [`set`] should treat the container background.
#[derive(Debug, Clone, Copy)]
pub enum BackgroundUpdate<'a> {
    Keep,
    Set(&'a str),
    Clear,
}

/// Parse every well-formed toggle. Malformed or unclosed blocks are ignored so
/// the surrounding Markdown stays intact.
pub fn parse(markdown: &str) -> Vec<ToggleBlock> {
    let lines: Vec<&str> = markdown.lines().collect();
    let mut blocks = Vec::new();
    let mut index = 0;

    while index < lines.len() {
        let Some(opening) = toggle_open(lines[index]) else {
            index += 1;
            continue;
        };

        let attributes = parse_attributes(opening.rest);
        let bg = attributes
            .iter()
            .find(|(key, _)| key == "bg")
            .and_then(|(_, value)| canonical_color(value))
            .map(str::to_string);

        let outer_fence = opening.fence_length;
        let mut nested_fences: Vec<usize> = Vec::new();
        let mut code_fence: Option<(char, usize)> = None;
        let mut end = None;
        let mut cursor = index + 1;

        while cursor < lines.len() {
            let line = lines[cursor].trim_end_matches('\r');
            let trimmed = line.trim();

            if let Some((marker, length)) = code_fence {
                if is_fence_close(trimmed, marker, length) {
                    code_fence = None;
                }
                cursor += 1;
                continue;
            }
            if let Some(open) = fence_open(trimmed) {
                code_fence = Some(open);
                cursor += 1;
                continue;
            }

            if let Some(close_length) = fenced_div_close(trimmed) {
                if let Some(&top) = nested_fences.last() {
                    if close_length >= top {
                        nested_fences.pop();
                    }
                    cursor += 1;
                    continue;
                }
                if close_length >= outer_fence {
                    end = Some(cursor);
                    break;
                }
                cursor += 1;
                continue;
            }

            if let Some(length) = fenced_div_open(trimmed) {
                nested_fences.push(length);
            }
            cursor += 1;
        }

        if let Some(end) = end {
            let content = normalize_content(&lines[index + 1..end]);
            let (title, body) = split_title_body(&content);
            blocks.push(ToggleBlock {
                start_line: index + 1,
                end_line: end + 1,
                open: !opening.collapsed,
                bg,
                title,
                body,
                content,
            });
            index = end + 1;
        } else {
            index += 1;
        }
    }

    blocks
}

/// Render a toggle in the canonical fenced-div form. Defaults are omitted.
pub fn render(title: &str, body: &str, open: bool, bg: Option<&str>) -> String {
    let title = title.trim_end();
    let body = body.trim();
    let bg = bg.and_then(canonical_color);

    let mut flags = Vec::new();
    if !open {
        flags.push("collapsed".to_string());
    }
    if let Some(bg) = bg {
        flags.push(format!("bg={}", quote(bg)));
    }

    let mut output = String::from("::: toggle");
    if !flags.is_empty() {
        output.push(' ');
        output.push_str(&flags.join(" "));
    }
    output.push('\n');

    // An empty title must still occupy the title slot when a body follows,
    // otherwise the first body block would be parsed back as the title.
    let title_output = if title.is_empty() && !body.is_empty() {
        EMPTY_TITLE
    } else {
        title
    };
    if !title_output.is_empty() {
        output.push('\n');
        output.push_str(title_output);
        output.push('\n');
    }
    if !body.is_empty() {
        output.push('\n');
        output.push_str(body);
        output.push('\n');
    }
    output.push_str("\n:::\n");
    output
}

/// Insert a toggle before `at_line` (1-based), or append it.
pub fn insert(
    markdown: &str,
    at_line: Option<usize>,
    title: &str,
    body: &str,
    open: bool,
    bg: Option<&str>,
) -> Result<String, String> {
    let bg = match bg {
        Some(value) => Some(validate_color(value)?),
        None => None,
    };
    let block = render(title, body, open, bg.as_deref());
    let lines: Vec<&str> = markdown.lines().collect();
    let insert_at = at_line
        .map(|line| line.saturating_sub(1).min(lines.len()))
        .unwrap_or(lines.len());
    let mut result: Vec<String> = Vec::with_capacity(lines.len() + 8);

    for (index, line) in lines.iter().enumerate() {
        if index == insert_at {
            push_separator(&mut result);
            result.extend(block.lines().map(str::to_string));
            result.push(String::new());
        }
        result.push((*line).to_string());
    }
    if insert_at >= lines.len() {
        push_separator(&mut result);
        result.extend(block.lines().map(str::to_string));
    }

    Ok(finish(markdown, result))
}

/// Update the title, body, fold state and/or background of one toggle.
pub fn set(
    markdown: &str,
    block_index: usize,
    title: Option<&str>,
    body: Option<&str>,
    open: Option<bool>,
    bg: BackgroundUpdate<'_>,
) -> Result<String, String> {
    if title.is_none()
        && body.is_none()
        && open.is_none()
        && matches!(bg, BackgroundUpdate::Keep)
    {
        return Err("provide at least one of title, content, open or bg".into());
    }
    let blocks = parse(markdown);
    let block = blocks
        .get(block_index)
        .ok_or_else(|| format!("toggle {} not found", block_index + 1))?;

    let next_title = title.map(str::to_string).unwrap_or_else(|| block.title.clone());
    let next_body = body.map(str::to_string).unwrap_or_else(|| block.body.clone());
    let next_open = open.unwrap_or(block.open);
    let next_bg = match bg {
        BackgroundUpdate::Keep => block.bg.clone(),
        BackgroundUpdate::Set(value) => Some(validate_color(value)?),
        BackgroundUpdate::Clear => None,
    };
    let replacement = render(&next_title, &next_body, next_open, next_bg.as_deref());

    Ok(replace_lines(
        markdown,
        block.start_line,
        block.end_line,
        replacement.trim_end_matches('\n'),
    ))
}

/// Remove a toggle. With `keep_content`, the title and body are hoisted into
/// the note as plain Markdown.
pub fn remove(markdown: &str, block_index: usize, keep_content: bool) -> Result<String, String> {
    let blocks = parse(markdown);
    let block = blocks
        .get(block_index)
        .ok_or_else(|| format!("toggle {} not found", block_index + 1))?;

    let replacement = if keep_content {
        let mut parts = Vec::new();
        if !block.title.is_empty() {
            parts.push(block.title.clone());
        }
        if !block.body.is_empty() {
            parts.push(block.body.clone());
        }
        parts.join("\n\n")
    } else {
        String::new()
    };

    Ok(replace_lines(
        markdown,
        block.start_line,
        block.end_line,
        &replacement,
    ))
}

/// Validate a palette color, returning its canonical lowercase form.
pub fn validate_color(color: &str) -> Result<String, String> {
    canonical_color(color)
        .map(str::to_string)
        .ok_or_else(|| {
            format!(
                "unknown toggle background color `{}`; expected one of: {}",
                color.trim(),
                COLORS.join(", ")
            )
        })
}

fn canonical_color(value: &str) -> Option<&'static str> {
    let value = value.trim();
    COLORS
        .iter()
        .copied()
        .find(|color| color.eq_ignore_ascii_case(value))
}

fn quote(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| format!("\"{value}\""))
}

/// Split the inner Markdown at the first blank line.
///
/// The editor always writes a blank line between the title and the body, so
/// the first block is the title. The `&nbsp;` placeholder is normalized back
/// to an empty title for round-tripping.
fn split_title_body(content: &str) -> (String, String) {
    let mut title_lines: Vec<&str> = Vec::new();
    let mut body_lines: Vec<&str> = Vec::new();
    let mut in_body = false;

    for line in content.lines() {
        if !in_body && line.trim().is_empty() {
            in_body = true;
            continue;
        }
        if in_body {
            body_lines.push(line);
        } else {
            title_lines.push(line);
        }
    }

    let title = title_lines.join("\n");
    let title = title.trim_end();
    let title = if title == EMPTY_TITLE || title.chars().all(|ch| ch == NON_BREAKING_SPACE) {
        String::new()
    } else {
        title.to_string()
    };
    let body = body_lines.join("\n").trim().to_string();
    (title, body)
}

struct ToggleOpen<'a> {
    fence_length: usize,
    collapsed: bool,
    rest: &'a str,
}

fn toggle_open(line: &str) -> Option<ToggleOpen<'_>> {
    let line = line.trim_end_matches('\r').trim_start();
    let fence_length = line.chars().take_while(|ch| *ch == ':').count();
    if fence_length < 3 {
        return None;
    }
    let rest = &line[fence_length..];
    if !starts_with_space(rest) {
        return None;
    }
    let rest = rest.trim_start();
    let rest = rest.strip_prefix("toggle")?;
    if !rest.is_empty() && !starts_with_space(rest) {
        return None;
    }
    let rest = rest.trim();
    let collapsed = rest.split_whitespace().any(|token| token == "collapsed");
    Some(ToggleOpen {
        fence_length,
        collapsed,
        rest,
    })
}

fn starts_with_space(value: &str) -> bool {
    value.chars().next().is_some_and(char::is_whitespace)
}

fn parse_attributes(input: &str) -> Vec<(String, String)> {
    let chars: Vec<char> = input.chars().collect();
    let mut attributes = Vec::new();
    let mut index = 0;

    while index < chars.len() {
        while index < chars.len() && chars[index].is_whitespace() {
            index += 1;
        }
        let key_start = index;
        while index < chars.len()
            && (chars[index].is_alphanumeric() || chars[index] == '-' || chars[index] == '_')
        {
            index += 1;
        }
        if index == key_start {
            index += 1;
            continue;
        }
        let key: String = chars[key_start..index].iter().collect();

        while index < chars.len() && chars[index].is_whitespace() {
            index += 1;
        }
        if index >= chars.len() || chars[index] != '=' {
            continue;
        }
        index += 1;
        while index < chars.len() && chars[index].is_whitespace() {
            index += 1;
        }
        if index >= chars.len() {
            break;
        }

        let value = if chars[index] == '"' || chars[index] == '\'' {
            let quote_char = chars[index];
            index += 1;
            let mut raw = String::new();
            let mut escaped = false;
            while index < chars.len() {
                let ch = chars[index];
                if escaped {
                    raw.push('\\');
                    raw.push(ch);
                    escaped = false;
                    index += 1;
                    continue;
                }
                if ch == '\\' {
                    escaped = true;
                    index += 1;
                    continue;
                }
                if ch == quote_char {
                    index += 1;
                    break;
                }
                raw.push(ch);
                index += 1;
            }
            if quote_char == '"' {
                serde_json::from_str(&format!("\"{raw}\"")).unwrap_or(raw)
            } else {
                raw.replace("\\'", "'").replace("\\\\", "\\")
            }
        } else {
            let value_start = index;
            while index < chars.len() && !chars[index].is_whitespace() {
                index += 1;
            }
            chars[value_start..index].iter().collect()
        };

        attributes.push((key, value));
    }

    attributes
}

fn fenced_div_close(line: &str) -> Option<usize> {
    let length = line.chars().take_while(|ch| *ch == ':').count();
    if length < 3 || !line[length..].trim().is_empty() {
        return None;
    }
    Some(length)
}

fn fenced_div_open(line: &str) -> Option<usize> {
    let length = line.chars().take_while(|ch| *ch == ':').count();
    if length < 3 {
        return None;
    }
    let rest = line[length..].trim_start();
    let first = rest.chars().next()?;
    first.is_ascii_alphabetic().then_some(length)
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

fn normalize_content(lines: &[&str]) -> String {
    let values: Vec<&str> = lines
        .iter()
        .map(|line| line.trim_end_matches('\r'))
        .collect();
    let mut start = 0;
    while start < values.len() && values[start].trim().is_empty() {
        start += 1;
    }
    let mut end = values.len();
    while end > start && values[end - 1].trim().is_empty() {
        end -= 1;
    }
    values[start..end].join("\n")
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

fn replace_lines(
    markdown: &str,
    start_line: usize,
    end_line: usize,
    replacement: &str,
) -> String {
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

    const BASIC: &str = "::: toggle\n\ntitle\n\nbody\n\n:::\n";

    #[test]
    fn parses_title_body_and_defaults() {
        let blocks = parse(&format!("before\n\n{BASIC}\nafter\n"));
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].start_line, 3);
        assert_eq!(blocks[0].end_line, 9);
        assert!(blocks[0].open);
        assert_eq!(blocks[0].bg, None);
        assert_eq!(blocks[0].title, "title");
        assert_eq!(blocks[0].body, "body");
        assert_eq!(blocks[0].content, "title\n\nbody");
    }

    #[test]
    fn parses_collapsed_and_background_flags() {
        let blocks = parse("::: toggle bg=\"yellow\" collapsed\n\ntitle\n\nbody\n\n:::\n");
        assert!(!blocks[0].open);
        assert_eq!(blocks[0].bg.as_deref(), Some("yellow"));
    }

    #[test]
    fn ignores_unknown_flags_and_invalid_backgrounds() {
        let blocks = parse("::: toggle collapsed unknown=x bg=\"teal\"\n\ntitle\n\nbody\n\n:::\n");
        assert!(!blocks[0].open);
        assert_eq!(blocks[0].bg, None);
    }

    #[test]
    fn round_trips_rendered_blocks() {
        let rendered = render("title", "- item\n\nbody", false, Some("blue"));
        let blocks = parse(&rendered);
        assert_eq!(blocks[0].title, "title");
        assert_eq!(blocks[0].body, "- item\n\nbody");
        assert!(!blocks[0].open);
        assert_eq!(blocks[0].bg.as_deref(), Some("blue"));
        assert_eq!(render("title", "- item\n\nbody", false, Some("blue")), rendered);
    }

    #[test]
    fn omits_default_flags() {
        let rendered = render("title", "body", true, None);
        assert!(rendered.starts_with("::: toggle\n"));
        assert!(!rendered.contains("collapsed"));
        assert!(!rendered.contains("bg="));
    }

    #[test]
    fn keeps_the_title_slot_for_empty_titles_with_a_body() {
        let rendered = render("", "body", true, None);
        assert!(rendered.contains("\n\n&nbsp;\n\n"));
        let blocks = parse(&rendered);
        assert_eq!(blocks[0].title, "");
        assert_eq!(blocks[0].body, "body");
    }

    #[test]
    fn renders_a_completely_empty_toggle() {
        let rendered = render("", "", true, None);
        assert_eq!(rendered, "::: toggle\n\n:::\n");
        let blocks = parse(&rendered);
        assert_eq!(blocks[0].title, "");
        assert_eq!(blocks[0].body, "");
    }

    #[test]
    fn inserts_at_a_line_or_at_the_end() {
        let output = insert("a\nb\n", Some(2), "title", "body", true, None).unwrap();
        assert!(output.starts_with("a\n\n::: toggle\n"));
        assert!(output.contains("title"));
        assert!(output.contains("b\n"));
        assert_eq!(parse(&output)[0].body, "body");

        let appended = insert("a\n", None, "title", "body", false, Some("YELLOW")).unwrap();
        assert!(appended.contains("::: toggle collapsed bg=\"yellow\""));
        assert_eq!(parse(&appended)[0].bg.as_deref(), Some("yellow"));
    }

    #[test]
    fn updates_fields_without_touching_the_rest() {
        let updated = set(
            BASIC,
            0,
            Some("new title"),
            None,
            Some(false),
            BackgroundUpdate::Set("green"),
        )
        .unwrap();
        let blocks = parse(&updated);
        assert_eq!(blocks[0].title, "new title");
        assert_eq!(blocks[0].body, "body");
        assert!(!blocks[0].open);
        assert_eq!(blocks[0].bg.as_deref(), Some("green"));

        let cleared = set(BASIC, 0, None, None, None, BackgroundUpdate::Clear).unwrap();
        assert_eq!(parse(&cleared)[0].bg, None);
    }

    #[test]
    fn rejects_empty_updates_and_unknown_colors() {
        assert!(set(BASIC, 0, None, None, None, BackgroundUpdate::Keep).is_err());
        assert!(set(BASIC, 0, None, None, None, BackgroundUpdate::Set("teal")).is_err());
        assert!(insert("x", None, "", "", true, Some("teal")).is_err());
    }

    #[test]
    fn removes_with_or_without_content() {
        let hoisted = remove(BASIC, 0, true).unwrap();
        assert!(!hoisted.contains("::: toggle"));
        assert!(hoisted.contains("title"));
        assert!(hoisted.contains("body"));

        let deleted = remove(BASIC, 0, false).unwrap();
        assert!(!deleted.contains("body"));
        assert!(!deleted.contains("::: toggle"));
    }

    #[test]
    fn balances_nested_fenced_divs() {
        let source = "::: toggle\n\nouter\n\n::: callout icon=\"💡\"\n\ninner\n\n:::\n\n:::\n";
        let blocks = parse(source);
        assert_eq!(blocks.len(), 1);
        assert!(blocks[0].body.contains("::: callout"));
        assert!(blocks[0].body.contains("inner"));
    }

    #[test]
    fn ignores_fences_and_unclosed_blocks() {
        let source = "```\n::: toggle\n```\n\n::: toggle\n\nno close\n";
        assert!(parse(source).is_empty());
    }
}
