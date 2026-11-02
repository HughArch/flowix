import type { Editor, MarkdownToken } from '@tiptap/core';
import type { Node as PMNode } from 'prosemirror-model';
import type { EditorState } from 'prosemirror-state';
import { getBlockSelection } from './block-selection';
import {
  isFlownoteTextColor,
  type FlownoteTextColor,
} from './flownote-text-mark';

/**
 * Line (block) background colour.
 *
 * The inline highlight mark (`==text==`) covers the glyphs themselves. A line
 * background belongs to the block node (`paragraph` / `heading`) so it can be
 * painted across the whole text column, including the gutters and the leading
 * and trailing space of the line.
 *
 * Markdown persistence follows the same adjacent-HTML-comment convention as
 * `flownote:text`: the comment trails the block's own markdown so plain readers
 * still see an ordinary paragraph/heading.
 */

export const FLOWNOTE_BLOCK_BACKGROUND_MARKER = 'flownote:block-bg';

/** Node attribute name shared by paragraph and heading. */
export const FLOWNOTE_BLOCK_BACKGROUND_ATTR = 'flownoteBg';

const BLOCK_BG_COMMENT_RE = /^<!--\s*flownote:block-bg\s+(\{[\s\S]*\})\s*-->$/;

const BLOCK_BACKGROUND_NODE_TYPES = new Set(['paragraph', 'heading', 'toggle']);

/**
 * Containers a block background may reach into when the user targets the
 * container itself (a list item or a blockquote). Tables and code blocks are
 * deliberately absent: painting their first cell/line is not a "line".
 */
const BLOCK_BACKGROUND_CONTAINER_TYPES = new Set(['listItem', 'taskItem', 'blockquote', 'columns', 'column', 'toggle']);

export function normalizeFlownoteBlockBackground(value: unknown): FlownoteTextColor | null {
  return isFlownoteTextColor(value) ? value : null;
}

export function renderFlownoteBlockBackgroundComment(bg: FlownoteTextColor): string {
  return `<!-- ${FLOWNOTE_BLOCK_BACKGROUND_MARKER} ${JSON.stringify({ bg })} -->`;
}

/**
 * Append the semantic comment after a block's markdown.
 *
 * Empty blocks (`''`, which the paragraph renderer emits for list-item and
 * table-cell children) still need a marker line so the colour survives a
 * round-trip; `&nbsp;` keeps the comment out of the leading-HTML-block path.
 */
export function appendFlownoteBlockBackgroundComment(
  markdown: string,
  bg: FlownoteTextColor | null,
): string {
  if (!bg) return markdown;
  const comment = renderFlownoteBlockBackgroundComment(bg);
  return markdown ? `${markdown}${comment}` : `&nbsp;${comment}`;
}

/** Read the background value written by `renderFlownoteBlockBackgroundComment`. */
export function parseFlownoteBlockBackgroundComment(value: string): FlownoteTextColor | null {
  const match = BLOCK_BG_COMMENT_RE.exec(value.trim());
  if (!match) return null;

  try {
    const payload = JSON.parse(match[1]) as { bg?: unknown };
    return normalizeFlownoteBlockBackground(payload?.bg);
  } catch {
    return null;
  }
}

function isFlownoteBlockBackgroundComment(value: string): boolean {
  return value.trimStart().startsWith(`<!-- ${FLOWNOTE_BLOCK_BACKGROUND_MARKER}`);
}

/**
 * Split the block background comment out of a block's inline Markdown tokens.
 *
 * A comment carrying an unknown colour is dropped as well: leaving it in the
 * document would render raw HTML inside the paragraph.
 */
export function splitFlownoteBlockBackgroundTokens(tokens: MarkdownToken[] | undefined): {
  bg: FlownoteTextColor | null;
  tokens: MarkdownToken[];
} {
  if (!tokens?.length) return { bg: null, tokens: tokens ?? [] };

  let bg: FlownoteTextColor | null = null;
  const kept: MarkdownToken[] = [];

  for (const token of tokens) {
    const raw = typeof token.raw === 'string'
      ? token.raw
      : typeof token.text === 'string' ? token.text : '';
    if (token.type === 'html' && isFlownoteBlockBackgroundComment(raw)) {
      bg = parseFlownoteBlockBackgroundComment(raw);
      continue;
    }
    kept.push(token);
  }

  return { bg, tokens: kept };
}

/** Tiptap node attribute definition shared by paragraph and heading. */
export const flownoteBlockBackgroundAttribute = {
  [FLOWNOTE_BLOCK_BACKGROUND_ATTR]: {
    // `undefined` (not `null`) keeps the attribute out of `getJSON()` for
    // uncoloured blocks, so existing document snapshots stay byte-identical.
    default: undefined as FlownoteTextColor | null | undefined,
    parseHTML: (element: HTMLElement) => {
      const value = element.getAttribute('data-flownote-block-bg');
      return isFlownoteTextColor(value) ? value : null;
    },
    renderHTML: (attributes: Record<string, unknown>) => {
      const bg = normalizeFlownoteBlockBackground(attributes[FLOWNOTE_BLOCK_BACKGROUND_ATTR]);
      return bg ? { 'data-flownote-block-bg': bg } : {};
    },
  },
};

function backgroundOfNode(node: PMNode): FlownoteTextColor | null {
  return normalizeFlownoteBlockBackground(node.attrs?.[FLOWNOTE_BLOCK_BACKGROUND_ATTR]);
}

/** The comment for a block node, ready to append to its Markdown. */
export function flownoteBlockBackgroundCommentForNode(node: PMNode | { attrs?: Record<string, unknown> }): FlownoteTextColor | null {
  const value = (node as { attrs?: Record<string, unknown> }).attrs?.[FLOWNOTE_BLOCK_BACKGROUND_ATTR];
  return normalizeFlownoteBlockBackground(value);
}

export interface FlownoteBlockBackgroundTarget {
  pos: number;
  node: PMNode;
}

function firstBackgroundNodeInside(node: PMNode, pos: number): FlownoteBlockBackgroundTarget | null {
  let found: FlownoteBlockBackgroundTarget | null = null;
  node.descendants((child, offset) => {
    if (found) return false;
    if (BLOCK_BACKGROUND_NODE_TYPES.has(child.type.name)) {
      found = { pos: pos + 1 + offset, node: child };
      return false;
    }
    return BLOCK_BACKGROUND_CONTAINER_TYPES.has(child.type.name);
  });
  return found;
}

function paragraphAtSelection(state: EditorState): FlownoteBlockBackgroundTarget | null {
  const { $from, $to } = state.selection;
  for (let depth = $from.depth; depth >= 0; depth -= 1) {
    const node = $from.node(depth);
    if (BLOCK_BACKGROUND_NODE_TYPES.has(node.type.name)) {
      // Only accept the node that actually contains the caret.
      return { pos: $from.before(depth), node };
    }
  }

  if ($from.pos !== $to.pos) {
    const targets = collectBackgroundTargetsBetween(state.doc, $from.pos, $to.pos);
    return targets[0] ?? null;
  }
  return null;
}

function collectBackgroundTargetsBetween(
  doc: PMNode,
  from: number,
  to: number,
): FlownoteBlockBackgroundTarget[] {
  const targets: FlownoteBlockBackgroundTarget[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (BLOCK_BACKGROUND_NODE_TYPES.has(node.type.name)) {
      targets.push({ pos, node });
      return false;
    }
    return BLOCK_BACKGROUND_CONTAINER_TYPES.has(node.type.name);
  });
  return targets;
}

export interface FlownoteBlockBackgroundOptions {
  /**
   * Drag-handle block selections win by default. Callers acting on a text
   * selection (the bubble-menu palette) should pass `false` so a stale block
   * selection cannot redirect the colour to unrelated rows.
   */
  preferBlockSelection?: boolean;
  /**
   * Block anchored by the drag-handle menu. Used when no block selection
   * applies, so right-clicking a row paints that row rather than wherever the
   * caret happens to sit.
   */
  targetPos?: number;
}

/**
 * Blocks a background command should paint, in document order.
 *
 * A drag-handle multi-block selection wins when `preferBlockSelection` is on:
 * users pick rows through the handle, and that selection must not be lost to
 * the caret position. Otherwise every paragraph/heading intersecting the text
 * selection is painted.
 */
export function collectFlownoteBlockBackgroundTargets(
  state: EditorState,
  { preferBlockSelection = true, targetPos }: FlownoteBlockBackgroundOptions = {},
): FlownoteBlockBackgroundTarget[] {
  const blockSelection = preferBlockSelection ? getBlockSelection(state) : null;
  if (blockSelection && blockSelection.ranges.length > 0) {
    const targets: FlownoteBlockBackgroundTarget[] = [];
    const seen = new Set<number>();
    for (const range of blockSelection.ranges) {
      const node = state.doc.nodeAt(range.from);
      if (!node) continue;
      const target = BLOCK_BACKGROUND_NODE_TYPES.has(node.type.name)
        ? { pos: range.from, node }
        : firstBackgroundNodeInside(node, range.from);
      if (!target || seen.has(target.pos)) continue;
      seen.add(target.pos);
      targets.push(target);
    }
    return targets;
  }

  if (targetPos != null) {
    const node = state.doc.nodeAt(targetPos);
    if (node) {
      const target = BLOCK_BACKGROUND_NODE_TYPES.has(node.type.name)
        ? { pos: targetPos, node }
        : firstBackgroundNodeInside(node, targetPos);
      return target ? [target] : [];
    }
  }

  const { from, to } = state.selection;
  if (from === to) {
    const target = paragraphAtSelection(state);
    return target ? [target] : [];
  }
  return collectBackgroundTargetsBetween(state.doc, from, to);
}

/** Colour shared by every target; `null` covers "mixed" and "no background". */
export function getFlownoteBlockBackground(
  editor: Editor,
  options: FlownoteBlockBackgroundOptions = {},
): FlownoteTextColor | null {
  if (editor.isDestroyed) return null;
  const targets = collectFlownoteBlockBackgroundTargets(editor.state, options);
  if (targets.length === 0) return null;

  const first = backgroundOfNode(targets[0].node);
  return targets.every((target) => backgroundOfNode(target.node) === first) ? first : null;
}

export function hasFlownoteBlockBackgroundTargets(
  editor: Editor,
  options: FlownoteBlockBackgroundOptions = {},
): boolean {
  if (editor.isDestroyed) return false;
  return collectFlownoteBlockBackgroundTargets(editor.state, options).length > 0;
}

/**
 * Paint every target block with `bg` (or clear it with `null`) in one
 * transaction so a multi-row selection is a single undo step.
 */
export function setFlownoteBlockBackground(
  editor: Editor,
  bg: FlownoteTextColor | null,
  options: FlownoteBlockBackgroundOptions = {},
): boolean {
  if (editor.isDestroyed) return false;
  const targets = collectFlownoteBlockBackgroundTargets(editor.state, options);
  if (targets.length === 0) return false;

  const nextBg = normalizeFlownoteBlockBackground(bg);
  const tr = editor.state.tr;
  for (const target of targets) {
    tr.setNodeMarkup(target.pos, undefined, {
      ...target.node.attrs,
      [FLOWNOTE_BLOCK_BACKGROUND_ATTR]: nextBg,
    });
  }
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}
