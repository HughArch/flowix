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
 * Flowus-style callout ("着重块") Markdown persistence.
 *
 * A callout is a fenced div whose info string carries the icon and colour:
 *
 * ```
 * ::: callout icon="💡" color="yellow"
 *
 * content
 *
 * :::
 * ```
 *
 * Defaults are omitted so ordinary callouts stay terse. Icons are written with
 * `JSON.stringify`, which keeps quotes and backslashes out of the fence line.
 */

export const CALLOUT_ICON = 'callout';
export const DEFAULT_CALLOUT_ICON = '💡';
export const DEFAULT_CALLOUT_COLOR: FlowixTextColor = 'gray';

/** Curated palette shown in the icon picker (no emoji-picker dependency). */
export const CALLOUT_ICONS = [
  '💡', '📌', '⚠️', '✅', '❌', '❓', '🔥', '⭐', '🎯', '📝',
  '📚', '🧠', '💬', '🔔', '🎉', '👍', '🚀', '🛠️', '📎', '🔖',
  '⏰', '☕', '🌱', '🧩', '💎', '🧪', '📊', '🗂️', '🌍', '❤️',
  '😀', '🐛', '🔍', '🎨', '🧭', '⚡', '🫧', '🌈', '☑️', '💭',
] as const;

const ICON_MAX_LENGTH = 64;
const ATTRIBUTE_RE = /([A-Za-z][\w-]*)\s*=\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]+)/g;
const CODE_FENCE_RE = /^(```+|~~~+)/;

interface Line {
  text: string;
  start: number;
  next: number;
}

export interface ScannedCallout {
  /** Whole fenced block, including the closing fence and its newline. */
  raw: string;
  icon: string;
  color: FlowixTextColor;
  /** Inner Markdown source between the fences. */
  source: string;
}

export function normalizeCalloutIcon(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_CALLOUT_ICON;
  const icon = value.replace(/[\r\n]+/g, '').trim();
  if (!icon || icon.length > ICON_MAX_LENGTH) return DEFAULT_CALLOUT_ICON;
  return icon;
}

export function normalizeCalloutColor(value: unknown): FlowixTextColor {
  return isFlowixTextColor(value) ? value : DEFAULT_CALLOUT_COLOR;
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

/** Parse `icon="💡" color="yellow"` in any order; unknown keys are ignored. */
export function parseCalloutAttributes(rest: string): Record<string, string> {
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
 * Locate the first line that starts a callout fence. `:::` also appears in
 * columns and ordinary prose, so the tokenizer cannot just use `indexOf`.
 */
export function findCalloutStart(source: string): number {
  let index = source.indexOf(':::');
  while (index !== -1) {
    if (index === 0 || source[index - 1] === '\n') {
      const line = nextLine(source, index);
      const open = fencedDivOpen(line.text);
      if (open && open.name === CALLOUT_ICON) return index;
    }
    index = source.indexOf(':::', index + 3);
  }
  return -1;
}

/**
 * Scan one callout fenced div without splitting the rest of the document.
 *
 * Returns null for malformed input (missing closing fence), so the caller can
 * leave the source to the regular paragraph parser instead of failing the note.
 */
export function scanCallout(source: string): ScannedCallout | null {
  const first = nextLine(source, 0);
  const opening = fencedDivOpen(first.text);
  if (!opening || opening.name !== CALLOUT_ICON) return null;

  const attributes = parseCalloutAttributes(opening.rest);
  const icon = normalizeCalloutIcon(attributes.icon);
  const color = normalizeCalloutColor(attributes.color);

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
          icon,
          color,
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

function parseCalloutToken(
  token: MarkdownToken,
  helpers: MarkdownParseHelpers,
): MarkdownParseResult {
  const tokens = (token.tokens as MarkdownToken[] | undefined) ?? [];
  // marked disables paragraph wrapping while lexing list-item content
  // (`state.top === false`), so plain lines arrive as `text` block tokens.
  // Promote them back to paragraphs before handing them to Tiptap.
  const normalized = tokens.map((child) => (
    child.type === 'text' ? { ...child, type: 'paragraph' } : child
  ));
  const content = helpers.parseChildren(normalized);

  return helpers.createNode(
    CALLOUT_ICON,
    {
      icon: normalizeCalloutIcon(token.icon),
      color: normalizeCalloutColor(token.color),
    },
    content.length > 0 ? content : [helpers.createNode('paragraph')],
  );
}

function renderCalloutAttributes(node: JSONContent): string {
  const icon = normalizeCalloutIcon(node.attrs?.icon);
  const color = normalizeCalloutColor(node.attrs?.color);
  const attributes: string[] = [];

  if (icon !== DEFAULT_CALLOUT_ICON) attributes.push(`icon=${JSON.stringify(icon)}`);
  if (color !== DEFAULT_CALLOUT_COLOR) attributes.push(`color=${JSON.stringify(color)}`);

  return attributes.length > 0 ? ` ${attributes.join(' ')}` : '';
}

function renderCallout(node: JSONContent, helpers: MarkdownRendererHelpers): string {
  // Render children one by one: `renderChildren` uses an empty separator, so
  // paragraphs would otherwise be concatenated without blank lines.
  const body = (node.content ?? [])
    .map((child, index) => helpers.renderChild?.(child, index) ?? helpers.renderChildren([child]))
    .filter((part) => part.trim().length > 0)
    .join('\n\n');

  const chunks = [`::: ${CALLOUT_ICON}${renderCalloutAttributes(node)}`];
  if (body) chunks.push('', body);
  chunks.push('', ':::');
  return chunks.join('\n');
}

export const calloutMarkdownTokenizer: MarkdownTokenizer = {
  name: CALLOUT_ICON,
  level: 'block',
  start: findCalloutStart,
  tokenize(source, _tokens, lexer) {
    const scanned = scanCallout(source);
    if (!scanned) return undefined;
    return {
      type: CALLOUT_ICON,
      raw: scanned.raw,
      icon: scanned.icon,
      color: scanned.color,
      tokens: lexer.blockTokens(scanned.source),
    };
  },
};

export const calloutMarkdownSpec = {
  markdownTokenizer: calloutMarkdownTokenizer,
  parseMarkdown: parseCalloutToken,
  renderMarkdown: renderCallout,
};
