import { getStyleProperty, mergeAttributes } from '@tiptap/core';
import type { Editor } from '@tiptap/core';
import type { MarkdownLexerConfiguration, MarkdownToken } from '@tiptap/core';
import Highlight from '@tiptap/extension-highlight';

export const FLOWNOTE_TEXT_COLORS = [
  'red',
  'orange',
  'yellow',
  'green',
  'cyan',
  'blue',
  'purple',
  'pink',
  'gray',
] as const;

export type FlownoteTextColor = (typeof FLOWNOTE_TEXT_COLORS)[number];

export interface FlownoteTextMarkAttributes {
  color?: string | null;
  flownoteBg?: FlownoteTextColor | null;
  flownoteFg?: FlownoteTextColor | null;
}

export interface FlownoteTextStylePatch {
  bg?: FlownoteTextColor | null;
  fg?: FlownoteTextColor | null;
}

const FLOWNOTE_TEXT_COLOR_MIGRATION_ALIASES: Record<string, FlownoteTextColor> = {
  danger: 'red',
  'on-danger': 'red',
};

const FLOWNOTE_TEXT_MARK_RE = /^==([^=\n]+)==[ \t]*<!--\s*flownote:text\s+(\{[^}\r\n]*\})\s*-->/;

export function isFlownoteTextColor(value: unknown): value is FlownoteTextColor {
  return typeof value === 'string'
    && (FLOWNOTE_TEXT_COLORS as readonly string[]).includes(value);
}

function normalizeFlownoteTextColor(value: unknown): FlownoteTextColor | undefined {
  if (isFlownoteTextColor(value)) return value;
  return typeof value === 'string' ? FLOWNOTE_TEXT_COLOR_MIGRATION_ALIASES[value] : undefined;
}

export function normalizeFlownoteTextStyle(value: unknown): FlownoteTextStylePatch | null {
  if (!value || typeof value !== 'object') return null;

  const payload = value as { bg?: unknown; fg?: unknown };
  const bg = payload.bg == null ? null : normalizeFlownoteTextColor(payload.bg);
  const fg = payload.fg == null ? null : normalizeFlownoteTextColor(payload.fg);

  if (bg === undefined && fg === undefined) return null;

  return { bg: bg ?? null, fg: fg ?? null };
}

export function parseFlownoteTextStylePayload(payload: string): FlownoteTextStylePatch | null {
  try {
    return normalizeFlownoteTextStyle(JSON.parse(payload));
  } catch {
    return null;
  }
}

function normalizeMarkStyle(attrs: Record<string, unknown> | undefined): FlownoteTextStylePatch {
  return {
    bg: normalizeFlownoteTextColor(attrs?.flownoteBg) ?? null,
    fg: normalizeFlownoteTextColor(attrs?.flownoteFg) ?? null,
  };
}

function hasFlownoteTextStyle(attrs: FlownoteTextStylePatch): boolean {
  return attrs.bg !== null || attrs.fg !== null;
}

/**
 * Highlight mark with a small semantic color payload.
 *
 * The payload is kept on the mark while editing. Markdown persistence uses
 * the adjacent HTML comment format so older Markdown readers still see the
 * normal `==text==` highlight.
 */
export const FlownoteHighlight = Highlight.extend({
  name: 'highlight',

  addAttributes() {
    const parentAttributes = this.parent?.() ?? {};

    return {
      ...parentAttributes,
      flownoteBg: {
        default: null,
        parseHTML: element => {
          const value = element.getAttribute('data-flownote-bg');
          return isFlownoteTextColor(value) ? value : null;
        },
        renderHTML: attributes => (
          attributes.flownoteBg
            ? { 'data-flownote-bg': attributes.flownoteBg }
            : {}
        ),
      },
      flownoteFg: {
        default: null,
        parseHTML: element => {
          const value = element.getAttribute('data-flownote-fg');
          return isFlownoteTextColor(value) ? value : null;
        },
        renderHTML: attributes => (
          attributes.flownoteFg
            ? { 'data-flownote-fg': attributes.flownoteFg }
            : {}
        ),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'mark' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['mark', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0];
  },

  renderMarkdown: (node, h) => {
    const style = normalizeMarkStyle(node.attrs as Record<string, unknown> | undefined);
    const content = h.renderChildren(node);

    if (!hasFlownoteTextStyle(style)) {
      return `==${content}==`;
    }

    return `==${content}==<!-- flownote:text ${JSON.stringify({
      bg: style.bg,
      fg: style.fg,
    })} -->`;
  },

  parseMarkdown: (token, h) => {
    const style = normalizeFlownoteTextStyle(token.attrs);
    return h.applyMark('highlight', h.parseInline(token.tokens || []), {
      color: null,
      flownoteBg: style?.bg ?? null,
      flownoteFg: style?.fg ?? null,
    });
  },

  markdownTokenizer: {
    name: 'highlight',
    level: 'inline',
    start: (src: string) => src.indexOf('=='),
    tokenize(src: string, _tokens: MarkdownToken[], h: MarkdownLexerConfiguration) {
      const match = FLOWNOTE_TEXT_MARK_RE.exec(src);
      if (match) {
        const style = parseFlownoteTextStylePayload(match[2]);
        if (!style) return undefined;

        const innerContent = match[1].trim();
        return {
          type: 'highlight',
          raw: match[0],
          text: innerContent,
          tokens: h.inlineTokens(innerContent),
          attrs: style,
        };
      }

      const legacyMatch = /^==(?!\s+==)([^=]+?)(?<!\s)==/.exec(src);
      if (!legacyMatch) return undefined;

      const innerContent = legacyMatch[1].trim();
      return {
        type: 'highlight',
        raw: legacyMatch[0],
        text: innerContent,
        tokens: h.inlineTokens(innerContent),
        attrs: { bg: null, fg: null },
      };
    },
  },
});

/** Apply one side of the semantic style while preserving the other side. */
export function setFlownoteTextStyle(
  editor: Editor,
  patch: FlownoteTextStylePatch,
): boolean {
  const current = editor.getAttributes('highlight') as FlownoteTextMarkAttributes;
  const hasBgPatch = Object.prototype.hasOwnProperty.call(patch, 'bg');
  const hasFgPatch = Object.prototype.hasOwnProperty.call(patch, 'fg');
  const nextBg = hasBgPatch ? patch.bg ?? null : current.flownoteBg ?? null;
  const nextFg = hasFgPatch ? patch.fg ?? null : current.flownoteFg ?? null;

  if (nextBg === null && nextFg === null) {
    return editor.chain().focus().unsetHighlight().run();
  }

  return editor
    .chain()
    .focus()
    .setMark('highlight', {
      color: null,
      flownoteBg: nextBg,
      flownoteFg: nextFg,
    })
    .run();
}

export function setDefaultFlownoteHighlight(editor: Editor): boolean {
  return editor
    .chain()
    .focus()
    .setMark('highlight', {
      color: null,
      flownoteBg: null,
      flownoteFg: null,
    })
    .run();
}

export function clearFlownoteHighlight(editor: Editor): boolean {
  return editor.chain().focus().unsetHighlight().run();
}

// Keep the import surface explicit for consumers that need to parse legacy
// inline HTML marks without duplicating Tiptap's style extraction behavior.
export function parseLegacyHighlightColor(element: HTMLElement): string | null {
  return element.getAttribute('data-color')
    || getStyleProperty(element, 'background-color')
    || element.style.backgroundColor
    || null;
}
