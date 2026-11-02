import type { CommandProps } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import type { EditorState } from '@tiptap/pm/state';
import { Fragment } from '@tiptap/pm/model';
import type { Node as PMNode, ResolvedPos } from 'prosemirror-model';
import { DEFAULT_CALLOUT_PRESET } from './callout-presets';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    callout: {
      /** Wrap the block at the selection in a callout container. */
      setCallout: () => ReturnType;
      /** Unwrap the nearest callout ancestor while keeping its children. */
      unsetCallout: () => ReturnType;
    };
  }
}

/**
 * Parents that hold ordinary blocks. Walking up from the cursor stops at the
 * first node whose parent is one of these, which keeps `setCallout` inside a
 * column/quote/list item instead of wrapping the whole outer container.
 */
const BLOCK_CONTAINER_TYPES = new Set([
  'doc',
  'column',
  'callout',
  'blockquote',
  'tableCell',
  'tableHeader',
  'listItem',
  'taskItem',
]);

/**
 * `listItem`/`taskItem` require a leading paragraph. Replacing it with a
 * callout would invalidate the node, so the wrap target moves up to the list.
 */
function isRequiredLeadingParagraph(parent: PMNode, index: number): boolean {
  return (parent.type.name === 'listItem' || parent.type.name === 'taskItem') && index === 0;
}

export function canWrapBlockInCallout(parent: PMNode, index: number): boolean {
  return !isRequiredLeadingParagraph(parent, index);
}

interface BlockTarget {
  pos: number;
  node: PMNode;
}

function blockAtSelection(state: EditorState): BlockTarget | null {
  const { selection } = state;

  // A NodeSelection (e.g. an image or media block) already names the block.
  if (selection instanceof NodeSelection) {
    const node = state.doc.nodeAt(selection.from);
    return node ? { pos: selection.from, node } : null;
  }

  const { $from } = selection;
  for (let depth = $from.depth; depth >= 1; depth -= 1) {
    const parent = $from.node(depth - 1);
    if (!BLOCK_CONTAINER_TYPES.has(parent.type.name)) continue;
    if (isRequiredLeadingParagraph(parent, $from.index(depth - 1))) continue;
    const node = $from.node(depth);
    if (!node.isBlock) continue;
    return { pos: $from.before(depth), node };
  }
  return null;
}

function nearestCalloutDepth($pos: ResolvedPos): number | null {
  for (let depth = $pos.depth; depth >= 1; depth -= 1) {
    if ($pos.node(depth).type.name === 'callout') return depth;
  }
  return null;
}

/**
 * `!!` + space shortcut guard. The plugin receives the state *before* the
 * space is inserted, so the paragraph still contains exactly `!!`.
 */
export function isCalloutShortcut(parent: PMNode, parentOffset: number): boolean {
  return parent.type.name === 'paragraph'
    && parentOffset === 2
    && parent.textContent === '!!';
}

/**
 * True when Backspace should unwrap the callout: empty selection, caret at the
 * very start of a textblock that is the callout's own first child.
 *
 * Nested structures must not match. For example, a caret at the start of the
 * first list item used to unwrap the whole callout, so Backspace on an ordered
 * list marker deleted the container instead of editing the list. Requiring the
 * textblock to be a direct child lets the list / quote / column own that key.
 */
export function isAtCalloutStart(state: EditorState): boolean {
  const { selection } = state;
  if (!selection.empty) return false;

  const { $from } = selection;
  if (!$from.parent.isTextblock || $from.parentOffset !== 0) return false;

  const depth = nearestCalloutDepth($from);
  if (depth === null) return false;
  if ($from.depth !== depth + 1) return false;
  return $from.index(depth) === 0;
}

export function setCallout({ state, dispatch }: CommandProps): boolean {
  const calloutType = state.schema.nodes.callout;
  if (!calloutType) return false;

  const target = blockAtSelection(state);
  if (!target) return false;
  if (target.node.type.name === 'callout') return false;
  if (!calloutType.validContent(Fragment.from(target.node))) return false;

  const $from = state.selection.$from;
  const offset = Math.max(0, Math.min($from.pos - target.pos, target.node.nodeSize));

  const callout = calloutType.create(
    {
      icon: DEFAULT_CALLOUT_PRESET.icon,
      color: DEFAULT_CALLOUT_PRESET.color,
    },
    target.node,
  );
  const tr = state
    .tr
    .replaceWith(target.pos, target.pos + target.node.nodeSize, callout);

  // The wrapped block moves exactly one token (the callout open token) inward;
  // mapping the old position through the replacement would collapse it to the
  // replacement boundary instead.
  const cursor = Math.min(target.pos + 1 + offset, tr.doc.content.size);
  tr.setSelection(TextSelection.near(tr.doc.resolve(cursor)));

  dispatch?.(tr.scrollIntoView());
  return true;
}

export function unsetCallout({ state, dispatch }: CommandProps): boolean {
  const { $from } = state.selection;
  const depth = nearestCalloutDepth($from);
  if (depth === null) return false;

  const calloutPos = $from.before(depth);
  const callout = $from.node(depth);
  const paragraphType = state.schema.nodes.paragraph;

  // `content: 'block+'` forbids an empty container. Nothing should leave a
  // callout childless, but a defensive paragraph keeps unwrapping total.
  const content = callout.childCount > 0
    ? callout.content
    : paragraphType
      ? Fragment.from(paragraphType.create())
      : Fragment.empty;
  if (content.size === 0) return false;

  const cursor = calloutPos + Math.max(1, $from.pos - calloutPos - 1);
  const tr = state.tr;
  // Unwrapping is a structural close: keep it separate from the preceding
  // typing history so one Backspace is one undo entry.
  closeHistory(tr);
  tr.replaceWith(calloutPos, calloutPos + callout.nodeSize, content);
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(cursor, tr.doc.content.size))));

  dispatch?.(tr.scrollIntoView());
  return true;
}
