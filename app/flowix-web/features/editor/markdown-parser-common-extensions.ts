import { Paragraph } from '@tiptap/extension-paragraph';
import { Heading } from '@tiptap/extension-heading';
import { ListItem } from '@tiptap/extension-list';
import { TaskItem } from '@tiptap/extension-task-item';
import type { JSONContent, MarkdownParseHelpers, MarkdownParseResult, MarkdownToken } from '@tiptap/core';
import {
  appendFlowixBlockBackgroundComment,
  flowixBlockBackgroundAttribute,
  flowixBlockBackgroundCommentForNode,
  splitFlowixBlockBackgroundTokens,
} from '@features/editor/extensions/flowix-block-background';
import type { FlowixTextColor } from '@features/editor/extensions/flowix-text-mark';

const EMPTY_MARKDOWN_PLACEHOLDER_RE = /^(?:&(?:amp;)?nbsp;|\u00a0)$/i;
const EMPTY_PARAGRAPH_MARKDOWN = '&nbsp;';

function isEmptyMarkdownPlaceholderText(value: string | undefined): boolean {
  return typeof value === 'string' && EMPTY_MARKDOWN_PLACEHOLDER_RE.test(value.trim());
}

function isEmptyMarkdownPlaceholder(
  content: JSONContent[],
  tokens: MarkdownToken[] = [],
  fallbackText?: string,
): boolean {
  const sourceToken = tokens.length === 1 && tokens[0].type === 'text' ? tokens[0] : undefined;
  const isReservedSource = sourceToken
    ? isEmptyMarkdownPlaceholderText(sourceToken.raw) || isEmptyMarkdownPlaceholderText(sourceToken.text)
    : isEmptyMarkdownPlaceholderText(fallbackText);

  return content.length === 1
    && content[0].type === 'text'
    && (!content[0].marks || content[0].marks.length === 0)
    && typeof content[0].text === 'string'
    && isReservedSource
    && isEmptyMarkdownPlaceholderText(content[0].text);
}

/** Shared Markdown parsing for paragraphs, including the saved empty-line marker. */
export const MarkdownParagraph = Paragraph.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      ...flowixBlockBackgroundAttribute,
    };
  },

  parseMarkdown(token: MarkdownToken, helpers: MarkdownParseHelpers) {
    const scanned = splitFlowixBlockBackgroundTokens(token.tokens);
    const tokens = scanned.tokens;

    // Markdown represents a standalone image as a block node in Flowix.
    if (tokens.length === 1 && tokens[0].type === 'image') {
      return helpers.parseChildren([tokens[0]]);
    }

    const content = helpers.parseInline(tokens);
    const normalizedContent = isEmptyMarkdownPlaceholder(content, tokens) ? [] : content;
    return helpers.createNode(
      'paragraph',
      scanned.bg ? { flowixBg: scanned.bg } : undefined,
      normalizedContent,
    );
  },

  renderMarkdown(node, helpers, ctx) {
    const content = Array.isArray(node.content) ? node.content : [];
    const base = content.length === 0
      ? (isPreviousNodeEmptyParagraph(ctx) ? EMPTY_PARAGRAPH_MARKDOWN : '')
      : helpers.renderChildren(content);
    return appendFlowixBlockBackgroundComment(base, flowixBlockBackgroundCommentForNode(node));
  },
});

/**
 * Heading keeps the block background attribute and its trailing Markdown
 * comment so a coloured title round-trips without changing its `##` shape.
 */
export const MarkdownHeading = Heading.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      ...flowixBlockBackgroundAttribute,
    };
  },

  parseMarkdown(token: MarkdownToken, helpers: MarkdownParseHelpers) {
    const scanned = splitFlowixBlockBackgroundTokens(token.tokens);
    const level = typeof token.depth === 'number' ? token.depth : 1;
    return helpers.createNode(
      'heading',
      scanned.bg ? { level, flowixBg: scanned.bg } : { level },
      helpers.parseInline(scanned.tokens),
    );
  },

  renderMarkdown(node, helpers) {
    const level = Number.parseInt(String(node.attrs?.level ?? 1), 10) || 1;
    const content = Array.isArray(node.content) ? node.content : [];
    // An empty heading has no Markdown form; a `&nbsp;` placeholder would turn
    // it into a paragraph on the next parse, so drop the colour with it.
    if (content.length === 0) return '';
    const base = `${'#'.repeat(level)} ${helpers.renderChildren(content)}`;
    return appendFlowixBlockBackgroundComment(base, flowixBlockBackgroundCommentForNode(node));
  },
});

function isPreviousNodeEmptyParagraph(
  ctx: { previousNode?: { type?: string; content?: unknown } | null } | null | undefined,
): boolean {
  if (ctx?.previousNode?.type !== 'paragraph') return false;
  return !Array.isArray(ctx.previousNode.content) || ctx.previousNode.content.length === 0;
}

/**
 * Move the block background comment from a list item's leading inline tokens
 * onto the item's first paragraph.
 *
 * `ListItem.parseMarkdown` builds its first paragraph directly instead of
 * delegating to the paragraph extension, so the comment never reaches
 * `MarkdownParagraph.parseMarkdown`. Lifting it here keeps a coloured list row
 * round-tripping through Markdown.
 */
function liftListItemBlockBackground(token: MarkdownToken): {
  token: MarkdownToken;
  bg: FlowixTextColor | null;
} {
  const tokens = token.tokens;
  if (!Array.isArray(tokens) || tokens.length === 0) return { token, bg: null };

  const [first, ...rest] = tokens;
  if (first?.type !== 'text' || !Array.isArray(first.tokens)) return { token, bg: null };

  const scanned = splitFlowixBlockBackgroundTokens(first.tokens);
  if (!scanned.bg) return { token, bg: null };

  return {
    token: { ...token, tokens: [{ ...first, tokens: scanned.tokens }, ...rest] },
    bg: scanned.bg,
  };
}

function applyBlockBackgroundToFirstParagraph<T>(result: T, bg: FlowixTextColor | null): T {
  if (!bg || !result || typeof result !== 'object') return result;

  const node = result as { type?: string; content?: unknown[] };
  if (node.type !== 'listItem' || !Array.isArray(node.content) || node.content.length === 0) {
    return result;
  }

  const [first, ...rest] = node.content as Array<{ type?: string; attrs?: Record<string, unknown> }>;
  if (first?.type !== 'paragraph') return result;

  return {
    ...node,
    content: [{ ...first, attrs: { ...first.attrs, flowixBg: bg } }, ...rest],
  } as T;
}

/** ListItem shares the block background comment lift with `MarkdownParagraph`. */
export const MarkdownListItem = ListItem.extend({
  parseMarkdown(token: MarkdownToken, helpers: MarkdownParseHelpers): MarkdownParseResult {
    const lifted = liftListItemBlockBackground(token);
    const parentParse = (this as {
      parent?: (value: MarkdownToken, parseHelpers: MarkdownParseHelpers) => MarkdownParseResult;
    }).parent;
    const parsed = parentParse
      ? parentParse(lifted.token, helpers)
      : [{ type: 'listItem', content: [{ type: 'paragraph' }] }];
    return applyBlockBackgroundToFirstParagraph(parsed, lifted.bg);
  },
});

/** TaskItem parses its first paragraph directly, so it must share placeholder handling. */
export const MarkdownTaskItem = TaskItem.extend({
  parseMarkdown(token: MarkdownToken, helpers: MarkdownParseHelpers) {
    const scanned = splitFlowixBlockBackgroundTokens(token.tokens);
    const inlineTokens = scanned.tokens;
    const inlineContent = inlineTokens.length
      ? helpers.parseInline(inlineTokens)
      : token.text
        ? [helpers.createNode('text', { text: token.text })]
        : [];
    const content: JSONContent[] = [helpers.createNode(
      'paragraph',
      scanned.bg ? { flowixBg: scanned.bg } : undefined,
      isEmptyMarkdownPlaceholder(inlineContent, inlineTokens, token.text) ? [] : inlineContent,
    )];

    if (token.nestedTokens?.length) {
      content.push(...helpers.parseChildren(token.nestedTokens));
    }

    return helpers.createNode('taskItem', { checked: token.checked || false }, content);
  },
});
