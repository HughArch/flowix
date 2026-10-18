const TABLE_SEPARATOR_CELL_RE = /^:?-{3,}:?$/;
const EMPTY_MARKDOWN_PLACEHOLDER_RE = /&(?:amp;)?nbsp;/gi;

function isEmptyMarkdownPlaceholderOnly(value: string): boolean {
  return value
    .replace(/\u00a0/g, '')
    .replace(EMPTY_MARKDOWN_PLACEHOLDER_RE, '')
    .trim() === '';
}

function normalizeMarkdownTableLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|') || !trimmed.slice(1, -1).includes('|')) {
    return line;
  }

  const cells = line.split('|');
  const innerCells = cells.slice(1, -1);
  if (innerCells.every((cell) => TABLE_SEPARATOR_CELL_RE.test(cell.trim()))) return line;

  const normalizedCells = innerCells.map((cell) => (
    isEmptyMarkdownPlaceholderOnly(cell) ? '' : cell
  ));
  return `|${normalizedCells.join('|')}|`;
}

/** Normalize the editor's empty-cell placeholders before parsing Markdown. */
export function normalizeMarkdownTableEmptyCells(markdown: string): string {
  return markdown
    .split('\n')
    .map(normalizeMarkdownTableLine)
    .join('\n');
}
