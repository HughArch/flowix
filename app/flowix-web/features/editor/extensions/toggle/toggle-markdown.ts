import type {
  JSONContent,
  MarkdownParseHelpers,
  MarkdownParseResult,
  MarkdownRendererHelpers,
  MarkdownToken,
  MarkdownTokenizer,
} from '@tiptap/core';
import {
  isFlowixTextColor,
  type FlowixTextColor,
} from '@features/editor/extensions/flowix-text-mark';
import { closesFence, fencedDivClose, fencedDivOpen } from '../fenced-div';

/**
 * Flowus-style toggle ("折叠块") Markdown persistence.
 *
 * A toggle is a fenced div whose first child block is the title line and whose
 * remaining children are the collapsible body:
 *
 * ```
 * ::: toggle
 *
 * title
 *
 * body
 *
 * :::
 * ```
 *
 * A collapsed toggle carries the `collapsed` flag:
 *
 * ```
 * ::: toggle collapsed
 * …
 * :::
 * ```
 *
 * The format is deliberately identical to callouts/columns so the scanner can
 * reuse the shared fence balancing rules and nest freely.
 */

export const TOGGLE_NODE_NAME = 'toggle';
export const TOGGLE_COLLAPSED_FLAG = 'collapsed';

/**
 * Transaction meta key used to mark fold/unfold transactions. Shared with the
 * editor plugin so its auto-expand guard can recognise its own updates.
 */
export const TOGGLE_FOLD_META = 'flowixToggleFold';

const COLLAPSED_FLAG_RE = /(?:^|\s)collapsed(?:\s|$)/;
const ATTRIBUTE_RE = /([A-Za-z][\w-]*)\s*=\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]+)/g;
const CODE_FENCE_RE = /^(```+|~~~+)/;

interface Line {
  text: string;
  start: number;
  next: number;
}

export interface ScannedToggle {
  /** Whole fenced block, including the closing fence and its newline. */
  raw: string;
  open: boolean;
  /** Optional line-background colour for the whole container. */
  bg: FlowixTextColor | null;
  /** Inner Markdown source between the fences. */
  source: string;
}

export function normalizeToggleOpen(value: unknown): boolean {
  if (value === false) return false;
  if (typeof value === 'string') return value.trim().toLowerCase() !== 'false';
  return true;
}

export function normalizeToggleBackground(value: unknown): FlowixTextColor | null {
  return isFlowixTextColor(value) ? value : null;
}

function decodeAttributeValue(raw: string): string {
  const quote = raw[0];
  if (quote !== '"' && quote !== "'") return raw;
  const inner = raw.slice(1, -1);
  if (quote === '"') {
    try {
      return JSON.parse(`"${inner}"`) as string;
    } catch {
      return inner;
    }
  }
  return inner.replace(/\\(.)/g, '$1');
}

/** Parse `bg="yellow" collapsed` in any order; unknown keys are ignored. */
function parseToggleAttributes(rest: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  let match: RegExpExecArray | null;
  ATTRIBUTE_RE.lastIndex = 0;
  while ((match = ATTRIBUTE_RE.exec(rest)) !== null) {
    attributes[match[1]] = decodeAttributeValue(match[2]);
  }
  return attributes;
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
 * Locate the first line that starts a toggle fence. `:::` also appears in
 * other containers and ordinary prose, so a plain indexOf is not enough.
 */
export function findToggleStart(source: string): number {
  let index = source.indexOf(':::');
  while (index !== -1) {
    if (index === 0 || source[index - 1] === '\n') {
      const line = nextLine(source, index);
      const open = fencedDivOpen(line.text);
      if (open && open.name === TOGGLE_NODE_NAME) return index;
    }
    index = source.indexOf(':::', index + 3);
  }
  return -1;
}

/**
 * Scan one toggle fenced div without splitting the rest of the document.
 *
 * Returns null for malformed input (missing closing fence), so the caller can
 * leave the source to the regular paragraph parser instead of failing the note.
 */
export function scanToggle(source: string): ScannedToggle | null {
  const first = nextLine(source, 0);
  const opening = fencedDivOpen(first.text);
  if (!opening || opening.name !== TOGGLE_NODE_NAME) return null;

  const attributes = parseToggleAttributes(opening.rest);
  const open = !COLLAPSED_FLAG_RE.test(opening.rest);
  const bg = normalizeToggleBackground(attributes.bg);
  const outerFence = opening.fenceLength;
  const nestedFences: number[] = [];
  let codeFence: string | null = null;
  let position = first.next;

  while (position < source.length) {
    const line = nextLine(source, position);
    position = line.next;

    const codeFenceMatch = CODE_FENCE_RE.exec(line.text.trim());
    if (codeFence) {
      if (
        codeFenceMatch
        && codeFenceMatch[1][0] === codeFence[0]
        && codeFenceMatch[1].length >= codeFence.length
      ) {
        codeFence = null;
      }
      continue;
    }
    if (codeFenceMatch) {
      codeFence = codeFenceMatch[1];
      continue;
    }

    const closeLength = fencedDivClose(line.text);
    if (closeLength !== null) {
      if (nestedFences.length > 0) {
        if (closesFence(closeLength, nestedFences[nestedFences.length - 1])) {
          nestedFences.pop();
        }
        continue;
      }
      if (closesFence(closeLength, outerFence)) {
        return {
          raw: source.slice(0, line.next),
          open,
          bg,
          source: source.slice(first.next, line.start),
        };
      }
      // A shorter fence inside the body is content, not a close.
      continue;
    }

    const nested = fencedDivOpen(line.text);
    if (nested) nestedFences.push(nested.fenceLength);
  }

  return null;
}

function parseToggleToken(
  token: MarkdownToken,
  helpers: MarkdownParseHelpers,
): MarkdownParseResult {
  const tokens = (token.tokens as MarkdownToken[] | undefined) ?? [];
  // `marked` disables paragraph wrapping while lexing list-item content, so
  // plain lines can arrive as `text` block tokens. Promote them back so the
  // toggle's first block is a real paragraph.
  const normalized = tokens.map((child) => (
    child.type === 'text' ? { ...child, type: 'paragraph' } : child
  ));
  const parsed = helpers.parseChildren(normalized);
  const first = parsed[0];
  // The first block is the title line. Headings and paragraphs can own it;
  // a list/table/container cannot, so keep it in the body behind an empty
  // title instead of silently promoting body content into the title slot.
  const hasTitle = first?.type === 'paragraph' || first?.type === 'heading';
  const content = hasTitle
    ? parsed
    : [helpers.createNode('paragraph'), ...parsed];

  const bg = normalizeToggleBackground(token.bg);
  const attrs: Record<string, unknown> = { open: token.collapsed !== true };
  // Omit the attribute entirely when absent: an explicit `null` would survive
  // schema coercion and make uncoloured toggles differ from freshly created
  // ones in `getJSON()`.
  if (bg) attrs.flowixBg = bg;

  return helpers.createNode(
    TOGGLE_NODE_NAME,
    // `open` is a reserved marked token field, so the flag travels under its
    // own name to avoid being overwritten by the lexer.
    attrs,
    content.length > 0 ? content : [helpers.createNode('paragraph')],
  );
}

function renderToggle(node: JSONContent, helpers: MarkdownRendererHelpers): string {
  const children = node.content ?? [];
  const renderChild = (child: JSONContent, index: number): string => (
    helpers.renderChild?.(child, index) ?? helpers.renderChildren([child])
  );

  const titleNode = children[0];
  const renderedTitle = titleNode ? renderChild(titleNode, 0) : '';
  const body = children
    .slice(1)
    .map((child, index) => renderChild(child, index + 1))
    .filter((part) => part.trim().length > 0)
    .join('\n\n');

  // A non-empty title must always be its own block, otherwise `breaks: true`
  // would merge it into the first body paragraph. An empty title only needs a
  // placeholder when a body follows; otherwise the short form stays readable.
  const emptyTitle = titleNode?.type === 'paragraph' && (titleNode.content?.length ?? 0) === 0;
  let titlePart = renderedTitle.trim().length > 0 ? renderedTitle : '&nbsp;';
  if (emptyTitle && body.length === 0) titlePart = '';

  const open = normalizeToggleOpen(node.attrs?.open);
  const bg = normalizeToggleBackground(node.attrs?.flowixBg);
  const flags = [
    open ? '' : TOGGLE_COLLAPSED_FLAG,
    bg ? `bg=${JSON.stringify(bg)}` : '',
  ].filter(Boolean).join(' ');
  const chunks = [`::: ${TOGGLE_NODE_NAME}${flags ? ` ${flags}` : ''}`];
  if (titlePart) chunks.push('', titlePart);
  if (body) chunks.push('', body);
  chunks.push('', ':::');
  return chunks.join('\n');
}

export const toggleMarkdownTokenizer: MarkdownTokenizer = {
  name: TOGGLE_NODE_NAME,
  level: 'block',
  start: findToggleStart,
  tokenize(source, _tokens, lexer) {
    const scanned = scanToggle(source);
    if (!scanned) return undefined;
    return {
      type: TOGGLE_NODE_NAME,
      raw: scanned.raw,
      collapsed: !scanned.open,
      bg: scanned.bg,
      tokens: lexer.blockTokens(scanned.source),
    };
  },
};

export const toggleMarkdownSpec = {
  markdownTokenizer: toggleMarkdownTokenizer,
  parseMarkdown: parseToggleToken,
  renderMarkdown: renderToggle,
};
