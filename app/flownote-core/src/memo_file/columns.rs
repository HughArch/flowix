//! Notion-style content columns encoded as fenced divs.
//!
//! ```markdown
//! ::: columns
//!
//! :::: column width=100
//!
//! left
//!
//! ::::
//!
//! :::: column width=100
//!
//! right
//!
//! ::::
//!
//! :::
//! ```
//!
//! The editor writes this format; the CLI and MCP use the same parser so
//! agents can inspect and rewrite a note without understanding the layout.

use serde::Serialize;

pub const MIN_COLUMNS: usize = 2;
pub const MAX_COLUMNS: usize = 5;
pub const DEFAULT_WIDTH: u32 = 100;
const MIN_WIDTH: u32 = 25;
const MAX_WIDTH: u32 = 1000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ColumnSpec {
    pub width: u32,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ColumnsBlock {
    /// 1-based line number of the `::: columns` opener.
    pub start_line: usize,
    /// 1-based line number of the closing `:::`.
    pub end_line: usize,
    pub columns: Vec<ColumnSpec>,
}

/// Parse every well-formed columns block. Malformed or unclosed blocks are
/// ignored so the surrounding Markdown stays intact.
pub fn parse(markdown: &str) -> Vec<ColumnsBlock> {
    let lines: Vec<&str> = markdown.lines().collect();
    let mut blocks = Vec::new();
    let mut index = 0;

    while index < lines.len() {
        if !is_columns_open(lines[index]) {
            index += 1;
            continue;
        }

        let start = index;
        let mut columns = Vec::new();
        let mut current: Option<(u32, Vec<&str>)> = None;
        let mut fence: Option<(char, usize)> = None;
        let mut end = None;
        let mut cursor = index + 1;

        while cursor < lines.len() {
            let line = lines[cursor].trim_end_matches('\r');
            let trimmed = line.trim();

            if let Some((marker, length)) = fence {
                if is_fence_close(trimmed, marker, length) {
                    fence = None;
                }
                if let Some((_, content)) = current.as_mut() {
                    content.push(line);
                }
                cursor += 1;
                continue;
            }
            if let Some(open) = fence_open(trimmed) {
                fence = Some(open);
                if let Some((_, content)) = current.as_mut() {
                    content.push(line);
                }
                cursor += 1;
                continue;
            }

            if let Some(width) = column_open(line) {
                if current.is_some() {
                    // Nested columns are not supported; keep the marker as
                    // content rather than corrupting the outer block.
                    if let Some((_, content)) = current.as_mut() {
                        content.push(line);
                    }
                } else {
                    current = Some((width, Vec::new()));
                }
                cursor += 1;
                continue;
            }
            if is_column_close(line) {
                if let Some((width, content)) = current.take() {
                    columns.push(ColumnSpec {
                        width,
                        content: normalize_content(&content),
                    });
                }
                cursor += 1;
                continue;
            }
            if is_columns_close(line) {
                if current.is_none() && columns.len() >= MIN_COLUMNS {
                    end = Some(cursor);
                }
                break;
            }

            if let Some((_, content)) = current.as_mut() {
                content.push(line);
            }
            cursor += 1;
        }

        if let Some(end) = end {
            blocks.push(ColumnsBlock {
                start_line: start + 1,
                end_line: end + 1,
                columns,
            });
            index = end + 1;
        } else {
            index += 1;
        }
    }

    blocks
}

/// Render columns back into the canonical fenced-div form.
pub fn render(columns: &[ColumnSpec]) -> String {
    let mut output = String::from("::: columns\n");
    for column in columns {
        output.push_str(&format!("\n:::: column width={}\n\n", column.width));
        let content = column.content.trim();
        if !content.is_empty() {
            output.push_str(content);
            output.push('\n');
        }
        output.push_str("\n::::\n");
    }
    output.push_str("\n:::\n");
    output
}

/// Insert an empty columns block before `at_line` (1-based), or append it.
pub fn insert(markdown: &str, at_line: Option<usize>, count: usize) -> Result<String, String> {
    let columns = vec![
        ColumnSpec {
            width: DEFAULT_WIDTH,
            content: String::new(),
        };
        count
    ];
    insert_specs(markdown, at_line, &columns)
}

/// Insert a columns block with explicit per-column content. Used by agents
/// that generate a filled layout in one call.
pub fn insert_specs(
    markdown: &str,
    at_line: Option<usize>,
    columns: &[ColumnSpec],
) -> Result<String, String> {
    if !(MIN_COLUMNS..=MAX_COLUMNS).contains(&columns.len()) {
        return Err(format!(
            "columns count must be between {MIN_COLUMNS} and {MAX_COLUMNS}"
        ));
    }

    let block = render(columns);
    let lines: Vec<&str> = markdown.lines().collect();
    let insert_at = at_line
        .map(|line| line.saturating_sub(1).min(lines.len()))
        .unwrap_or(lines.len());
    let mut result: Vec<String> = Vec::with_capacity(lines.len() + columns.len());

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

/// Remove one column. Its content is hoisted after the block; when a single
/// column remains the container dissolves into plain Markdown.
pub fn remove_column(
    markdown: &str,
    block_index: usize,
    column_index: usize,
) -> Result<String, String> {
    let blocks = parse(markdown);
    let block = blocks
        .get(block_index)
        .ok_or_else(|| format!("columns block {} not found", block_index + 1))?;
    if column_index >= block.columns.len() {
        return Err(format!(
            "column {} not found in columns block {}",
            column_index + 1,
            block_index + 1
        ));
    }

    let mut columns = block.columns.clone();
    columns.remove(column_index);
    let replacement = if columns.len() <= 1 {
        columns
            .first()
            .map(|column| column.content.clone())
            .unwrap_or_default()
    } else {
        render(&columns).trim_end_matches('\n').to_string()
    };

    Ok(replace_lines(
        markdown,
        block.start_line,
        block.end_line,
        &replacement,
    ))
}

/// Set the widths of every column in a block. Widths use the same relative
/// weights as the editor (default 100).
pub fn set_widths(
    markdown: &str,
    block_index: usize,
    widths: &[u32],
) -> Result<String, String> {
    let blocks = parse(markdown);
    let block = blocks
        .get(block_index)
        .ok_or_else(|| format!("columns block {} not found", block_index + 1))?;
    if widths.len() != block.columns.len() {
        return Err(format!(
            "columns block {} has {} columns, but {} widths were provided",
            block_index + 1,
            block.columns.len(),
            widths.len()
        ));
    }

    let columns: Vec<ColumnSpec> = block
        .columns
        .iter()
        .zip(widths)
        .map(|(column, width)| ColumnSpec {
            width: (*width).clamp(MIN_WIDTH, MAX_WIDTH),
            content: column.content.clone(),
        })
        .collect();

    Ok(replace_lines(
        markdown,
        block.start_line,
        block.end_line,
        render(&columns).trim_end_matches('\n'),
    ))
}

fn normalize_content(lines: &[&str]) -> String {
    let mut start = 0;
    while start < lines.len() && lines[start].trim().is_empty() {
        start += 1;
    }
    let mut end = lines.len();
    while end > start && lines[end - 1].trim().is_empty() {
        end -= 1;
    }
    lines[start..end].join("\n")
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

fn is_columns_open(line: &str) -> bool {
    line.trim() == "::: columns"
}

fn is_columns_close(line: &str) -> bool {
    line.trim() == ":::"
}

fn column_open(line: &str) -> Option<u32> {
    let trimmed = line.trim();
    let rest = trimmed.strip_prefix("::::")?;
    let rest = rest.trim_start();
    let rest = rest.strip_prefix("column")?;
    let rest = rest.trim();
    if rest.is_empty() {
        return Some(DEFAULT_WIDTH);
    }
    let value = rest.strip_prefix("width=")?;
    let parsed = value.trim().parse::<u32>().unwrap_or(DEFAULT_WIDTH);
    Some(parsed.clamp(MIN_WIDTH, MAX_WIDTH))
}

fn is_column_close(line: &str) -> bool {
    line.trim() == "::::"
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

#[cfg(test)]
mod tests {
    use super::*;

    const TWO_COLUMNS: &str = "::: columns\n\n:::: column width=100\n\nleft\n\n::::\n\n:::: column width=200\n\nright\n\n::::\n\n:::\n";

    #[test]
    fn parses_two_columns() {
        let blocks = parse(TWO_COLUMNS);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].start_line, 1);
        assert_eq!(blocks[0].columns.len(), 2);
        assert_eq!(blocks[0].columns[0].width, 100);
        assert_eq!(blocks[0].columns[0].content, "left");
        assert_eq!(blocks[0].columns[1].width, 200);
        assert_eq!(blocks[0].columns[1].content, "right");
    }

    #[test]
    fn round_trips_rendered_columns() {
        let columns = vec![
            ColumnSpec {
                width: 100,
                content: "- a\n- b".into(),
            },
            ColumnSpec {
                width: 50,
                content: "text".into(),
            },
        ];
        let rendered = render(&columns);
        assert_eq!(parse(&rendered)[0].columns, columns);
    }

    #[test]
    fn ignores_fences_and_unclosed_blocks() {
        let source = "```\n::: columns\n```\n\n::: columns\n\n:::: column\n\nx\n\n::::\n";
        assert!(parse(source).is_empty());
    }

    #[test]
    fn inserts_an_empty_block_before_a_line() {
        let output = insert("a\nb\n", Some(2), 3).unwrap();
        assert!(output.starts_with("a\n\n::: columns\n"));
        assert!(output.contains(":::: column width=100"));
        assert!(output.contains("b\n"));
        assert_eq!(parse(&output)[0].columns.len(), 3);
    }

    #[test]
    fn appends_when_no_line_is_given() {
        let output = insert("a\n", None, 2).unwrap();
        assert!(output.starts_with("a\n\n::: columns"));
        assert_eq!(parse(&output)[0].columns.len(), 2);
    }

    #[test]
    fn removes_a_column_and_hoists_its_content() {
        let source = format!("before\n\n{TWO_COLUMNS}\nafter\n");
        let output = remove_column(&source, 0, 0).unwrap();
        assert!(output.contains("before"));
        assert!(output.contains("right"));
        assert!(!output.contains("left"));
        // Removing one of two columns dissolves the container.
        assert!(parse(&output).is_empty());
    }

    #[test]
    fn dissolves_the_last_column() {
        let source = "::: columns\n\n:::: column width=100\n\nsolo\n\n::::\n\n:::: column width=100\n\nother\n\n::::\n\n:::\n";
        let output = remove_column(source, 0, 0).unwrap();
        assert!(!output.contains("::: columns"));
        assert!(output.contains("other"));
        assert!(!output.contains("solo"));
    }

    #[test]
    fn sets_widths_by_index() {
        let output = set_widths(TWO_COLUMNS, 0, &[40, 160]).unwrap();
        let blocks = parse(&output);
        assert_eq!(blocks[0].columns[0].width, 40);
        assert_eq!(blocks[0].columns[1].width, 160);
        assert_eq!(blocks[0].columns[0].content, "left");
        assert_eq!(blocks[0].columns[1].content, "right");
    }

    #[test]
    fn rejects_invalid_width_counts() {
        assert!(set_widths(TWO_COLUMNS, 0, &[100]).is_err());
        assert!(insert("x", None, 6).is_err());
    }
}
