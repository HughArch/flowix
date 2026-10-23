//! Line (block) background colours encoded as trailing HTML comments.
//!
//! The editor paints a paragraph/heading background from a node attribute and
//! persists it next to the block:
//!
//! ```markdown
//! 这一行有淡黄色背景<!-- flowix:block-bg {"bg":"yellow"} -->
//! ```
//!
//! The comment trails the block's own Markdown, so ordinary readers still see
//! a plain paragraph. The CLI and MCP use this module to inspect and rewrite
//! those comments without understanding the editor's node model.

use serde::Serialize;

pub const COLORS: &[&str] = &[
    "red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink", "gray",
];

const COMMENT_OPEN: &str = "<!-- flowix:block-bg";
const TEXT_EXCERPT_LEN: usize = 80;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LineBackground {
    /// 1-based first line of the text block.
    pub start_line: usize,
    /// 1-based last line of the block; the comment lives on this line.
    pub end_line: usize,
    pub color: String,
    /// Plain-text excerpt of the block, for humans and agents.
    pub text: String,
}

#[derive(Debug, Clone)]
struct Block {
    /// 0-based inclusive line range.
    start: usize,
    end: usize,
    color: Option<String>,
}

/// List every block that currently carries a background colour.
pub fn parse(markdown: &str) -> Vec<LineBackground> {
    let lines: Vec<&str> = markdown.lines().collect();
    scan_blocks(&lines)
        .into_iter()
        .filter_map(|block| {
            let text = block_excerpt(&lines, &block);
            let color = block.color?;
            Some(LineBackground {
                start_line: block.start + 1,
                end_line: block.end + 1,
                color,
                text,
            })
        })
        .collect()
}

/// Set the background colour of the text block containing `line` (1-based).
pub fn set(markdown: &str, line: usize, color: &str) -> Result<String, String> {
    let color = normalize_color(color).ok_or_else(|| {
        format!(
            "unknown background color `{color}`; expected one of: {}",
            COLORS.join(", ")
        )
    })?;
    apply(markdown, line, Some(color))
}

/// Remove the background colour of the text block containing `line`.
pub fn clear(markdown: &str, line: usize) -> Result<String, String> {
    apply(markdown, line, None)
}

fn apply(markdown: &str, line: usize, color: Option<&str>) -> Result<String, String> {
    if line == 0 {
        return Err("line must be 1 or greater".into());
    }

    let lines: Vec<&str> = markdown.lines().collect();
    let blocks = scan_blocks(&lines);
    let block = blocks
        .iter()
        .find(|block| line - 1 >= block.start && line - 1 <= block.end)
        .ok_or_else(|| {
            format!(
                "line {line} is not inside a text block that can carry a background \
                 (blank lines, fences, table rows and table/column markers are skipped)"
            )
        })?;

    let mut next: Vec<String> = lines.iter().map(|line| (*line).to_string()).collect();
    let target = block.end;
    // Remove every previous marker (even one with an unknown colour) so
    // rewriting a row never stacks duplicate comments.
    let content = strip_all_comments(&next[target]);

    next[target] = match color {
        Some(color) => {
            let prefix = if needs_empty_marker(&content) {
                format!("{content} &nbsp;")
            } else {
                content
            };
            format!("{prefix}{COMMENT_OPEN} {{\"bg\":\"{color}\"}} -->")
        }
        None => content,
    };

    Ok(rebuild(markdown, next))
}

fn scan_blocks(lines: &[&str]) -> Vec<Block> {
    let mut blocks: Vec<Block> = Vec::new();
    let mut current: Option<Block> = None;
    let mut fence: Option<(char, usize)> = None;

    for (index, raw) in lines.iter().enumerate() {
        let line = raw.trim_end_matches('\r');
        let trimmed = line.trim();

        if let Some((marker, length)) = fence {
            if is_fence_close(trimmed, marker, length) {
                fence = None;
            }
            continue;
        }
        if let Some(open) = fence_open(trimmed) {
            finish_block(&mut current, &mut blocks);
            fence = Some(open);
            continue;
        }
        if trimmed.is_empty()
            || is_structural_line(trimmed)
            || trimmed.starts_with('|')
        {
            finish_block(&mut current, &mut blocks);
            continue;
        }

        let (_, color) = split_comment(line);

        if is_heading(trimmed) {
            // A heading never absorbs the paragraph that follows it.
            finish_block(&mut current, &mut blocks);
            blocks.push(Block {
                start: index,
                end: index,
                color,
            });
            continue;
        }

        let starts_block = is_list_item(trimmed) || current.is_none();
        if starts_block {
            finish_block(&mut current, &mut blocks);
            current = Some(Block {
                start: index,
                end: index,
                color,
            });
            continue;
        }

        if let Some(block) = current.as_mut() {
            block.end = index;
            if color.is_some() {
                block.color = color;
            }
        }
    }

    finish_block(&mut current, &mut blocks);
    blocks
}

fn finish_block(current: &mut Option<Block>, blocks: &mut Vec<Block>) {
    if let Some(block) = current.take() {
        blocks.push(block);
    }
}

fn block_excerpt(lines: &[&str], block: &Block) -> String {
    let text = lines[block.start..=block.end]
        .iter()
        .map(|line| split_comment(line).0)
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let mut excerpt: String = text.chars().take(TEXT_EXCERPT_LEN).collect();
    if text.chars().count() > TEXT_EXCERPT_LEN {
        excerpt.push('…');
    }
    excerpt
}

/// Split a trailing `flowix:block-bg` comment off a line.
///
/// A comment with an unknown colour is treated as ordinary text so a typo
/// cannot silently erase the block's content.
fn split_comment(line: &str) -> (String, Option<String>) {
    let Some(start) = line.rfind(COMMENT_OPEN) else {
        return (line.to_string(), None);
    };
    let tail = line[start..].trim_end();
    if !tail.ends_with("-->") {
        return (line.to_string(), None);
    }
    let (Some(json_start), Some(json_end)) = (tail.find('{'), tail.rfind('}')) else {
        return (line.to_string(), None);
    };
    if json_start >= json_end {
        return (line.to_string(), None);
    }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&tail[json_start..=json_end]) else {
        return (line.to_string(), None);
    };
    let Some(color) = value.get("bg").and_then(serde_json::Value::as_str) else {
        return (line.to_string(), None);
    };
    match normalize_color(color) {
        Some(color) => (line[..start].trim_end().to_string(), Some(color.to_string())),
        None => (line.to_string(), None),
    }
}

fn normalize_color(value: &str) -> Option<&'static str> {
    let value = value.trim();
    COLORS.iter().copied().find(|color| *color == value)
}

/// Drop every trailing block-background marker from a line.
fn strip_all_comments(line: &str) -> String {
    let mut result = line.to_string();
    while let Some(start) = result.rfind(COMMENT_OPEN) {
        let Some(offset) = result[start..].find("-->") else {
            break;
        };
        result.replace_range(start..start + offset + 3, "");
    }
    result.trim_end().to_string()
}

/// A list marker with no content (`-`, `1.`) needs the empty-line marker so
/// the trailing comment does not turn the item into a paragraph.
fn needs_empty_marker(content: &str) -> bool {
    let trimmed = content.trim_end();
    if matches!(trimmed, "-" | "*" | "+") {
        return true;
    }
    let digits = trimmed.chars().take_while(char::is_ascii_digit).count();
    digits > 0 && digits == trimmed.chars().count() - 1
        && trimmed.chars().last().is_some_and(|ch| ch == '.' || ch == ')')
}

fn rebuild(original: &str, lines: Vec<String>) -> String {
    let mut output = lines.join("\n");
    if original.ends_with('\n') {
        output.push('\n');
    }
    output
}

fn is_heading(line: &str) -> bool {
    let hashes = line.chars().take_while(|ch| *ch == '#').count();
    (1..=6).contains(&hashes)
        && line
            .chars()
            .nth(hashes)
            .is_some_and(|ch| ch.is_whitespace())
}

fn is_list_item(line: &str) -> bool {
    if let Some(rest) = line.strip_prefix(['-', '*', '+']) {
        return rest.starts_with(' ') || rest.starts_with('\t');
    }
    let digits = line.chars().take_while(char::is_ascii_digit).count();
    if digits == 0 || digits > 9 {
        return false;
    }
    let rest = &line[digits..];
    if let Some(rest) = rest.strip_prefix('.').or_else(|| rest.strip_prefix(')')) {
        return rest.starts_with(' ') || rest.starts_with('\t');
    }
    false
}

fn is_structural_line(line: &str) -> bool {
    line == "::: columns"
        || line == ":::"
        || line == "::::"
        || line.starts_with(":::: column")
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
    length >= open_length && line.chars().nth(length).is_none_or(char::is_whitespace)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sets_and_reads_a_paragraph_background() {
        let source = "first\n\nsecond\n";
        let output = set(source, 3, "yellow").unwrap();
        assert_eq!(output, "first\n\nsecond<!-- flowix:block-bg {\"bg\":\"yellow\"} -->\n");

        let blocks = parse(&output);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].start_line, 3);
        assert_eq!(blocks[0].end_line, 3);
        assert_eq!(blocks[0].color, "yellow");
        assert_eq!(blocks[0].text, "second");
    }

    #[test]
    fn targets_the_whole_multi_line_paragraph() {
        let source = "line one\nline two\n\nnext\n";
        let output = set(source, 1, "blue").unwrap();
        assert_eq!(
            output,
            "line one\nline two<!-- flowix:block-bg {\"bg\":\"blue\"} -->\n\nnext\n"
        );
        assert_eq!(parse(&output)[0].end_line, 2);
    }

    #[test]
    fn replaces_and_clears_an_existing_colour() {
        let source = "text<!-- flowix:block-bg {\"bg\":\"red\"} -->\n";
        let replaced = set(source, 1, "green").unwrap();
        assert_eq!(replaced, "text<!-- flowix:block-bg {\"bg\":\"green\"} -->\n");

        let cleared = clear(&replaced, 1).unwrap();
        assert_eq!(cleared, "text\n");
        assert!(parse(&cleared).is_empty());
    }

    #[test]
    fn handles_headings_and_list_items() {
        let source = "# Title\n\n- one\n- two\n";
        let with_heading = set(source, 1, "pink").unwrap();
        assert!(with_heading.starts_with("# Title<!-- flowix:block-bg {\"bg\":\"pink\"} -->\n"));

        let with_item = set(&with_heading, 4, "gray").unwrap();
        assert!(with_item.contains("- two<!-- flowix:block-bg {\"bg\":\"gray\"} -->"));
        assert_eq!(parse(&with_item).len(), 2);
    }

    #[test]
    fn keeps_an_empty_list_item_a_list_item() {
        let output = set("- \n- two\n", 1, "red").unwrap();
        assert!(output.starts_with("- &nbsp;<!-- flowix:block-bg {\"bg\":\"red\"} -->\n"));
    }

    #[test]
    fn skips_fences_tables_and_column_markers() {
        let source = "```\ncode\n```\n\n::: columns\n\n:::: column width=100\n\ntext\n\n::::\n\n:::\n";
        // Line 2 is inside a fence, line 5 is the columns opener, line 7 is a
        // column marker — only the paragraph at line 9 is addressable.
        assert!(set(source, 2, "red").is_err());
        assert!(set(source, 5, "red").is_err());
        assert!(set(source, 7, "red").is_err());
        assert!(set(source, 9, "red").unwrap().contains("text<!-- flowix:block-bg"));
    }

    #[test]
    fn rejects_unknown_colours_and_blank_lines() {
        assert!(set("a\n\nb\n", 1, "chartreuse").is_err());
        assert!(set("a\n\nb\n", 2, "red").is_err());
        assert!(set("a\n", 0, "red").is_err());
    }

    #[test]
    fn ignores_comments_with_an_unknown_colour() {
        let source = "text<!-- flowix:block-bg {\"bg\":\"nope\"} -->\n";
        assert!(parse(source).is_empty());
        // Rewriting replaces the invalid marker instead of stacking a second one.
        assert_eq!(
            set(source, 1, "cyan").unwrap(),
            "text<!-- flowix:block-bg {\"bg\":\"cyan\"} -->\n"
        );
    }
}
