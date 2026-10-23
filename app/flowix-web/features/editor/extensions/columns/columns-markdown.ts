import type {
  JSONContent,
  MarkdownParseHelpers,
  MarkdownParseResult,
  MarkdownRendererHelpers,
  MarkdownToken,
  MarkdownTokenizer,
} from '@tiptap/core';

export const COLUMN_WIDTH_UNIT = 100;
export const MIN_COLUMN_WIDTH = 25;
export const MAX_COLUMNS = 5;
export const MIN_COLUMNS = 2;

const COLUMNS_OPEN_RE = /^:::[ \t]+columns[ \t]*$/;
const COLUMNS_CLOSE_RE = /^:::[ \t]*$/;
const COLUMN_OPEN_RE = /^::::[ \t]+column(?:[ \t]+width=(\S+))?[ \t]*$/;
const COLUMN_CLOSE_RE = /^::::[ \t]*$/;
const FENCE_RE = /^(```+|~~~+)/;

interface Line {
  text: string;
  start: number;
  next: number;
}

export interface ScannedColumn {
  width: number;
  source: string;
}

export interface ScannedColumns {
  raw: string;
  columns: ScannedColumn[];
}

export function normalizeColumnWidth(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return COLUMN_WIDTH_UNIT;
  return Math.min(1000, Math.max(MIN_COLUMN_WIDTH, Math.round(parsed)));
}

function nextLine(source: string, start: number): Line {
  const newline = source.indexOf('\n', start);
  const end = newline === -1 ? source.length : newline;
  return {
    text: source.slice(start, end).replace(/\r$/, ''),
    start,
    next: newline === -1 ? source.length : newline + 1,
  };
}

/**
 * Locate the first real `::: columns` opener. `:::` also appears in nested
 * containers and in ordinary prose, so a plain indexOf would make marked retry
 * this tokenizer at every occurrence.
 */
function findColumnsStart(source: string): number {
  let index = source.indexOf(':::');
  while (index !== -1) {
    if (index === 0 || source[index - 1] === '\n') {
      const line = nextLine(source, index);
      if (COLUMNS_OPEN_RE.test(line.text)) return index;
    }
    index = source.indexOf(':::', index + 3);
  }
  return -1;
}

/**
 * Scan a fenced-div columns block without splitting the whole document.
 * Returns null when the block is malformed; callers then leave the source to
 * the regular paragraph parser instead of failing the whole note.
 */
export function scanColumns(source: string): ScannedColumns | null {
  const first = nextLine(source, 0);
  if (!COLUMNS_OPEN_RE.test(first.text)) return null;

  const columns: ScannedColumn[] = [];
  let columnStart: number | null = null;
  let columnWidth = COLUMN_WIDTH_UNIT;
  let fence: string | null = null;
  let nestedColumns = 0;
  let nestedColumnDepth = 0;
  let position = first.next;

  while (position < source.length) {
    const line = nextLine(source, position);
    position = line.next;
    const trimmed = line.text.trim();

    const fenceMatch = FENCE_RE.exec(trimmed);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      continue;
    }

    // A nested `::: columns` block is kept as column content. Its closing
    // `:::` must not close the outer container.
    if (COLUMNS_OPEN_RE.test(line.text)) {
      nestedColumns += 1;
      continue;
    }

    const columnOpen = COLUMN_OPEN_RE.exec(line.text);
    if (columnOpen) {
      if (columnStart !== null) {
        // Nested `:::: column` markers stay in the content and are degraded by
        // the parser; they must not restart the outer column.
        nestedColumnDepth += 1;
        continue;
      }
      columnStart = line.next;
      columnWidth = normalizeColumnWidth(columnOpen[1]);
      continue;
    }

    if (COLUMN_CLOSE_RE.test(line.text)) {
      if (nestedColumnDepth > 0) {
        nestedColumnDepth -= 1;
        continue;
      }
      if (columnStart === null) return null;
      columns.push({
        width: columnWidth,
        source: source.slice(columnStart, line.start),
      });
      columnStart = null;
      continue;
    }

    if (COLUMNS_CLOSE_RE.test(line.text)) {
      if (nestedColumns > 0) {
        nestedColumns -= 1;
        continue;
      }
      if (columnStart !== null || columns.length < MIN_COLUMNS) return null;
      return { raw: source.slice(0, line.next), columns };
    }
  }

  return null;
}

function columnContent(column: JSONContent): JSONContent[] {
  return column.content && column.content.length > 0
    ? column.content
    : [{ type: 'paragraph' }];
}

/**
 * Nested columns are not supported. Nested `columns` nodes are hoisted into the
 * outer list; anything beyond MAX_COLUMNS is folded into the last kept column
 * so no content is lost.
 */
function flattenNestedColumns(columns: JSONContent[]): JSONContent[] {
  const flat: JSONContent[] = [];
  for (const column of columns) {
    const children = column.content ?? [];
    const ordinary = children.filter((child) => child.type !== 'columns');
    if (ordinary.length > 0 || children.length === 0) {
      flat.push({
        ...column,
        content: ordinary.length > 0 ? ordinary : [{ type: 'paragraph' }],
      });
    }
    for (const child of children) {
      if (child.type !== 'columns') continue;
      for (const nestedColumn of child.content ?? []) flat.push(nestedColumn);
    }
  }

  if (flat.length <= MAX_COLUMNS) return flat;

  const kept = flat.slice(0, MAX_COLUMNS);
  const overflow = flat
    .slice(MAX_COLUMNS)
    .flatMap((column) => column.content ?? []);
  const last = kept[MAX_COLUMNS - 1];
  kept[MAX_COLUMNS - 1] = {
    ...last,
    content: [...columnContent(last), ...overflow],
  };
  return kept;
}

function parseColumnsToken(
  token: MarkdownToken,
  helpers: MarkdownParseHelpers,
): MarkdownParseResult {
  const scanned = (token.columns as Array<{ width?: unknown; tokens?: MarkdownToken[] }> | undefined) ?? [];
  const columns = scanned.map((column) => {
    const content = helpers.parseChildren(column.tokens ?? []);
    return helpers.createNode(
      'column',
      { width: normalizeColumnWidth(column.width) },
      content.length > 0 ? content : [helpers.createNode('paragraph')],
    );
  });

  const flat = flattenNestedColumns(columns);

  // A single remaining column is not a columns block any more; hoisting its
  // content keeps the schema-required `column{2,3}` valid.
  if (flat.length < MIN_COLUMNS) {
    return flat.flatMap((column) => column.content ?? []);
  }

  return helpers.createNode('columns', undefined, flat);
}

export const columnsMarkdownTokenizer: MarkdownTokenizer = {
  name: 'columns',
  level: 'block',
  start: findColumnsStart,
  tokenize(source, _tokens, lexer) {
    const scanned = scanColumns(source);
    if (!scanned) return undefined;
    return {
      type: 'columns',
      raw: scanned.raw,
      columns: scanned.columns.map((column) => ({
        width: column.width,
        tokens: lexer.blockTokens(column.source),
      })),
    };
  },
};

function renderColumns(node: JSONContent, helpers: MarkdownRendererHelpers): string {
  const columns = node.content ?? [];
  const chunks: string[] = ['::: columns'];

  for (const column of columns) {
    const width = normalizeColumnWidth(column.attrs?.width);
    chunks.push('', `:::: column width=${width}`, '');

    const body = columnContent(column)
      .map((child, index) => helpers.renderChild?.(child, index) ?? helpers.renderChildren([child]))
      .filter((part) => part.trim().length > 0)
      .join('\n\n');

    if (body) chunks.push(body);
    chunks.push('', '::::');
  }

  chunks.push('', ':::');
  return chunks.join('\n');
}

export const columnsMarkdownSpec = {
  markdownTokenizer: columnsMarkdownTokenizer,
  parseMarkdown: parseColumnsToken,
  renderMarkdown: renderColumns,
};
