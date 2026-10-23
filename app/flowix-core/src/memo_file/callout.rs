//! Flowus-style callouts encoded as fenced divs.
//!
//! ```markdown
//! ::: callout icon="💡" color="orange"
//!
//! content
//!
//! :::
//! ```
//!
//! The editor writes this format; the CLI and MCP use the same parser so agents
//! can inspect and rewrite callouts without understanding the layout.
//!
//! Parsing keeps the pre-preset defaults (💡 / gray) for fences without
//! attributes, so notes written before the colour presets existed do not change
//! appearance. New blocks created by [`insert`] default to the "info" preset
//! (💡 / orange).

use serde::Serialize;

pub const DEFAULT_ICON: &str = "💡";
/// Default for fences that omit `color` (legacy notes).
pub const PARSE_DEFAULT_COLOR: &str = "gray";
/// Default for newly inserted callouts (the "info" preset).
pub const NEW_DEFAULT_COLOR: &str = "orange";
pub const COLORS: [&str; 9] = [
    "red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink", "gray",
];

const MAX_ICON_CHARS: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CalloutBlock {
    /// 1-based line number of the `::: callout` opener.
    pub start_line: usize,
    /// 1-based line number of the closing `:::`.
    pub end_line: usize,
    pub icon: String,
    pub color: String,
    pub content: String,
}

/// Parse every well-formed callout. Malformed or unclosed blocks are ignored so
/// the surrounding Markdown stays intact.
pub fn parse(markdown: &str) -> Vec<CalloutBlock> {
    let lines: Vec<&str> = markdown.lines().collect();
    let mut blocks = Vec::new();
    let mut index = 0;

    while index < lines.len() {
        let Some(opening) = callout_open(lines[index]) else {
            index += 1;
            continue;
        };

        let attributes = parse_attributes(opening.rest);
        let icon = normalize_icon(
            attributes
                .iter()
                .find(|(key, _)| key == "icon")
                .map(|(_, value)| value.as_str())
                .unwrap_or(""),
        );
        let color = normalize_color(
            attributes
                .iter()
                .find(|(key, _)| key == "color")
                .map(|(_, value)| value.as_str()),
        );

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
            blocks.push(CalloutBlock {
                start_line: index + 1,
                end_line: end + 1,
                icon,
                color,
                content: normalize_content(&lines[index + 1..end]),
            });
            index = end + 1;
        } else {
            index += 1;
        }
    }

    blocks
}

/// Render a callout in the canonical fenced-div form. Defaults are omitted.
pub fn render(icon: &str, color: &str, content: &str) -> String {
    let icon = normalize_icon(icon);
    let color = normalize_color(Some(color));

    let mut attributes = Vec::new();
    if icon != DEFAULT_ICON {
        attributes.push(format!("icon={}", quote(&icon)));
    }
    if color != PARSE_DEFAULT_COLOR {
        attributes.push(format!("color={}", quote(&color)));
    }

    let mut output = String::from("::: callout");
    if !attributes.is_empty() {
        output.push(' ');
        output.push_str(&attributes.join(" "));
    }
    output.push('\n');

    let content = content.trim();
    if !content.is_empty() {
        output.push('\n');
        output.push_str(content);
        output.push('\n');
    }
    output.push_str("\n:::\n");
    output
}

/// Insert a callout before `at_line` (1-based), or append it.
pub fn insert(
    markdown: &str,
    at_line: Option<usize>,
    icon: Option<&str>,
    color: Option<&str>,
    content: &str,
) -> Result<String, String> {
    let color = match color {
        Some(value) => validate_color(value)?,
        None => NEW_DEFAULT_COLOR.to_string(),
    };
    let icon = normalize_icon(icon.unwrap_or(DEFAULT_ICON));
    let block = render(&icon, &color, content);
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

/// Update the icon and/or color of one callout, keeping its content.
pub fn set(
    markdown: &str,
    block_index: usize,
    icon: Option<&str>,
    color: Option<&str>,
) -> Result<String, String> {
    if icon.is_none() && color.is_none() {
        return Err("provide at least one of icon or color".into());
    }
    let blocks = parse(markdown);
    let block = blocks
        .get(block_index)
        .ok_or_else(|| format!("callout {} not found", block_index + 1))?;

    let next_icon = icon.map(normalize_icon).unwrap_or_else(|| block.icon.clone());
    let next_color = match color {
        Some(value) => validate_color(value)?,
        None => block.color.clone(),
    };
    let replacement = render(&next_icon, &next_color, &block.content);

    Ok(replace_lines(
        markdown,
        block.start_line,
        block.end_line,
        replacement.trim_end_matches('\n'),
    ))
}

/// Remove a callout. With `keep_content`, its body is hoisted into the note.
pub fn remove(
    markdown: &str,
    block_index: usize,
    keep_content: bool,
) -> Result<String, String> {
    let blocks = parse(markdown);
    let block = blocks
        .get(block_index)
        .ok_or_else(|| format!("callout {} not found", block_index + 1))?;
    let replacement = if keep_content {
        block.content.clone()
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
                "unknown callout color `{}`; expected one of: {}",
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

fn normalize_color(value: Option<&str>) -> String {
    value
        .and_then(canonical_color)
        .map(str::to_string)
        .unwrap_or_else(|| PARSE_DEFAULT_COLOR.to_string())
}

fn normalize_icon(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .filter(|ch| *ch != '\r' && *ch != '\n')
        .collect();
    let cleaned = cleaned.trim();
    if cleaned.is_empty() || cleaned.chars().count() > MAX_ICON_CHARS {
        DEFAULT_ICON.to_string()
    } else {
        cleaned.to_string()
    }
}

fn quote(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| format!("\"{value}\""))
}

struct CalloutOpen<'a> {
    fence_length: usize,
    rest: &'a str,
}

fn callout_open(line: &str) -> Option<CalloutOpen<'_>> {
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
    let rest = rest.strip_prefix("callout")?;
    if !rest.is_empty() && !starts_with_space(rest) {
        return None;
    }
    Some(CalloutOpen {
        fence_length,
        rest: rest.trim(),
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

    const BASIC: &str = "::: callout icon=\"💡\" color=\"yellow\"\n\ncontent\n\n:::\n";

    #[test]
    fn parses_attributes_and_content() {
        let blocks = parse(&format!("before\n\n{BASIC}\nafter\n"));
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].start_line, 3);
        assert_eq!(blocks[0].icon, "💡");
        assert_eq!(blocks[0].color, "yellow");
        assert_eq!(blocks[0].content, "content");
    }

    #[test]
    fn legacy_fences_default_to_gray() {
        let blocks = parse("::: callout\n\nhello\n\n:::\n");
        assert_eq!(blocks[0].icon, DEFAULT_ICON);
        assert_eq!(blocks[0].color, PARSE_DEFAULT_COLOR);
    }

    #[test]
    fn accepts_attributes_in_any_order_and_ignores_unknown_ones() {
        let blocks = parse("::: callout color='green' unknown=x icon=\"🚀\"\n\nhi\n\n:::\n");
        assert_eq!(blocks[0].icon, "🚀");
        assert_eq!(blocks[0].color, "green");
    }

    #[test]
    fn round_trips_rendered_blocks() {
        let rendered = render("⚠️", "yellow", "line one\n\n- item");
        let blocks = parse(&rendered);
        assert_eq!(blocks[0].icon, "⚠️");
        assert_eq!(blocks[0].color, "yellow");
        assert_eq!(blocks[0].content, "line one\n\n- item");
    }

    #[test]
    fn omits_default_attributes() {
        let rendered = render(DEFAULT_ICON, PARSE_DEFAULT_COLOR, "body");
        assert!(rendered.starts_with("::: callout\n"));
        assert!(!rendered.contains("icon="));
        assert!(!rendered.contains("color="));
    }

    #[test]
    fn inserts_with_the_info_default() {
        let output = insert("a\nb\n", Some(2), None, None, "body").unwrap();
        assert!(output.starts_with("a\n\n::: callout color=\"orange\"\n"));
        assert!(output.contains("body"));
        assert!(output.contains("b\n"));
        let blocks = parse(&output);
        assert_eq!(blocks[0].color, NEW_DEFAULT_COLOR);
        assert_eq!(blocks[0].content, "body");
    }

    #[test]
    fn appends_when_no_line_is_given() {
        let output = insert("a\n", None, Some("⚠️"), Some("YELLOW"), "").unwrap();
        assert!(output.starts_with("a\n\n::: callout icon=\"⚠️\" color=\"yellow\""));
        assert_eq!(parse(&output).len(), 1);
    }

    #[test]
    fn updates_icon_and_color_without_touching_content() {
        let output = set(BASIC, 0, Some("✅"), Some("green")).unwrap();
        let blocks = parse(&output);
        assert_eq!(blocks[0].icon, "✅");
        assert_eq!(blocks[0].color, "green");
        assert_eq!(blocks[0].content, "content");
    }

    #[test]
    fn rejects_unknown_colors_and_empty_updates() {
        assert!(set(BASIC, 0, None, Some("teal")).is_err());
        assert!(set(BASIC, 0, None, None).is_err());
        assert!(insert("x", None, None, Some("teal"), "").is_err());
    }

    #[test]
    fn removes_with_or_without_content() {
        let hoisted = remove(BASIC, 0, true).unwrap();
        assert!(!hoisted.contains("::: callout"));
        assert!(hoisted.contains("content"));

        let deleted = remove(BASIC, 0, false).unwrap();
        assert!(!deleted.contains("content"));
        assert!(!deleted.contains("::: callout"));
    }

    #[test]
    fn balances_nested_fenced_divs() {
        let source = "::: callout color=\"blue\"\n\nouter\n\n::: columns\n\n:::: column width=100\n\ninner\n\n::::\n\n:::: column width=100\n\nright\n\n::::\n\n:::\n\n:::\n";
        let blocks = parse(source);
        assert_eq!(blocks.len(), 1);
        assert!(blocks[0].content.contains("::: columns"));
        assert!(blocks[0].content.contains("inner"));
    }

    #[test]
    fn ignores_fences_and_unclosed_blocks() {
        let source = "```\n::: callout\n```\n\n::: callout\n\nno close\n";
        assert!(parse(source).is_empty());
    }

    #[test]
    fn decodes_quoted_and_escaped_icons() {
        let blocks = parse("::: callout icon=\"a\\\"b\" color=\"red\"\n\nx\n\n:::\n");
        assert_eq!(blocks[0].icon, "a\"b");
        assert_eq!(blocks[0].color, "red");
    }
}
