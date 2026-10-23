import type { Editor, MarkdownToken } from '@tiptap/core';
import type { Node as PMNode } from 'prosemirror-model';
import type { EditorState } from 'prosemirror-state';
import { getBlockSelection } from './block-selection';
import {
  isFlowixTextColor,
  type FlowixTextColor,
} from './flowix-text-mark';

/**
 * Line (block) background colour.
 *
 * The inline highlight mark (`==text==`) covers the glyphs themselves. A line
 * background belongs to the block node (`paragraph` / `heading`) so it can be
 * painted across the whole text column, including the gutters and the leading
 * and trailing space of the line.
 *
 * Markdown persistence follows the same adjacent-HTML-comment convention as
 * `flowix:text`: the comment trails the block's own markdown so plain readers
 * still see an ordinary paragraph/heading.
 */

export const FLOWIX_BLOCK_BACKGROUND_MARKER = 'flowix:block-bg';

/** Node attribute name shared by paragraph and heading. */
export const FLOWIX_BLOCK_BACKGROUND_ATTR = 'flowixBg';

const BLOCK_BG_COMMENT_RE = /^<!--\s*flowix:block-bg\s+(\{[\s\S]*\})\s*-->$/;

const BLOCK_BACKGROUND_NODE_TYPES = new Set(['paragraph', 'heading']);

/**
 * Containers a block background may reach into when the user targets the
 * container itself (a list item or a blockquote). Tables and code blocks are
 * deliberately absent: painting their first cell/line is not a "line".
 */
const BLOCK_BACKGROUND_CONTAINER_TYPES = new Set(['listItem', 'taskItem', 'blockquote', 'columns', 'column']);

export function normalizeFlowixBlockBackground(value: unknown): FlowixTextColor | null {
  return isFlowixTextColor(value) ? value : null;
}

export function renderFlowixBlockBackgroundComment(bg: FlowixTextColor): string {
  return `<!-- ${FLOWIX_BLOCK_BACKGROUND_MARKER} ${JSON.stringify({ bg })} -->`;
}

/**
 * Append the semantic comment after a block's markdown.
 *
 * Empty blocks (`''`, which the paragraph renderer emits for list-item and
 * table-cell children) still need a marker line so the colour survives a
 * round-trip; `&nbsp;` keeps the comment out of the leading-HTML-block path.
 */
export function appendFlowixBlockBackgroundComment(
  markdown: string,
  bg: FlowixTextColor | null,
): string {
  if (!bg) return markdown;
  const comment = renderFlowixBlockBackgroundComment(bg);
  return markdown ? `${markdown}${comment}` : `&nbsp;${comment}`;
}

/** Read the background value written by `renderFlowixBlockBackgroundComment`. */
export function parseFlowixBlockBackgroundComment(value: string): FlowixTextColor | null {
  const match = BLOCK_BG_COMMENT_RE.exec(value.trim());
  if (!match) return null;

  try {
    const payload = JSON.parse(match[1]) as { bg?: unknown };
    return normalizeFlowixBlockBackground(payload?.bg);
  } catch {
    return null;
  }
}

function isFlowixBlockBackgroundComment(value: string): boolean {
  return value.trimStart().startsWith(`<!-- ${FLOWIX_BLOCK_BACKGROUND_MARKER}`);
}

/**
 * Split the block background comment out of a block's inline Markdown tokens.
 *
 * A comment carrying an unknown colour is dropped as well: leaving it in the
 * document would render raw HTML inside the paragraph.
 */
export function splitFlowixBlockBackgroundTokens(tokens: MarkdownToken[] | undefined): {
  bg: FlowixTextColor | null;
  tokens: MarkdownToken[];
} {
  if (!tokens?.length) return { bg: null, tokens: tokens ?? [] };

  let bg: FlowixTextColor | null = null;
  const kept: MarkdownToken[] = [];

  for (const token of tokens) {
    const raw = typeof token.raw === 'string'
      ? token.raw
      : typeof token.text === 'string' ? token.text : '';
    if (token.type === 'html' && isFlowixBlockBackgroundComment(raw)) {
      bg = parseFlowixBlockBackgroundComment(raw);
      continue;
    }
    kept.push(token);
  }

  return { bg, tokens: kept };
}

/** Tiptap node attribute definition shared by paragraph and heading. */
export const flowixBlockBackgroundAttribute = {
  [FLOWIX_BLOCK_BACKGROUND_ATTR]: {
    // `undefined` (not `null`) keeps the attribute out of `getJSON()` for
    // uncoloured blocks, so existing document snapshots stay byte-identical.
    default: undefined as FlowixTextColor | null | undefined,
    parseHTML: (element: HTMLElement) => {
      const value = element.getAttribute('data-flowix-block-bg');
      return isFlowixTextColor(value) ? value : null;
    },
    renderHTML: (attributes: Record<string, unknown>) => {
      const bg = normalizeFlowixBlockBackground(attributes[FLOWIX_BLOCK_BACKGROUND_ATTR]);
      return bg ? { 'data-flowix-block-bg': bg } : {};
    },
  },
};

function backgroundOfNode(node: PMNode): FlowixTextColor | null {
  return normalizeFlowixBlockBackground(node.attrs?.[FLOWIX_BLOCK_BACKGROUND_ATTR]);
}

/** The comment for a block node, ready to append to its Markdown. */
export function flowixBlockBackgroundCommentForNode(node: PMNode | { attrs?: Record<string, unknown> }): FlowixTextColor | null {
  const value = (node as { attrs?: Record<string, unknown> }).attrs?.[FLOWIX_BLOCK_BACKGROUND_ATTR];
  return normalizeFlowixBlockBackground(value);
}

export interface FlowixBlockBackgroundTarget {
  pos: number;
  node: PMNode;
}

function firstBackgroundNodeInside(node: PMNode, pos: number): FlowixBlockBackgroundTarget | null {
  let found: FlowixBlockBackgroundTarget | null = null;
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

function paragraphAtSelection(state: EditorState): FlowixBlockBackgroundTarget | null {
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
): FlowixBlockBackgroundTarget[] {
  const targets: FlowixBlockBackgroundTarget[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (BLOCK_BACKGROUND_NODE_TYPES.has(node.type.name)) {
      targets.push({ pos, node });
      return false;
    }
    return BLOCK_BACKGROUND_CONTAINER_TYPES.has(node.type.name);
  });
  return targets;
}

export interface FlowixBlockBackgroundOptions {
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
export function collectFlowixBlockBackgroundTargets(
  state: EditorState,
  { preferBlockSelection = true, targetPos }: FlowixBlockBackgroundOptions = {},
): FlowixBlockBackgroundTarget[] {
  const blockSelection = preferBlockSelection ? getBlockSelection(state) : null;
  if (blockSelection && blockSelection.ranges.length > 0) {
    const targets: FlowixBlockBackgroundTarget[] = [];
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
export function getFlowixBlockBackground(
  editor: Editor,
  options: FlowixBlockBackgroundOptions = {},
): FlowixTextColor | null {
  if (editor.isDestroyed) return null;
  const targets = collectFlowixBlockBackgroundTargets(editor.state, options);
  if (targets.length === 0) return null;

  const first = backgroundOfNode(targets[0].node);
  return targets.every((target) => backgroundOfNode(target.node) === first) ? first : null;
}

export function hasFlowixBlockBackgroundTargets(
  editor: Editor,
  options: FlowixBlockBackgroundOptions = {},
): boolean {
  if (editor.isDestroyed) return false;
  return collectFlowixBlockBackgroundTargets(editor.state, options).length > 0;
}

/**
 * Paint every target block with `bg` (or clear it with `null`) in one
 * transaction so a multi-row selection is a single undo step.
 */
export function setFlowixBlockBackground(
  editor: Editor,
  bg: FlowixTextColor | null,
  options: FlowixBlockBackgroundOptions = {},
): boolean {
  if (editor.isDestroyed) return false;
  const targets = collectFlowixBlockBackgroundTargets(editor.state, options);
  if (targets.length === 0) return false;

  const nextBg = normalizeFlowixBlockBackground(bg);
  const tr = editor.state.tr;
  for (const target of targets) {
    tr.setNodeMarkup(target.pos, undefined, {
      ...target.node.attrs,
      [FLOWIX_BLOCK_BACKGROUND_ATTR]: nextBg,
    });
  }
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}
