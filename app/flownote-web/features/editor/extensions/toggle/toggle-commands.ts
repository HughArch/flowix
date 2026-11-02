import type { CommandProps } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import type { EditorState } from '@tiptap/pm/state';
import { Fragment } from '@tiptap/pm/model';
import type { Node as PMNode, ResolvedPos } from 'prosemirror-model';
import { TOGGLE_NODE_NAME } from './toggle-markdown';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    toggle: {
      /** Wrap the block at the selection in a toggle; the wrapped block becomes the title. */
      setToggle: () => ReturnType;
      /** Unwrap the nearest toggle ancestor while keeping its children. */
      unsetToggle: () => ReturnType;
    };
  }
}

/**
 * Parents that hold ordinary blocks. Walking up from the cursor stops at the
 * first node whose parent is one of these, which keeps `setToggle` inside a
 * column/callout/toggle instead of wrapping the whole outer container.
 */
const BLOCK_CONTAINER_TYPES = new Set([
  'doc',
  'column',
  'callout',
  TOGGLE_NODE_NAME,
  'blockquote',
  'tableCell',
  'tableHeader',
  'listItem',
  'taskItem',
]);

/**
 * `listItem`/`taskItem` require a leading paragraph. Replacing it with a
 * toggle would invalidate the node, so the wrap target is rejected.
 */
function isRequiredLeadingParagraph(parent: PMNode, index: number): boolean {
  return (parent.type.name === 'listItem' || parent.type.name === 'taskItem') && index === 0;
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

function nearestToggleDepth($pos: ResolvedPos): number | null {
  for (let depth = $pos.depth; depth >= 1; depth -= 1) {
    if ($pos.node(depth).type.name === TOGGLE_NODE_NAME) return depth;
  }
  return null;
}

/**
 * True when Backspace should unwrap the toggle: empty selection, caret at the
 * very start of a textblock that is the toggle's own first child (the title).
 *
 * Nested structures must not match, so a caret at the start of the first list
 * item inside the body does not delete the whole container.
 */
export function isAtToggleStart(state: EditorState): boolean {
  const { selection } = state;
  if (!selection.empty) return false;

  const { $from } = selection;
  if (!$from.parent.isTextblock || $from.parentOffset !== 0) return false;

  const depth = nearestToggleDepth($from);
  if (depth === null) return false;
  if ($from.depth !== depth + 1) return false;
  return $from.index(depth) === 0;
}

export function setToggle({ state, dispatch }: CommandProps): boolean {
  const toggleType = state.schema.nodes[TOGGLE_NODE_NAME];
  if (!toggleType) return false;

  // Wrapping the title line of an existing toggle would nest a container
  // inside its own header, which has no useful meaning. Body blocks may still
  // be wrapped into nested toggles.
  const { $from } = state.selection;
  const toggleDepth = nearestToggleDepth($from);
  if (
    toggleDepth !== null
    && $from.depth === toggleDepth + 1
    && $from.index(toggleDepth) === 0
  ) {
    return false;
  }

  const target = blockAtSelection(state);
  if (!target) return false;
  if (target.node.type.name === TOGGLE_NODE_NAME) return false;
  if (!toggleType.validContent(Fragment.from(target.node))) return false;

  const paragraphType = state.schema.nodes.paragraph;
  // Only a textblock can act as the title line. Wrapping a list/table/columns
  // container would put it in the title slot, so those become the body behind
  // an empty title paragraph instead.
  const isTitleBlock = target.node.isTextblock;
  const wrapped = isTitleBlock
    ? target.node
    : paragraphType
      ? Fragment.fromArray([paragraphType.create(), target.node])
      : target.node;

  const offset = Math.max(0, Math.min($from.pos - target.pos, target.node.nodeSize));
  // The empty title paragraph adds its own node size ahead of the wrapped block.
  const titleOffset = isTitleBlock || !paragraphType ? offset : offset + paragraphType.create().nodeSize;

  const toggle = toggleType.create({ open: true }, wrapped);
  const tr = state
    .tr
    .replaceWith(target.pos, target.pos + target.node.nodeSize, toggle);

  // The wrapped block moves exactly one token (the toggle open token) inward;
  // mapping the old position through the replacement would collapse it to the
  // replacement boundary instead.
  const cursor = Math.min(target.pos + 1 + titleOffset, tr.doc.content.size);
  tr.setSelection(TextSelection.near(tr.doc.resolve(cursor)));

  dispatch?.(tr.scrollIntoView());
  return true;
}

export function unsetToggle({ state, dispatch }: CommandProps): boolean {
  const { $from } = state.selection;
  const depth = nearestToggleDepth($from);
  if (depth === null) return false;

  const togglePos = $from.before(depth);
  const toggle = $from.node(depth);
  const paragraphType = state.schema.nodes.paragraph;

  // `content: 'block+'` forbids an empty container. Nothing should leave a
  // toggle childless, but a defensive paragraph keeps unwrapping total.
  const content = toggle.childCount > 0
    ? toggle.content
    : paragraphType
      ? Fragment.from(paragraphType.create())
      : Fragment.empty;
  if (content.size === 0) return false;

  const cursor = togglePos + Math.max(1, $from.pos - togglePos - 1);
  const tr = state.tr;
  // Unwrapping is a structural close: keep it separate from the preceding
  // typing history so one Backspace is one undo entry.
  closeHistory(tr);
  tr.replaceWith(togglePos, togglePos + toggle.nodeSize, content);
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(cursor, tr.doc.content.size))));

  dispatch?.(tr.scrollIntoView());
  return true;
}
